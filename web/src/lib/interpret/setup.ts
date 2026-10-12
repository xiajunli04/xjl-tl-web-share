/**
 * 准备阶段：设置校验与创建请求组装（契约 §2.4 InterpretCreateRequest）。
 */
import type { EngineInfo, SpeechEngines } from "@/lib/api/speech";
import type { ChatScenario, InterpretCreateRequest, InterpretMode, LatencyMode } from "@/lib/api/interpret";

export interface SetupInput {
  mode: InterpretMode;
  engine: string;
  listenTarget: string;
  converseA: string;
  converseB: string;
  roomLang: string;
  /** CHAT：我的语言 / 对话语言 / 场景 */
  chatMyLang: string;
  chatAiLang: string;
  chatScenario: ChatScenario;
  displayName: string;
  glossaryIds: number[];
  domainHint: string;
  gender: "female" | "male";
  tts: boolean;
  headphone: boolean;
  converseAuto: boolean;
  ttsEngine?: string | null;
  /** 级联引擎的翻译模型；S2S 引擎忽略 */
  mtModelConfigId?: number | null;
  /** 响应速度（仅平台级联） */
  latencyMode?: LatencyMode;
}

/** 本次会话涉及的语言（顺序即契约中的 languages） */
export function setupLanguages(
  s: Pick<SetupInput, "mode" | "listenTarget" | "converseA" | "converseB" | "roomLang" | "chatMyLang" | "chatAiLang">,
): string[] {
  if (s.mode === "LISTEN") return [s.listenTarget];
  if (s.mode === "CONVERSE") return [s.converseA, s.converseB];
  if (s.mode === "CHAT") return [s.chatMyLang, s.chatAiLang];
  return [s.roomLang];
}

/** 引擎是否支持对话"自动"方向（仅级联；S2S 只支持按键说话） */
export function supportsAutoConverse(engine: EngineInfo | undefined | null): boolean {
  return !!engine && engine.autoConverse === true && engine.s2s !== true;
}

/** AI 对话的平台级联链路（识别 → 对话模型 → 合成） */
export const CHAT_ENGINE = "cascade";
/** AI 对话的实时语音模型（端到端，improve-speech-playback-latency D7） */
export const REALTIME_CHAT_ENGINE = "realtime-chat";
export const CHAT_ENGINES = [CHAT_ENGINE, REALTIME_CHAT_ENGINE] as const;

/** 是否平台级联引擎（术语库、翻译 / 回复模型、响应速度只对它生效） */
export function isCascade(engineId: string) {
  return engineId === CHAT_ENGINE;
}

/**
 * 当前模式可选的引擎：AI 对话取 chat 类别（平台级联 / 实时语音模型）；
 * 后端尚未提供 chat 类别时回退为 interpret 中的级联引擎。其余模式取 interpret 类别。
 */
export function engineListFor(mode: InterpretMode, engines: SpeechEngines | undefined | null): EngineInfo[] {
  if (!engines) return [];
  if (mode !== "CHAT") return engines.interpret ?? [];
  if (engines.chat?.length) return engines.chat;
  return (engines.interpret ?? []).filter((e) => e.id === CHAT_ENGINE);
}

/** 校验设置；返回中文错误文案，通过时返回 null */
export function validateSetup(s: SetupInput, engine: EngineInfo | undefined | null): string | null {
  if (s.mode === "CHAT" && !(CHAT_ENGINES as readonly string[]).includes(s.engine)) return "AI 对话仅支持平台级联或实时语音模型";
  if (!engine) return "请选择同传引擎";
  if (!engine.available) return engine.reason ?? "该引擎当前不可用";
  const langs = setupLanguages(s);
  if (langs.some((l) => !l)) return "请选择语言";
  if (s.mode === "CONVERSE" && s.converseA === s.converseB) return "双向对话的两种语言必须不同";
  const unsupported = langs.find((l) => !engine.languages.includes(l));
  if (unsupported) return `所选引擎不支持该语言（${unsupported}）`;
  return null;
}

/** 组装创建请求 */
export function buildCreateRequest(s: SetupInput, engine: EngineInfo | undefined | null): InterpretCreateRequest {
  const auto = s.mode === "CONVERSE" && s.converseAuto && supportsAutoConverse(engine);
  return {
    mode: s.mode,
    engine: s.engine,
    languages: setupLanguages(s),
    sourceHints: [],
    converseRouting: s.mode === "CONVERSE" ? (auto ? "auto" : "ptt") : undefined,
    // 实时语音模型不支持术语库（端到端模型不经过平台翻译）
    glossaryIds: s.engine === REALTIME_CHAT_ENGINE ? [] : s.glossaryIds,
    domainHint: s.domainHint.trim() || null,
    tts: s.tts,
    // 会议室各自使用自己的设备，默认全双工
    headphone: s.mode === "ROOM" ? true : s.headphone,
    gender: s.gender,
    voices: {},
    asrEngine: null,
    ttsEngine: s.ttsEngine ?? null,
    // 级联引擎可单独选择更快的对话模型做同传翻译；S2S 引擎由服务端取对应厂商的实时同传配置
    modelConfigId: s.engine === "cascade" ? (s.mtModelConfigId ?? null) : null,
    displayName: s.displayName.trim() || null,
    title: null,
    chatScenario: s.mode === "CHAT" ? s.chatScenario : null,
    latencyMode: isCascade(s.engine) ? (s.latencyMode ?? "balanced") : null,
  };
}

/** 半双工门控是否启用：单设备模式（LISTEN / CONVERSE）且未开耳机模式 */
export function halfDuplexEnabled(mode: InterpretMode, headphone: boolean) {
  return mode !== "ROOM" && !headphone;
}

/**
 * 择机开播（improve-speech-endpointing-and-live-ux D7）：半双工的收听 / 对话避免播报掐断正在说的话；
 * AI 对话不论是否戴耳机都不在用户说话时开口。会议室各自开播，不推迟。
 */
export function startGateEnabled(mode: InterpretMode, headphone: boolean) {
  return mode === "CHAT" || halfDuplexEnabled(mode, headphone);
}

/** 语气词（与服务端 app.speech.endpointing.FILLERS 一致）：中日韩按子串去除，拉丁语按词 */
const CJK_FILLERS = ["就是说", "那个", "就是", "嗯", "呃", "额", "啊", "哦", "唔", "噢", "呀", "えーと", "えっと", "ええと", "うーん", "あのー", "あの", "まあ", "えー", "ええ", "저기", "음", "어", "그", "아"];
const WORD_FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "er", "erm", "hmm", "hm", "mm", "ah", "oh", "eh"]);
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯]/gu;

/**
 * 有效语音（improve-speech-endpointing-and-live-ux D6）：去掉标点与语气词后，中日韩至少 2 个字，
 * 或至少 1 个长度 ≥ 2 的非语气词拉丁词，或含数字。咳嗽、"嗯""um" 不算——用于插话与让位的门槛。
 */
export function isMeaningfulSpeech(text: string | null | undefined): boolean {
  let s = text ?? "";
  for (const f of CJK_FILLERS) s = s.split(f).join(" ");
  if ((s.match(CJK_CHAR) ?? []).length >= 2) return true;
  if (/\d/.test(s)) return true;
  const words = s.replace(CJK_CHAR, " ").toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.some((w) => w.length >= 2 && !WORD_FILLERS.has(w));
}

/**
 * AI 对话的自动打断（插话）：只在耳机模式（全双工）下、AI 正在播报时、收到用户（非 AI）新的有效识别结果时触发。
 * 半双工下播报期间不上行音频，只能点「打断」。
 */
export function shouldAutoInterrupt(o: {
  mode: InterpretMode | null | undefined;
  role: "user" | "assistant" | undefined;
  headphone: boolean;
  playing: boolean;
  text?: string;
}): boolean {
  return o.mode === "CHAT" && o.role !== "assistant" && o.headphone && o.playing && isMeaningfulSpeech(o.text);
}
