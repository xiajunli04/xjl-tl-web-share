import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 三端共享的契约样例：docs/contracts/translate-stream-sample.txt */
export const SAMPLE_PATH = fileURLToPath(
  new URL("../../../../docs/contracts/translate-stream-sample.txt", import.meta.url),
);

export function loadSample() {
  return readFileSync(SAMPLE_PATH, "utf-8");
}

/** 按 "### STREAM: <name>" 切分样例，返回各段原始 SSE 文本 */
export function sampleStreams(): Record<string, string> {
  const text = loadSample();
  const parts = text.split(/^### STREAM: (\w+)\r?\n/m);
  const out: Record<string, string> = {};
  for (let i = 1; i < parts.length; i += 2) out[parts[i]] = parts[i + 1].replace(/\s+$/, "") + "\n\n";
  return out;
}

/** 把字符串编码为字节并按给定大小切块，用于覆盖跨 chunk（含多字节字符被截断）的情况 */
export function byteStream(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

export function sseResponse(text: string, chunkSize = 37): Response {
  return new Response(byteStream(text, chunkSize), {
    status: 200,
    headers: { "Content-Type": "text/event-stream;charset=UTF-8" },
  });
}
