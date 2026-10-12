import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseParser, type SseMessage } from "@/lib/sse";
import { toTranslateEvent, translateApi, type TranslateEvent, type TranslateRequest } from "@/lib/api/translate";
import {
  createRunStore,
  currentRound,
  currentTranslation,
  latestReview,
  reduceAll,
  reduceRun,
  initialRunState,
} from "@/lib/translation-run";
import { sampleStreams, sseResponse } from "./helpers";

function events(text: string): TranslateEvent[] {
  const out: SseMessage[] = [];
  const p = createSseParser((m) => out.push(m));
  p.feed(text);
  p.end();
  return out.map(toTranslateEvent).filter((e): e is TranslateEvent => e !== null);
}

const REQ: TranslateRequest = {
  text: "Machine learning models are usually trained on GPUs.",
  sourceLang: "auto",
  targetLang: "zh",
  mode: "auto",
  style: "faithful",
  glossaryIds: [7, 9],
};

describe("reduceRun · fast 路径", () => {
  const s = reduceAll(events(sampleStreams().fast));

  it("最终状态", () => {
    expect(s.status).toBe("done");
    expect(s.requestId).toBe("req-fast-001");
    expect(s.detect).toEqual({ lang: "en", confidence: 0.97, method: "lingua" });
    expect(s.plan?.path).toBe("fast");
    expect(s.rounds).toEqual([{ round: 0, text: "早上好" }]);
    expect(s.final?.recordId).toBe(101);
    expect(currentTranslation(s)).toBe("早上好");
  });

  it("节点：跳过的节点以 skipped 记录，其余均已完成", () => {
    expect(s.nodes.map((n) => [n.node, n.status])).toEqual([
      ["analyze", "completed"],
      ["plan", "completed"],
      ["retrieve", "skipped"],
      ["translate", "completed"],
      ["review", "skipped"],
      ["refine", "skipped"],
      ["finalize", "completed"],
    ]);
    expect(s.nodes.find((n) => n.node === "translate")?.usage).toEqual({
      promptTokens: 96,
      completionTokens: 4,
    });
  });
});

describe("reduceRun · standard 路径（含 1 轮修正）", () => {
  const evs = events(sampleStreams().standard);
  const s = reduceAll(evs);

  it("节点按执行顺序记录，review 出现两次", () => {
    expect(s.nodes.map((n) => n.node)).toEqual([
      "analyze",
      "plan",
      "retrieve",
      "translate",
      "review",
      "refine",
      "review",
      "finalize",
    ]);
    expect(s.nodes.every((n) => n.status === "completed")).toBe(true);
    expect(new Set(s.nodes.map((n) => n.key)).size).toBe(s.nodes.length);
  });

  it("每轮译文与评审", () => {
    expect(s.rounds).toHaveLength(2);
    expect(s.rounds[0].text).toBe("机器学习模型\n通常在 显卡上训练。");
    expect(s.rounds[0].review).toMatchObject({ score: 72, passed: false });
    expect(s.rounds[1].text).toBe("机器学习模型\n通常在 图形处理器上训练。");
    expect(s.rounds[1].review).toMatchObject({ score: 93, passed: true });
    expect(latestReview(s)?.score).toBe(93);
    expect(currentRound(s)).toBe(1);
  });

  it("术语命中与最终结果", () => {
    expect(s.terms?.hits).toHaveLength(2);
    expect(s.terms?.skippedGlossaries).toEqual([9]);
    expect(s.final?.compliance.every((c) => c.compliant)).toBe(true);
    expect(s.final?.recordId).toBe(102);
    expect(currentTranslation(s)).toBe(s.rounds[1].text);
  });

  it("收到更大的 round 时清空当前译文，重新开始流式显示", () => {
    const idx = evs.findIndex((e) => e.event === "delta" && e.data.round === 1);
    const before = reduceAll(evs.slice(0, idx));
    expect(currentTranslation(before)).toBe("机器学习模型\n通常在 显卡上训练。");
    const after = reduceRun(before, evs[idx]);
    expect(currentTranslation(after)).toBe("机器学习模型\n通常在 ");
    expect(currentRound(after)).toBe(1);
  });

  it("运行中的节点在 completed 之前保持 running", () => {
    const idx = evs.findIndex((e) => e.event === "node" && e.data.node === "translate" && e.data.status === "started");
    const mid = reduceAll(evs.slice(0, idx + 1));
    expect(mid.nodes.at(-1)).toMatchObject({ node: "translate", status: "running" });
  });

  it("评审分为 null（解析失败视为通过）时照常归约", () => {
    const s2 = reduceAll(
      [
        { event: "delta", data: { round: 0, text: "译文" } },
        { event: "review", data: { round: 0, score: null, passed: true, issues: [] } },
        { event: "node", data: { seq: 9, node: "refine", status: "skipped", summary: "评审通过，无需修正" } },
      ],
      { ...initialRunState, status: "running" },
    );
    expect(latestReview(s2)).toMatchObject({ score: null, passed: true });
    expect(s2.nodes).toEqual([
      expect.objectContaining({ node: "refine", status: "skipped" }),
    ]);
  });

  it("用户指定源语言时没有 detect 事件，detect 保持为空", () => {
    const evs = events(sampleStreams().fast).filter((e) => e.event !== "detect");
    expect(reduceAll(evs).detect).toBeUndefined();
  });

  it("error 事件使状态变为 error", () => {
    const s2 = reduceRun(initialRunState, { event: "error", data: { code: "C0121", message: "鉴权失败" } });
    expect(s2.status).toBe("error");
    expect(s2.error?.code).toBe("C0121");
  });
});

describe("createRunStore（useTranslationRun 的底层 store）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("经由 fetch + SSE 解析驱动到 done，并在 final 后触发历史失效回调", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sampleStreams().standard, 11)));
    const onFinal = vi.fn();
    const store = createRunStore({ stream: translateApi.stream, onFinal });
    await store.getState().start(REQ);
    const s = store.getState();
    expect(s.status).toBe("done");
    expect(s.request).toEqual(REQ);
    expect(s.rounds).toHaveLength(2);
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal.mock.calls[0][0].recordId).toBe(102);
  });

  it("再次发起翻译时清空上一次的结果（final / detect / plan / 耗时）", async () => {
    const store = createRunStore({ stream: translateApi.stream });
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sampleStreams().fast)));
    await store.getState().start(REQ);
    expect(store.getState().final?.recordId).toBe(101);
    let observed: unknown = "unset";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const s = store.getState();
        observed = { status: s.status, final: s.final, plan: s.plan, finishedAt: s.finishedAt, rounds: s.rounds };
        return sseResponse(sampleStreams().standard);
      }),
    );
    await store.getState().start(REQ);
    expect(observed).toEqual({ status: "running", final: undefined, plan: undefined, finishedAt: undefined, rounds: [] });
    expect(store.getState().final?.recordId).toBe(102);
  });

  it("流建立前的 ApiError 归约为 error 状态（保留 traceId）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: "A0212", message: "过于频繁", data: null, traceId: "t1" }), {
          status: 429,
        }),
      ),
    );
    const store = createRunStore({ stream: translateApi.stream });
    await store.getState().start(REQ);
    expect(store.getState()).toMatchObject({ status: "error", error: { code: "A0212", traceId: "t1" } });
  });

  it("流在 final 之前断开时提示连接中断", async () => {
    const truncated = sampleStreams().fast.split("event: final")[0];
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(truncated)));
    const store = createRunStore({ stream: translateApi.stream });
    await store.getState().start(REQ);
    expect(store.getState()).toMatchObject({ status: "error", error: { code: "B0001" } });
  });

  it("stop() 中断请求，状态变为 stopped，且不触发 onFinal", async () => {
    const onFinal = vi.fn();
    const store = createRunStore({
      onFinal,
      stream: (_req, { signal, onEvent }) =>
        new Promise((_resolve, reject) => {
          onEvent({ event: "start", data: { requestId: "r" } });
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    const p = store.getState().start(REQ);
    expect(store.getState().status).toBe("running");
    store.getState().stop();
    await p;
    expect(store.getState().status).toBe("stopped");
    expect(onFinal).not.toHaveBeenCalled();
  });
});
