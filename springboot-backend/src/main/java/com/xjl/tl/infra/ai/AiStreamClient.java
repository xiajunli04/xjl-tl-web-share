package com.xjl.tl.infra.ai;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.TraceIdHolder;
import com.xjl.tl.common.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.client.reactive.JdkClientHttpConnector;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import reactor.core.publisher.Flux;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.http.HttpClient;
import java.time.Duration;

/**
 * Python AI 服务的流式客户端（见 design D5）：基于 WebClient + JDK HttpClient（不引入 Netty 服务器），
 * 附加 X-Internal-Token 与 X-Trace-Id，把上游 SSE 解析为 {@code ServerSentEvent<String>}（data 原样保留）。
 * <ul>
 *   <li>只有 2xx 且 Content-Type 为 text/event-stream 的响应按 SSE 解析</li>
 *   <li>其余响应（Python 建流之前的校验失败，HTTP 400/401，code 如 A0410、A0420、C0130、B0100）按统一信封解析，
 *       原样保留 code 与 message 抛出 BizException；信封无法解析时视为 C0110</li>
 *   <li>连接失败：抛出 C0110</li>
 *   <li>订阅被取消时断开与上游的连接</li>
 * </ul>
 */
@Component
public class AiStreamClient {

    private static final Logger log = LoggerFactory.getLogger(AiStreamClient.class);
    private static final ParameterizedTypeReference<ServerSentEvent<String>> SSE_TYPE =
            new ParameterizedTypeReference<>() {
            };
    /** 单个事件的最大字节数（final 事件包含完整译文；图片翻译 done 事件可能携带 base64 结果图）。 */
    private static final int MAX_EVENT_BYTES = 32 * 1024 * 1024;

    private final WebClient webClient;
    private final Duration connectTimeout;
    private final JsonMapper jsonMapper;

    public AiStreamClient(AppProperties props, JsonMapper jsonMapper) {
        AppProperties.Ai ai = props.ai();
        this.connectTimeout = ai.connectTimeout();
        // 连接器在每次请求时替换（见 stream），这里只保存公共配置
        this.webClient = WebClient.builder()
                .baseUrl(ai.baseUrl())
                .defaultHeader(AiServiceClient.INTERNAL_TOKEN_HEADER, ai.internalToken() == null ? "" : ai.internalToken())
                .codecs(c -> c.defaultCodecs().maxInMemorySize(MAX_EVENT_BYTES))
                .build();
        this.jsonMapper = jsonMapper;
    }

    /**
     * POST 请求上游流式接口。
     *
     * @param path    上游路径，如 /internal/translate/stream
     * @param body    请求体（序列化为 JSON）
     * @param traceId 透传的 traceId（流式处理跨线程，需调用方在请求线程中获取）
     */
    public Flux<ServerSentEvent<String>> stream(String path, Object body, String traceId) {
        String json = jsonMapper.writeValueAsString(body);
        // 每个流使用独立的 JDK HttpClient，并在结束、出错或取消时 shutdownNow()：
        // Spring 的 JdkClientHttpResponse 对响应体使用了 cache()，下游取消不会传播到 JDK 的订阅，
        // 不主动关闭的话与上游的连接会一直保持（上游感知不到取消，也无法停止 Agent）。
        return Flux.using(this::newHttpClient, client -> exchange(client, path, json, traceId), HttpClient::shutdownNow);
    }

    private HttpClient newHttpClient() {
        return HttpClient.newBuilder()
                .connectTimeout(connectTimeout)
                .version(HttpClient.Version.HTTP_1_1)
                .build();
    }

    private Flux<ServerSentEvent<String>> exchange(HttpClient client, String path, String json, String traceId) {
        return webClient.mutate().clientConnector(new JdkClientHttpConnector(client)).build()
                .post()
                .uri(path)
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.TEXT_EVENT_STREAM)
                .headers(h -> {
                    if (traceId != null) {
                        h.set(TraceIdHolder.HEADER, traceId);
                    }
                })
                .bodyValue(json)
                .exchangeToFlux(resp -> {
                    boolean eventStream = resp.headers().contentType()
                            .map(MediaType.TEXT_EVENT_STREAM::isCompatibleWith).orElse(false);
                    if (resp.statusCode().is2xxSuccessful() && eventStream) {
                        return resp.bodyToFlux(SSE_TYPE);
                    }
                    return resp.bodyToMono(String.class).defaultIfEmpty("")
                            .flatMapMany(b -> Flux.error(toException(path, resp.statusCode(), b)));
                })
                .onErrorMap(WebClientRequestException.class, e -> {
                    log.warn("AI 服务流式调用失败 {}：{}", path, e.getMostSpecificCause().toString());
                    return new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
                });
    }

    /** 非 SSE 响应：按信封解析并原样保留 code 与 message；无法解析的响应（如网关错误页）视为服务不可用。 */
    private BizException toException(String path, HttpStatusCode status, String body) {
        log.warn("AI 服务流式接口返回非事件流响应 {} status={}", path, status.value());
        try {
            JsonNode envelope = jsonMapper.readTree(body);
            String code = envelope.path("code").asString(null);
            if (code == null || ErrorCode.SUCCESS.getCode().equals(code)) {
                return new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
            }
            ErrorCode known = ErrorCode.fromCode(code);
            String message = envelope.path("message").asString(known != null ? known.getMessage() : "AI 服务返回错误");
            return new BizException(code, message, known != null ? known.getHttpStatus() : status.value(), null);
        } catch (RuntimeException e) {
            return new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
        }
    }
}
