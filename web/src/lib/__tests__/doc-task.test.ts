import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completedChunksOf,
  createDocTaskStore,
  initialDocTaskState,
  reduceDocEvents,
  reduceDocTask,
  withSegments,
} from "@/lib/doc-task";
import { docApi, type DocEvent, type DocSegmentVO } from "@/lib/api/documents";
import { subscribeSse } from "@/lib/sse";
import { ApiError } from "@/lib/http";
import { useAuthStore } from "@/stores/auth";
import { baseTask, fullRunEvents, sampleBlocks, toBrowserEvents, toSseText, type StreamEvent } from "./doc-helpers";
import { sseResponse } from "./helpers";

const RUN = toBrowserEvents(fullRunEvents());
const byName = (name: DocEvent["event"]) => RUN.events.filter((e) => e.event === name);

/** 把段落加载插入到 parsed 之后（模拟 useDocTask 收到 parsed 后重新拉取） */
function reduceWithSegmentsAfterParsed(events: DocEvent[], segments: DocSegmentVO[]) {
  let s = initialDocTaskState;
  for (const e of events) {
    s = reduceDocTask(s, e, 1000);
    if (e.event === "parsed") s = withSegments(s, segments);
  }
  return s;
}

describe("reduceDocTask · 契约样例（doc-stream-sample.md 2.1 经 Spring 转换）", () => {
  const s = reduceWithSegmentsAfterParsed(RUN.events, RUN.segments);

  it("终态为 COMPLETED，进度 2/2，统计与用量来自 completed", () => {
    expect(s.task?.status).toBe("COMPLETED");
    expect(s.task?.progressDone).toBe(2);
    expect(s.task?.progressTotal).toBe(2);
    expect(s.task?.stats).toEqual({ chunks: 2, cachedChunks: 0, refined: 1, compliance: { ok: 3, total: 3 } });
    expect(s.task?.promptTokens).toBe(1960);
  });

  it("各段译文合成正确，一致性阶段修正的段落被覆盖并记录用于闪烁", () => {
    expect(s.segments?.map((x) => x.target)).toEqual([
      "图形处理器基础",
      "图形处理器可加速训练。",
      "用法",
      "每个训练轮次都使用图形处理器。",
    ]);
    expect(s.segments?.[3].reviewRounds).toBe(1);
    // 首译未遵循（compliant=false），一致性修正后按新译文重新判定为遵循
    expect(s.segments?.[3].compliance?.[0]).toEqual({ source: "GPU", target: "图形处理器", compliant: true });
    expect([...s.fixedAt.keys()]).toEqual([3]);
    expect(s.task?.consistencyReport?.issues[0]).toMatchObject({ term: "GPU", chosen: "图形处理器", fixedSegs: [3] });
  });

  it("parsed / analysis / awaiting_confirm 合成到任务与术语", () => {
    expect(s.task?.detectedLang).toBe("en");
    expect(s.task?.summary).toContain("GPU");
    expect(s.task?.domain).toBe("计算机");
    expect(s.terms?.map((t) => t.source)).toEqual(["GPU", "epoch", "training"]);
    expect([...s.doneChunks].sort()).toEqual([0, 1]);
  });

  it("待确认阶段的中间状态", () => {
    const idx = RUN.events.findIndex((e) => e.event === "awaiting_confirm");
    const mid = reduceDocEvents(RUN.events.slice(0, idx + 1));
    expect(mid.task?.status).toBe("AWAITING_CONFIRM");
    expect(mid.task?.phase).toBe("awaiting_confirm");
    expect(mid.terms).toHaveLength(3);
  });
});

describe("reduceDocTask · 去重与缓冲", () => {
  const [chunk0, chunk1] = byName("chunk_done") as Extract<DocEvent, { event: "chunk_done" }>[];

  it("重复的 chunk_done 不重复计数，也不覆盖译文", () => {
    let s = withSegments(reduceDocEvents([RUN.events[0], byName("parsed")[0]]), RUN.segments);
    s = reduceDocTask(s, chunk0);
    const tampered: DocEvent = {
      event: "chunk_done",
      data: { ...chunk0.data, progressDone: 2, segments: [{ ...chunk0.data.segments[0], target: "篡改" }] },
    };
    const again = reduceDocTask(s, tampered);
    expect(again.task?.progressDone).toBe(1);
    expect(again.segments?.[0].target).toBe("图形处理器基础");
    expect(again.log.at(-1)?.kind).toBe("duplicate");
  });

  it("chunk_done 不含已编辑段落时（Spring 行为），已编辑的译文保持不变", () => {
    const edited = RUN.segments.map((x) => (x.seq === 1 ? { ...x, target: "人工译文", edited: true, status: "TRANSLATED" } : x));
    let s = withSegments(reduceDocEvents([RUN.events[0], byName("parsed")[0]]), edited);
    s = reduceDocTask(s, {
      event: "chunk_done",
      data: { ...chunk0.data, segments: chunk0.data.segments.filter((u) => u.seq !== 1) },
    });
    expect(s.segments?.[0].target).toBe("图形处理器基础");
    expect(s.segments?.[1]).toMatchObject({ target: "人工译文", edited: true });
    expect(s.task?.progressDone).toBe(1);
  });

  it("用户操作推送的 phase（取消中 / 确认后翻译中）直接更新状态", () => {
    const s = reduceDocEvents([
      RUN.events[0],
      { event: "phase", data: { status: "TRANSLATING", phase: "translating" } },
      { event: "phase", data: { status: "CANCELLING", phase: "translating" } },
    ]);
    expect(s.task).toMatchObject({ status: "CANCELLING", phase: "translating" });
    expect(s.log.at(-1)?.title).toBe("正在取消任务");
  });

  it("completed 中个别字段为空时保留增量合成的摘要与一致性报告", () => {
    const done = RUN.events.at(-1) as Extract<DocEvent, { event: "completed" }>;
    const s = reduceDocEvents([
      ...RUN.events.slice(0, -1),
      { event: "completed", data: { ...done.data, summary: null, consistencyReport: null } },
    ]);
    expect(s.task?.summary).toContain("GPU");
    expect(s.task?.consistencyReport?.issues).toHaveLength(1);
  });

  it("段落加载前到达的分块译文被缓冲，加载后补应用", () => {
    let s = reduceDocEvents([RUN.events[0], byName("parsed")[0], chunk0]);
    expect(s.segments).toBeNull();
    expect(s.pendingUpdates).toHaveLength(2);
    s = withSegments(s, RUN.segments);
    expect(s.pendingUpdates).toHaveLength(0);
    expect(s.segments?.[1].target).toBe("图形处理器可加速训练。");
  });

  it("中途订阅：snapshot 为 1/2，之后的 chunk_done 推进到 2/2", () => {
    const snap: DocEvent = {
      event: "snapshot",
      data: baseTask({ status: "TRANSLATING", phase: "translating", progressDone: 1, progressTotal: 2 }),
    };
    const s = reduceDocEvents([snap, chunk1]);
    expect(s.task?.progressDone).toBe(2);
  });

  it("失败后 retry：段落中已完成的分块以 cached 重放时被跳过（2.2 样例）", () => {
    const retry = toBrowserEvents(sampleBlocks()[2] as unknown as StreamEvent[]);
    const translated = RUN.segments.map((x) =>
      x.chunkIndex === 0 ? { ...x, target: "已有译文", status: "TRANSLATED" } : x,
    );
    expect([...completedChunksOf(translated)]).toEqual([0]);
    const snap: DocEvent = {
      event: "snapshot",
      data: baseTask({ status: "FAILED", progressDone: 1, progressTotal: 2 }),
    };
    let s = withSegments(reduceDocEvents([snap]), translated);
    s = reduceDocEvents(retry.events.slice(1), s);
    const cached = retry.events.find((e) => e.event === "chunk_done");
    expect(cached && cached.event === "chunk_done" && cached.data.cached).toBe(true);
    expect(s.task?.progressDone).toBe(1);
    expect(s.segments?.[0].target).toBe("已有译文");
  });

  it("failed / cancelled（2.3 样例）写入错误信息与终结状态", () => {
    const [failed, cancelled] = toBrowserEvents(sampleBlocks()[3] as unknown as StreamEvent[]).events.slice(1);
    const f = reduceDocEvents([RUN.events[0], failed]);
    expect(f.task).toMatchObject({ status: "FAILED", errorCode: "C0122", retryable: true });
    const c = reduceDocEvents([RUN.events[0], cancelled]);
    expect(c.task?.status).toBe("CANCELLED");
  });
});

describe("createDocTaskStore · 订阅、重连与终结后停止", () => {
  beforeEach(() => useAuthStore.setState({ accessToken: "tok", refreshToken: "r" }));
  afterEach(() => vi.unstubAllGlobals());

  const subscribe: typeof docApi.subscribe = (id, opts) => {
    const { onEvent, ...rest } = opts;
    return subscribeSse(`/api/doc-tasks/${id}/events`, {
      ...rest,
      onMessage: (m) => {
        onEvent({ event: m.event, data: JSON.parse(m.data) } as DocEvent);
      },
    });
  };

  function translatedUpTo(chunk: number) {
    return RUN.segments.map((x) => {
      if ((x.chunkIndex ?? 99) > chunk) return x;
      const chunkEvt = byName("chunk_done").find(
        (e) => e.event === "chunk_done" && e.data.segments.some((u) => u.seq === x.seq),
      );
      const u = chunkEvt?.event === "chunk_done" ? chunkEvt.data.segments.find((v) => v.seq === x.seq) : undefined;
      return u ? { ...x, target: u.target, status: "TRANSLATED" } : x;
    });
  }

  it("断线重连：重新拉取段落、重放的 chunk_done 去重、completed 后停止且不再重连", async () => {
    const ev = RUN.events.filter((e) => e.event !== "awaiting_confirm");
    const firstChunk = ev.findIndex((e) => e.event === "chunk_done");
    const conn1 = ev.slice(0, firstChunk + 1); // 收到第 1 块后断线
    const snapshot2: DocEvent = {
      event: "snapshot",
      data: baseTask({ status: "TRANSLATING", phase: "translating", progressDone: 1, progressTotal: 2, detectedLang: "en" }),
    };
    const afterDone: DocEvent = { event: "phase", data: { status: "TRANSLATING", phase: "translating" } };
    const conn2 = [snapshot2, ev[firstChunk], ...ev.slice(firstChunk + 1), afterDone];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sseResponse(toSseText(conn1)))
      .mockResolvedValueOnce(sseResponse(toSseText(conn2)));
    vi.stubGlobal("fetch", fetchMock);

    const segmentCalls: number[] = [];
    const store = createDocTaskStore(42, {
      subscribe,
      segments: async () => {
        segmentCalls.push(Date.now());
        return segmentCalls.length === 1 ? RUN.segments : translatedUpTo(0);
      },
      terms: async () => RUN.terms,
      sleep: () => Promise.resolve(),
      idleTimeoutMs: 0,
    });
    store.getState().start();
    await store.getState().running;
    await new Promise((r) => setTimeout(r, 0));

    const s = store.getState();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(segmentCalls).toHaveLength(2); // parsed 后一次 + 重连 snapshot 后一次
    expect(s.snapshots).toBe(2);
    expect(s.task?.status).toBe("COMPLETED");
    expect(s.task?.progressDone).toBe(2);
    expect(s.conn).toBe("closed");
    expect(s.segments?.map((x) => x.target)).toEqual([
      "图形处理器基础",
      "图形处理器可加速训练。",
      "用法",
      "每个训练轮次都使用图形处理器。",
    ]);
    expect(s.log.filter((l) => l.kind === "duplicate")).toHaveLength(1);
    expect(s.log.some((l) => l.kind === "reconnecting")).toBe(true);
  });

  it("订阅时任务已终结：只收 snapshot，不重连", async () => {
    const done = baseTask({ status: "COMPLETED", progressDone: 2, progressTotal: 2 });
    const fetchMock = vi.fn(async () => sseResponse(toSseText([{ event: "snapshot", data: done }])));
    vi.stubGlobal("fetch", fetchMock);
    const store = createDocTaskStore(42, {
      subscribe,
      segments: async () => translatedUpTo(1),
      terms: async () => RUN.terms,
      sleep: () => Promise.resolve(),
      idleTimeoutMs: 0,
    });
    store.getState().start();
    await store.getState().running;
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getState().conn).toBe("closed");
    expect(store.getState().segments).toHaveLength(4);
    expect(store.getState().terms).toHaveLength(3);
  });

  it("任务不存在（A0404）：进入 error 状态，不重连", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "A0404", message: "资源不存在", data: null }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const store = createDocTaskStore(7, {
      subscribe,
      segments: async () => [],
      terms: async () => [],
      sleep: () => Promise.resolve(),
    });
    store.getState().start();
    await store.getState().running;
    expect(store.getState().conn).toBe("error");
    expect(store.getState().error).toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stop() 中断订阅后不再更新状态", async () => {
    let enqueue: ((s: string) => void) | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        enqueue = (s) => c.enqueue(new TextEncoder().encode(s));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })),
    );
    const store = createDocTaskStore(42, {
      subscribe,
      segments: async () => RUN.segments,
      terms: async () => [],
      sleep: () => Promise.resolve(),
      idleTimeoutMs: 0,
    });
    store.getState().start();
    await vi.waitFor(() => expect(enqueue).not.toBeNull());
    enqueue!(toSseText([RUN.events[0]]));
    await vi.waitFor(() => expect(store.getState().task?.status).toBe("PENDING"));
    store.getState().stop();
    expect(store.getState().conn).toBe("closed");
    await store.getState().running;
    expect(store.getState().task?.status).toBe("PENDING");
  });
});
