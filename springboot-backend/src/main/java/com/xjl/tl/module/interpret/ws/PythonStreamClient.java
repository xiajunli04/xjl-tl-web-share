package com.xjl.tl.module.interpret.ws;

import com.xjl.tl.common.config.AppProperties;
import com.xjl.tl.common.config.MediaProperties;
import com.xjl.tl.infra.ai.AiServiceClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Spring → Python 同传内部 WebSocket 客户端（add-speech-and-image-translation D1，契约 §1.8）。
 * 基于 JDK {@link java.net.http.WebSocket}，握手携带 X-Internal-Token；地址缺省由 app.ai.base-url 推导
 * （http → ws、https → wss，路径 /internal/interpret/stream），可用 app.media.interpret-ws-url 覆盖。
 * <p>
 * JDK WebSocket 同一时刻只允许一个未完成的发送：{@link Connection} 把所有发送串成一条 CompletableFuture 链，
 * 调用方不阻塞；连接尚未建立时发送自动排队，积压超过 {@link #MAX_BACKLOG} 帧时丢弃音频帧（控制帧不丢）。
 */
@Component
public class PythonStreamClient {

    public static final String PATH = "/internal/interpret/stream";
    /** 未完成发送的帧数上限（约 10 秒的 40 ms 音频帧）。 */
    static final int MAX_BACKLOG = 250;
    private static final Logger log = LoggerFactory.getLogger(PythonStreamClient.class);

    private final URI uri;
    private final String token;
    private final Duration connectTimeout;
    private final HttpClient http;

    public PythonStreamClient(AppProperties app, MediaProperties media) {
        this.uri = resolveUri(app.ai().baseUrl(), media.interpretWsUrl());
        this.token = app.ai().internalToken() == null ? "" : app.ai().internalToken();
        this.connectTimeout = app.ai().connectTimeout();
        this.http = HttpClient.newBuilder().connectTimeout(connectTimeout).build();
        log.info("Python 同传 WebSocket 地址：{}", uri);
    }

    /** 由 AI 服务地址推导同传 WebSocket 地址；override 非空时直接使用。 */
    static URI resolveUri(String baseUrl, String override) {
        if (StringUtils.hasText(override)) {
            return URI.create(override.trim());
        }
        URI base = URI.create(baseUrl);
        String scheme = "https".equalsIgnoreCase(base.getScheme()) ? "wss" : "ws";
        String path = base.getPath() == null ? "" : base.getPath().replaceAll("/+$", "");
        return URI.create(scheme + "://" + base.getRawAuthority() + path + PATH);
    }

    public URI uri() {
        return uri;
    }

    /** 连接事件回调（在 HttpClient 线程上调用）。 */
    public interface Listener {
        /** 收到一条完整的文本消息。 */
        void onText(String text);

        /** 对端关闭连接。 */
        void onClosed(int statusCode, String reason);

        /** 连接建立失败或传输错误。 */
        void onFailure(Throwable error);
    }

    /** 发起连接（异步，立即返回）。 */
    public Connection connect(Listener listener) {
        CompletableFuture<WebSocket> opened = http.newWebSocketBuilder()
                .header(AiServiceClient.INTERNAL_TOKEN_HEADER, token)
                .connectTimeout(connectTimeout)
                .buildAsync(uri, new Adapter(listener));
        return new Connection(opened, listener);
    }

    /** 一条到 Python 的连接（= 一条发言流）。 */
    public static final class Connection {
        private final CompletableFuture<WebSocket> opened;
        private final AtomicInteger backlog = new AtomicInteger();
        private CompletableFuture<WebSocket> tail;
        private boolean closed;

        Connection(CompletableFuture<WebSocket> opened, Listener listener) {
            this.opened = opened;
            this.tail = opened;
            // 异步回调：避免连接在构造期间同步失败时，调用方尚未拿到本对象就收到失败通知
            opened.whenCompleteAsync((ws, err) -> {
                if (err != null) {
                    listener.onFailure(unwrap(err));
                }
            });
        }

        /** 发送文本帧（控制帧与首帧 config，不受积压限制）。 */
        public synchronized void sendText(String text) {
            if (closed) {
                return;
            }
            enqueue(ws -> ws.sendText(text, true));
        }

        /** 发送二进制帧；连接已关闭或积压过多时丢弃并返回 false。数据会被复制。 */
        public synchronized boolean sendBinary(ByteBuffer data) {
            if (closed || backlog.get() >= MAX_BACKLOG) {
                return false;
            }
            ByteBuffer copy = ByteBuffer.allocate(data.remaining());
            copy.put(data.duplicate()).flip();
            enqueue(ws -> ws.sendBinary(copy, true));
            return true;
        }

        private void enqueue(java.util.function.Function<WebSocket, CompletionStage<WebSocket>> send) {
            backlog.incrementAndGet();
            tail = tail.thenCompose(send).whenComplete((ws, err) -> backlog.decrementAndGet());
        }

        /** 正常关闭（1000）：排在已入队的发送之后；3 秒内未完成则直接中断。 */
        public synchronized void close() {
            if (closed) {
                return;
            }
            closed = true;
            tail.thenCompose(ws -> ws.sendClose(WebSocket.NORMAL_CLOSURE, ""))
                    .orTimeout(3, TimeUnit.SECONDS)
                    .whenComplete((ws, err) -> {
                        if (err != null) {
                            abort();
                        }
                    });
        }

        /** 立即中断连接（对端已关闭或出错时使用）。 */
        public synchronized void abort() {
            closed = true;
            if (opened.isDone() && !opened.isCompletedExceptionally()) {
                opened.join().abort();
            } else {
                opened.thenAccept(WebSocket::abort);
            }
        }

        /** 当前未完成的发送数（测试与监控用）。 */
        public int backlog() {
            return backlog.get();
        }
    }

    private static Throwable unwrap(Throwable err) {
        return err instanceof CompletionException && err.getCause() != null ? err.getCause() : err;
    }

    /** JDK 监听器适配：拼接分片文本帧，逐条请求下一帧。 */
    private static final class Adapter implements WebSocket.Listener {
        private final Listener listener;
        private final StringBuilder buffer = new StringBuilder();

        Adapter(Listener listener) {
            this.listener = listener;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            buffer.append(data);
            if (last) {
                String text = buffer.toString();
                buffer.setLength(0);
                try {
                    listener.onText(text);
                } catch (RuntimeException e) {
                    log.warn("处理 Python 同传事件失败：{}", e.toString(), e);
                }
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            listener.onClosed(statusCode, reason);
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            listener.onFailure(error);
        }
    }
}
