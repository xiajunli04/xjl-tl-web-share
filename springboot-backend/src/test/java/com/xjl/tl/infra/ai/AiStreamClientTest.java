package com.xjl.tl.infra.ai;

import com.sun.net.httpserver.HttpServer;
import com.xjl.tl.common.BizException;
import com.xjl.tl.common.config.AppProperties;
import com.xjl.tl.support.SampleStreams;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.codec.ServerSentEvent;
import reactor.core.Disposable;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * tasks 5.1：AiStreamClient 用 JDK HttpServer 模拟上游 SSE——事件原样解析、含换行的 JSON 不被破坏、
 * 附加内部令牌与 traceId、非事件流响应按信封透传、取消时断开上游连接。
 */
class AiStreamClientTest {

    private HttpServer server;
    private final AtomicReference<String> lastToken = new AtomicReference<>();
    private final AtomicReference<String> lastTrace = new AtomicReference<>();
    private final AtomicReference<String> lastBody = new AtomicReference<>();
    private final CountDownLatch upstreamClosed = new CountDownLatch(1);
    private volatile int status = 200;
    private volatile String payload = "";
    private volatile boolean endless;
    private volatile String contentType;

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/", ex -> {
            lastToken.set(ex.getRequestHeaders().getFirst("X-Internal-Token"));
            lastTrace.set(ex.getRequestHeaders().getFirst("X-Trace-Id"));
            lastBody.set(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", contentType != null ? contentType
                    : status == 200 ? "text/event-stream" : "application/json");
            ex.sendResponseHeaders(status, endless ? 0 : bytes.length);
            OutputStream os = ex.getResponseBody();
            try {
                os.write(bytes);
                os.flush();
                while (endless) {
                    Thread.sleep(50);
                    os.write(": keepalive\n\n".getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }
                os.close();
            } catch (IOException e) {
                upstreamClosed.countDown();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        server.start();
    }

    @AfterEach
    void stop() {
        endless = false;
        server.stop(0);
    }

    private AiStreamClient client(String baseUrl) {
        AppProperties props = new AppProperties(null, null, null, new AppProperties.Cors(List.of()),
                new AppProperties.Ai(baseUrl, "secret-token", Duration.ofSeconds(3), Duration.ofSeconds(5)));
        return new AiStreamClient(props, JsonMapper.builder().build());
    }

    private AiStreamClient client() {
        return client("http://127.0.0.1:" + server.getAddress().getPort());
    }

    @Test
    void parsesSampleStreamVerbatimWithHeaders() {
        List<SampleStreams.Event> sample = SampleStreams.upstream("standard");
        StringBuilder sb = new StringBuilder(": ping\n\n");
        sample.forEach(e -> sb.append("event: ").append(e.event()).append("\ndata: ").append(e.data()).append("\n\n"));
        payload = sb.toString();

        List<ServerSentEvent<String>> events = client().stream("/internal/translate/stream", Map.of("text", "hi"), "trace-xyz")
                .collectList().block(Duration.ofSeconds(5));

        assertThat(events).isNotNull();
        List<ServerSentEvent<String>> data = events.stream().filter(e -> e.data() != null).toList();
        assertThat(data).extracting(ServerSentEvent::event).containsExactlyElementsOf(
                sample.stream().map(SampleStreams.Event::event).toList());
        assertThat(data).extracting(ServerSentEvent::data).containsExactlyElementsOf(
                sample.stream().map(SampleStreams.Event::data).toList());
        // 注释行单独解析为不带 data 的事件
        assertThat(events.getFirst().data()).isNull();
        assertThat(lastToken.get()).isEqualTo("secret-token");
        assertThat(lastTrace.get()).isEqualTo("trace-xyz");
        assertThat(lastBody.get()).isEqualTo("{\"text\":\"hi\"}");
    }

    @Test
    void jsonWithNewlinesAndLeadingSpacesIsNotBroken() {
        String delta = "{\"round\":0,\"text\":\"\\n  world\"}";
        payload = "event: delta\ndata: " + delta + "\n\n"
                // 多行 data 按 SSE 规范以换行拼接
                + "event: delta\ndata: {\"round\":0,\ndata:  \"text\":\"x\"}\n\n";
        List<ServerSentEvent<String>> events = client().stream("/s", Map.of(), null).collectList().block(Duration.ofSeconds(5));
        assertThat(events).hasSize(2);
        assertThat(events.get(0).data()).isEqualTo(delta);
        assertThat(JsonMapper.builder().build().readTree(events.get(0).data()).path("text").asString()).isEqualTo("\n  world");
        assertThat(events.get(1).data()).isEqualTo("{\"round\":0,\n \"text\":\"x\"}");
    }

    @Test
    void businessErrorBeforeStreamIsPassedThrough() {
        status = 401;
        payload = "{\"code\":\"B0100\",\"message\":\"内部服务鉴权失败\",\"data\":null}";
        assertThatThrownBy(() -> client().stream("/s", Map.of(), null).blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(BizException.class, e -> assertThat(e.getCode()).isEqualTo("B0100"));
    }

    @Test
    void envelopeErrorsKeepCodeAndMessage() {
        status = 400;
        payload = "{\"code\":\"A0420\",\"message\":\"不支持的语种：xx\",\"data\":null,\"traceId\":\"t\"}";
        assertThatThrownBy(() -> client().stream("/s", Map.of(), null).blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(BizException.class, e -> {
                    assertThat(e.getCode()).isEqualTo("A0420");
                    assertThat(e.getMessage()).isEqualTo("不支持的语种：xx");
                });
        status = 500;
        payload = "{\"code\":\"B0001\",\"message\":\"系统执行出错\"}";
        assertThatThrownBy(() -> client().stream("/s", Map.of(), null).blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(BizException.class, e -> assertThat(e.getCode()).isEqualTo("B0001"));
        // 2xx 但不是事件流：同样按信封解析，不当作 SSE
        status = 200;
        contentType = "application/json";
        payload = "{\"code\":\"C0130\",\"message\":\"模型配置不存在或已停用\",\"data\":null}";
        assertThatThrownBy(() -> client().stream("/s", Map.of(), null).blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(BizException.class, e -> assertThat(e.getCode()).isEqualTo("C0130"));
    }

    @Test
    void unparsableResponseAndUnreachableBecomeC0110() throws IOException {
        status = 502;
        contentType = "text/html";
        payload = "<html>Bad Gateway</html>";
        assertThatThrownBy(() -> client().stream("/s", Map.of(), null).blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(BizException.class, e -> assertThat(e.getCode()).isEqualTo("C0110"));
        int freePort;
        try (ServerSocket s = new ServerSocket(0)) {
            freePort = s.getLocalPort();
        }
        assertThatThrownBy(() -> client("http://127.0.0.1:" + freePort).stream("/s", Map.of(), null)
                .blockLast(Duration.ofSeconds(5)))
                .isInstanceOfSatisfying(BizException.class, e -> {
                    assertThat(e.getCode()).isEqualTo("C0110");
                    assertThat(e.getMessage()).isEqualTo("AI 服务不可用");
                });
    }

    @Test
    void cancellingSubscriptionClosesUpstreamConnection() throws InterruptedException {
        endless = true;
        payload = "event: start\ndata: {\"requestId\":\"r\"}\n\n";
        CountDownLatch gotStart = new CountDownLatch(1);
        Disposable d = client().stream("/s", Map.of(), null)
                .filter(e -> "start".equals(e.event()))
                .subscribe(e -> gotStart.countDown());
        assertThat(gotStart.await(5, TimeUnit.SECONDS)).isTrue();
        d.dispose();
        assertThat(upstreamClosed.await(5, TimeUnit.SECONDS)).as("取消后上游连接应被关闭").isTrue();
    }
}
