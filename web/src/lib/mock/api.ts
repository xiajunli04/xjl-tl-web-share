/**
 * 开发用 REST mock（NEXT_PUBLIC_MOCK_API=1）：内存数据，刷新页面即重置。
 * 仅用于后端未就绪时自查页面与交互，生产构建不会包含该模块。
 */
import { ApiError, type RequestOptions } from "@/lib/http";
import type {
  LoginLogVO,
  LoginResult,
  ModelConfigVO,
  OperationLogVO,
  PageResult,
  UserInfo,
} from "@/lib/api/types";
import type { DetectResult, Language, ModelOption } from "@/lib/api/translate";
import type { GlossaryVO, ImportPreview, TermVO } from "@/lib/api/glossaries";
import type { TranslationDetailVO, TranslationSummaryVO } from "@/lib/api/history";
import { CAPABILITY_LABEL, isAllowedCombination } from "@/lib/model-capability";

const BOM = new RegExp("^" + String.fromCharCode(0xfeff));
const now = Date.now();
const iso = (offsetMin: number) => new Date(now - offsetMin * 60_000).toISOString();

function fakeJwt() {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64({ sub: "1", exp: Math.floor(Date.now() / 1000) + 7200 })}.mock`;
}

export const LANGUAGES: Language[] = [
  { code: "zh", name: "中文", nativeName: "中文" },
  { code: "en", name: "英语", nativeName: "English" },
  { code: "ja", name: "日语", nativeName: "日本語" },
  { code: "ko", name: "韩语", nativeName: "한국어" },
  { code: "fr", name: "法语", nativeName: "Français" },
  { code: "de", name: "德语", nativeName: "Deutsch" },
  { code: "es", name: "西班牙语", nativeName: "Español" },
  { code: "ru", name: "俄语", nativeName: "Русский" },
  { code: "pt", name: "葡萄牙语", nativeName: "Português" },
  { code: "it", name: "意大利语", nativeName: "Italiano" },
  { code: "ar", name: "阿拉伯语", nativeName: "العربية" },
  { code: "th", name: "泰语", nativeName: "ไทย" },
  { code: "vi", name: "越南语", nativeName: "Tiếng Việt" },
  { code: "id", name: "印尼语", nativeName: "Bahasa Indonesia" },
  { code: "tr", name: "土耳其语", nativeName: "Türkçe" },
];

const admin: UserInfo = {
  id: 1,
  username: "admin",
  nickname: "系统管理员",
  email: "admin@example.com",
  status: "ENABLED",
  roles: ["ADMIN", "USER"],
  lastLoginAt: iso(5),
  createdAt: iso(60 * 24 * 30),
};

const users: UserInfo[] = [
  admin,
  ...["alice", "bob", "carol", "david", "erin", "frank", "grace"].map((u, i) => ({
    id: i + 2,
    username: u,
    nickname: ["爱丽丝", "鲍勃", "卡罗尔", "大卫", "艾琳", "弗兰克", "格蕾丝"][i],
    email: `${u}@example.com`,
    status: (i === 3 ? "DISABLED" : "ENABLED") as UserInfo["status"],
    roles: (i === 0 ? ["ADMIN", "USER"] : ["USER"]) as UserInfo["roles"],
    lastLoginAt: i === 5 ? null : iso(60 * (i + 1) * 3),
    createdAt: iso(60 * 24 * (20 - i)),
  })),
];

const models: ModelConfigVO[] = [
  {
    id: 1,
    name: "DeepSeek Chat",
    provider: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.deepseek.com/v1",
    modelName: "deepseek-chat",
    apiKeyMask: "sk-****a1b2",
    params: { temperature: 0.3, maxTokens: 2048, timeoutSeconds: 60 },
    isDefault: true,
    isReviewDefault: false,
    enabled: true,
    remark: "主力翻译模型",
    createdAt: iso(60 * 24 * 10),
    updatedAt: iso(60 * 5),
  },
  {
    id: 2,
    name: "Claude Sonnet",
    provider: "ANTHROPIC",
    supportsVision: true,
    baseUrl: "https://api.anthropic.com",
    modelName: "claude-sonnet-4-5",
    apiKeyMask: "sk-ant-****9f0e",
    params: { temperature: 0.2, maxTokens: 4096, timeoutSeconds: 90 },
    isDefault: false,
    isReviewDefault: true,
    enabled: true,
    remark: "评审模型",
    createdAt: iso(60 * 24 * 8),
    updatedAt: iso(60 * 30),
  },
  {
    id: 3,
    name: "Qwen-MT Turbo",
    provider: "OPENAI_COMPATIBLE",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelName: "qwen-mt-turbo",
    apiKeyMask: "sk-****77cd",
    params: { temperature: 0.1 },
    isDefault: false,
    enabled: false,
    remark: null,
    createdAt: iso(60 * 24 * 3),
    updatedAt: iso(60 * 24),
  },
  // add-speech-and-image-translation：不同能力类型的样例
  {
    id: 4,
    name: "GPT-5.6 Luna（视觉）",
    capability: "CHAT",
    provider: "OPENAI_COMPATIBLE",
    supportsVision: true,
    baseUrl: "https://subapi.orzle.xyz/v1",
    modelName: "gpt-5.6-luna",
    apiKeyMask: "sk-****luna",
    params: { temperature: 0.2, maxTokens: 4096, timeoutSeconds: 120 },
    isDefault: false,
    isReviewDefault: false,
    enabled: true,
    remark: "图片翻译 OCR（支持图片输入）",
    createdAt: iso(60 * 24 * 2),
    updatedAt: iso(60 * 3),
  },
  {
    id: 21,
    name: "Whisper 转写",
    capability: "ASR",
    provider: "OPENAI_COMPATIBLE",
    baseUrl: "https://subapi.orzle.xyz/v1",
    modelName: "whisper-1",
    apiKeyMask: "sk-****wh1r",
    params: { timeoutSeconds: 60 },
    isDefault: true,
    enabled: true,
    remark: null,
    createdAt: iso(60 * 24 * 2),
    updatedAt: iso(60 * 20),
  },
  {
    id: 22,
    name: "OpenAI 语音合成",
    capability: "TTS",
    provider: "OPENAI_COMPATIBLE",
    baseUrl: "https://api.openai.com/v1",
    modelName: "gpt-4o-mini-tts",
    apiKeyMask: "sk-****tts0",
    params: { timeoutSeconds: 30, extra: { voice: "alloy" } },
    isDefault: false,
    enabled: false,
    remark: "暂无密钥，播报默认使用 edge-tts",
    createdAt: iso(60 * 24),
    updatedAt: iso(60 * 24),
  },
  {
    id: 12,
    name: "千问同传 3.8",
    capability: "REALTIME_TRANSLATE",
    provider: "DASHSCOPE",
    baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    modelName: "qwen3.8-livetranslate-flash-realtime",
    apiKeyMask: "sk-****ds38",
    params: { timeoutSeconds: 30, extra: { voice: "Tina" } },
    isDefault: true,
    enabled: true,
    remark: "已实测：句末约 0.8 s 定稿",
    createdAt: iso(60 * 24),
    updatedAt: iso(60 * 2),
  },
  {
    id: 13,
    name: "豆包同传 2.0",
    capability: "REALTIME_TRANSLATE",
    provider: "VOLCENGINE",
    baseUrl: "wss://openspeech.bytedance.com/api/v4/ast/v2/translate",
    modelName: "seed-liveinterpret-2.0",
    apiKeyMask: "****",
    params: { extra: { appId: "8888888888" } },
    isDefault: false,
    enabled: false,
    remark: "可选引擎，暂无密钥",
    createdAt: iso(60 * 20),
    updatedAt: iso(60 * 20),
  },
  {
    id: 6,
    name: "千问图片翻译",
    capability: "IMAGE_TRANSLATE",
    provider: "DASHSCOPE",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    modelName: "qwen-mt-image-2.0",
    apiKeyMask: "sk-****mt2i",
    params: { timeoutSeconds: 60 },
    isDefault: false,
    enabled: false,
    remark: "需公网图床时不可用",
    createdAt: iso(60 * 18),
    updatedAt: iso(60 * 18),
  },
];

let glossaries: GlossaryVO[] = [
  {
    id: 7,
    name: "AI 与计算机术语",
    description: "机器学习、硬件相关的常用译法",
    sourceLang: "en",
    targetLang: "zh",
    domain: "计算机",
    scope: "PRIVATE",
    termCount: 6,
    ownerId: 1,
    ownerName: "admin",
    editable: true,
    createdAt: iso(60 * 24 * 6),
    updatedAt: iso(60 * 2),
  },
  {
    id: 8,
    name: "医学基础词汇",
    description: "临床与药理常见术语",
    sourceLang: "en",
    targetLang: "zh",
    domain: "医学",
    scope: "PRIVATE",
    termCount: 3,
    ownerId: 1,
    ownerName: "admin",
    editable: true,
    createdAt: iso(60 * 24 * 4),
    updatedAt: iso(60 * 20),
  },
  {
    id: 9,
    name: "日语游戏本地化",
    description: null,
    sourceLang: "en",
    targetLang: "ja",
    domain: "游戏",
    scope: "PUBLIC",
    termCount: 2,
    ownerId: 2,
    ownerName: "alice",
    editable: false,
    createdAt: iso(60 * 24 * 9),
    updatedAt: iso(60 * 24 * 2),
  },
  {
    id: 10,
    name: "法律合同通用表达",
    description: "合同条款高频短语",
    sourceLang: "zh",
    targetLang: "en",
    domain: "法律",
    scope: "PUBLIC",
    termCount: 0,
    ownerId: 1,
    ownerName: "admin",
    editable: true,
    createdAt: iso(60 * 24 * 12),
    updatedAt: iso(60 * 24 * 12),
  },
];

const terms: Record<number, TermVO[]> = {
  7: [
    ["GPU", "图形处理器", "不要译作“显卡”", true],
    ["machine learning", "机器学习", null, false],
    ["neural network", "神经网络", null, false],
    ["inference", "推理", "模型推理场景", false],
    ["fine-tuning", "微调", null, false],
    ["token", "词元", "LLM 语境", false],
  ].map(([s, t, n, c], i) => ({
    id: 100 + i,
    sourceTerm: s as string,
    targetTerm: t as string,
    note: n as string | null,
    caseSensitive: c as boolean,
    updatedAt: iso(60 * (i + 1)),
  })),
  8: [
    ["hypertension", "高血压"],
    ["antibiotic", "抗生素"],
    ["placebo", "安慰剂"],
  ].map(([s, t], i) => ({
    id: 200 + i,
    sourceTerm: s,
    targetTerm: t,
    note: null,
    caseSensitive: false,
    updatedAt: iso(60 * (i + 3)),
  })),
  9: [
    ["health potion", "回復薬", null],
    ["quest", "クエスト", null],
  ].map(([s, t], i) => ({
    id: 300 + i,
    sourceTerm: s as string,
    targetTerm: t as string,
    note: null,
    caseSensitive: false,
    updatedAt: iso(60 * 24),
  })),
  10: [],
};

const traceStandard: TranslationDetailVO["traces"] = [
  [1, "analyze", "completed", "识别为英语（99%），命中 2 条术语，跳过 1 个语言对不符的术语库", 35, 0, 0],
  [2, "plan", "completed", "标准路径 · 计算机", 2410, 120, 8],
  [3, "retrieve", "completed", "上下文包：2 条术语，领域=计算机，风格=忠实", 2, 0, 0],
  [4, "translate", "completed", "首译完成", 3120, 310, 22],
  [5, "review", "completed", "第 0 轮评审 72 分，未通过（1 个问题）", 2890, 420, 60],
  [6, "refine", "completed", "第 1 轮修正完成", 2950, 460, 24],
  [7, "review", "completed", "第 1 轮评审 93 分，通过", 2610, 430, 20],
  [8, "finalize", "completed", "术语遵循 2/2", 1, 0, 0],
].map(([seq, node, status, summary, latencyMs, p, c]) => ({
  seq: seq as number,
  node: node as TranslationDetailVO["traces"][number]["node"],
  status: status as "completed",
  summary: summary as string,
  detail:
    node === "review"
      ? { score: seq === 5 ? 72 : 93, issues: seq === 5 ? [{ category: "terminology", severity: "major", span: "显卡", suggestion: "术语 GPU 应译为“图形处理器”" }] : [] }
      : node === "plan"
        ? { path: "standard", domain: "计算机", reason: "命中 2 条术语，选择标准路径；领域判定为计算机" }
        : { note: "mock" },
  latencyMs: latencyMs as number,
  promptTokens: p as number,
  completionTokens: c as number,
}));

const traceFast: TranslationDetailVO["traces"] = [
  { seq: 1, node: "analyze", status: "completed", summary: "识别为英语（97%），未选择术语库", detail: null, latencyMs: 12, promptTokens: 0, completionTokens: 0 },
  { seq: 2, node: "plan", status: "completed", summary: "快速路径", detail: { path: "fast" }, latencyMs: 1, promptTokens: 0, completionTokens: 0 },
  { seq: 3, node: "retrieve", status: "skipped", summary: "快速路径跳过", detail: null, latencyMs: null, promptTokens: null, completionTokens: null },
  { seq: 4, node: "translate", status: "completed", summary: "首译完成", detail: null, latencyMs: 1830, promptTokens: 96, completionTokens: 4 },
  { seq: 5, node: "review", status: "skipped", summary: "快速路径跳过", detail: null, latencyMs: null, promptTokens: null, completionTokens: null },
  { seq: 6, node: "refine", status: "skipped", summary: "快速路径跳过", detail: null, latencyMs: null, promptTokens: null, completionTokens: null },
  { seq: 7, node: "finalize", status: "completed", summary: "无术语需校验", detail: null, latencyMs: 1, promptTokens: 0, completionTokens: 0 },
];

const historySeed: [string, string, string, string, "fast" | "standard", number | null][] = [
  ["Machine learning models\nare usually trained on GPUs.", "机器学习模型\n通常在 图形处理器上训练。", "en", "zh", "standard", 93],
  ["Good morning", "早上好", "en", "zh", "fast", null],
  ["卷积神经网络在图像识别任务上表现出色。", "Convolutional neural networks excel at image recognition tasks.", "zh", "en", "standard", 90],
  ["The patient was prescribed antibiotics for the infection.", "患者因感染被开具了抗生素。", "en", "zh", "standard", 88],
  ["今日はいい天気ですね。", "今天天气真好啊。", "ja", "zh", "fast", null],
  ["Bonjour, comment allez-vous ?", "你好，您好吗？", "fr", "zh", "fast", null],
  ["Please keep {name} and %d unchanged in the output.", "请在输出中保持 {name} 和 %d 不变。", "en", "zh", "standard", 95],
  ["Fine-tuning improves inference quality on domain data.", "微调可以提升模型在领域数据上的推理质量。", "en", "zh", "standard", 86],
  ["Der Vertrag tritt mit Unterzeichnung in Kraft.", "合同自签署之日起生效。", "de", "zh", "standard", 91],
];

let history: TranslationDetailVO[] = historySeed.map(([s, t, sl, tl, path, score], i) => ({
  id: 102 - i,
  sourceText: s,
  targetText: t,
  sourceLang: sl,
  targetLang: tl,
  detectedLang: sl,
  path,
  mode: "auto",
  style: "faithful",
  domain: path === "standard" ? "计算机" : "通用",
  glossaryIds: path === "standard" ? [7] : [],
  modelConfigId: 1,
  reviewScore: score,
  reviewRounds: i === 0 ? 1 : 0,
  favorite: i % 3 === 0,
  compliance:
    i === 0
      ? [
          { source: "GPU", target: "图形处理器", compliant: true },
          { source: "machine learning", target: "机器学习", compliant: true },
        ]
      : i === 7
        ? [
            { source: "fine-tuning", target: "微调", compliant: true },
            { source: "inference", target: "推理", compliant: true },
          ]
        : [],
  termHits:
    i === 0
      ? [
          { source: "GPU", target: "图形处理器", glossaryId: 7 },
          { source: "machine learning", target: "机器学习", glossaryId: 7 },
        ]
      : [],
  promptTokens: path === "standard" ? 1740 : 96,
  completionTokens: path === "standard" ? 134 : 4,
  latencyMs: path === "standard" ? 14050 - i * 400 : 1880,
  createdAt: iso(i * 95 + 3),
  traces: path === "standard" ? traceStandard : traceFast,
}));

const loginLogs: LoginLogVO[] = Array.from({ length: 23 }).map((_, i) => ({
  id: 500 - i,
  userId: i % 5 === 3 ? null : (i % 4) + 1,
  username: ["admin", "alice", "bob", "unknown", "carol"][i % 5],
  ip: `192.168.1.${10 + i}`,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  success: i % 5 !== 3,
  failReason: i % 5 === 3 ? "用户名或密码错误" : null,
  createdAt: iso(i * 47),
}));

const opLogs: OperationLogVO[] = Array.from({ length: 18 }).map((_, i) => ({
  id: 900 - i,
  userId: 1,
  username: "admin",
  module: ["用户管理", "模型配置", "模型配置", "用户管理"][i % 4],
  action: ["禁用用户", "新建模型配置", "测试连通性", "分配角色"][i % 4],
  method: ["PUT", "POST", "POST", "PUT"][i % 4],
  path: ["/api/admin/users/4/status", "/api/admin/model-configs", "/api/admin/model-configs/1/test", "/api/admin/users/2/roles"][i % 4],
  params:
    i % 4 === 1
      ? JSON.stringify({ name: "DeepSeek Chat", provider: "OPENAI_COMPATIBLE", baseUrl: "https://api.deepseek.com/v1", modelName: "deepseek-chat", apiKey: "******", params: { temperature: 0.3, maxTokens: 2048 } })
      : JSON.stringify({ status: "DISABLED" }),
  resultCode: i % 6 === 5 ? "A0410" : "00000",
  durationMs: 12 + i * 7,
  ip: "127.0.0.1",
  traceId: `7f3a${(1000 + i).toString(16)}c9e2b4d1`,
  createdAt: iso(i * 63),
}));

let systemTick = 0;

function page<T>(rows: T[], q?: RequestOptions["query"]): PageResult<T> {
  const pageNum = Number(q?.pageNum ?? 1);
  const pageSize = Number(q?.pageSize ?? 10);
  return {
    records: rows.slice((pageNum - 1) * pageSize, pageNum * pageSize),
    total: rows.length,
    pageNum,
    pageSize,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kw = (q: RequestOptions["query"]) => String(q?.keyword ?? q?.username ?? "").toLowerCase();

function detect(text: string): DetectResult {
  const t = text.trim();
  if (!t) throw new ApiError("A0410", "文本不能为空", undefined, 400);
  let lang = "en";
  if (/[぀-ヿ]/.test(t)) lang = "ja";
  else if (/[가-힯]/.test(t)) lang = "ko";
  else if (/[一-鿿]/.test(t)) lang = "zh";
  else if (/[Ѐ-ӿ]/.test(t)) lang = "ru";
  else if (/[؀-ۿ]/.test(t)) lang = "ar";
  else if (/[฀-๿]/.test(t)) lang = "th";
  else if (/\b(le|la|les|est|bonjour|vous|et)\b/i.test(t)) lang = "fr";
  else if (/\b(der|die|das|und|ist|mit)\b/i.test(t)) lang = "de";
  const short = t.length < 4;
  const confidence = short ? 0.62 : 0.9 + Math.min(t.length, 90) / 1000;
  return {
    lang,
    confidence,
    method: short ? "llm" : "lingua",
    candidates: [
      { lang, confidence },
      { lang: lang === "en" ? "fr" : "en", confidence: (1 - confidence) * 0.7 },
      { lang: lang === "zh" ? "ja" : "de", confidence: (1 - confidence) * 0.3 },
    ],
  };
}

/** 会话内记录（mock 会话写入）同步进历史：已同步过的只更新采用标记 */
async function syncSessionHistory() {
  const store = await import("./session-store");
  store.listSessions({});
  for (const rec of store.records) {
    const ex = history.find((h) => h.id === rec.id);
    if (ex) {
      ex.adopted = rec.adopted;
      continue;
    }
    history.unshift({
      id: rec.id,
      sourceText: rec.sourceText,
      targetText: rec.targetText,
      sourceLang: rec.sourceLang,
      targetLang: rec.targetLang,
      detectedLang: rec.sourceLang,
      path: rec.path as TranslationDetailVO["path"],
      mode: rec.path === "revise" ? ("revise" as TranslationDetailVO["mode"]) : "auto",
      style: rec.style,
      domain: "通用",
      glossaryIds: [],
      modelConfigId: 1,
      reviewScore: rec.reviewScore,
      reviewRounds: 0,
      favorite: false,
      compliance: [],
      termHits: [],
      promptTokens: rec.path === "standard" ? 1200 : 160,
      completionTokens: rec.targetText.length * 2,
      latencyMs: rec.path === "standard" ? 6200 : 1880,
      createdAt: rec.createdAt,
      sessionId: rec.sessionId,
      revisionOf: rec.revisionOf,
      reviseInstruction: rec.reviseInstruction,
      clarification: rec.clarification,
      adopted: rec.adopted,
      traces: sessionTraces(rec),
    });
  }
  history.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function sessionTraces(rec: { path: string; clarification: unknown }): TranslationDetailVO["traces"] {
  const t = (seq: number, node: string, status: string, summary: string, latencyMs: number | null, detail: unknown = null) => ({
    seq,
    node: node as TranslationDetailVO["traces"][number]["node"],
    status: status as "completed",
    summary,
    detail,
    latencyMs,
    promptTokens: latencyMs ? 120 : null,
    completionTokens: latencyMs ? 24 : null,
  });
  if (rec.path === "revise") {
    return [
      t(1, "analyze", "completed", "修订：沿用原记录语种", 12),
      t(2, "plan", "completed", "修订路径", 2, { path: "revise" }),
      t(3, "retrieve", "skipped", "修订路径跳过", null),
      t(4, "translate", "completed", "按修订要求改写完成", 1650),
      t(5, "review", "skipped", "修订路径跳过", null),
      t(6, "refine", "skipped", "修订路径跳过", null),
      t(7, "finalize", "completed", "无术语需校验", 1),
    ];
  }
  const list = [t(1, "analyze", "completed", "识别为英语（98%）", 14), t(2, "plan", "completed", "标准路径 · 通用", 1820)];
  if (rec.clarification) list.push(t(3, "clarify", "completed", "用户澄清后继续", 3, rec.clarification));
  const n = list.length;
  list.push(
    t(n + 1, "retrieve", "completed", "上下文包：会话上下文 2 轮", 46, { tmHits: [], sessionTurns: 2 }),
    t(n + 2, "translate", "completed", "首译完成", 1650),
    t(n + 3, "review", "completed", "第 0 轮评审 92 分，通过", 2100, { score: 92, issues: [] }),
    t(n + 4, "finalize", "completed", "无术语需校验", 1),
  );
  return list;
}

function summary(d: TranslationDetailVO): TranslationSummaryVO {
  return {
    id: d.id,
    sourcePreview: d.sourceText.slice(0, 120),
    targetPreview: d.targetText.slice(0, 120),
    sourceLang: d.sourceLang,
    targetLang: d.targetLang,
    path: d.path,
    reviewScore: d.reviewScore,
    favorite: d.favorite,
    latencyMs: d.latencyMs,
    createdAt: d.createdAt,
    sessionId: d.sessionId ?? null,
    revisionOf: d.revisionOf ?? null,
    reviseInstruction: d.reviseInstruction ?? null,
    clarification: d.clarification ?? null,
    adopted: d.adopted ?? null,
  };
}

function bodyOf<T>(opts: RequestOptions): T {
  return (opts.body ?? {}) as T;
}

/** 能力与提供方组合校验（design D12），非法组合返回 A0410 */
function checkCombination(b: Partial<ModelConfigVO>) {
  const capability = b.capability ?? "CHAT";
  const provider = b.provider ?? "OPENAI_COMPATIBLE";
  if (!isAllowedCombination(capability, provider)) {
    throw new ApiError("A0410", `能力「${CAPABILITY_LABEL[capability]}」不支持提供方 ${provider}`, "mock-a0410", 400);
  }
}

export async function mockRequest<T>(path: string, opts: RequestOptions): Promise<T> {
  await sleep(250 + Math.random() * 350);
  const method = opts.method ?? "GET";
  const q = opts.query;
  const r = (v: unknown) => v as T;
  let m: RegExpMatchArray | null;

  /* ---- 文档任务（lib/mock/doc-engine.ts） ---- */
  if (path.startsWith("/api/doc-tasks")) {
    const { mockDocRequest } = await import("./doc-engine");
    const res = await mockDocRequest(path, opts);
    if (res) return r(res.data);
  }

  // 演示错误状态：关键词为 "error" 时返回 B0001
  if (q?.keyword === "error") throw new ApiError("B0001", "系统执行出错", "mock-7c1e9a0b42f3", 500);

  /* ---- 认证 ---- */
  if (path === "/api/auth/login" || path === "/api/auth/refresh") {
    const res: LoginResult = { accessToken: fakeJwt(), refreshToken: "mock-refresh", expiresIn: 7200, user: admin };
    return r(res);
  }
  if (path === "/api/auth/logout") return r(null);
  if (path === "/api/auth/me") return r(admin);
  if (path === "/api/users/me" && method === "PUT") {
    Object.assign(admin, bodyOf<Partial<UserInfo>>(opts));
    return r(admin);
  }
  if (path === "/api/users/me/password") return r(null);

  /* ---- 翻译 ---- */
  if (path === "/api/translate/languages") return r(LANGUAGES);
  if (path === "/api/translate/detect") return r(detect(bodyOf<{ text: string }>(opts).text));
  if (path === "/api/model-configs/options") {
    const capability = String(q?.capability ?? "CHAT");
    const opts2: ModelOption[] = models
      .filter((x) => x.enabled && (x.capability ?? "CHAT") === capability)
      .filter((x) => String(q?.vision) !== "true" || !!x.supportsVision)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      .map(({ id, name, provider, isDefault, isReviewDefault, supportsVision }) => ({
        id, name, provider, isDefault, isReviewDefault: !!isReviewDefault, capability: capability as ModelOption["capability"],
        supportsVision: !!supportsVision,
      }));
    return r(opts2);
  }

  /* ---- 语音（lib/mock/speech.ts） ---- */
  if (path.startsWith("/api/speech/")) {
    const { mockSpeech } = await import("./speech");
    return mockSpeech<T>(path, opts);
  }

  /* ---- 同传（lib/mock/interpret.ts）：只拦截 POST 创建 / 加入 / 票据 / 结束，历史 GET/PUT/DELETE 放行 ---- */
  if (
    method === "POST" &&
    /^\/api\/interpret\/(sessions(\/\d+\/(ticket|end))?|rooms\/[^/]+\/join)$/.test(path)
  ) {
    const { mockInterpret } = await import("./interpret");
    return mockInterpret<T>(path, opts);
  }

  /* ---- 图片翻译（lib/mock/image.ts） ---- */
  if (path.startsWith("/api/image-translations")) {
    const { mockImageRequest } = await import("./image");
    return mockImageRequest<T>(path, opts);
  }
  /* ---- 同传历史（lib/mock/interpret-history.ts，只处理 GET / PUT / DELETE） ---- */
  if (path.startsWith("/api/interpret/sessions") && method !== "POST") {
    const { mockInterpretHistory } = await import("./interpret-history");
    const res = await mockInterpretHistory<T>(path, opts);
    if (res) return res.data;
  }

  /* ---- 解读（lib/mock/insights.ts） ---- */
  if (path.startsWith("/api/translations/insights")) {
    const { mockInsightsRequest } = await import("./insights");
    return mockInsightsRequest<T>(path, opts);
  }

  /* ---- 会话（lib/mock/session-store.ts） ---- */
  if (path.startsWith("/api/translate/sessions") || path.startsWith("/api/tm")) {
    const store = await import("./session-store");
    if (path === "/api/translate/sessions" && method === "GET") return r(store.listSessions(q ?? {}));
    if (path === "/api/translate/sessions" && method === "POST") {
      return r(store.createSession(bodyOf<Parameters<typeof store.createSession>[0]>(opts)));
    }
    if ((m = path.match(/^\/api\/translate\/sessions\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === "DELETE") {
        store.deleteSession(id);
        return r(null);
      }
      if (method === "PUT") return r(store.updateSession(id, bodyOf(opts)));
      return r(store.detailOf(store.getSession(id)));
    }
    if ((m = path.match(/^\/api\/translate\/sessions\/(\d+)\/records\/(\d+)\/adopt$/))) {
      return r(store.adoptRecord(Number(m[1]), Number(m[2])));
    }
    /* ---- 翻译记忆 ---- */
    if (path === "/api/tm" && method === "GET") return r(store.listTm(q ?? {}));
    if ((m = path.match(/^\/api\/tm\/(\d+)$/)) && method === "DELETE") {
      store.deleteTm(Number(m[1]));
      return r(null);
    }
    if ((m = path.match(/^\/api\/tm\/from-record\/(\d+)$/))) {
      const id = Number(m[1]);
      const rec = store.findRecord(id) ?? history.find((h) => h.id === id);
      if (!rec) throw new ApiError("A0404", "记录不存在", "mock-a0404", 404);
      const sourceLang = "detectedLang" in rec && rec.detectedLang ? rec.detectedLang : rec.sourceLang === "auto" ? store.detectLang(rec.sourceText) : rec.sourceLang;
      return r(
        store.upsertTm([
          { sourceLang, targetLang: rec.targetLang, sourceText: rec.sourceText, targetText: rec.targetText, origin: "workbench", originRef: String(id) },
        ]),
      );
    }
    if (path === "/api/tm/search") {
      const b = bodyOf<{ text: string; sourceLang: string; targetLang: string }>(opts);
      return r(store.searchTm(b.text, b.sourceLang, b.targetLang, 3, false));
    }
  }

  /* ---- 术语库 ---- */
  if (path === "/api/glossaries" && method === "GET") {
    const k = kw(q);
    let rows = glossaries.filter((g) => !k || g.name.toLowerCase().includes(k));
    if (q?.scope) rows = rows.filter((g) => g.scope === q.scope);
    if (q?.sourceLang) rows = rows.filter((g) => g.sourceLang === q.sourceLang);
    if (q?.targetLang) rows = rows.filter((g) => g.targetLang === q.targetLang);
    return r(page(rows, q));
  }
  if (path === "/api/glossaries" && method === "POST") {
    const b = bodyOf<Partial<GlossaryVO>>(opts);
    const g: GlossaryVO = {
      id: Math.max(...glossaries.map((x) => x.id)) + 1,
      name: b.name ?? "",
      description: b.description ?? null,
      sourceLang: b.sourceLang ?? "en",
      targetLang: b.targetLang ?? "zh",
      domain: b.domain ?? null,
      scope: b.scope ?? "PRIVATE",
      termCount: 0,
      ownerId: 1,
      ownerName: "admin",
      editable: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    glossaries = [g, ...glossaries];
    terms[g.id] = [];
    return r(g);
  }
  if ((m = path.match(/^\/api\/glossaries\/(\d+)$/))) {
    const id = Number(m[1]);
    const g = glossaries.find((x) => x.id === id);
    if (!g) throw new ApiError("A0404", "资源不存在", undefined, 404);
    if (method === "DELETE") {
      glossaries = glossaries.filter((x) => x.id !== id);
      return r(null);
    }
    Object.assign(g, bodyOf<Partial<GlossaryVO>>(opts), { updatedAt: new Date().toISOString() });
    return r(g);
  }
  if ((m = path.match(/^\/api\/glossaries\/(\d+)\/terms\/import\/preview$/))) {
    const id = Number(m[1]);
    const file = opts.form?.get("file") as File | null;
    const text = file ? await file.text() : "";
    const lines = text.replace(BOM, "").split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length || !/^source\s*,/i.test(lines[0])) {
      throw new ApiError("A0421", "导入文件格式错误：缺少 source 表头或编码不是 UTF-8", "mock-a0421", 400);
    }
    const existing = new Set((terms[id] ?? []).map((t) => t.sourceTerm.toLowerCase()));
    const preview: ImportPreview = { total: lines.length - 1, valid: 0, newCount: 0, updateCount: 0, errors: [], sample: [] };
    lines.slice(1).forEach((l, i) => {
      const [source = "", target = "", note = ""] = l.split(",").map((s) => s.trim());
      const line = i + 2;
      if (!source || !target) {
        preview.errors.push({ line, message: !source ? "缺少源术语" : "缺少目标术语" });
        return;
      }
      preview.valid++;
      if (existing.has(source.toLowerCase())) preview.updateCount++;
      else preview.newCount++;
      if (preview.sample.length < 5) preview.sample.push({
          line,
          sourceTerm: source,
          targetTerm: target,
          note: note || null,
          exists: existing.has(source.toLowerCase()),
        });
    });
    return r(preview);
  }
  if ((m = path.match(/^\/api\/glossaries\/(\d+)\/terms\/import$/))) {
    const id = Number(m[1]);
    const file = opts.form?.get("file") as File | null;
    const strategy = String(opts.form?.get("strategy") ?? "skip");
    const text = file ? await file.text() : "";
    const lines = text.replace(BOM, "").split(/\r?\n/).filter((l) => l.trim()).slice(1);
    const list = terms[id] ?? (terms[id] = []);
    const res = { inserted: 0, updated: 0, skipped: 0, failed: 0 };
    for (const l of lines) {
      const [source = "", target = "", note = ""] = l.split(",").map((s) => s.trim());
      if (!source || !target) {
        res.failed++;
        continue;
      }
      const ex = list.find((t) => t.sourceTerm.toLowerCase() === source.toLowerCase());
      if (ex) {
        if (strategy === "overwrite") {
          Object.assign(ex, { targetTerm: target, note: note || null, updatedAt: new Date().toISOString() });
          res.updated++;
        } else res.skipped++;
      } else {
        list.unshift({ id: Date.now() + res.inserted, sourceTerm: source, targetTerm: target, note: note || null, caseSensitive: false, updatedAt: new Date().toISOString() });
        res.inserted++;
      }
    }
    const g = glossaries.find((x) => x.id === id);
    if (g) g.termCount = list.length;
    return r(res);
  }
  if ((m = path.match(/^\/api\/glossaries\/(\d+)\/terms(?:\/(\d+))?$/))) {
    const id = Number(m[1]);
    const termId = m[2] ? Number(m[2]) : null;
    const list = terms[id] ?? (terms[id] = []);
    const g = glossaries.find((x) => x.id === id);
    if (method === "GET") {
      const k = kw(q);
      return r(page(list.filter((t) => !k || t.sourceTerm.toLowerCase().includes(k) || t.targetTerm.includes(k)), q));
    }
    if (g && !g.editable) throw new ApiError("A0301", "无权限修改公共术语库", undefined, 403);
    const b = bodyOf<Partial<TermVO>>(opts);
    if (method === "POST") {
      if (list.some((t) => t.sourceTerm.toLowerCase() === (b.sourceTerm ?? "").toLowerCase())) {
        throw new ApiError("A0112", "术语已存在", undefined, 409);
      }
      const t: TermVO = { id: Date.now(), sourceTerm: b.sourceTerm ?? "", targetTerm: b.targetTerm ?? "", note: b.note ?? null, caseSensitive: !!b.caseSensitive, updatedAt: new Date().toISOString() };
      list.unshift(t);
      if (g) g.termCount = list.length;
      return r(t);
    }
    const idx = list.findIndex((t) => t.id === termId);
    if (idx === -1) throw new ApiError("A0404", "资源不存在", undefined, 404);
    if (method === "DELETE") {
      list.splice(idx, 1);
      if (g) g.termCount = list.length;
      return r(null);
    }
    list[idx] = { ...list[idx], ...b, note: b.note ?? null, updatedAt: new Date().toISOString() };
    return r(list[idx]);
  }

  /* ---- 历史 ---- */
  if (path === "/api/translations" && method === "GET") {
    const k = kw(q);
    await syncSessionHistory();
    let rows = history.filter((h) => !k || h.sourceText.toLowerCase().includes(k) || h.targetText.toLowerCase().includes(k));
    if (q?.sourceLang) rows = rows.filter((h) => h.sourceLang === q.sourceLang);
    if (q?.targetLang) rows = rows.filter((h) => h.targetLang === q.targetLang);
    if (q?.favorite === true) rows = rows.filter((h) => h.favorite);
    return r(page(rows.map(summary), q));
  }
  if ((m = path.match(/^\/api\/translations\/(\d+)(\/favorite)?$/))) {
    const id = Number(m[1]);
    await syncSessionHistory();
    const h = history.find((x) => x.id === id);
    if (!h) throw new ApiError("A0404", "资源不存在", undefined, 404);
    if (m[2]) {
      h.favorite = !!bodyOf<{ favorite: boolean }>(opts).favorite;
      return r(null);
    }
    if (method === "DELETE") {
      history = history.filter((x) => x.id !== id);
      return r(null);
    }
    return r(h);
  }

  /* ---- 管理 ---- */
  if (path === "/api/admin/users" && method === "GET") {
    const k = kw(q);
    let rows = users.filter((u) => !k || u.username.includes(k));
    if (q?.status) rows = rows.filter((u) => u.status === q.status);
    if (q?.role) rows = rows.filter((u) => u.roles.includes(q.role as "ADMIN"));
    return r(page(rows, q));
  }
  if (path === "/api/admin/users" && method === "POST") {
    const b = bodyOf<Partial<UserInfo>>(opts);
    const u: UserInfo = { id: users.length + 1, username: b.username ?? "", nickname: b.nickname ?? null, email: b.email ?? null, status: "ENABLED", roles: b.roles ?? ["USER"], lastLoginAt: null, createdAt: new Date().toISOString() };
    users.push(u);
    return r(u);
  }
  if ((m = path.match(/^\/api\/admin\/users\/(\d+)(?:\/(status|roles|password))?$/))) {
    const u = users.find((x) => x.id === Number(m![1]));
    if (!u) throw new ApiError("A0404", "资源不存在", undefined, 404);
    if (m[2] === "status") u.status = bodyOf<{ status: UserInfo["status"] }>(opts).status;
    if (m[2] === "roles") u.roles = bodyOf<{ roles: UserInfo["roles"] }>(opts).roles;
    if (!m[2] && method === "DELETE") users.splice(users.indexOf(u), 1);
    return r(null);
  }
  if (path === "/api/admin/model-configs" && method === "GET") {
    const k = kw(q);
    return r(page(models.filter((x) => !k || x.name.toLowerCase().includes(k) || x.modelName.includes(k)), q));
  }
  if (path === "/api/admin/model-configs" && method === "POST") {
    const b = bodyOf<Partial<ModelConfigVO> & { apiKey?: string }>(opts);
    checkCombination(b);
    const mc: ModelConfigVO = { id: Math.max(0, ...models.map((x) => x.id)) + 1, name: b.name ?? "", capability: b.capability ?? "CHAT", provider: b.provider ?? "OPENAI_COMPATIBLE", supportsVision: (b.capability ?? "CHAT") === "CHAT" && !!b.supportsVision, baseUrl: b.baseUrl ?? "", modelName: b.modelName ?? "", apiKeyMask: "sk-****new0", params: b.params ?? {}, isDefault: false, isReviewDefault: false, enabled: b.enabled ?? true, remark: b.remark ?? null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    models.push(mc);
    return r(mc);
  }
  if ((m = path.match(/^\/api\/admin\/model-configs\/(\d+)(?:\/(default|review-default|enabled|test))?$/))) {
    const mc = models.find((x) => x.id === Number(m![1]));
    if (!mc) throw new ApiError("A0404", "资源不存在", undefined, 404);
    // 默认模型按能力唯一（design D12）
    if (m[2] === "default") models.forEach((x) => {
      if ((x.capability ?? "CHAT") === (mc.capability ?? "CHAT")) x.isDefault = x.id === mc.id;
    });
    else if (m[2] === "review-default") {
      if (method === "DELETE") mc.isReviewDefault = false;
      else {
        if (!mc.enabled) throw new ApiError("C0130", "模型配置已停用", undefined, 400);
        if ((mc.capability ?? "CHAT") !== "CHAT") throw new ApiError("A0410", "只有对话能力的模型可以设为评审模型", undefined, 400);
        models.forEach((x) => (x.isReviewDefault = x.id === mc.id));
      }
    } else if (m[2] === "enabled") {
      mc.enabled = bodyOf<{ enabled: boolean }>(opts).enabled;
      if (!mc.enabled) mc.isReviewDefault = false;
    }
    else if (m[2] === "test") {
      await sleep(900);
      return r(
        mc.enabled && mc.id !== 3
          ? {
              ok: true,
              model: mc.modelName,
              latencyMs: 820 + mc.id * 130,
              reply: { CHAT: "pong", ASR: "大家好，这是一段测试音频。", TTS: "音频 12345 字节", REALTIME_TRANSLATE: "会话已建立", REALTIME_CHAT: "会话已建立", IMAGE_TRANSLATE: "结果图 64×32" }[mc.capability ?? "CHAT"],
              usage: (mc.capability ?? "CHAT") === "CHAT" ? { promptTokens: 12, completionTokens: 2 } : undefined,
            }
          : { ok: false, latencyMs: 410, errorCode: "C0121", errorMessage: "401 Unauthorized: invalid api key" },
      );
    } else if (method === "DELETE") models.splice(models.indexOf(mc), 1);
    else if (method === "PUT") {
      const b = bodyOf<Partial<ModelConfigVO>>(opts);
      checkCombination(b);
      Object.assign(mc, b, { supportsVision: (b.capability ?? "CHAT") === "CHAT" && !!b.supportsVision, updatedAt: new Date().toISOString() });
    }
    return r(m[2] || method === "DELETE" ? null : mc);
  }
  if (path === "/api/admin/logs/login") {
    let rows = loginLogs.filter((l) => !kw(q) || l.username.includes(kw(q)));
    if (q?.success !== undefined) rows = rows.filter((l) => String(l.success) === String(q.success));
    return r(page(rows, q));
  }
  if (path === "/api/admin/logs/operation") {
    let rows = opLogs.filter((l) => !kw(q) || l.username.includes(kw(q)));
    if (q?.module) rows = rows.filter((l) => l.module.includes(String(q.module)));
    return r(page(rows, q));
  }
  if (path === "/api/admin/system/status") {
    systemTick++;
    return r({
      items: [
        { name: "spring", status: "UP", detail: "v0.1.0 · 运行 3 小时" },
        { name: "postgres", status: "UP", detail: "PostgreSQL 16.4 · pgvector / pg_trgm" },
        { name: "redis", status: "UP", detail: "7.4.1" },
        // 每第 3 次刷新模拟 AI 服务不可用，用于观察状态切换动画
        systemTick % 3 === 0
          ? { name: "ai-service", status: "DOWN", detail: "Connection refused: localhost:8000" }
          : { name: "ai-service", status: "UP", detail: "FastAPI · lingua 已预热" },
      ],
    });
  }

  throw new ApiError("A0404", `mock 未实现：${method} ${path}`, undefined, 404);
}

export async function mockDownload(
  path: string,
  query?: RequestOptions["query"],
): Promise<{ blob: Blob; filename: string | null }> {
  await sleep(300);
  if (path.startsWith("/api/doc-tasks")) {
    const { mockDocDownload } = await import("./doc-engine");
    const res = await mockDocDownload(path, query);
    if (res) return res;
  }
  if (path.startsWith("/api/image-translations")) {
    const { mockImageDownload } = await import("./image");
    return mockImageDownload(path);
  }
  const m = path.match(/^\/api\/glossaries\/(\d+)\/terms\/export$/);
  const list = m ? (terms[Number(m[1])] ?? []) : [];
  const csv = ["source,target,note", ...list.map((t) => `${t.sourceTerm},${t.targetTerm},${t.note ?? ""}`)].join("\n");
  return { blob: new Blob([String.fromCharCode(0xfeff) + csv], { type: "text/csv" }), filename: `glossary-${m?.[1] ?? "x"}.csv` };
}
