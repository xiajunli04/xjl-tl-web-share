package com.xjl.tl.infra.ai;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import org.junit.jupiter.api.Test;
import org.springframework.http.codec.ServerSentEvent;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import tools.jackson.databind.json.JsonMapper;

import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/** 通用 SSE 转发：终止事件、处理失败、上游异常、提前结束、超时与心跳。 */
class SseRelayTest {

    private final SseRelay relay = new SseRelay(JsonMapper.builder().build());
    private final SseRelay.Options options = new SseRelay.Options(Set.of("done"), Duration.ofMillis(50),
            Duration.ofMillis(400), ErrorCode.TRANSLATE_TIMEOUT);

    private static ServerSentEvent<String> ev(String event, String data) {
        return ServerSentEvent.builder(data).event(event).build();
    }

    private List<ServerSentEvent<String>> run(Flux<ServerSentEvent<String>> upstream,
                                              java.util.function.Function<ServerSentEvent<String>, Mono<ServerSentEvent<String>>> handler,
                                              AtomicReference<Boolean> finished) {
        return relay.relay(upstream, handler, options, finished::set, "t-1")
                .filter(e -> e.event() != null).collectList().block(Duration.ofSeconds(5));
    }

    @Test
    void stopsAtTerminalEventAndReportsSuccess() {
        AtomicReference<Boolean> ok = new AtomicReference<>();
        List<ServerSentEvent<String>> out = run(Flux.just(ev("delta", "{}"), ev("done", "{}"), ev("delta", "{}")),
                e -> Mono.just(relay.forward(e, "t-1")), ok);
        assertThat(out).extracting(ServerSentEvent::event).containsExactly("delta", "done");
        assertThat(ok.get()).isTrue();
    }

    @Test
    void handlerFailureAndUpstreamErrorsBecomeErrorEvents() {
        AtomicReference<Boolean> ok = new AtomicReference<>();
        List<ServerSentEvent<String>> failed = run(Flux.just(ev("done", "{}")),
                e -> Mono.error(new IllegalStateException("db down")), ok);
        assertThat(failed.getLast().data()).contains("B0001").contains("t-1");
        assertThat(ok.get()).isFalse();
        List<ServerSentEvent<String>> biz = run(Flux.error(new BizException(ErrorCode.LLM_AUTH_FAILED)),
                e -> Mono.just(e), ok);
        assertThat(biz.getLast().data()).contains("C0121");
        List<ServerSentEvent<String>> other = run(Flux.error(new RuntimeException("reset")), e -> Mono.just(e), ok);
        assertThat(other.getLast().data()).contains("C0110");
        List<ServerSentEvent<String>> truncated = run(Flux.just(ev("delta", "{}")), e -> Mono.just(e), ok);
        assertThat(truncated.getLast().data()).contains("提前结束");
        // 上游 error 事件补 traceId，已有 traceId 时不覆盖
        assertThat(relay.forward(ev("error", "{\"code\":\"C0120\"}"), "t-9").data()).contains("t-9");
        assertThat(relay.forward(ev("error", "{\"traceId\":\"x\"}"), "t-9").data()).doesNotContain("t-9");
        assertThat(relay.parse("not json")).isNull();
    }

    @Test
    void timesOutWithHeartbeats() {
        List<ServerSentEvent<String>> all = relay.relay(Flux.never(), Mono::just, options, null, null)
                .collectList().block(Duration.ofSeconds(5));
        assertThat(all).anyMatch(e -> " ping".equals(e.comment()));
        assertThat(all.getLast().event()).isEqualTo("error");
        assertThat(all.getLast().data()).contains("C0141");
    }
}
