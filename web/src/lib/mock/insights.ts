/**
 * 解读 mock（NEXT_PUBLIC_MOCK_API=1）：备选译法 / 关键表达 / 追问流式回答。
 * 习语示例（raining cats and dogs）返回契约中的样例，其余文本按语种生成通用样例。
 */
import { ApiError, type RequestOptions } from "@/lib/http";
import { abortError, type SseMessage } from "@/lib/sse";
import type { AskRequest, Insights, InsightsRequest } from "@/lib/api/insights";

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true },
    );
  });
}

const firstClause = (s: string, n = 18) => {
  const t = s.trim().split(/[。！？.!?\n]/)[0] ?? s;
  return t.length > n ? t.slice(0, n) + "…" : t;
};

export function mockInsights(req: InsightsRequest): Insights {
  if (req.source.length > 2000) throw new ApiError("A0410", "原文不能超过 2000 字符", undefined, 400);
  const usage = { promptTokens: 210, completionTokens: 180 };
  if (/cats and dogs/i.test(req.source)) {
    return {
      alternatives: [
        { text: "雨下得很大。", register: "中性", note: "日常叙述最常用，平实自然" },
        { text: "外面大雨如注。", register: "书面", note: "适合书面描写，画面感更强" },
        { text: "雨下得跟瓢泼似的！", register: "口语", note: "朋友聊天时更生动" },
      ],
      expressions: [
        { source: "raining cats and dogs", target: "倾盆大雨", meaning: "形容雨下得非常大", note: "英语习语，不能直译为“下猫下狗”" },
        { source: "It's", target: "（省略）", meaning: "天气句的形式主语", note: "中文天气描写通常不需要主语" },
      ],
      summary: "原文是英语习语，译文采用中文四字成语对应，语义与语气都更贴近。",
      usage,
    };
  }
  const zhTarget = req.targetLang === "zh";
  const t = req.translation.trim();
  const head = firstClause(t);
  const srcHead = firstClause(req.source, 24);
  return {
    alternatives: zhTarget
      ? [
          { text: t.replace(/通常/g, "一般").replace(/。$/, "") + "。", register: "中性", note: "替换个别用词，语气更平实" },
          { text: "通俗地说，" + t, register: "口语", note: "加上口语化的引导语，适合讲解场景" },
          { text: t.replace(/在/g, "于").replace(/上训练/g, "上进行训练"), register: "正式", note: "书面化的介词与动词搭配，适合论文与报告" },
        ]
      : [
          { text: t.replace(/\bare usually\b/i, "are typically"), register: "正式", note: "用 typically 替换 usually，更适合技术文档" },
          { text: t.replace(/\.$/, "") + ", generally speaking.", register: "口语", note: "句尾补充语气，读起来更像口头表达" },
        ],
    expressions: [
      { source: srcHead, target: head, meaning: "句子主干，决定整句的语序与信息重心", note: "译文按目标语习惯调整了语序" },
      ...(req.source.match(/GPU|neural network|machine learning|神经网络|图形处理器/i)
        ? [{ source: req.source.match(/GPU|neural network|machine learning|神经网络|图形处理器/i)![0], target: zhTarget ? "图形处理器" : "GPU", meaning: "专业术语，按术语库固定译法", note: "术语库要求统一译法" }]
        : []),
    ],
    summary: zhTarget ? "译文整体忠实，语序已按中文习惯调整；可按场景选择更口语或更正式的说法。" : "The translation is faithful; alternatives differ mainly in register.",
    usage,
  };
}

function answerFor(req: AskRequest): string {
  const q = req.question;
  if (/口语/.test(q)) return `口语一点可以说：“${firstClause(req.translation, 30).replace(/。$/, "")}啦”。日常交流里可以省掉书面化的连接词，句子更短，语气词能让表达更自然；但在正式文档里还是建议保留原译。`;
  if (/正式/.test(q)) return `更正式的说法可以把口语化的词换成书面语，例如用“于”“进行”等结构，并避免语气词。这样更适合论文、报告和合同等场景。`;
  if (/为什么|为何/.test(q)) return `这样译主要有三点考虑：第一，原文的信息重心在句首，译文保持了同样的重心；第二，按目标语的表达习惯调整了语序，避免逐词直译带来的生硬感；第三，专业术语遵循了术语库的统一译法，保证前后一致。`;
  return `关于“${q.replace(/[？?]$/, "")}”：当前译文“${firstClause(req.translation, 20)}”在语义上与原文一致。如果想换一种说法，可以参考上方「备选译法」里不同语体的版本，再结合具体场景选择。`;
}

export async function mockAskStream(
  req: AskRequest,
  opts: { signal?: AbortSignal; onMessage: (m: SseMessage) => void },
): Promise<void> {
  await sleep(500, opts.signal);
  if (!req.question.trim()) throw new ApiError("A0410", "问题不能为空", undefined, 400);
  const chars = Array.from(answerFor(req));
  for (let i = 0; i < chars.length; i += 2) {
    opts.onMessage({ event: "delta", data: JSON.stringify({ text: chars.slice(i, i + 2).join("") }) });
    await sleep(35, opts.signal);
  }
  opts.onMessage({ event: "done", data: JSON.stringify({ usage: { promptTokens: 320, completionTokens: chars.length } }) });
}

export async function mockInsightsRequest<T>(path: string, opts: RequestOptions): Promise<T> {
  if (path === "/api/translations/insights" && opts.method === "POST") {
    await new Promise((r) => setTimeout(r, 900));
    return mockInsights(opts.body as InsightsRequest) as T;
  }
  throw new ApiError("A0404", `mock 未实现：${opts.method ?? "GET"} ${path}`, undefined, 404);
}
