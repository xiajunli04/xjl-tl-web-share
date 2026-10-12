import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseParser, readSseStream, streamSse, type SseMessage } from "@/lib/sse";
import { ApiError } from "@/lib/http";
import { toTranslateEvent } from "@/lib/api/translate";
import { SAMPLE_STREAM_FAST, SAMPLE_STREAM_STANDARD } from "@/lib/mock/stream-sample";
import { currentTranslation, reduceAll } from "@/lib/translation-run";
import { byteStream, loadSample, sampleStreams, sseResponse } from "./helpers";

function parseAll(text: string, step?: number): SseMessage[] {
  const out: SseMessage[] = [];
  const p = createSseParser((m) => out.push(m));
  if (!step) p.feed(text);
  else for (let i = 0; i < text.length; i += step) p.feed(text.slice(i, i + step));
  p.end();
  return out;
}

const FAST_EVENTS = [
  "start",
  "node",
  "detect",
  "node",
  "node",
  "plan",
  "node",
  "node",
  "node",
  "delta",
  "delta",
  "node",
  "node",
  "node",
  "node",
  "node",
  "final",
];

describe("createSseParser · 契约样例", () => {
  const streams = sampleStreams();

  it("样例包含 fast 与 standard 两段", () => {
    expect(Object.keys(streams)).toEqual(["fast", "standard"]);
  });

  it("fast 段事件顺序正确，且每个 data 都是合法 JSON", () => {
    const msgs = parseAll(streams.fast);
    expect(msgs.map((m) => m.event)).toEqual(FAST_EVENTS);
    for (const m of msgs) expect(() => JSON.parse(m.data)).not.toThrow();
    expect(msgs.at(-1)?.event).toBe("final");
  });

  it("standard 段以 final 结束，心跳注释被忽略，delta 中的换行与空格原样保留", () => {
    const msgs = parseAll(streams.standard);
    expect(msgs).toHaveLength(27);
    expect(msgs.every((m) => m.event !== "message")).toBe(true);
    expect(msgs.at(-1)?.event).toBe("final");
    const firstDelta = msgs.find((m) => m.event === "delta")!;
    expect(JSON.parse(firstDelta.data).text).toBe("机器学习模型\n通常在 ");
    const reviews = msgs.filter((m) => m.event === "review").map((m) => JSON.parse(m.data));
    expect(reviews.map((r) => [r.round, r.score, r.passed])).toEqual([
      [0, 72, false],
      [1, 93, true],
    ]);
  });

  it("整份样例文件（含 # 说明行与分隔行）作为一个流解析时，说明行被当作未知字段忽略", () => {
    // 样例文件末尾没有空行，按规范最后一个事件需要补一个空行才会分发
    const all = parseAll(loadSample() + "\n\n");
    expect(all).toHaveLength(FAST_EVENTS.length + 27);
    expect(all.filter((m) => m.event === "final")).toHaveLength(2);
  });

  it("逐字符喂入与 CRLF 换行得到完全相同的结果", () => {
    const whole = parseAll(streams.standard);
    expect(parseAll(streams.standard, 1)).toEqual(whole);
    expect(parseAll(streams.standard, 7)).toEqual(whole);
    const crlf = streams.standard.replace(/\n/g, "\r\n");
    expect(parseAll(crlf, 1)).toEqual(whole);
    expect(parseAll(streams.standard.replace(/\n/g, "\r"), 3)).toEqual(whole);
  });

  it("开发 mock 内嵌的样例与 docs 中的契约样例一致", () => {
    expect(parseAll(SAMPLE_STREAM_FAST)).toEqual(parseAll(streams.fast));
    expect(parseAll(SAMPLE_STREAM_STANDARD)).toEqual(parseAll(streams.standard));
  });

  it("全部事件都能转换为类型化的翻译事件", () => {
    const events = parseAll(streams.standard).map(toTranslateEvent);
    expect(events.every((e) => e !== null)).toBe(true);
  });
});

describe("createSseParser · 规范细节", () => {
  it("多行 data 以 \\n 拼接，冒号后仅去掉一个空格", () => {
    const msgs = parseAll("event: x\ndata: a\ndata:  b\ndata:c\n\n");
    expect(msgs).toEqual([{ event: "x", data: "a\n b\nc", id: undefined }]);
  });

  it("注释行、无 data 的事件不分发；未指定事件名时默认为 message", () => {
    const msgs = parseAll(": ping\n\nevent: lonely\n\ndata: 1\n\n");
    expect(msgs).toEqual([{ event: "message", data: "1", id: undefined }]);
  });

  it("流在事件中途结束时丢弃不完整的事件", () => {
    expect(parseAll("event: a\ndata: {}\n")).toEqual([]);
  });
});

describe("真实 Spring 输出（字段冒号后无空格、:ping 心跳）", () => {
  const raw = readFileSync(
    fileURLToPath(new URL("./fixtures/real-run-via-spring.sse.txt", import.meta.url)),
    "utf-8",
  );
  // 夹具由文件保存，末尾可能缺少分发 final 所需的空行
  const real = raw.endsWith("\n\n") ? raw : raw.replace(/\n?$/, "\n\n");

  it("real-run-via-spring.sse.txt 解析为完整事件序列，以 final 结束", () => {
    const msgs = parseAll(real);
    expect(msgs).toHaveLength(45);
    expect(msgs[0]).toMatchObject({ event: "start" });
    expect(msgs.at(-1)?.event).toBe("final");
    const deltas = msgs.filter((m) => m.event === "delta").map((m) => JSON.parse(m.data).text as string);
    expect(deltas).toHaveLength(26);
    // 带前导空格的增量必须原样保留
    expect(deltas).toContain(" 分");
    expect(deltas.join("")).toBe(JSON.parse(msgs.at(-1)!.data).translation);
  });

  it("逐字节切块读取真实流结果一致", async () => {
    const msgs: SseMessage[] = [];
    await readSseStream(byteStream(real, 3), (m) => msgs.push(m));
    expect(msgs).toEqual(parseAll(real));
  });

  it("有无前导空格两种写法等价；只去掉一个空格", () => {
    expect(parseAll('event:final\ndata:{"x":1}\n\n')).toEqual(parseAll('event: final\ndata: {"x":1}\n\n'));
    expect(parseAll("data:  two\n\n")[0].data).toBe(" two");
  });

  it(":ping 与 : ping 两种心跳都被忽略", () => {
    const msgs = parseAll(':ping\n\n: ping\n\nevent:node\n:ping\ndata:{"seq":1}\n\n');
    expect(msgs).toEqual([{ event: "node", data: '{"seq":1}', id: undefined }]);
  });

  it("驱动 useTranslationRun 的归约：首轮通过、refine 跳过", () => {
    const events = parseAll(real)
      .map(toTranslateEvent)
      .filter((e): e is NonNullable<typeof e> => e !== null);
    const s = reduceAll(events);
    expect(s.status).toBe("done");
    expect(s.rounds).toHaveLength(1);
    expect(s.rounds[0].review?.score).toBe(100);
    expect(s.nodes.find((n) => n.node === "refine")?.status).toBe("skipped");
    expect(currentTranslation(s)).toBe(s.final?.translation);
    expect(s.final?.recordId).toBe(1);
  });
});

describe("readSseStream", () => {
  it("按字节切块（多字节字符被截断）时仍能正确解码", async () => {
    const msgs: SseMessage[] = [];
    await readSseStream(byteStream(sampleStreams().standard, 5), (m) => msgs.push(m));
    expect(msgs).toEqual(parseAll(sampleStreams().standard));
  });

  it("AbortSignal 中断后以 AbortError 结束", async () => {
    const ctrl = new AbortController();
    const msgs: SseMessage[] = [];
    const p = readSseStream(byteStream(sampleStreams().standard, 16), (m) => {
      msgs.push(m);
      if (msgs.length === 3) ctrl.abort();
    }, ctrl.signal);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(msgs.length).toBeLessThan(27);
  });
});

describe("streamSse", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("2xx 事件流：逐条回调", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(sampleStreams().fast)));
    const msgs: SseMessage[] = [];
    await streamSse("/api/translate/stream", { text: "Good morning" }, { onMessage: (m) => msgs.push(m) });
    expect(msgs.map((m) => m.event)).toEqual(FAST_EVENTS);
  });

  it("流建立之前的非 2xx JSON 错误解析为 ApiError（含 traceId）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ code: "A0212", message: "翻译请求过于频繁", data: null, traceId: "t-429" }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const err = await streamSse("/api/translate/stream", {}, { onMessage: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "A0212", traceId: "t-429", httpStatus: 429 });
  });

  it.each([
    [400, "A0410"],
    [400, "A0420"],
    [404, "A0404"],
    [429, "A0212"],
    [502, "C0130"],
  ])("建流前 HTTP %i + application/json → ApiError(%s)", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code, message: "err", data: null, traceId: "tid" }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const err = await streamSse("/api/translate/stream", {}, { onMessage: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code, httpStatus: status, traceId: "tid" });
  });

  it("HTTP 200 但 Content-Type 不是 text/event-stream 时按信封抛出", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: "C0130", message: "未配置默认模型", data: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const err = await streamSse("/api/translate/stream", {}, { onMessage: () => {} }).catch((e) => e);
    expect(err).toMatchObject({ code: "C0130" });
  });

  it("非 JSON 的错误响应返回 B0001", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    const err = await streamSse("/api/translate/stream", {}, { onMessage: () => {} }).catch((e) => e);
    expect(err).toMatchObject({ code: "B0001", httpStatus: 502 });
  });
});
