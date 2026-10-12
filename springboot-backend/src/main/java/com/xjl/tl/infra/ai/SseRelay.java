package com.xjl.tl.infra.ai;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.TraceIdHolder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;

/**
 * 通用的两跳 SSE 转发（图片翻译、解读追问使用；文本翻译有自己的运行状态见 TranslateService）：
 * <ul>
 *   <li>上游注释（心跳）不转发，由本服务按固定间隔发送注释心跳 ": ping"</li>
 *   <li>每个事件交给调用方的处理函数（可落库、改写或原样转发），处理函数抛出的异常转换为 error 事件</li>
 *   <li>上游异常：业务码透传，其余视为 C0110；上游在终止事件之前结束视为 C0110；总超时转为 error 事件</li>
 *   <li>输出终止事件（如 done、error）后结束；客户端取消时断开上游</li>
 * </ul>
 */
@Component
public class SseRelay {

    public static final String EVENT_ERROR = "error";
    static final ServerSentEvent<String> PING = ServerSentEvent.<String>builder().comment(" ping").build();

    private static final Logger log = LoggerFactory.getLogger(SseRelay.class);

    private final JsonMapper jsonMapper;

    public SseRelay(JsonMapper jsonMapper) {
        this.jsonMapper = jsonMapper;
    }

    /**
     * 转发选项。
     *
     * @param terminal  终止事件名（error 恒为终止事件）
     * @param heartbeat 心跳间隔
     * @param timeout   总超时；到时仍未结束则输出 timeoutCode 对应的 error 事件
     * @param timeoutCode 超时错误码
     */
    public record Options(Set<String> terminal, Duration heartbeat, Duration timeout, ErrorCode timeoutCode) {
    }

    /**
     * 建立转发流。
     *
     * @param upstream 上游事件流（AiStreamClient）
     * @param handler  事件处理：返回要输出给浏览器的事件（可在内部调用 {@link #blocking} 落库）
     * @param onFinish 流结束时回调，参数为是否已输出终止事件中的成功事件（非 error）；可为 null
     * @param traceId  透传的 traceId
     */
    public Flux<ServerSentEvent<String>> relay(Flux<ServerSentEvent<String>> upstream,
                                               Function<ServerSentEvent<String>, Mono<ServerSentEvent<String>>> handler,
                                               Options options, java.util.function.Consumer<Boolean> onFinish,
                                               String traceId) {
        return Flux.defer(() -> {
            AtomicBoolean terminated = new AtomicBoolean();
            AtomicBoolean succeeded = new AtomicBoolean();
            Flux<ServerSentEvent<String>> main = upstream
                    .filter(e -> e.event() != null || e.data() != null)
                    .concatMap(e -> {
                        if (terminated.get()) {
                            return Mono.<ServerSentEvent<String>>empty();
                        }
                        String event = e.event() == null ? "message" : e.event();
                        boolean terminal = EVENT_ERROR.equals(event) || options.terminal().contains(event);
                        if (terminal && !terminated.compareAndSet(false, true)) {
                            return Mono.<ServerSentEvent<String>>empty();
                        }
                        return handler.apply(e)
                                .doOnNext(out -> {
                                    if (terminal && !EVENT_ERROR.equals(out.event())) {
                                        succeeded.set(true);
                                    }
                                })
                                .onErrorResume(err -> {
                                    terminated.set(true);
                                    log.error("SSE 事件处理失败 traceId={} event={}", traceId, event, err);
                                    return Mono.just(err instanceof BizException be
                                            ? error(be.getCode(), be.getMessage(), traceId)
                                            : error(ErrorCode.SYSTEM_ERROR.getCode(), "结果保存失败", traceId));
                                });
                    })
                    .onErrorResume(err -> {
                        if (!terminated.compareAndSet(false, true)) {
                            return Flux.empty();
                        }
                        if (err instanceof BizException be) {
                            log.warn("SSE 上游错误 traceId={} code={}", traceId, be.getCode());
                            return Flux.just(error(be.getCode(), be.getMessage(), traceId));
                        }
                        log.warn("SSE 上游异常 traceId={}：{}", traceId, err.toString());
                        return Flux.just(error(ErrorCode.AI_SERVICE_UNAVAILABLE.getCode(),
                                ErrorCode.AI_SERVICE_UNAVAILABLE.getMessage(), traceId));
                    })
                    .concatWith(Flux.defer(() -> terminated.compareAndSet(false, true)
                            ? Flux.just(error(ErrorCode.AI_SERVICE_UNAVAILABLE.getCode(), "AI 服务提前结束了事件流", traceId))
                            : Flux.empty()));
            Flux<ServerSentEvent<String>> heartbeat = Flux.interval(options.heartbeat(), options.heartbeat()).map(i -> PING);
            Flux<ServerSentEvent<String>> timeout = Mono.delay(options.timeout())
                    .filter(i -> terminated.compareAndSet(false, true))
                    .map(i -> {
                        log.warn("SSE 转发超时 traceId={} timeout={}", traceId, options.timeout());
                        return error(options.timeoutCode().getCode(), options.timeoutCode().getMessage(), traceId);
                    })
                    .flux();
            return Flux.merge(main, heartbeat, timeout)
                    .takeUntil(e -> e.event() != null
                            && (EVENT_ERROR.equals(e.event()) || options.terminal().contains(e.event())))
                    .doFinally(signal -> {
                        if (onFinish != null) {
                            onFinish.accept(succeeded.get());
                        }
                    });
        });
    }

    /** error 事件：{code, message, traceId}。 */
    public ServerSentEvent<String> error(String code, String message, String traceId) {
        ObjectNode n = jsonMapper.createObjectNode();
        n.put("code", code);
        n.put("message", message);
        if (traceId != null) {
            n.put("traceId", traceId);
        }
        return ServerSentEvent.builder(jsonMapper.writeValueAsString(n)).event(EVENT_ERROR).build();
    }

    /** 原样转发上游事件；上游 error 事件未带 traceId 时补上。 */
    public ServerSentEvent<String> forward(ServerSentEvent<String> e, String traceId) {
        String data = e.data() == null ? "" : e.data();
        if (EVENT_ERROR.equals(e.event()) && traceId != null) {
            JsonNode node = parse(data);
            if (node instanceof ObjectNode obj && !obj.has("traceId")) {
                obj.put("traceId", traceId);
                data = jsonMapper.writeValueAsString(obj);
            }
        }
        return ServerSentEvent.builder(data).event(e.event()).build();
    }

    /** 解析 JSON，失败返回 null。 */
    public JsonNode parse(String data) {
        try {
            return data == null ? null : jsonMapper.readTree(data);
        } catch (RuntimeException ex) {
            return null;
        }
    }

    /** 在 boundedElastic 线程上执行阻塞操作（落库），期间沿用请求的 traceId。 */
    public static <T> Mono<T> blocking(String traceId, Callable<T> task) {
        return Mono.fromCallable(() -> {
            String previous = TraceIdHolder.get();
            if (traceId != null) {
                TraceIdHolder.set(traceId);
            }
            try {
                return task.call();
            } finally {
                if (previous != null) {
                    TraceIdHolder.set(previous);
                } else {
                    TraceIdHolder.clear();
                }
            }
        }).subscribeOn(Schedulers.boundedElastic());
    }
}
