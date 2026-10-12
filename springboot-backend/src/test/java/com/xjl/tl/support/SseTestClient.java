package com.xjl.tl.support;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 测试用 SSE 客户端（模拟浏览器 fetch + ReadableStream）：逐行解析事件并记录到达时间，可中途关闭连接。
 */
public class SseTestClient {

    /** 一个事件；注释行以 event="comment" 表示。elapsedMs 为相对请求发出的到达时间。 */
    public record Event(String event, String data, long elapsedMs) {
        public boolean isComment() {
            return "comment".equals(event);
        }
    }

    private static final Event END = new Event("<end>", "", -1);

    private final String baseUrl;
    private final JsonMapper jsonMapper;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();

    public SseTestClient(String baseUrl, JsonMapper jsonMapper) {
        this.baseUrl = baseUrl;
        this.jsonMapper = jsonMapper;
    }

    /** 发起 POST /api/translate/stream。 */
    public Session open(String token, Object body) throws IOException, InterruptedException {
        return post("/api/translate/stream", token, body);
    }

    /** 发起 POST 事件流（如 /api/translate/sessions/{id}/revise）。 */
    public Session post(String path, String token, Object body) throws IOException, InterruptedException {
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .header("Authorization", "Bearer " + token)
                .POST(HttpRequest.BodyPublishers.ofString(jsonMapper.writeValueAsString(body)))
                .build();
        long start = System.nanoTime();
        HttpResponse<InputStream> resp = http.send(req, HttpResponse.BodyHandlers.ofInputStream());
        return new Session(resp, start);
    }

    /** 发起 multipart POST 事件流（如 /api/image-translations）；parts 的值为 String 或 {@link FilePart}，List 表示重复字段。 */
    public Session multipart(String path, String token, java.util.Map<String, Object> parts)
            throws IOException, InterruptedException {
        String boundary = "----tl-test-" + System.nanoTime();
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        for (var e : parts.entrySet()) {
            List<?> values = e.getValue() instanceof List<?> l ? l : List.of(e.getValue());
            for (Object v : values) {
                out.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
                if (v instanceof FilePart f) {
                    out.write(("Content-Disposition: form-data; name=\"" + e.getKey() + "\"; filename=\"" + f.filename()
                            + "\"\r\nContent-Type: " + f.contentType() + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    out.write(f.bytes());
                } else {
                    out.write(("Content-Disposition: form-data; name=\"" + e.getKey() + "\"\r\n\r\n" + v)
                            .getBytes(StandardCharsets.UTF_8));
                }
                out.write("\r\n".getBytes(StandardCharsets.UTF_8));
            }
        }
        out.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .header("Accept", "text/event-stream")
                .header("Authorization", "Bearer " + token)
                .POST(HttpRequest.BodyPublishers.ofByteArray(out.toByteArray()))
                .build();
        long start = System.nanoTime();
        HttpResponse<InputStream> resp = http.send(req, HttpResponse.BodyHandlers.ofInputStream());
        return new Session(resp, start);
    }

    /** multipart 文件字段。 */
    public record FilePart(String filename, String contentType, byte[] bytes) {
    }

    /** 发起 GET 订阅（如 /api/doc-tasks/{id}/events）。 */
    public Session get(String path, String token) throws IOException, InterruptedException {
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .header("Accept", "text/event-stream")
                .header("Authorization", "Bearer " + token)
                .GET()
                .build();
        long start = System.nanoTime();
        HttpResponse<InputStream> resp = http.send(req, HttpResponse.BodyHandlers.ofInputStream());
        return new Session(resp, start);
    }

    public final class Session implements AutoCloseable {
        private final HttpResponse<InputStream> response;
        private final long startNanos;
        private final BlockingQueue<Event> queue = new LinkedBlockingQueue<>();
        private final List<Event> received = new ArrayList<>();
        private boolean ended;

        Session(HttpResponse<InputStream> response, long startNanos) {
            this.response = response;
            this.startNanos = startNanos;
            if (response.statusCode() == 200) {
                Thread reader = new Thread(this::readLoop, "sse-test-reader");
                reader.setDaemon(true);
                reader.start();
            }
        }

        public int status() {
            return response.statusCode();
        }

        public String header(String name) {
            return response.headers().firstValue(name).orElse(null);
        }

        /** 非 200 时读取 JSON 响应体。 */
        public JsonNode jsonBody() throws IOException {
            try (InputStream in = response.body()) {
                return jsonMapper.readTree(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            }
        }

        /** 等待下一个非注释事件；流结束或超时返回 null。 */
        public Event next(Duration timeout) throws InterruptedException {
            long deadline = System.nanoTime() + timeout.toNanos();
            while (!ended) {
                long left = deadline - System.nanoTime();
                Event e = queue.poll(Math.max(left, 0), TimeUnit.NANOSECONDS);
                if (e == null) {
                    return null;
                }
                if (e == END) {
                    ended = true;
                    return null;
                }
                received.add(e);
                if (!e.isComment()) {
                    return e;
                }
            }
            return null;
        }

        /** 读取到流结束（或超时），返回全部事件（含注释）。 */
        public List<Event> readAll(Duration timeout) throws InterruptedException {
            long deadline = System.nanoTime() + timeout.toNanos();
            while (!ended) {
                long left = deadline - System.nanoTime();
                if (left <= 0) {
                    throw new AssertionError("事件流在 " + timeout + " 内没有结束，已收到：" + received);
                }
                Event e = queue.poll(left, TimeUnit.NANOSECONDS);
                if (e == null) {
                    continue;
                }
                if (e == END) {
                    ended = true;
                } else {
                    received.add(e);
                }
            }
            return List.copyOf(received);
        }

        public boolean ended() {
            return ended;
        }

        public List<Event> received() {
            return List.copyOf(received);
        }

        /** 模拟浏览器中断：关闭连接。 */
        @Override
        public void close() {
            try {
                response.body().close();
            } catch (IOException ignored) {
                // 已关闭
            }
        }

        private void readLoop() {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
                String event = null;
                StringBuilder data = null;
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.isEmpty()) {
                        if (data != null || event != null) {
                            queue.add(new Event(event == null ? "message" : event, data == null ? "" : data.toString(), elapsed()));
                        }
                        event = null;
                        data = null;
                    } else if (line.startsWith(":")) {
                        queue.add(new Event("comment", line.substring(1), elapsed()));
                    } else if (line.startsWith("event:")) {
                        event = stripOneSpace(line.substring(6));
                    } else if (line.startsWith("data:")) {
                        String d = stripOneSpace(line.substring(5));
                        data = data == null ? new StringBuilder(d) : data.append('\n').append(d);
                    }
                }
            } catch (IOException ignored) {
                // 连接被关闭
            } finally {
                queue.add(END);
            }
        }

        private long elapsed() {
            return (System.nanoTime() - startNanos) / 1_000_000;
        }
    }

    private static String stripOneSpace(String s) {
        return s.startsWith(" ") ? s.substring(1) : s;
    }
}
