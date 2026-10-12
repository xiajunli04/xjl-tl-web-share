/**
 * 同传 mock（NEXT_PUBLIC_MOCK_API=1）：
 * - REST：只拦截 POST 会话创建 / 加入房间 / 取票据 / 结束（历史 GET/PUT/DELETE 不在此处理）
 * - MockInterpretSocket：不连 WS，用脚本化事件序列驱动四种模式（partial、多语译文、audio、metrics、会议室成员进出；
 *   AI 对话：AI 先开口、用户句与 AI 回复交替、interrupt 打断）
 * - mockMicLevel()：与脚本同步的模拟电平（本人"说话"时升高）
 * 生产构建不会包含该模块。
 */
import { ApiError, type RequestOptions } from "@/lib/http";
import type { InterpretCreateRequest, InterpretEndVO, InterpretJoinRequest, InterpretJoinVO, InterpretMode } from "@/lib/api/interpret";
import type { WebSocketLike } from "@/lib/interpret/connection";
import type { ClientControl, Participant, ServerEvent, Speaker } from "@/lib/interpret/protocol";
import { bytesToBase64 } from "@/lib/audio/pcm";
import { MOCK_ENGINES } from "./speech";

/* ---------------- 内存会话 ---------------- */

interface MockSession {
  id: number;
  mode: InterpretMode;
  engine: string;
  languages: string[];
  routing: "auto" | "ptt";
  tts: boolean;
  roomCode: string | null;
  startedAt: number;
  utterances: number;
  e2eSum: number;
  chatScenario?: string | null;
}

interface MockTicket {
  sessionId: number;
  participantId: string;
  displayName: string;
  lang: string;
  isHost: boolean;
}

const sessions = new Map<number, MockSession>();
const tickets = new Map<string, MockTicket>();
let seq = 40;
let ticketSeq = 0;

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function roomCode() {
  return Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
}

function issue(t: MockTicket): string {
  const id = `mock-ticket-${++ticketSeq}`;
  tickets.set(id, t);
  return id;
}

function joinVO(s: MockSession, t: MockTicket): InterpretJoinVO {
  return {
    sessionId: s.id,
    participantId: t.participantId,
    wsTicket: issue(t),
    roomCode: s.roomCode,
    mode: s.mode,
    engine: s.engine,
    languages: s.mode === "ROOM" ? [t.lang] : s.languages,
    isHost: t.isHost,
    wsUrl: "/ws/interpret",
  };
}

function bodyOf<T>(opts: RequestOptions): T {
  return (opts.body ?? {}) as T;
}

/** REST 拦截（只处理 POST，见 mock/api.ts 的分发条件） */
export async function mockInterpret<T>(path: string, opts: RequestOptions): Promise<T> {
  let m: RegExpMatchArray | null;
  if (path === "/api/interpret/sessions") {
    const req = bodyOf<InterpretCreateRequest>(opts);
    const engine = MOCK_ENGINES.interpret.find((e) => e.id === req.engine);
    if (!engine || !engine.available) throw new ApiError("C0173", engine?.reason ?? "语音引擎不可用", "mock-c0173", 503);
    if (req.mode === "CHAT" && req.engine !== "cascade") {
      throw new ApiError("A0410", "AI 对话仅支持平台级联引擎", undefined, 400);
    }
    if (req.mode === "CONVERSE") {
      if (req.languages.length !== 2 || req.languages[0] === req.languages[1]) {
        throw new ApiError("A0410", "双向对话的两种语言必须不同", undefined, 400);
      }
      if (engine.s2s && req.converseRouting === "auto") {
        throw new ApiError("A0410", "该引擎仅支持按键说话", undefined, 400);
      }
    }
    const s: MockSession = {
      id: ++seq,
      mode: req.mode,
      engine: req.engine,
      languages: req.languages,
      routing: req.converseRouting ?? "auto",
      tts: req.tts !== false,
      roomCode: req.mode === "ROOM" ? roomCode() : null,
      startedAt: Date.now(),
      utterances: 0,
      e2eSum: 0,
      chatScenario: req.mode === "CHAT" ? (req.chatScenario ?? "free") : null,
    };
    sessions.set(s.id, s);
    return joinVO(s, {
      sessionId: s.id,
      participantId: "p1",
      displayName: req.displayName || "我",
      lang: req.languages[0],
      isHost: true,
    }) as T;
  }
  if ((m = path.match(/^\/api\/interpret\/rooms\/([^/]+)\/join$/))) {
    const code = decodeURIComponent(m[1]).toUpperCase();
    const req = bodyOf<InterpretJoinRequest>(opts);
    if (code === "000000") throw new ApiError("A0452", "房间不存在或已关闭", undefined, 404);
    if (code === "999999") throw new ApiError("A0451", "会议室已满（最多 8 人）", undefined, 409);
    // 任意其他房间码：创建一个虚拟房间（主持人为中文），便于两个窗口分别演示
    let s = [...sessions.values()].find((x) => x.roomCode === code);
    if (!s) {
      s = { id: ++seq, mode: "ROOM", engine: "cascade", languages: ["zh"], routing: "auto", tts: true, roomCode: code, startedAt: Date.now(), utterances: 0, e2eSum: 0 };
      sessions.set(s.id, s);
    }
    return joinVO(s, {
      sessionId: s.id,
      participantId: req.participantId || `p${Math.floor(Math.random() * 900) + 100}`,
      displayName: req.displayName || "访客",
      lang: req.lang,
      isHost: false,
    }) as T;
  }
  if ((m = path.match(/^\/api\/interpret\/sessions\/(\d+)\/ticket$/))) {
    const s = sessions.get(Number(m[1]));
    if (!s) throw new ApiError("A0404", "会话不存在", undefined, 404);
    return joinVO(s, { sessionId: s.id, participantId: "p1", displayName: "我", lang: s.languages[0], isHost: true }) as T;
  }
  if ((m = path.match(/^\/api\/interpret\/sessions\/(\d+)\/end$/))) {
    const s = sessions.get(Number(m[1]));
    if (!s) throw new ApiError("A0404", "会话不存在", undefined, 404);
    const durationMs = Date.now() - s.startedAt;
    const vo: InterpretEndVO = {
      id: s.id,
      mode: s.mode,
      engine: s.engine,
      languages: s.languages,
      roomCode: s.roomCode,
      status: "ENDED",
      title: null,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs,
      stats: { utterances: s.utterances, avgE2eMs: s.utterances ? Math.round(s.e2eSum / s.utterances) : null, durationMs },
      favorite: false,
    };
    return vo as T;
  }
  throw new ApiError("A0404", `mock 未实现：${opts.method ?? "GET"} ${path}`);
}

/* ---------------- 脚本素材 ---------------- */

type Lines = Partial<Record<string, string>> & { en: string };

/** 收听：发布会场景，多语种发言 */
const LISTEN_LINES: { src: string; t: Lines; pause?: boolean }[] = [
  { src: "en", t: { en: "Good morning everyone, and welcome to our product launch.", zh: "大家早上好，欢迎来到我们的产品发布会。", ja: "皆さん、おはようございます。製品発表会へようこそ。", ko: "여러분 안녕하세요, 제품 발표회에 오신 것을 환영합니다." } },
  { src: "ja", t: { ja: "本日は新しいリアルタイム翻訳エンジンをご紹介します。", zh: "今天为大家介绍全新的实时翻译引擎。", en: "Today we will introduce our new real-time translation engine.", ko: "오늘은 새로운 실시간 번역 엔진을 소개합니다." } },
  { src: "en", pause: true, t: { en: "It understands more than sixty languages with about two seconds of delay.", zh: "它能理解六十多种语言，延迟大约只有两秒。", ja: "60以上の言語を約2秒の遅延で理解します。", ko: "60개 이상의 언어를 약 2초의 지연으로 이해합니다." } },
  { src: "ko", t: { ko: "전문 용어는 용어집을 통해 정확하게 번역됩니다.", zh: "专业术语会通过术语库准确翻译。", en: "Technical terms are translated accurately through the glossary.", ja: "専門用語は用語集によって正確に翻訳されます。" } },
  { src: "zh", t: { zh: "接下来请大家看现场演示。", en: "Next, please take a look at the live demo.", ja: "続いてライブデモをご覧ください。", ko: "다음으로 라이브 데모를 보시겠습니다." } },
  { src: "en", t: { en: "Large language models now power the whole pipeline.", zh: "现在整条管线都由大模型驱动。", ja: "現在、パイプライン全体を大規模言語モデルが支えています。", ko: "이제 대규모 언어 모델이 전체 파이프라인을 구동합니다." } },
];

/** 对话：问路场景，A/B 交替 */
const CONVERSE_LINES: { side: "A" | "B"; t: Record<string, string> }[] = [
  { side: "A", t: { zh: "你好，请问去机场的地铁怎么坐？", en: "Hi, how do I take the subway to the airport?", ja: "すみません、空港へ行く地下鉄はどう乗ればいいですか？", ko: "안녕하세요, 공항 가는 지하철은 어떻게 타나요?" } },
  { side: "B", t: { en: "Take Line 2 and change to the airport express at Central Station.", zh: "坐二号线，在中央站换乘机场快线。", ja: "2号線に乗って、中央駅で空港快速に乗り換えてください。", ko: "2호선을 타고 중앙역에서 공항철도로 갈아타세요." } },
  { side: "A", t: { zh: "大概需要多长时间？", en: "About how long does it take?", ja: "だいたいどのくらいかかりますか？", ko: "대략 얼마나 걸리나요?" } },
  { side: "B", t: { en: "Around forty minutes, trains come every ten minutes.", zh: "大约四十分钟，每十分钟一班。", ja: "40分ほどで、電車は10分おきに来ます。", ko: "40분 정도 걸리고 열차는 10분마다 옵니다." } },
  { side: "A", t: { zh: "太好了，非常感谢！", en: "Great, thank you so much!", ja: "よかった、本当にありがとうございます！", ko: "좋네요, 정말 감사합니다!" } },
];

/** 会议室：跨国项目周会 */
const ROOM_LINES: { who: number; t: Record<string, string>; pause?: boolean }[] = [
  { who: 0, t: { zh: "大家好，我们开始本周的项目同步。", en: "Hello everyone, let's start this week's project sync.", ja: "皆さんこんにちは、今週のプロジェクト共有を始めましょう。", ko: "안녕하세요, 이번 주 프로젝트 공유를 시작하겠습니다." } },
  { who: 1, t: { en: "The mobile release is on track for Friday.", zh: "移动端版本按计划周五发布。", ja: "モバイル版のリリースは金曜日の予定通りです。", ko: "모바일 버전은 예정대로 금요일에 출시됩니다." } },
  { who: 2, t: { ja: "翻訳メモリの検索速度が二倍になりました。", zh: "翻译记忆的检索速度提升了一倍。", en: "Translation memory search is now twice as fast.", ko: "번역 메모리 검색 속도가 두 배가 되었습니다." } },
  { who: 0, pause: true, t: { zh: "很好，术语库的同步问题解决了吗？", en: "Great. Has the glossary sync issue been fixed?", ja: "いいですね。用語集の同期の問題は解決しましたか？", ko: "좋습니다. 용어집 동기화 문제는 해결되었나요?" } },
  { who: 3, t: { ko: "네, 어제 수정 버전을 배포했습니다.", zh: "是的，昨天已经部署了修复版本。", en: "Yes, we deployed the fix yesterday.", ja: "はい、昨日修正版をデプロイしました。" } },
  { who: 1, t: { en: "I'll share the test report after the meeting.", zh: "会后我会分享测试报告。", ja: "会議の後でテストレポートを共有します。", ko: "회의 후에 테스트 보고서를 공유하겠습니다." } },
];

/** AI 对话：餐厅场景，AI 先开口，用户与 AI 交替（en 为对话语言示例，zh 为母语） */
/**
 * split：用户说到一半停顿，AI 抢先开始回复，用户接着说（演示回复让位：AI 气泡撤回，随后对整句回应）；
 * late：用户转写晚于 AI 回复的首个事件到达（演示按发言流序号插入）
 */
const CHAT_LINES: { who: "ai" | "me"; t: Record<string, string>; split?: Record<string, [string, string]>; late?: boolean }[] = [
  { who: "ai", t: { en: "Good evening, welcome to Lumi's Kitchen! Here is the menu. Can I get you something to drink first?", zh: "晚上好，欢迎光临 Lumi 小厨！这是菜单。要先来点喝的吗？", ja: "こんばんは、Lumi's Kitchen へようこそ！メニューです。まずお飲み物はいかがですか？" } },
  {
    who: "me",
    t: { zh: "我想要一杯橙汁，还有不辣的菜推荐吗？", en: "I'd like an orange juice. Any dishes that aren't spicy?" },
    split: { zh: ["我想要一杯橙汁，", "还有不辣的菜推荐吗？"], en: ["I'd like an orange juice,", "and any dishes that aren't spicy?"] },
  },
  { who: "ai", t: { en: "You could say: \"Could you recommend something mild?\" Our honey garlic chicken is mild and very popular. Would you like to try it?", zh: "你可以说：“Could you recommend something mild?” 我们的蜂蜜蒜香鸡不辣，而且很受欢迎。要试试吗？", ja: "「Could you recommend something mild?」と言えますよ。ハニーガーリックチキンは辛くなくて人気です。いかがですか？" } },
  { who: "me", t: { zh: "好的，就要这个，再来一份米饭。", en: "Okay, I'll have that, and a bowl of rice." } },
  { who: "ai", t: { en: "Great choice! One honey garlic chicken with rice and an orange juice. It will be ready in about fifteen minutes.", zh: "好选择！一份蜂蜜蒜香鸡配米饭，再加一杯橙汁，大约十五分钟就好。", ja: "いい選択ですね！ハニーガーリックチキンとライス、オレンジジュースですね。15分ほどでお持ちします。" } },
  { who: "me", late: true, t: { zh: "谢谢，可以刷卡吗？", en: "Thanks, can I pay by card?" } },
  { who: "ai", t: { en: "Of course, we accept all major cards. Just let me know when you're ready for the bill. Enjoy your meal!", zh: "当然可以，我们支持各大银行卡。准备结账时告诉我就好，祝您用餐愉快！", ja: "もちろんです。主要なカードはすべて使えます。お会計の際はお声がけください。ごゆっくりどうぞ！" } },
];

const AI_SPEAKER_ID = "ai";

function lineIn(t: Partial<Record<string, string>> & { en?: string }, lang: string): string {
  return t[lang] ?? `[${lang}] ${t.en ?? Object.values(t)[0] ?? ""}`;
}

/** 文本切成渐进前缀（partial） */
function prefixes(text: string, parts: number): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 1; i <= parts; i++) out.push(chars.slice(0, Math.max(1, Math.round((chars.length * i) / (parts + 1)))).join(""));
  return out;
}

/** 文本切成增量（delta） */
function deltas(text: string, parts: number): string[] {
  const chars = Array.from(text);
  const size = Math.max(1, Math.ceil(chars.length / parts));
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

/** 0.4 s 的 24 kHz PCM16（极低音量的柔和提示音，演示播报状态与半双工门控） */
let toneChunk: string | null = null;
function audioChunk(): string {
  if (toneChunk) return toneChunk;
  const n = 9600;
  const bytes = new Uint8Array(n * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) {
    const env = Math.sin((Math.PI * i) / n);
    view.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * env * 120), true);
  }
  toneChunk = bytesToBase64(bytes);
  return toneChunk;
}

/* ---------------- 模拟电平 ---------------- */

let localSpeaking = false;
let phase = 0;

/** 模拟 RMS：本人"说话"时 0.03–0.2 起伏，否则为底噪 */
export function mockMicLevel(): number {
  phase += 0.35;
  if (!localSpeaking) return 0.0012 + Math.random() * 0.0008;
  return 0.03 + (Math.sin(phase) * 0.5 + 0.5) * 0.12 + Math.random() * 0.05;
}

/* ---------------- 模拟 WebSocket ---------------- */

const AUDIO_CHUNKS = 4;

interface Member extends Participant {
  joinAt: number;
  leaveAt?: number;
}

export class MockInterpretSocket implements WebSocketLike {
  binaryType: BinaryType = "arraybuffer";
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private timers = new Set<ReturnType<typeof setTimeout>>();
  private ticket: MockTicket | null;
  private session: MockSession | null;
  private n = 0;
  private cursor = 0;
  private pttSide: "A" | "B" | null = null;
  private pttLine = { A: 0, B: 0 };
  private members: Member[] = [];
  private busy = false;
  private muted = false;
  /** 自动对话中收到按键帧后进入手动（停止自动脚本），收到 flush 恢复 */
  private manual = false;
  private elapsed = 0;

  constructor(url: string) {
    const t = new URL(url, "http://mock").searchParams.get("ticket") ?? "";
    this.ticket = tickets.get(t) ?? null;
    tickets.delete(t);
    this.session = this.ticket ? (sessions.get(this.ticket.sessionId) ?? null) : null;
    this.later(260, () => {
      if (!this.ticket || !this.session) {
        this.readyState = 3;
        this.onclose?.({ code: 1006, reason: "ticket" } as CloseEvent);
        return;
      }
      this.readyState = 1;
      this.onopen?.({} as Event);
      this.start();
    });
  }

  send(data: string | ArrayBufferLike | ArrayBufferView) {
    if (typeof data !== "string") return; // 音频帧：脚本不依赖真实音频
    let c: ClientControl;
    try {
      c = JSON.parse(data) as ClientControl;
    } catch {
      return;
    }
    if (c.type === "ping") this.emit({ type: "pong" });
    if (c.type === "ptt") this.onPtt(c.side);
    if (c.type === "mute") this.muted = c.muted;
    if (c.type === "interrupt") {
      if (c.yield) this.onYield();
      else this.onInterrupt();
    }
    if (c.type === "flush" && this.manual && this.pttSide === null && this.session?.routing === "auto") {
      this.manual = false;
      this.later(600, () => this.next());
    }
    if (c.type === "end") {
      const s = this.session!;
      this.emit({ type: "ended", reason: "user_end", stats: { durationMs: Date.now() - s.startedAt, utterances: s.utterances, avgE2eMs: s.utterances ? Math.round(s.e2eSum / s.utterances) : null } });
      this.later(80, () => this.close(1000));
    }
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    localSpeaking = false;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason: "" } as CloseEvent));
  }

  /* ---- 内部 ---- */

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private emit(e: ServerEvent) {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent);
  }

  private get me(): Speaker {
    const t = this.ticket!;
    return { participantId: t.participantId, displayName: t.displayName, lang: t.lang };
  }

  private start() {
    const s = this.session!;
    const t = this.ticket!;
    this.emit({
      type: "ready",
      sessionId: s.id,
      participantId: t.participantId,
      mode: s.mode,
      engine: s.engine,
      languages: s.mode === "ROOM" ? [t.lang] : s.languages,
      roomCode: s.roomCode,
      isHost: t.isHost,
    });
    if (s.mode === "ROOM") this.setupRoom();
    else if (s.mode === "CONVERSE" && s.routing === "ptt") return; // 按键模式：等待 ptt
    this.later(s.mode === "CHAT" ? 700 : 900, () => this.next());
  }

  /* ---- 会议室成员 ---- */

  private setupRoom() {
    const t = this.ticket!;
    const pool = ["en", "ja", "ko", "zh", "fr"].filter((l) => l !== t.lang);
    const names: Record<string, string> = { en: "Emma", ja: "佐藤", ko: "민준", zh: "王老师", fr: "Louis" };
    const others = t.isHost ? pool.slice(0, 3) : ["zh", ...pool.filter((l) => l !== "zh")].slice(0, 3);
    this.members = [
      { participantId: t.participantId, displayName: t.displayName, lang: t.lang, speaking: false, isHost: t.isHost, online: true, joinAt: 0 },
      ...others.map((lang, i) => ({
        participantId: `m${i + 2}`,
        displayName: names[lang] ?? lang,
        lang,
        speaking: false,
        isHost: !t.isHost && i === 0,
        online: true,
        joinAt: i === 0 && !t.isHost ? 0 : 1200 + i * 1600,
        leaveAt: i === 2 ? 26_000 : undefined,
      })),
    ];
    this.pushParticipants();
    for (const m of this.members) {
      if (m.joinAt > 0) this.later(m.joinAt, () => this.pushParticipants());
      if (m.leaveAt) {
        this.later(m.leaveAt, () => this.pushParticipants());
        // 离开后 6 s 重新加入（演示进出）
        this.later(m.leaveAt + 6000, () => {
          m.joinAt = 0;
          m.leaveAt = undefined;
          this.pushParticipants();
        });
      }
    }
  }

  private visibleMembers(): Member[] {
    const at = this.elapsed;
    return this.members.filter((m) => m.joinAt <= at && (m.leaveAt === undefined || m.leaveAt > at));
  }

  private pushParticipants() {
    this.elapsed = Date.now() - this.session!.startedAt;
    this.emit({
      type: "participants",
      list: this.visibleMembers().map(({ participantId, displayName, lang, speaking, isHost, online }) => ({ participantId, displayName, lang, speaking, isHost, online })),
    });
  }

  private setSpeaking(pid: string, on: boolean) {
    const m = this.members.find((x) => x.participantId === pid);
    if (!m || m.speaking === on) return;
    m.speaking = on;
    this.pushParticipants();
  }

  /* ---- 脚本推进 ---- */

  private next() {
    if (this.readyState !== 1 || this.busy) return;
    const s = this.session!;
    if (s.mode === "CONVERSE" && this.manual) return;
    if (this.muted && s.mode !== "ROOM") {
      this.later(1000, () => this.next());
      return;
    }
    // 每 5 句插入一次噪声（咳嗽）：先出现 partial，随后被撤回，界面不残留空白气泡（improve-speech-endpointing-and-live-ux）
    if (s.mode !== "CHAT" && this.cursor > 0 && this.cursor % 5 === 0 && !this.noiseAt.has(this.cursor)) {
      this.noiseAt.add(this.cursor);
      this.noise(s.mode === "ROOM" ? (this.visibleMembers()[1] ?? this.visibleMembers()[0]) : this.me);
      return;
    }
    if (s.mode === "LISTEN") {
      const line = LISTEN_LINES[this.cursor++ % LISTEN_LINES.length];
      const target = s.languages[0];
      this.utter({ speaker: this.me, srcLang: line.src, text: lineIn(line.t, line.src), targets: line.src === target ? {} : { [target]: lineIn(line.t, target) }, local: true, audioLang: target, pause: line.pause });
      return;
    }
    if (s.mode === "CONVERSE") {
      const line = CONVERSE_LINES[this.cursor++ % CONVERSE_LINES.length];
      this.converseLine(line.side, line.t);
      return;
    }
    if (s.mode === "CHAT") {
      const line = CHAT_LINES[this.cursor++ % CHAT_LINES.length];
      const [my, ai] = s.languages;
      if (line.who === "ai") this.aiReply(lineIn(line.t, ai), my === ai ? null : lineIn(line.t, my));
      else if (line.split?.[my]) this.splitTurn(line.split[my]);
      else if (line.late) this.lateTurn(lineIn(line.t, my));
      else this.utter({ speaker: this.me, srcLang: my, text: lineIn(line.t, my), targets: {}, local: true, audioLang: ai });
      return;
    }
    // ROOM
    const present = this.visibleMembers();
    const line = ROOM_LINES[this.cursor++ % ROOM_LINES.length];
    let who = present[line.who % present.length] ?? present[0];
    // 我已静音：本该我说的句子改由下一位成员说
    if (this.muted && who.participantId === this.ticket!.participantId && present.length > 1) {
      who = present[(line.who + 1) % present.length];
    }
    const langs = [...new Set(present.map((p) => p.lang))].filter((l) => l !== who.lang);
    const targets = Object.fromEntries(langs.map((l) => [l, lineIn(line.t, l)]));
    this.utter({ speaker: { participantId: who.participantId, displayName: who.displayName, lang: who.lang }, srcLang: who.lang, text: lineIn(line.t, who.lang), targets, local: who.participantId === this.ticket!.participantId, audioLang: this.ticket!.lang, pause: line.pause });
  }

  private converseLine(side: "A" | "B", t: Record<string, string>, opts: { fast?: boolean } = {}) {
    const s = this.session!;
    const [a, b] = s.languages;
    const src = side === "A" ? a : b;
    const dst = side === "A" ? b : a;
    this.utter({ speaker: this.me, srcLang: src, text: lineIn(t, src), targets: { [dst]: lineIn(t, dst) }, local: true, audioLang: dst, skipPartial: opts.fast });
  }

  private onPtt(side: "A" | "B" | null) {
    const s = this.session!;
    if (s.mode !== "CONVERSE") return;
    if (side) {
      this.manual = true;
      this.pttSide = side;
      localSpeaking = true;
      return;
    }
    const pressed = this.pttSide;
    this.pttSide = null;
    localSpeaking = false;
    if (!pressed || this.busy) return;
    const lines = CONVERSE_LINES.filter((l) => l.side === pressed);
    const line = lines[this.pttLine[pressed]++ % lines.length];
    this.converseLine(pressed, line.t, { fast: true });
  }

  /* ---- AI 对话 ---- */

  private reply: { id: string; text: string; shown: string; timers: Set<ReturnType<typeof setTimeout>> } | null = null;
  private noiseAt = new Set<number>();
  /** 让位演示：AI 回复撤回后，等用户后半句说完再对整句回应 */
  private afterYield: (() => void) | null = null;

  /** AI 回复：流式 partial（累计）→ final → 母语字幕 → audio → metrics，全部带 role=assistant */
  private aiReply(text: string, subtitle: string | null, opts: { autoNext?: boolean } = {}) {
    const s = this.session!;
    const ai = s.languages[1];
    const id = `${this.ticket!.participantId}:${++this.n}`;
    const speaker: Speaker = { participantId: AI_SPEAKER_ID, displayName: "Lumi", lang: ai };
    const role = "assistant" as const;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const reply = { id, text, shown: "", timers };
    this.reply = reply;
    this.busy = true;
    const at = (ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        timers.delete(t);
        this.timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
      this.timers.add(t);
    };
    // 思考 1.1 s 后开始逐段出字
    let t = 1100;
    for (const p of prefixes(text, 6)) {
      t += 160;
      at(t, () => {
        reply.shown = p;
        this.emit({ type: "transcript.partial", utteranceId: id, speaker, role, text: p });
      });
    }
    t += 160;
    at(t, () => {
      reply.shown = text;
      this.emit({ type: "transcript.final", utteranceId: id, speaker, role, text, lang: ai, ttsFallback: false });
    });
    if (subtitle) {
      for (const d of deltas(subtitle, 4)) {
        t += 90;
        at(t, () => this.emit({ type: "translation.delta", utteranceId: id, speaker, role, lang: s.languages[0], delta: d }));
      }
      t += 60;
      at(t, () => this.emit({ type: "translation.final", utteranceId: id, speaker, role, lang: s.languages[0], text: subtitle, ttsFallback: false }));
    }
    // 播报：按文本长度给出 5–9 段 0.4 s 的音频
    const chunks = s.tts ? Math.min(9, Math.max(5, Math.round(Array.from(text).length / 14))) : 0;
    for (let i = 0; i < chunks; i++) {
      t += i === 0 ? 200 : 140;
      const last = i === chunks - 1;
      at(t, () => this.emit({ type: "audio", utteranceId: id, speaker, role, lang: ai, format: "pcm16", sampleRate: 24000, seq: i + 1, last, data: audioChunk() }));
    }
    t += 120;
    const e2e = 2100 + Math.round(Math.random() * 900);
    at(t, () => {
      s.utterances++;
      s.e2eSum += e2e;
      this.emit({ type: "metrics", utteranceId: id, speaker, role, asrMs: null, mtFirstMs: 1100, mtMs: 1800, ttsFirstMs: chunks ? 600 : null, e2eMs: e2e });
      this.reply = null;
      this.busy = false;
    });
    if (opts.autoNext !== false) at(t + chunks * 400 + 1600, () => this.next());
  }

  /** 回复让位：撤回尚未开播的回复（之后该 utteranceId 不再有事件），等用户说完再回应 */
  private onYield() {
    const r = this.reply;
    if (!r) return;
    r.timers.forEach((t) => {
      clearTimeout(t);
      this.timers.delete(t);
    });
    this.reply = null;
    this.busy = false;
    const ai = this.session!.languages[1];
    this.emit({ type: "transcript.discard", utteranceId: r.id, speaker: { participantId: AI_SPEAKER_ID, displayName: "Lumi", lang: ai }, role: "assistant" });
    const resume = this.afterYield;
    this.afterYield = null;
    resume?.();
  }

  /** 让位演示：用户说前半句 → 定稿 → AI 抢先开始回复 → 用户接着说后半句（客户端发 interrupt{yield}）→ AI 对整句回应 */
  private splitTurn([first, second]: [string, string]) {
    const s = this.session!;
    const [my, ai] = s.languages;
    const answer = CHAT_LINES[this.cursor % CHAT_LINES.length];
    this.utter({
      speaker: this.me,
      srcLang: my,
      text: first,
      targets: {},
      local: true,
      audioLang: ai,
      then: () => {
        this.aiReply(ai === "en" ? "Sure, one orange juice. Anything else?" : lineIn({ en: "Sure, one orange juice. Anything else?" }, ai), null, { autoNext: false });
        const secondId = `${this.ticket!.participantId}:${this.n + 1}`;
        this.afterYield = () =>
          this.utter({
            speaker: this.me,
            srcLang: my,
            text: second,
            targets: {},
            local: true,
            audioLang: ai,
            id: secondId,
            then: () => {
              this.cursor++;
              this.aiReply(lineIn(answer.t, ai), my === ai ? null : lineIn(answer.t, my));
            },
          });
        // AI 回复尚未开播时用户接着开口：后半句的第一个 partial（客户端据此判定让位并发 interrupt{yield}）
        this.later(1500, () => {
          if (!this.afterYield) return;
          localSpeaking = true;
          this.n++;
          this.emit({ type: "transcript.partial", utteranceId: secondId, speaker: this.me, text: Array.from(second).slice(0, 4).join("") });
        });
        // 客户端没有让位（如已开始播放、关闭了播报）：回复照常结束后用户再说后半句
        this.later(6000, () => {
          const resume = this.afterYield;
          this.afterYield = null;
          resume?.();
        });
      },
    });
  }

  /** 迟到演示：用户句的 utteranceId 先分配，AI 回复先出字，用户转写随后才到（应排在回复之前） */
  private lateTurn(text: string) {
    const s = this.session!;
    const [my, ai] = s.languages;
    const userId = `${this.ticket!.participantId}:${++this.n}`;
    const answer = CHAT_LINES[this.cursor % CHAT_LINES.length];
    this.cursor++;
    localSpeaking = true;
    this.later(1200, () => {
      localSpeaking = false;
      this.aiReply(lineIn(answer.t, ai), my === ai ? null : lineIn(answer.t, my));
    });
    this.later(1200 + 1600, () => {
      this.emit({ type: "transcript.final", utteranceId: userId, speaker: this.me, text, lang: my });
      this.emit({ type: "metrics", utteranceId: userId, speaker: this.me, asrMs: 380 });
    });
  }

  /** 噪声：一声咳嗽先被识别出零星文字，随后服务端判为语气词 / 噪声并撤回 */
  private noise(speaker: Speaker) {
    const s = this.session!;
    const id = `${speaker.participantId}:${++this.n}`;
    const local = speaker.participantId === this.ticket!.participantId;
    if (local) localSpeaking = true;
    if (s.mode === "ROOM") this.setSpeaking(speaker.participantId, true);
    this.later(300, () => this.emit({ type: "transcript.partial", utteranceId: id, speaker, text: "嗯", hold: true }));
    this.later(1100, () => {
      if (local) localSpeaking = false;
      if (s.mode === "ROOM") this.setSpeaking(speaker.participantId, false);
      this.emit({ type: "transcript.discard", utteranceId: id, speaker });
    });
    this.later(1700, () => this.next());
  }

  private onInterrupt() {
    const r = this.reply;
    if (!r) return;
    r.timers.forEach((t) => {
      clearTimeout(t);
      this.timers.delete(t);
    });
    this.reply = null;
    this.busy = false;
    const ai = this.session!.languages[1];
    const speaker: Speaker = { participantId: AI_SPEAKER_ID, displayName: "Lumi", lang: ai };
    if (r.shown && r.shown !== r.text) {
      this.emit({ type: "transcript.final", utteranceId: r.id, speaker, role: "assistant", text: r.shown, lang: ai });
    }
    this.emit({ type: "reply.interrupted", utteranceId: r.id, speaker, role: "assistant", text: r.shown });
    this.emit({ type: "metrics", utteranceId: r.id, speaker, role: "assistant", asrMs: null, mtFirstMs: 1100, mtMs: null, ttsFirstMs: null, e2eMs: null });
    this.later(1200, () => this.next());
  }

  private utter(u: {
    speaker: Speaker;
    srcLang: string;
    text: string;
    targets: Record<string, string>;
    local: boolean;
    audioLang: string;
    skipPartial?: boolean;
    /** 说到一半停顿 1 秒（服务端判为未说完：partial 带 hold，随后续说并入同一句） */
    pause?: boolean;
    /** 指定 utteranceId（已发出过 partial 的句子） */
    id?: string;
    /** 定稿后的回调（代替自动推进下一句） */
    then?: () => void;
  }) {
    const s = this.session!;
    const id = u.id ?? `${u.speaker.participantId}:${++this.n}`;
    const speaker = u.speaker;
    const parts = u.skipPartial ? [] : prefixes(u.text, u.pause ? 4 : 3);
    const STEP = 520;
    const PAUSE = 1000;
    this.busy = true;
    let t = 0;
    if (u.local && parts.length) localSpeaking = true;
    if (s.mode === "ROOM") this.setSpeaking(speaker.participantId, true);
    parts.forEach((p, i) => {
      t += STEP;
      const hold = !!u.pause && i === 1;
      this.later(t, () => {
        this.emit({ type: "transcript.partial", utteranceId: id, speaker, text: p, ...(hold ? { hold } : {}) });
        if (hold && u.local) localSpeaking = false;
      });
      if (hold) {
        t += PAUSE;
        if (u.local) this.later(t, () => (localSpeaking = true));
      }
    });
    t += STEP;
    const startedMs = Date.now() - s.startedAt;
    this.later(t, () => {
      if (u.local) localSpeaking = false;
      this.emit({ type: "transcript.final", utteranceId: id, speaker, text: u.text, lang: u.srcLang, startedMs, endedMs: startedMs + t });
    });
    if (u.then) {
      const then = u.then;
      this.later(t + 120, () => {
        this.emit({ type: "metrics", utteranceId: id, speaker, asrMs: 400 });
        this.busy = false;
        then();
      });
      return;
    }
    const targets = Object.entries(u.targets);
    t += 380;
    for (const [lang, text] of targets) {
      for (const d of deltas(text, 4)) {
        t += 110;
        this.later(t, () => this.emit({ type: "translation.delta", utteranceId: id, speaker, lang, delta: d }));
      }
      t += 60;
      this.later(t, () => this.emit({ type: "translation.final", utteranceId: id, speaker, lang, text, ttsFallback: false }));
    }
    const e2e = 1700 + Math.round(Math.random() * 1200);
    const hasAudio = s.tts && targets.some(([l]) => l === u.audioLang);
    if (hasAudio) {
      for (let i = 0; i < AUDIO_CHUNKS; i++) {
        t += i === 0 ? 220 : 160;
        const last = i === AUDIO_CHUNKS - 1;
        this.later(t, () => this.emit({ type: "audio", utteranceId: id, speaker, lang: u.audioLang, format: "pcm16", sampleRate: 24000, seq: i + 1, last, data: audioChunk() }));
      }
    }
    t += 120;
    this.later(t, () => {
      s.utterances++;
      s.e2eSum += e2e;
      this.emit({ type: "metrics", utteranceId: id, speaker, asrMs: 420 + Math.round(Math.random() * 200), mtFirstMs: 380, mtMs: 900, ttsFirstMs: hasAudio ? 520 : null, e2eMs: e2e });
      if (s.mode === "ROOM") this.setSpeaking(speaker.participantId, false);
      this.busy = false;
    });
    // 播报时长（4 × 0.4 s）+ 间隔后进入下一句；按键对话不自动推进
    const autoNext = !(s.mode === "CONVERSE" && s.routing === "ptt");
    if (autoNext) this.later(t + (hasAudio ? 1900 : 900) + 900, () => this.next());
  }
}
