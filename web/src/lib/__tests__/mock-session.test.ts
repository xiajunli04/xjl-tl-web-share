import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SseMessage } from "@/lib/sse";
import { toTranslateEvent, type TranslateEvent } from "@/lib/api/translate";
import { reduceAll } from "@/lib/translation-run";
import { mockClarifyStream, mockReviseStream, mockTranslateStream } from "@/lib/mock/stream";
import * as store from "@/lib/mock/session-store";

/** 用假定时器跑完一条 mock 流，返回类型化事件 */
async function collect(start: (onMessage: (m: SseMessage) => void) => Promise<void>): Promise<TranslateEvent[]> {
  const out: SseMessage[] = [];
  const p = start((m) => out.push(m));
  await vi.runAllTimersAsync();
  await p;
  return out.map(toTranslateEvent).filter((e): e is TranslateEvent => e !== null);
}

describe("mock 会话流程（离线自查用）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("新会话三轮：歧义句以 clarify 结束并写入 pending，回答后从断点继续并写入带问答的记录", async () => {
    const s = store.createSession({ sourceLang: "en", targetLang: "zh" });
    const req = { text: "I bought the X200 headphones last week.", sourceLang: "en", targetLang: "zh", mode: "standard" as const, style: "faithful" as const, sessionId: s.id };
    const first = reduceAll(await collect((onMessage) => mockTranslateStream(req, { onMessage })));
    expect(first.status).toBe("done");
    expect(first.final?.sessionId).toBe(s.id);
    expect(first.final?.recordId).toBeTypeOf("number");

    const amb = { ...req, text: "Please send it to the bank." };
    const interrupted = reduceAll(await collect((onMessage) => mockTranslateStream(amb, { onMessage })));
    expect(interrupted.status).toBe("clarify");
    const detail = store.detailOf(store.getSession(s.id));
    expect(detail.pending?.span).toBe("bank");
    expect(detail.hasPending).toBe(true);

    const resumed = reduceAll(
      await collect((onMessage) => mockClarifyStream(s.id, { threadId: interrupted.clarify!.threadId, answer: "银行" }, { onMessage })),
      { ...interrupted, resumes: 1, status: "running" },
    );
    expect(resumed.status).toBe("done");
    expect(resumed.final?.translation).toContain("银行");
    expect(resumed.final?.clarification?.answer).toBe("银行");
    const after = store.detailOf(store.getSession(s.id));
    expect(after.pending).toBeNull();
    expect(after.turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(after.turns[1].versions[0].clarification?.answer).toBe("银行");
  });

  it("追问失效：threadId 不一致返回 A0440", async () => {
    const s = store.createSession({ sourceLang: "en", targetLang: "zh" });
    await expect(mockClarifyStream(s.id, { threadId: "turn:nope", answer: "x" }, { onMessage: () => {} })).rejects.toMatchObject({ code: "A0440" });
  });

  it("修订：走 revise 路径，新版本自动采用，切回 v1 后采用标记唯一", async () => {
    const s = store.createSession({ sourceLang: "en", targetLang: "zh" });
    const req = { text: "It stopped working yesterday.", sourceLang: "en", targetLang: "zh", mode: "fast" as const, style: "faithful" as const, sessionId: s.id };
    const v1 = reduceAll(await collect((onMessage) => mockTranslateStream(req, { onMessage })));
    const v2 = reduceAll(await collect((onMessage) => mockReviseStream(s.id, { recordId: v1.final!.recordId!, instruction: "更口语" }, { onMessage })));
    expect(v2.plan?.path).toBe("revise");
    expect(v2.nodes.find((n) => n.node === "retrieve")?.status).toBe("skipped");
    expect(v2.final?.revisionOf).toBe(v1.final?.recordId);
    let d = store.detailOf(store.getSession(s.id));
    expect(d.turns).toHaveLength(1);
    expect(d.turns[0].adoptedRecordId).toBe(v2.final?.recordId);
    d = store.adoptRecord(s.id, v1.final!.recordId!);
    expect(d.turns[0].versions.filter((v) => v.adopted).map((v) => v.id)).toEqual([v1.final?.recordId]);
  });

  it("翻译记忆：存入后相似句命中，带匹配度与来源", () => {
    store.upsertTm([{ sourceLang: "en", targetLang: "zh", sourceText: "Reboot the node before upgrading.", targetText: "升级前重启节点。", origin: "workbench", originRef: "1" }]);
    const r = store.searchTm("Reboot the node before upgrading it.", "en", "zh", 3, false);
    expect(r.hits[0]?.target).toBe("升级前重启节点。");
    expect(r.hits[0]?.fuzzy).toBeGreaterThan(0.85);
    // 重复写入覆盖
    store.upsertTm([{ sourceLang: "en", targetLang: "zh", sourceText: "reboot the node  before upgrading.", targetText: "升级之前先重启节点。", origin: "workbench", originRef: "2" }]);
    expect(store.listTm({ keyword: "reboot" }).records.map((e) => e.targetText)).toEqual(["升级之前先重启节点。"]);
  });
});
