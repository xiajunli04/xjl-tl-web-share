package com.xjl.tl.infra.ai;

import com.sun.net.httpserver.HttpServer;
import com.xjl.tl.common.BizException;
import com.xjl.tl.common.TraceIdHolder;
import com.xjl.tl.common.config.AppProperties;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 7.1：AiServiceClient 正常解包、业务错误透传、服务不可达 / 5xx 抛 C0110。
 * 使用 JDK 内置 HttpServer 模拟 Python AI 服务。
 */
class AiServiceClientTest {

    private HttpServer server;
    private final AtomicReference<String> lastToken = new AtomicReference<>();
    private final AtomicReference<String> lastTrace = new AtomicReference<>();
    private final AtomicReference<String> lastBody = new AtomicReference<>();
    private volatile int status = 200;
    private volatile String response = "{}";

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            lastToken.set(ex.getRequestHeaders().getFirst("X-Internal-Token"));
            lastTrace.set(ex.getRequestHeaders().getFirst("X-Trace-Id"));
            lastBody.set(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(status, bytes.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(bytes);
            }
        });
        server.start();
        TraceIdHolder.set("trace-abc");
    }

    @AfterEach
    void stop() {
        server.stop(0);
        TraceIdHolder.clear();
    }

    private AiServiceClient client(String baseUrl) {
        AppProperties props = new AppProperties(null, null, null, new AppProperties.Cors(List.of()),
                new AppProperties.Ai(baseUrl, "secret-token", Duration.ofSeconds(3), Duration.ofSeconds(5)));
        return new AiServiceClient(props, JsonMapper.builder().build());
    }

    private AiServiceClient client() {
        return client("http://127.0.0.1:" + server.getAddress().getPort());
    }

    @Test
    void successUnwrapsEnvelopeAndSendsHeaders() {
        response = """
                {"code":"00000","message":"成功","data":{"ok":true,"model":"deepseek-chat","latencyMs":812,
                 "reply":"pong","usage":{"promptTokens":9,"completionTokens":2}},"traceId":"trace-abc"}""";
        ModelTestResult result = client().testModel(3L);
        assertThat(result.ok()).isTrue();
        assertThat(result.model()).isEqualTo("deepseek-chat");
        assertThat(result.latencyMs()).isEqualTo(812L);
        assertThat(result.usage().promptTokens()).isEqualTo(9);
        assertThat(lastToken.get()).isEqualTo("secret-token");
        assertThat(lastTrace.get()).isEqualTo("trace-abc");
        assertThat(lastBody.get()).contains("\"modelConfigId\":3");
    }

    @Test
    void failedConnectivityIsNormalResult() {
        response = """
                {"code":"00000","data":{"ok":false,"latencyMs":30012,"errorCode":"C0122","errorMessage":"LLM 调用超时"}}""";
        ModelTestResult result = client().testModel(3L);
        assertThat(result.ok()).isFalse();
        assertThat(result.errorCode()).isEqualTo("C0122");
    }

    @Test
    void businessErrorCodeIsPassedThrough() {
        status = 400;
        response = """
                {"code":"C0130","message":"模型配置不存在或已停用","data":null,"traceId":"trace-abc"}""";
        assertThatThrownBy(() -> client().testModel(99L))
                .isInstanceOfSatisfying(BizException.class, e -> {
                    assertThat(e.getCode()).isEqualTo("C0130");
                    assertThat(e.getMessage()).isEqualTo("模型配置不存在或已停用");
                    assertThat(e.getHttpStatus()).isEqualTo(400);
                });
    }

    @Test
    void internalAuthFailureIsPassedThrough() {
        status = 401;
        response = """
                {"code":"B0100","message":"内部服务鉴权失败","data":null}""";
        assertThatThrownBy(() -> client().health())
                .isInstanceOfSatisfying(BizException.class, e -> assertThat(e.getCode()).isEqualTo("B0100"));
    }

    @Test
    void serverErrorBecomesC0110() {
        status = 500;
        response = """
                {"code":"B0001","message":"系统执行出错"}""";
        assertThatThrownBy(() -> client().health())
                .isInstanceOfSatisfying(BizException.class, e -> {
                    assertThat(e.getCode()).isEqualTo("C0110");
                    assertThat(e.getHttpStatus()).isEqualTo(503);
                });
    }

    @Test
    void tmUnavailableOn503IsPassedThrough() {
        status = 503;
        response = """
                {"code":"C0160","message":"翻译记忆服务不可用","data":null}""";
        assertThatThrownBy(() -> client().post("/internal/tm/entries", java.util.Map.of("userId", 1), Object.class))
                .isInstanceOfSatisfying(BizException.class, e -> {
                    assertThat(e.getCode()).isEqualTo("C0160");
                    assertThat(e.getHttpStatus()).isEqualTo(503);
                });
    }

    @Test
    void getAndDeleteEncodePathVariablesAndQuery() {
        AtomicReference<String> uri = new AtomicReference<>();
        AtomicReference<String> method = new AtomicReference<>();
        server.removeContext("/");
        server.createContext("/", ex -> {
            uri.set(ex.getRequestURI().getRawPath() + "?" + ex.getRequestURI().getRawQuery());
            method.set(ex.getRequestMethod());
            byte[] bytes = "{\"code\":\"00000\",\"data\":null}".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, bytes.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(bytes);
            }
        });
        java.util.Map<String, Object> query = new java.util.LinkedHashMap<>();
        query.put("userId", 3);
        query.put("keyword", "a&b {c}");
        query.put("empty", "");
        query.put("none", null);
        assertThat(client().get("/internal/tm/entries", java.util.Map.of(), query, Object.class)).isNull();
        assertThat(method.get()).isEqualTo("GET");
        assertThat(uri.get()).isEqualTo("/internal/tm/entries?userId=3&keyword=a%26b%20%7Bc%7D");
        client().delete("/internal/translate/threads/{threadId}", java.util.Map.of("threadId", "turn:a/b"),
                java.util.Map.of(), Object.class);
        assertThat(method.get()).isEqualTo("DELETE");
        assertThat(uri.get()).isEqualTo("/internal/translate/threads/turn%3Aa%2Fb?null");
    }

    @Test
    void unreachableServiceBecomesC0110() throws IOException {
        int freePort;
        try (ServerSocket s = new ServerSocket(0)) {
            freePort = s.getLocalPort();
        }
        assertThatThrownBy(() -> client("http://127.0.0.1:" + freePort).health())
                .isInstanceOfSatisfying(BizException.class, e -> {
                    assertThat(e.getCode()).isEqualTo("C0110");
                    assertThat(e.getMessage()).isEqualTo("AI 服务不可用");
                });
    }
}
