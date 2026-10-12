package com.xjl.tl.support;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 流式集成测试基类：真实 Tomcat（随机端口）+ 模拟 Python AI 服务（{@link MockAiServer}）。
 * 心跳与超时缩短到测试可接受的时长；继承本类的测试共享同一个 Spring 上下文。
 * 文档任务的事件消费者只在本上下文中启动（application-test.yml 默认关闭）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
public abstract class StreamingTestBase extends IntegrationTestBase {

    public static final long HEARTBEAT_MS = 300;
    public static final long TIMEOUT_MS = 4000;

    @LocalServerPort
    protected int port;

    @DynamicPropertySource
    static void streamingProps(DynamicPropertyRegistry r) {
        r.add("app.ai.base-url", () -> MockAiServer.get().baseUrl());
        r.add("app.translate.heartbeat-interval", () -> HEARTBEAT_MS + "ms");
        r.add("app.translate.timeout", () -> TIMEOUT_MS + "ms");
        // 文档任务：本上下文启动事件消费者；心跳、读取阻塞与 pending 认领阈值缩短到测试可接受的时长
        r.add("app.doc.consumer-enabled", () -> "true");
        r.add("app.doc.consumer-name", () -> "spring-test");
        r.add("app.doc.heartbeat-interval", () -> HEARTBEAT_MS + "ms");
        r.add("app.doc.poll-timeout", () -> "200ms");
        r.add("app.doc.claim-min-idle", () -> "500ms");
        // 同传：模拟 Python WS 服务；段合并超时、断线宽限期与自动结束缩短到测试可接受的时长
        r.add("app.media.interpret-ws-url", () -> MockInterpretServer.get().url());
        r.add("app.media.segment-wait-timeout", () -> "800ms");
        r.add("app.media.segment-flush-interval", () -> "100ms");
        r.add("app.media.rejoin-grace", () -> "3s");
        r.add("app.media.idle-end-after", () -> "4s");
    }

    protected MockInterpretServer mockInterpret() {
        return MockInterpretServer.get();
    }

    protected MockAiServer mockAi() {
        return MockAiServer.get();
    }

    protected SseTestClient sse() {
        return new SseTestClient("http://127.0.0.1:" + port, jsonMapper);
    }
}
