/**
 * 首页演示数据（add-ai-avatar-and-landing D8）。文学样例由项目配置的 AI 生成并经编辑，其他样例取自平台实测与 docs/experiments/实验报告.md，
 * 行业数据取自公开来源并以区间标注"估算"。所有演示均为前端回放，不调用后端。
 */
import type { CharacterId } from "@/lib/avatar/characters";
import { chip, initialTrace, output, stage, type Step, type TraceState } from "./script";

/* ---------------- Hero：一次完整的 Agent 轨迹 ---------------- */

export const HERO_SOURCE = "Long after the rain had passed, the old house kept its fragrance of wet cedar, as though the years we had lost were still waiting quietly beneath the eaves for someone to call them home.";
export const HERO_TRANSLATION = "雨过许久，老屋依然留着雨湿雪松的香气，仿佛那些失去的岁月仍静静守候在檐下，等着有人唤它们回家。";
export const CLASSICAL_SOURCE = "莫听穿林打叶声，何妨吟啸且徐行。竹杖芒鞋轻胜马，谁怕？一蓑烟雨任平生。";
export const CLASSICAL_TRANSLATION = "Pay no heed to the rain beating through the trees and on the leaves;\nwhy not hum and whistle as I stroll along at ease?\nWith a bamboo staff and straw sandals, I am more at ease than on horseback.\nWho’s afraid?\nIn a straw cape amid mist and rain, I shall live out my days.";

/** Literary replays finish streaming before review begins; timings are illustrative. */
function literaryScript(text: string, analysis: string, imagery: string[]): Step<TraceState>[] {
  const translated = output(2150, text, 38);
  const finished = translated.at + (translated.dur ?? 0) + 100;
  return [
    stage(300, "analyze", "active"),
    stage(1100, "analyze", "done", analysis),
    stage(1150, "plan", "active"),
    ...imagery.map((label, i) => chip(1450 + i * 250, label)),
    stage(2000, "plan", "done", "创意风格 · 保留意象，重组节奏"),
    stage(2050, "translate", "active"),
    translated,
    stage(finished, "translate", "done", "按目标语言习惯表达"),
    stage(finished + 50, "review", "active"),
    stage(finished + 900, "review", "done", "核对意象、语气与表达自然度"),
    stage(finished + 950, "refine", "skipped", "示例译文 · 可继续调整文风"),
  ];
}

export const HERO_SCRIPT = literaryScript(HERO_TRANSLATION, "英 → 中 · 诗性散文", ["意象 · 雨后木香", "隐喻 · 唤岁月归家"]);

/* ---------------- 交互试玩：文学与能力样例 ---------------- */

export type SampleKey = "literary" | "classical" | "ambiguity" | "terms" | "context";

export interface PlaygroundSample {
  key: SampleKey;
  label: string;
  hint: string;
  source: string;
  sourceLabel?: string;
  targetLabel?: string;
  sourceNote?: string;
  sourceAudio?: string;
  targetAudio?: string;
  /** 追问前（或完整）的脚本 */
  script: Step<TraceState>[];
  /** 歧义样例：访客选择后接着播放的分支脚本（从 0 开始计时） */
  branches?: { label: string; script: Step<TraceState>[] }[];
  /** 一句话说明这个样例展示了什么 */
  takeaway: string;
}

const askDuck: Step<TraceState> = {
  at: 2300,
  apply: (s) => ({ ...s, question: { prompt: "“duck” 在这里指什么？", options: ["她的鸭子（名词）", "她低头躲闪（动词）"] } }),
};

const answered = (choice: string): Step<TraceState> => ({
  at: 0,
  apply: (s) => ({ ...s, question: null, notes: { ...s.notes, plan: `用户确认：${choice}` } }),
});

export const PLAYGROUND: PlaygroundSample[] = [
  {
    key: "literary",
    label: "诗性散文",
    hint: "英语 → 中文 · 保留意象，也保留余韵",
    source: HERO_SOURCE,
    sourceAudio: "/audio/literary-source-en.mp3",
    targetAudio: "/audio/literary-target-zh.mp3",
    sourceLabel: "原文 · 英语散文",
    targetLabel: "译文 · 中文文学表达",
    script: HERO_SCRIPT,
    takeaway: "把雨后的木香、旧屋与等待归家的岁月一起带入中文。创意风格允许调整句式，让隐喻和节奏在另一种语言里自然成立。",
  },
  {
    key: "classical",
    label: "古典新译",
    hint: "文言文 → 英语 · 让旷达跨越语言",
    source: CLASSICAL_SOURCE,
    sourceAudio: "/audio/classical-source-zh.mp3",
    targetAudio: "/audio/classical-target-en.mp3",
    sourceLabel: "原文 · 宋词",
    targetLabel: "译文 · 英语文学表达",
    sourceNote: "苏轼《定风波·莫听穿林打叶声》上阕",
    script: literaryScript(CLASSICAL_TRANSLATION, "中 → 英 · 宋词，风雨中的从容", ["意象 · 竹杖、草鞋、蓑衣", "语气 · 从容旷达"]),
    takeaway: "竹杖、草鞋与烟雨仍在，句式则顺着英语的节奏展开。文学意译追求的是让读者读懂同一种心境，而不是逐字寻找替身。",
  },
  {
    key: "ambiguity",
    label: "歧义句",
    hint: "一句话两种意思",
    source: "I saw her duck.",
    script: [
      stage(200, "analyze", "active"),
      stage(1000, "analyze", "done", "英 → 中 · 日常对话"),
      stage(1050, "plan", "active"),
      chip(1500, "发现歧义：duck"),
      askDuck,
    ],
    branches: [
      {
        label: "她的鸭子（名词）",
        script: [
          answered("名词 · 鸭子"),
          stage(100, "plan", "done"),
          stage(150, "translate", "active"),
          output(250, "我看见了她的鸭子。"),
          stage(1200, "translate", "done", "按确认的含义翻译"),
          stage(1250, "review", "active"),
          stage(2000, "review", "done", "96 分"),
          stage(2050, "refine", "skipped", "无需修正"),
        ],
      },
      {
        label: "她低头躲闪（动词）",
        script: [
          answered("动词 · 低头躲闪"),
          stage(100, "plan", "done"),
          stage(150, "translate", "active"),
          output(250, "我看见她猛地低头躲了一下。"),
          stage(1500, "translate", "done", "按确认的含义翻译"),
          stage(1550, "review", "active"),
          stage(2300, "review", "done", "95 分"),
          stage(2350, "refine", "skipped", "无需修正"),
        ],
      },
    ],
    takeaway: "遇到真正的歧义，Agent 不去猜，而是先问你——这正是人工译者会做的事。",
  },
  {
    key: "terms",
    label: "术语句",
    hint: "团队术语库强制生效",
    source: "Scale the Deployment to three replicas and expose it with a Service.",
    script: [
      stage(200, "analyze", "active"),
      stage(900, "analyze", "done", "英 → 中 · Kubernetes 文档"),
      stage(950, "plan", "active"),
      chip(1250, "Deployment → 保留"),
      chip(1500, "replica → 副本"),
      chip(1750, "Service → 保留"),
      stage(2000, "plan", "done", "术语库命中 3 条（硬约束）"),
      stage(2050, "translate", "active"),
      output(2150, "将 Deployment 扩容到三个副本，并通过 Service 对外暴露。"),
      stage(3900, "translate", "done", "注入术语表"),
      stage(3950, "review", "active"),
      stage(4800, "review", "done", "术语遵循 3/3"),
      stage(4850, "refine", "skipped", "无需修正"),
    ],
    takeaway: "术语不是“建议”：命中的条目作为硬约束注入，评审再逐条核对是否遵循。",
  },
  {
    key: "context",
    label: "上下文",
    hint: "记得前文说的是什么",
    source: "They stopped charging this morning, and the case has a small crack.",
    script: [
      stage(200, "analyze", "active"),
      chip(600, "会话记忆：they = 耳机"),
      chip(900, "会话记忆：case = 充电盒"),
      stage(1200, "analyze", "done", "英 → 中 · 售后对话（第 3 轮）"),
      stage(1250, "plan", "active"),
      stage(1800, "plan", "done", "带上最近对话与专名表"),
      stage(1850, "translate", "active"),
      output(1950, "今天早上耳机充不进电了，而且充电盒上有一道小裂缝。"),
      stage(3800, "translate", "done", "指代按前文消解"),
      stage(3850, "review", "active"),
      stage(4700, "review", "done", "93 分"),
      stage(4750, "refine", "skipped", "无需修正"),
    ],
    takeaway: "没有上下文时，这句会被译成“他们停止充电了……外壳上有裂缝”。实验中会话上下文把这类指代的准确率提到 95.9%。",
  },
];

export const emptyTrace = initialTrace;

/* ---------------- 与传统方式对比 ---------------- */

export type CompareScenarioKey = "doc" | "dialog" | "meeting";
export type CompareColumnKey = "human" | "mt" | "llm" | "agent";

/** 文本片段：issue 为问题说明（高亮），good 为亮点（绿色） */
export interface Seg {
  t: string;
  issue?: string;
  good?: string;
}

export interface CompareCell {
  output: Seg[];
  time: string;
  cost: string;
  terms: { ok: boolean | null; label: string };
}

export interface CompareScenario {
  key: CompareScenarioKey;
  label: string;
  source: string;
  context: string;
  cells: Record<CompareColumnKey, CompareCell>;
}

export const COMPARE_COLUMNS: { key: CompareColumnKey; title: string; sub: string }[] = [
  { key: "human", title: "人工翻译", sub: "专业译者 / 同传译员" },
  { key: "mt", title: "传统机器翻译", sub: "逐句、无上下文" },
  { key: "llm", title: "直接问通用大模型", sub: "单次对话、无术语库" },
  { key: "agent", title: "本平台 Agent", sub: "分析 → 规划 → 翻译 → 评审" },
];

export const COMPARE: CompareScenario[] = [
  {
    key: "doc",
    label: "技术文档",
    source: "A Deployment manages a ReplicaSet. When you update the Deployment, it creates a new ReplicaSet …",
    context: "5,000 词的 Kubernetes 文档，Deployment / ReplicaSet 按中文社区惯例保留英文",
    cells: {
      human: {
        output: [{ t: "Deployment 管理一个 ReplicaSet。更新 Deployment 时，它会创建一个新的 ReplicaSet……" }],
        time: "约 2 个工作日",
        cost: "$500–1,100（估算）",
        terms: { ok: true, label: "一致" },
      },
      mt: {
        output: [
          { t: "部署", issue: "资源名被意译" },
          { t: "管理一个副本集。当您更新" },
          { t: "调度", issue: "同一术语前后译法不一" },
          { t: "时，它会创建一个新的" },
          { t: "复制集", issue: "与上文“副本集”不一致" },
          { t: "……" },
        ],
        time: "秒级",
        cost: "极低",
        terms: { ok: false, label: "前后不一" },
      },
      llm: {
        output: [
          { t: "部署（Deployment）", issue: "通顺，但未按社区惯例保留英文" },
          { t: "负责管理副本集。更新部署时，它会新建一个副本集……" },
        ],
        time: "分钟级（需逐段粘贴）",
        cost: "低",
        terms: { ok: null, label: "不受控" },
      },
      agent: {
        output: [
          { t: "Deployment", good: "按术语表保留" },
          { t: " 管理一个 " },
          { t: "ReplicaSet", good: "全文一致" },
          { t: "。更新 Deployment 时，它会创建一个新的 ReplicaSet……" },
        ],
        time: "约 9 分钟（按实测 700 词 / 78 s 推算）",
        cost: "仅模型调用费用",
        terms: { ok: true, label: "术语库 + 全文一致" },
      },
    },
  },
  {
    key: "dialog",
    label: "歧义对话",
    source: "Customer: My earbuds arrived yesterday. … They stopped charging and the case has a small crack.",
    context: "售后对话第 3 轮，they / case 需要按前文理解",
    cells: {
      human: {
        output: [{ t: "耳机今天充不进电了，而且充电盒上有一道小裂缝。" }],
        time: "需要通读上下文",
        cost: "按字数计费",
        terms: { ok: true, label: "理解准确" },
      },
      mt: {
        output: [
          { t: "他们停止充电了", issue: "指代错误：they 指耳机" },
          { t: "，而且" },
          { t: "外壳", issue: "多义词选错：case 应为充电盒" },
          { t: "有一个小裂缝。" },
        ],
        time: "秒级",
        cost: "极低",
        terms: { ok: false, label: "逐句翻译丢失前文" },
      },
      llm: {
        output: [
          { t: "它们停止充电了，而且" },
          { t: "外壳", issue: "没看到前文时只能猜" },
          { t: "上有一道小裂缝。" },
        ],
        time: "秒级",
        cost: "低",
        terms: { ok: null, label: "取决于是否粘贴前文" },
      },
      agent: {
        output: [
          { t: "耳机", good: "会话记忆消解指代" },
          { t: "今天充不进电了，而且" },
          { t: "充电盒", good: "按前文消歧" },
          { t: "上有一道小裂缝。" },
        ],
        time: "秒级",
        cost: "仅模型调用费用",
        terms: { ok: true, label: "指代准确率 95.9%（实验）" },
      },
    },
  },
  {
    key: "meeting",
    label: "跨语言会议",
    source: "三人三语周会：主持人说中文，成员说英语和日语",
    context: "1 小时会议，每个人都要实时听懂另外两个人",
    cells: {
      human: {
        output: [{ t: "每个语言方向需要 2 名同传译员轮换，外加同传设备" }],
        time: "需提前预约",
        cost: "$600–1,200 / 人 / 天（AIIC，估算）",
        terms: { ok: true, label: "专业" },
      },
      mt: {
        output: [{ t: "只能翻译文本：会后整理录音再逐句翻译", issue: "无法实时" }],
        time: "会后数小时",
        cost: "低",
        terms: { ok: false, label: "无术语库" },
      },
      llm: {
        output: [{ t: "可以对着麦克风一问一答，但无法同时服务三种语言", issue: "不支持多人多语" }],
        time: "轮流等待",
        cost: "低",
        terms: { ok: null, label: "不受控" },
      },
      agent: {
        output: [
          { t: "多语会议室", good: "3–8 人各用自己的语言" },
          { t: "：每人看到并听到自己语言的字幕与语音，逐句延迟 " },
          { t: "3.3 s（级联）/ 0.31 s（端到端）", good: "实测 p50" },
        ],
        time: "随开随用",
        cost: "本地识别免密钥 + 模型调用费用",
        terms: { ok: true, label: "术语准确率 100%（级联）" },
      },
    },
  },
];

/** 精简对比表（≤6 行，供读屏与截图引用） */
export const COMPARE_TABLE: { dim: string; human: string; mt: string; llm: string; agent: string }[] = [
  { dim: "速度", human: "按天计", mt: "秒级", llm: "秒级", agent: "秒到分钟级" },
  { dim: "术语一致", human: "✓", mt: "✗", llm: "不受控", agent: "术语库硬约束 + 评审核对" },
  { dim: "上下文", human: "✓", mt: "✗", llm: "需手动粘贴", agent: "篇章摘要 + 会话记忆" },
  { dim: "歧义处理", human: "询问客户", mt: "猜", llm: "猜", agent: "主动追问" },
  { dim: "实时语音", human: "需同传译员", mt: "✗", llm: "单人", agent: "收听 / 对话 / 会议室" },
  { dim: "过程可见", human: "—", mt: "✗", llm: "✗", agent: "逐步轨迹可回看" },
];

/* ---------------- 成本估算器 ---------------- */

/** 行业参考（估算，见脚注来源） */
export const RATES = {
  /** 人工笔译 $/词（2026 美国市场区间，Polilingua） */
  humanPerWord: [0.1, 0.22] as const,
  /** 人工笔译 词/天（ATA 2014 调查） */
  humanWordsPerDay: 2855,
  /** 会议同传 $/人/天（AIIC 历史区间） */
  interpreterPerDay: [600, 1200] as const,
  /** 每个语言方向 2 名译员轮换 */
  interpretersPerPair: 2,
  /** 本平台：实验中混合策略约 700 词 / 78 s（实验报告 §3.3） */
  agentWordsPerSecond: 700 / 78,
};

export interface DocEstimate {
  humanDays: number;
  humanCost: [number, number];
  agentMinutes: number;
}

export function estimateDoc(words: number): DocEstimate {
  return {
    humanDays: words / RATES.humanWordsPerDay,
    humanCost: [words * RATES.humanPerWord[0], words * RATES.humanPerWord[1]],
    agentMinutes: words / RATES.agentWordsPerSecond / 60,
  };
}

/** 会议：语言数 n 时需要 n(n-1)/2 个语言方向（双向），每个方向 2 名译员；不足半天按半天计 */
export function estimateMeeting(hours: number, languages: number): { interpreters: number; cost: [number, number] } {
  const pairs = (languages * (languages - 1)) / 2;
  const interpreters = pairs * RATES.interpretersPerPair;
  const days = Math.max(0.5, Math.ceil(hours / 4) / 2);
  return {
    interpreters,
    cost: [interpreters * RATES.interpreterPerDay[0] * days, interpreters * RATES.interpreterPerDay[1] * days],
  };
}

export const SOURCES = [
  { label: "人工笔译单价", text: "Polilingua 2026 翻译价格指南（$0.10–0.22/词）" },
  { label: "人工笔译速度", text: "ATA 翻译与口译服务调查（约 2,855 词/天，2014）" },
  { label: "会议同传日费", text: "AIIC 会议口译费用说明（$600–1,200/人/天）" },
  { label: "本平台数据", text: "本项目实验报告 §3.3、§10.2、§11（合成测试集，规模有限）" },
];

/* ---------------- 评测数据 ---------------- */

export interface StatItem {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix: string;
  label: string;
  detail: string;
  source: string;
}

export const STATS: StatItem[] = [
  { value: 82, prefix: "−", suffix: "%", label: "严重错误", detail: "加入前块上下文后，MQM major 错误从 11 个降到 2 个", source: "实验报告 §3.3 发现 1" },
  { value: 95.9, decimals: 1, suffix: "%", label: "指代与多义准确率", detail: "会话上下文修正“他们 / 外壳”这类错误（无上下文 89.8%）", source: "实验报告 §10.2" },
  { value: 46, prefix: "−", suffix: "%", label: "长文档耗时", detail: "混合策略 143.5 s → 77.7 s，质量无显著差异", source: "实验报告 §3.3 发现 5" },
  { value: 100, suffix: "%", label: "同传术语准确率", detail: "级联同传接入术语库后从 33% 提升到 100%", source: "实验报告 §11.1 发现 13" },
  { value: 0.31, decimals: 2, suffix: " s", label: "端到端同传延迟", detail: "千问同传句末后 p50 0.31 s 出译音（级联 3.3 s）", source: "实验报告 §11.1 发现 12" },
  { value: 10, prefix: "+", suffix: "", label: "图片翻译 chrF", detail: "两步法（OCR → 术语 → 翻译）对比单次视觉翻译", source: "实验报告 §11.2 发现 15" },
];

/* ---------------- 和 AI 面对面 ---------------- */

export type GreetingKey = "hello" | "restaurant" | "interview";

export const GREETING_SCENES: { key: GreetingKey; label: string }[] = [
  { key: "hello", label: "打个招呼" },
  { key: "restaurant", label: "餐厅点餐" },
  { key: "interview", label: "求职面试" },
];

/** 各语言形象的开场白：text 用该形象的语言朗读，sub 为字幕（中文形象配英文字幕，其余配中文） */
export const GREETINGS: Record<CharacterId, Record<GreetingKey, { text: string; sub: string }>> = {
  zh: {
    hello: { text: "你好，我是 Lumi！我可以实时为你的对话做翻译，也可以陪你用想练习的语言聊天。", sub: "Hi, I'm Lumi! I can interpret your conversations in real time, or chat with you in the language you want to practice." },
    restaurant: { text: "晚上好，欢迎光临！这是菜单，要先来点喝的吗？", sub: "Good evening, welcome! Here is the menu. Can I get you something to drink first?" },
    interview: { text: "感谢你今天过来，可以先简单介绍一下你自己吗？", sub: "Thanks for coming in today. Could you start by telling me a little about yourself?" },
  },
  en: {
    hello: { text: "Hi, I'm Lumi! I can interpret your conversations in real time, or chat with you in any language you want to practice.", sub: "你好，我是 Lumi！我可以实时为你的对话做翻译，也可以陪你用想练习的语言聊天。" },
    restaurant: { text: "Good evening, welcome! Here is the menu. Can I get you something to drink first?", sub: "晚上好，欢迎光临！这是菜单，要先来点喝的吗？" },
    interview: { text: "Thanks for coming in today. Could you start by telling me a little about yourself?", sub: "感谢你今天过来。可以先简单介绍一下你自己吗？" },
  },
  ja: {
    hello: { text: "こんにちは、Lumiです！会話をリアルタイムで通訳したり、練習したい言葉でおしゃべりしたりできますよ。", sub: "你好，我是 Lumi！我可以实时为对话做翻译，也可以用你想练习的语言陪你聊天。" },
    restaurant: { text: "いらっしゃいませ！こちらがメニューです。まずお飲み物はいかがですか？", sub: "欢迎光临！这是菜单，要先来点喝的吗？" },
    interview: { text: "本日はお越しいただきありがとうございます。まず簡単に自己紹介をお願いできますか？", sub: "感谢你今天前来。可以先简单做个自我介绍吗？" },
  },
  ko: {
    hello: { text: "안녕하세요, 저는 Lumi예요! 대화를 실시간으로 통역하거나, 연습하고 싶은 언어로 함께 이야기할 수 있어요.", sub: "你好，我是 Lumi！我可以实时为对话做翻译，也可以用你想练习的语言陪你聊天。" },
    restaurant: { text: "어서 오세요! 여기 메뉴입니다. 먼저 음료부터 드릴까요?", sub: "欢迎光临！这是菜单，要先来点喝的吗？" },
    interview: { text: "오늘 와 주셔서 감사합니다. 먼저 간단하게 자기소개를 해 주시겠어요?", sub: "感谢你今天前来。可以先简单做个自我介绍吗？" },
  },
};

/* ---------------- FAQ ---------------- */

export const FAQ: { q: string; a: string }[] = [
  {
    q: "首页的演示是真的在调用模型吗？",
    a: "不是。首页所有演示都是用平台真实运行和实验中的样例回放的，不会上传你的任何内容。注册登录后即可体验真实的翻译、同传和 AI 对话。",
  },
  {
    q: "支持哪些语言？",
    a: "文本与文档翻译支持中、英、日、韩、法、德、西、俄、葡、意、阿、泰、越、印尼、土耳其 15 种语言；本地语音识别支持中英日韩粤，接入厂商同传引擎后可扩展到 60 多种语言。",
  },
  {
    q: "我的数据会被用来训练模型吗？",
    a: "平台本身不训练模型。翻译记录、术语库和翻译记忆只保存在你部署的数据库中；调用哪家模型、用哪个密钥，都由管理员在后台配置。",
  },
  {
    q: "和直接用大模型聊天翻译有什么不同？",
    a: "平台把翻译拆成分析、规划、翻译、评审、修正几个可观测的步骤，并自动带上术语库、翻译记忆和篇章上下文；遇到歧义会主动追问。每一步都能在轨迹里回看，效果有实验数据支撑。",
  },
  {
    q: "数字人 Lumi 需要很好的电脑吗？",
    a: "不需要。Lumi 是一张高清立绘加上实时的口型、眨眼和视差动画，一个形象的资源不到 0.6 MB，只在需要时加载。设备性能不足、浏览器不支持 WebGL 或开启了“减少动效”时，会自动显示静态形象，功能完全一样。",
  },
];
