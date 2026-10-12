package com.xjl.tl.support;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

/**
 * 测试用浏览器侧 WebSocket 客户端（JDK WebSocket，携带 Origin）：收集文本事件，可等待指定类型的事件与关闭码。
 */
public final class WsTestClient implements AutoCloseable {

    public static final String ORIGIN = "http://localhost:3000";
    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    private final WebSocket ws;
    private final BlockingQueue<JsonNode> queue = new LinkedBlockingQueue<>();
    private final List<JsonNode> all = new CopyOnWriteArrayList<>();
    private final CompletableFuture<Integer> closed = new CompletableFuture<>();

    private WsTestClient(String url) {
        Listener listener = new Listener();
        this.ws = HttpClient.newHttpClient().newWebSocketBuilder()
                .header("Origin", ORIGIN)
                .connectTimeout(Duration.ofSeconds(5))
                .buildAsync(URI.create(url), listener)
                .join();
    }

    /** 连接 ws://127.0.0.1:{port}/ws/interpret?ticket=…；握手失败时抛出 CompletionException（cause 为 WebSocketHandshakeException）。 */
    public static WsTestClient connect(int port, String ticket) {
        return new WsTestClient("ws://127.0.0.1:" + port + "/ws/interpret?ticket=" + ticket);
    }

    public void sendText(String text) {
        ws.sendText(text, true).join();
    }

    public void sendJson(Object o) {
        sendText(MAPPER.writeValueAsString(o));
    }

    public void sendAudio(int bytes) {
        ws.sendBinary(ByteBuffer.wrap(new byte[bytes]), true).join();
    }

    /** 等待下一个满足条件的事件（跳过其余事件）；超时返回 null。 */
    public JsonNode next(Predicate<JsonNode> match, Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (true) {
            long left = deadline - System.nanoTime();
            if (left <= 0) {
                return null;
            }
            JsonNode n = queue.poll(left, TimeUnit.NANOSECONDS);
            if (n == null) {
                return null;
            }
            if (match.test(n)) {
                return n;
            }
        }
    }

    /** 等待下一个 type 为指定值的事件。 */
    public JsonNode next(String type, Duration timeout) throws InterruptedException {
        return next(n -> type.equals(n.path("type").asString("")), timeout);
    }

    /** 等待下一个 type 为指定值的事件，超时则断言失败。 */
    public JsonNode expect(String type) throws InterruptedException {
        JsonNode n = next(type, Duration.ofSeconds(8));
        if (n == null) {
            throw new AssertionError("没有收到 " + type + " 事件，已收到：" + all);
        }
        return n;
    }

    /** 到目前为止收到的全部事件。 */
    public List<JsonNode> received() {
        return new ArrayList<>(all);
    }

    /** 收到的某类型事件。 */
    public List<JsonNode> received(String type) {
        return all.stream().filter(n -> type.equals(n.path("type").asString(""))).toList();
    }

    /** 等待连接被服务端关闭，返回关闭码；超时返回 null。 */
    public Integer awaitClose(Duration timeout) {
        try {
            return closed.get(timeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            return null;
        }
    }

    public boolean isClosed() {
        return closed.isDone();
    }

    @Override
    public void close() {
        if (!ws.isOutputClosed()) {
            try {
                ws.sendClose(WebSocket.NORMAL_CLOSURE, "").get(3, TimeUnit.SECONDS);
            } catch (Exception e) {
                ws.abort();
            }
        }
    }

    /** 立即断开（模拟网络中断）。 */
    public void abort() {
        ws.abort();
    }

    private final class Listener implements WebSocket.Listener {
        private final StringBuilder buffer = new StringBuilder();

        @Override
        public void onOpen(WebSocket webSocket) {
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            buffer.append(data);
            if (last) {
                JsonNode n = MAPPER.readTree(buffer.toString());
                buffer.setLength(0);
                all.add(n);
                queue.add(n);
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            closed.complete(statusCode);
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            closed.complete(-1);
        }
    }
}
