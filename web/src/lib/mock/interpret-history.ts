/**
 * 同传历史 mock（NEXT_PUBLIC_MOCK_API=1）：只处理 GET 列表 / 详情 / 转写、PUT 收藏、DELETE；
 * 会话创建等 POST 接口由 lib/mock/interpret.ts 处理。
 */
import { ApiError, type RequestOptions } from "@/lib/http";
import type { PageResult } from "@/lib/api/types";
import type { InterpretSegmentVO, InterpretSessionVO } from "@/lib/api/interpret-history";

const iso = (offsetMin: number) => new Date(Date.now() - offsetMin * 60_000).toISOString();

type Line = [speaker: string, name: string, lang: string, text: string, translations: Record<string, string>];

function build(lines: Line[], startGapMs = 1200): InterpretSegmentVO[] {
  let t = startGapMs;
  return lines.map(([p, name, lang, text, translations], i) => {
    const dur = 1400 + text.length * 90;
    const seg: InterpretSegmentVO = {
      seq: i + 1,
      speakerParticipant: p,
      speakerName: name,
      sourceLang: lang,
      sourceText: text,
      translations,
      metrics: { e2eMs: 1900 + ((i * 377) % 900), asrMs: 320, mtMs: 900 },
      startedMs: t,
      endedMs: t + dur,
    };
    t += dur + 900 + ((i * 211) % 1500);
    return seg;
  });
}

const LISTEN: Line[] = [
  ["p1", "我", "en", "Good afternoon, everyone, and welcome to the product launch.", { zh: "大家下午好，欢迎来到产品发布会。" }],
  ["p1", "我", "en", "Today we are introducing a translation platform built on agents.", { zh: "今天我们要介绍一个基于智能体的翻译平台。" }],
  ["p1", "我", "en", "It supports live interpretation, image translation and document translation.", { zh: "它支持同声传译、图片翻译和文档翻译。" }],
  ["p1", "我", "en", "Terminology stays consistent thanks to the shared glossary.", { zh: "得益于共享术语库，术语始终保持一致。" }],
  ["p1", "我", "en", "Let's start with a short demo of the live mode.", { zh: "我们先简单演示一下同传模式。" }],
  ["p1", "我", "en", "Latency is usually around two seconds per sentence.", { zh: "每句话的延迟通常在两秒左右。" }],
];

const CONVERSE: Line[] = [
  ["A", "A 侧", "zh", "你好，请问去机场的大巴在哪里坐？", { en: "Hello, where can I take the airport bus?" }],
  ["B", "B 侧", "en", "It's right outside exit B, next to the taxi stand.", { zh: "就在 B 出口外面，出租车停靠点旁边。" }],
  ["A", "A 侧", "zh", "大概多久一班？", { en: "How often does it run?" }],
  ["B", "B 侧", "en", "Every twenty minutes until eleven at night.", { zh: "每二十分钟一班，一直到晚上十一点。" }],
  ["A", "A 侧", "zh", "车票可以在车上买吗？", { en: "Can I buy a ticket on the bus?" }],
  ["B", "B 侧", "en", "Yes, but card payment is faster at the machine.", { zh: "可以，不过在售票机刷卡更快。" }],
  ["A", "A 侧", "zh", "好的，非常感谢！", { en: "Great, thank you so much!" }],
];

const ROOM: Line[] = [
  ["p1", "主持人", "zh", "大家好，我们开始今天的周会。", { en: "Hello everyone, let's start today's weekly meeting.", ja: "皆さんこんにちは、今週の定例会議を始めます。" }],
  ["p2", "Alice", "en", "Thanks. The image translation module is ready for testing.", { zh: "谢谢。图片翻译模块已经可以测试了。", ja: "ありがとうございます。画像翻訳モジュールはテスト可能です。" }],
  ["p3", "佐藤", "ja", "評価データは三十枚準備しました。", { zh: "评测数据准备了三十张。", en: "I have prepared thirty images for evaluation." }],
  ["p1", "主持人", "zh", "很好，下周三之前完成第一轮评测。", { en: "Great, let's finish the first round of evaluation before next Wednesday.", ja: "いいですね、来週水曜日までに第一ラウンドの評価を終えましょう。" }],
  ["p2", "Alice", "en", "I'll share the results in the group chat.", { zh: "我会把结果发到群聊里。", ja: "結果はグループチャットで共有します。" }],
];

const CHAT: Line[] = [
  ["ai", "Lumi", "en", "Good evening, welcome to Lumi's Kitchen! Can I get you something to drink first?", { zh: "晚上好，欢迎光临 Lumi 小厨！要先来点喝的吗？" }],
  ["p1", "我", "zh", "我想要一杯橙汁，有不辣的菜推荐吗？", {}],
  ["ai", "Lumi", "en", "You could say: \"Could you recommend something mild?\" Our honey garlic chicken is mild and popular.", { zh: "你可以说：“Could you recommend something mild?” 我们的蜂蜜蒜香鸡不辣，也很受欢迎。" }],
  ["p1", "我", "en", "Okay, I'll have that, and a bowl of rice.", {}],
  ["ai", "Lumi", "en", "Great choice! It will be ready in about fifteen minutes.", { zh: "好选择！大约十五分钟就好。" }],
];

interface Stored {
  session: InterpretSessionVO;
  segments: InterpretSegmentVO[];
}

const store: Stored[] = [];

function seed() {
  if (store.length) return;
  const add = (s: Omit<InterpretSessionVO, "durationMs" | "endedAt" | "stats">, lines: Line[], participants: number) => {
    const segments = build(lines);
    const durationMs = (segments.at(-1)?.endedMs ?? 0) + 2400;
    const e2e = segments.map((x) => x.metrics?.e2eMs ?? 0);
    const langs = Array.from(new Set(segments.flatMap((x) => [x.sourceLang, ...Object.keys(x.translations)])));
    store.push({
      session: {
        ...s,
        durationMs,
        endedAt: new Date(new Date(s.startedAt).getTime() + durationMs).toISOString(),
        stats: {
          utterances: segments.length,
          avgE2eMs: Math.round(e2e.reduce((a, b) => a + b, 0) / e2e.length),
          p50E2eMs: [...e2e].sort((a, b) => a - b)[Math.floor(e2e.length / 2)],
          participants,
          languages: langs,
        },
      },
      segments,
    });
  };
  add({ id: 43, mode: "CHAT", engine: "cascade", languages: ["zh", "en"], roomCode: null, status: "ENDED", title: "AI 对话 · 英语", startedAt: iso(20), favorite: false, options: { chatScenario: "restaurant", tts: true } }, CHAT, 1);
  add({ id: 42, mode: "ROOM", engine: "cascade", languages: ["zh"], roomCode: "K7M2QX", status: "ENDED", title: "会议室 K7M2QX", startedAt: iso(55), favorite: true, options: { tts: true } }, ROOM, 3);
  add({ id: 41, mode: "CONVERSE", engine: "cascade", languages: ["zh", "en"], roomCode: null, status: "ENDED", title: "双向对话 · 中文 ⇄ 英语", startedAt: iso(60 * 6), favorite: false, options: { converseRouting: "auto" } }, CONVERSE, 1);
  add({ id: 40, mode: "LISTEN", engine: "qwen-livetranslate", languages: ["zh"], roomCode: null, status: "ENDED", title: "同传收听 · 中文", startedAt: iso(60 * 30), favorite: false, options: { tts: true, headphone: true } }, LISTEN, 1);
}

function find(id: number) {
  seed();
  const s = store.find((x) => x.session.id === id);
  if (!s) throw new ApiError("A0404", "资源不存在", undefined, 404);
  return s;
}

function page<T>(rows: T[], q: RequestOptions["query"], maxSize = 100): PageResult<T> {
  const pageNum = Number(q?.pageNum ?? 1);
  const pageSize = Math.min(maxSize, Number(q?.pageSize ?? 10));
  return { records: rows.slice((pageNum - 1) * pageSize, pageNum * pageSize), total: rows.length, pageNum, pageSize };
}

/** 返回 undefined 表示不由本模块处理（例如 POST，交给 lib/mock/interpret.ts） */
export async function mockInterpretHistory<T>(path: string, opts: RequestOptions): Promise<{ data: T } | undefined> {
  const method = opts.method ?? "GET";
  if (method === "POST") return undefined;
  seed();
  const q = opts.query ?? {};
  const r = (v: unknown) => ({ data: v as T });
  let m: RegExpMatchArray | null;
  if (path === "/api/interpret/sessions/active" && method === "GET") return r(null);
  if (path === "/api/interpret/sessions" && method === "GET") {
    const kw = String(q.keyword ?? "").trim().toLowerCase();
    let rows = store.filter(
      (x) =>
        !kw ||
        (x.session.title ?? "").toLowerCase().includes(kw) ||
        x.segments.some((s) => [s.sourceText, ...Object.values(s.translations)].some((t) => t.toLowerCase().includes(kw))),
    );
    if (q.mode) rows = rows.filter((x) => x.session.mode === q.mode);
    if (String(q.favorite) === "true") rows = rows.filter((x) => x.session.favorite);
    return r(page(rows.map((x) => x.session), q));
  }
  if ((m = path.match(/^\/api\/interpret\/sessions\/(\d+)$/))) {
    const s = find(Number(m[1]));
    if (method === "DELETE") {
      store.splice(store.indexOf(s), 1);
      return r(null);
    }
    if (method === "GET") return r(s.session);
  }
  if ((m = path.match(/^\/api\/interpret\/sessions\/(\d+)\/segments$/)) && method === "GET") {
    return r(page(find(Number(m[1])).segments, q, 100));
  }
  if ((m = path.match(/^\/api\/interpret\/sessions\/(\d+)\/favorite$/)) && method === "PUT") {
    find(Number(m[1])).session.favorite = !!(opts.body as { favorite?: boolean } | undefined)?.favorite;
    return r(null);
  }
  return undefined;
}
