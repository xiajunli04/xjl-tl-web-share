import { describe, expect, it } from "vitest";
import { createSseParser, type SseMessage } from "@/lib/sse";
import { toTranslateEvent, type TranslateEvent } from "@/lib/api/translate";
import type { SessionDetailVO, RecordBrief } from "@/lib/api/sessions";
import { createRunStore, initialRunState, reduceAll, sessionTurnsOf, tmHitsOf } from "@/lib/translation-run";
import { diffText, sideOf, similarity, tokenize } from "@/lib/text-diff";
import { matchInfo, matchScore, originInfo } from "@/lib/tm-match";
import { buildThread, defaultTitle, groupSessions, pickAdopted, turnOfRecord } from "@/lib/session-thread";

function events(text: string): TranslateEvent[] {
  const out: SseMessage[] = [];
  const p = createSseParser((m) => out.push(m));
  p.feed(text);
  p.end();
  return out.map(toTranslateEvent).filter((e): e is TranslateEvent => e !== null);
}

const sse = (event: string, data: unknown) => `event:${event}\ndata:${JSON.stringify(data)}\n\n`;

const HIT = { id: 5, source: "Restart the Pod after updating the ConfigMap.", target: "更新 ConfigMap 后重启该 Pod。", fuzzy: 0.8132, semantic: 0.95, origin: "document", originRef: "12:5" };

const INTERRUPTED =
  sse("start", { requestId: "abc" }) +
  sse("node", { seq: 1, node: "analyze", status: "started" }) +
  sse("node", { seq: 2, node: "analyze", status: "completed", summary: "识别为英语" }) +
  sse("node", { seq: 3, node: "plan", status: "started" }) +
  sse("plan", { path: "standard", domain: "金融", reason: "会话请求" }) +
  sse("node", { seq: 4, node: "plan", status: "completed" }) +
  sse("node", { seq: 5, node: "clarify", status: "started" }) +
  sse("node", { seq: 6, node: "clarify", status: "interrupted", summary: "等待澄清" }) +
  sse("clarify", { threadId: "turn:abc", question: "bank 指什么？", options: ["银行", "河岸"], span: "bank", reason: "多义词" });

const RESUMED =
  sse("start", { requestId: "abc" }) +
  sse("node", { seq: 1, node: "clarify", status: "started" }) +
  sse("node", { seq: 2, node: "clarify", status: "completed", summary: "用户澄清：银行" }) +
  sse("node", { seq: 3, node: "retrieve", status: "started" }) +
  sse("node", { seq: 4, node: "retrieve", status: "completed", summary: "上下文包", detail: { tmHits: [HIT], sessionTurns: 2 } }) +
  sse("node", { seq: 5, node: "translate", status: "started" }) +
  sse("delta", { round: 0, text: "请寄到银行。" }) +
  sse("node", { seq: 6, node: "translate", status: "completed" }) +
  sse("memory", { summary: "早期摘要", entities: [{ source: "X200", target: "X200", note: "型号" }], memorizedUntil: 3 }) +
  sse("final", {
    translation: "请寄到银行。",
    sourceLang: "en",
    targetLang: "zh",
    path: "standard",
    domain: "金融",
    compliance: [],
    usage: { promptTokens: 1, completionTokens: 1 },
    latencyMs: 10,
    clarification: { question: "bank 指什么？", options: ["银行", "河岸"], span: "bank", answer: "银行" },
    tmHits: [HIT],
    recordId: 12,
    sessionId: 7,
    revisionOf: null,
  });

describe("SSE 新事件 · clarify / memory / node.detail / final 新字段", () => {
  it("解析 clarify（终止事件）与 interrupted 节点", () => {
    const es = events(INTERRUPTED);
    expect(es.at(-1)).toEqual({
      event: "clarify",
      data: { threadId: "turn:abc", question: "bank 指什么？", options: ["银行", "河岸"], span: "bank", reason: "多义词" },
    });
    const s = reduceAll(es);
    expect(s.status).toBe("clarify");
    expect(s.final).toBeUndefined();
    expect(s.clarify?.threadId).toBe("turn:abc");
    expect(s.nodes.find((n) => n.node === "clarify")?.status).toBe("interrupted");
  });

  it("恢复流接着归约：clarify 节点原地改为完成，节点 key 不与中断前冲突，带上 memory / tmHits / 会话字段", () => {
    const first = reduceAll(events(INTERRUPTED));
    const resumed = reduceAll(events(RESUMED), { ...first, resumes: 1, status: "running" });
    expect(resumed.status).toBe("done");
    expect(resumed.nodes.map((n) => n.node)).toEqual(["analyze", "plan", "clarify", "retrieve", "translate"]);
    expect(resumed.nodes.filter((n) => n.node === "clarify")).toHaveLength(1);
    expect(resumed.nodes.find((n) => n.node === "clarify")?.status).toBe("completed");
    expect(new Set(resumed.nodes.map((n) => n.key)).size).toBe(resumed.nodes.length);
    expect(resumed.memory?.memorizedUntil).toBe(3);
    expect(resumed.final?.clarification?.answer).toBe("银行");
    expect(resumed.final?.sessionId).toBe(7);
    expect(tmHitsOf(resumed)).toEqual([HIT]);
    expect(sessionTurnsOf(resumed)).toBe(2);
  });

  it("tmHitsOf：final 优先，其次 retrieve detail，缺字段时为空数组", () => {
    const onlyNode = reduceAll(events(RESUMED).filter((e) => e.event !== "final"));
    expect(tmHitsOf(onlyNode)).toEqual([HIT]);
    expect(tmHitsOf(initialRunState)).toEqual([]);
    const legacy = reduceAll(events(sse("node", { seq: 1, node: "retrieve", status: "completed" })));
    expect(tmHitsOf(legacy)).toEqual([]);
    expect(sessionTurnsOf(legacy)).toBeUndefined();
  });

  it("未知事件名被忽略", () => {
    expect(events(sse("whatever", { a: 1 }))).toEqual([]);
  });
});

describe("运行 store · clarify 结束与恢复", () => {
  const play = (text: string) => async (o: { onEvent: (e: TranslateEvent) => void }) => {
    for (const e of events(text)) o.onEvent(e);
  };

  it("以 clarify 结束不视为连接中断；keep 恢复后时间线连续，seed 带上回答", async () => {
    const seen: string[] = [];
    const store = createRunStore({ stream: async () => {}, onSessionEvent: (e, sid) => seen.push(`${e.event}:${sid}`) });
    await store.getState().run(play(INTERRUPTED), { kind: "translate", sessionId: 7, request: { text: "Please send it to the bank.", sourceLang: "auto", targetLang: "zh", mode: "auto", style: "faithful", sessionId: 7 } });
    expect(store.getState().status).toBe("clarify");
    expect(store.getState().error).toBeUndefined();

    const clarify = { ...store.getState().clarify!, answer: "银行" };
    await store.getState().run(play(RESUMED), { kind: "resume", keep: true, sessionId: 7, seed: { clarify } });
    const s = store.getState();
    expect(s.status).toBe("done");
    expect(s.clarify?.answer).toBe("银行");
    expect(s.request?.text).toBe("Please send it to the bank.");
    expect(s.nodes[0].node).toBe("analyze");
    expect(s.kind).toBe("resume");
    expect(seen).toEqual(["clarify:7", "memory:7", "final:7"]);
  });

  it("retry 重放上一次运行（修订 / 恢复同样适用）", async () => {
    let calls = 0;
    const store = createRunStore({ stream: async () => {} });
    await store.getState().run(async () => {
      calls++;
    }, { kind: "revise", sessionId: 1, reviseOf: 3, instruction: "更口语" });
    expect(store.getState().status).toBe("error");
    await store.getState().retry();
    expect(calls).toBe(2);
    expect(store.getState().instruction).toBe("更口语");
  });
});

describe("text-diff · 差异高亮", () => {
  it("拉丁文字按词切分，中文逐字切分", () => {
    expect(tokenize("Restart the Pod.")).toEqual(["Restart", " ", "the", " ", "Pod", "."]);
    expect(tokenize("重启该Pod")).toEqual(["重", "启", "该", "P", "o", "d"]);
  });

  it("英文：只有替换的词被标记", () => {
    const parts = diffText("Restart the Pod after updating the ConfigMap.", "Restart the Pod after updating the Secret.");
    expect(sideOf(parts, "a").filter((p) => p.changed).map((p) => p.text)).toEqual(["ConfigMap"]);
    expect(sideOf(parts, "b").filter((p) => p.changed).map((p) => p.text)).toEqual(["Secret"]);
    // 两侧拼回原文
    expect(sideOf(parts, "a").map((p) => p.text).join("")).toBe("Restart the Pod after updating the ConfigMap.");
    expect(sideOf(parts, "b").map((p) => p.text).join("")).toBe("Restart the Pod after updating the Secret.");
  });

  it("中文逐字对比，相同文本没有差异，空串安全", () => {
    const parts = diffText("我上周买了耳机", "我昨天买了耳机");
    expect(sideOf(parts, "a").filter((p) => p.changed).map((p) => p.text)).toEqual(["上周"]);
    expect(diffText("相同", "相同")).toEqual([{ op: "equal", text: "相同" }]);
    expect(diffText("", "abc")).toEqual([{ op: "insert", text: "abc" }]);
  });

  it("similarity 与 difflib ratio 同量纲", () => {
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("", "")).toBe(1);
    expect(similarity("abcd", "abef")).toBeCloseTo(0.5);
    expect(similarity("Restart the Pod after updating the ConfigMap.", "Restart the Pod after updating the Secret.")).toBeGreaterThan(0.75);
  });
});

describe("tm-match · 匹配度格式化与来源", () => {
  it("100% / 字面百分比 / 语义", () => {
    expect(matchInfo({ fuzzy: 1, semantic: 1 })).toMatchObject({ kind: "exact", label: "100%", percent: 100 });
    expect(matchInfo({ fuzzy: 0.92, semantic: 0.97 })).toMatchObject({ kind: "fuzzy", label: "92%" });
    expect(matchInfo({ fuzzy: 0.4, semantic: 0.91 })).toMatchObject({ kind: "semantic", label: "语义", percent: 91 });
  });

  it("非完全匹配最多显示 99%，缺字段或非法值按 0 处理", () => {
    expect(matchInfo({ fuzzy: 0.996, semantic: 1 }).label).toBe("99%");
    expect(matchInfo({ fuzzy: undefined as unknown as number, semantic: Number.NaN })).toMatchObject({ kind: "semantic", percent: 0 });
    expect(matchInfo({ fuzzy: 1.5, semantic: -1 }).kind).toBe("exact");
  });

  it("排序分 max(fuzzy, 0.9 × semantic)", () => {
    expect(matchScore({ fuzzy: 0.5, semantic: 1 })).toBeCloseTo(0.9);
    expect(matchScore({ fuzzy: 0.95, semantic: 0.9 })).toBeCloseTo(0.95);
  });

  it("来源跳转：工作台 → 历史详情；文档 → 工作区段落；无法解析时没有链接", () => {
    expect(originInfo("workbench", "123")).toEqual({ kind: "workbench", label: "工作台 · 记录 #123", href: "/history?open=123" });
    expect(originInfo("document", "12:5")).toEqual({ kind: "document", label: "文档任务 #12 · §5", href: "/documents/12?seq=5" });
    expect(originInfo("document", "bad").href).toBeNull();
    expect(originInfo("workbench", null).href).toBeNull();
    expect(originInfo(undefined, undefined).kind).toBe("other");
  });
});

const rec = (id: number, p: Partial<RecordBrief> = {}): RecordBrief => ({
  id,
  sourceText: `src-${id}`,
  targetText: `tgt-${id}`,
  mode: "auto",
  path: "fast",
  reviseInstruction: null,
  clarification: null,
  revisionOf: null,
  adopted: false,
  reviewScore: null,
  createdAt: `2026-10-01T00:00:0${id % 10}Z`,
  ...p,
});

describe("session-thread · 线程与版本链组装", () => {
  const detail: Pick<SessionDetailVO, "turns"> = {
    turns: [
      { seq: 2, versions: [rec(13, { revisionOf: 12, path: "revise", reviseInstruction: "更口语", adopted: true }), rec(12)], adoptedRecordId: 13 },
      { seq: 1, versions: [rec(11, { adopted: true, clarification: { question: "q", options: ["a", "b"], span: "x", answer: "a" } })], adoptedRecordId: 11 },
    ],
  };

  it("轮次按 seq、版本按 createdAt 升序，v1 为原始翻译", () => {
    const t = buildThread(detail);
    expect(t.map((x) => x.seq)).toEqual([1, 2]);
    expect(t[1].versions.map((v) => `${v.label}:${v.id}`)).toEqual(["v1:12", "v2:13"]);
    expect(t[1].adopted.id).toBe(13);
    expect(t[1].adoptedIndex).toBe(1);
    expect(t[1].source).toBe("src-12");
    expect(t[0].clarification?.answer).toBe("a");
  });

  it("乐观覆盖优先于 adoptedRecordId", () => {
    const t = buildThread(detail, new Map([[2, 12]]));
    expect(t[1].adopted.label).toBe("v1");
  });

  it("采用标记兜底：adoptedRecordId 缺失 → adopted=true → 最新版本", () => {
    expect(pickAdopted({ versions: [rec(1), rec(2, { adopted: true }), rec(3)], adoptedRecordId: null })).toBe(1);
    expect(pickAdopted({ versions: [rec(1), rec(2)], adoptedRecordId: 99 })).toBe(1);
  });

  it("后端缺字段不崩：没有 turns / 空版本的轮次被跳过", () => {
    expect(buildThread(undefined)).toEqual([]);
    expect(buildThread({ turns: null as unknown as [] })).toEqual([]);
    expect(buildThread({ turns: [{ seq: 1, versions: [], adoptedRecordId: null }] })).toEqual([]);
  });

  it("turnOfRecord 找到记录所在轮次", () => {
    const t = buildThread(detail);
    expect(turnOfRecord(t, 12)).toBe(2);
    expect(turnOfRecord(t, 999)).toBeNull();
    expect(turnOfRecord(t, null)).toBeNull();
  });

  it("会话按今天 / 更早分组，空组不返回", () => {
    const now = new Date(2026, 9, 4, 15, 0, 0);
    const g = groupSessions(
      [
        { id: 1, updatedAt: new Date(2026, 9, 4, 9).toISOString() },
        { id: 2, updatedAt: new Date(2026, 9, 3, 23).toISOString() },
        { id: 3, updatedAt: "bad" },
      ],
      now,
    );
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([
      ["今天", [1]],
      ["更早", [2, 3]],
    ]);
    expect(groupSessions([], now)).toEqual([]);
  });

  it("默认标题取前 20 个字符", () => {
    expect(defaultTitle("  I bought the X200 headphones last week.  ")).toBe("I bought the X200 he…");
    expect(defaultTitle("短句")).toBe("短句");
    expect(defaultTitle("   ")).toBe("新会话");
  });
});
