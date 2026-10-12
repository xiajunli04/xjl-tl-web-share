package com.xjl.tl.infra.ai;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.TraceIdHolder;
import com.xjl.tl.common.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.util.UriBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * Python AI 服务客户端（见 design D9）。
 * <ul>
 *   <li>连接超时 3 秒、读超时 60 秒</li>
 *   <li>自动附加 X-Internal-Token 与 X-Trace-Id</li>
 *   <li>解包响应信封：成功返回 data；业务错误码原样透传；连接失败或 5xx 抛出 C0110
 *       （例外：5xx 信封中的 C0160 翻译记忆服务不可用与 C0171–C0174 语音/图片上游错误原样透传）</li>
 *   <li>二进制接口（如语音合成）：2xx 且非 JSON 的响应体原样返回，JSON 响应按信封解析</li>
 *   <li>流式二进制接口（朗读，improve-speech-playback-latency D2）：2xx 且非 JSON 时返回未关闭的上游输入流，
 *       由调用方边读边写出并负责关闭</li>
 *   <li>路径变量与查询参数按 URI 模板变量编码（如 threadId 中的冒号、关键词中的特殊字符）</li>
 * </ul>
 */
@Component
public class AiServiceClient {

    public static final String INTERNAL_TOKEN_HEADER = "X-Internal-Token";
    private static final Logger log = LoggerFactory.getLogger(AiServiceClient.class);
    /**
     * 5xx 响应中仍需原样透传的业务码（其余 5xx 一律视为 AI 服务不可用）：翻译记忆不可用，
     * 以及语音与图片的上游错误（OCR 解析失败、语音合成失败、语音引擎不可用、实时同传上游失败）。
     */
    private static final Set<String> PASS_THROUGH_5XX = Set.of(ErrorCode.TM_UNAVAILABLE.getCode(),
            ErrorCode.OCR_PARSE_FAILED.getCode(), ErrorCode.TTS_FAILED.getCode(),
            ErrorCode.SPEECH_ENGINE_UNAVAILABLE.getCode(), ErrorCode.REALTIME_UPSTREAM_FAILED.getCode());

    private final RestClient restClient;
    private final JsonMapper jsonMapper;

    public AiServiceClient(AppProperties props, JsonMapper jsonMapper) {
        AppProperties.Ai ai = props.ai();
        HttpClient httpClient = HttpClient.newBuilder()
                .connectTimeout(ai.connectTimeout())
                .version(HttpClient.Version.HTTP_1_1)
                .build();
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(httpClient);
        factory.setReadTimeout(ai.readTimeout());
        this.restClient = RestClient.builder()
                .baseUrl(ai.baseUrl())
                .requestFactory(factory)
                .defaultHeader(INTERNAL_TOKEN_HEADER, ai.internalToken() == null ? "" : ai.internalToken())
                .build();
        this.jsonMapper = jsonMapper;
    }

    /** GET /internal/health。 */
    public JsonNode health() {
        return get("/internal/health", JsonNode.class);
    }

    /** POST /internal/llm/test。 */
    public ModelTestResult testModel(Long modelConfigId) {
        return post("/internal/llm/test", new ModelTestRequest(modelConfigId), ModelTestResult.class);
    }

    public <T> T get(String path, Class<T> type) {
        return exchange(HttpMethod.GET, path, Map.of(), Map.of(), null, type);
    }

    public <T> T post(String path, Object body, Class<T> type) {
        return exchange(HttpMethod.POST, path, Map.of(), Map.of(), body, type);
    }

    /**
     * GET 带查询参数（值为 null 或空串的参数不发送）。
     *
     * @param pathTemplate 路径模板，如 /internal/tm/entries
     * @param pathVars     路径变量
     * @param query        查询参数
     */
    public <T> T get(String pathTemplate, Map<String, ?> pathVars, Map<String, ?> query, Class<T> type) {
        return exchange(HttpMethod.GET, pathTemplate, pathVars, query, null, type);
    }

    /** DELETE，路径变量与查询参数规则同 {@link #get(String, Map, Map, Class)}。 */
    public <T> T delete(String pathTemplate, Map<String, ?> pathVars, Map<String, ?> query, Class<T> type) {
        return exchange(HttpMethod.DELETE, pathTemplate, pathVars, query, null, type);
    }

    /** 由路径模板、路径变量与查询参数构造 URI：变量值统一按模板变量编码。 */
    private static Function<UriBuilder, URI> uri(String pathTemplate, Map<String, ?> pathVars, Map<String, ?> query) {
        return b -> {
            Map<String, Object> vars = new LinkedHashMap<>(pathVars);
            b.path(pathTemplate);
            query.forEach((k, v) -> {
                if (v != null && !(v instanceof String str && str.isEmpty())) {
                    String var = "q_" + k;
                    b.queryParam(k, "{" + var + "}");
                    vars.put(var, v);
                }
            });
            return b.build(vars);
        };
    }

    private <T> T exchange(HttpMethod method, String path, Map<String, ?> pathVars, Map<String, ?> query, Object body,
                           Class<T> type) {
        RawResponse raw;
        try {
            RestClient.RequestBodySpec spec = restClient.method(method).uri(uri(path, pathVars, query))
                    .accept(MediaType.APPLICATION_JSON);
            String traceId = TraceIdHolder.get();
            if (traceId != null) {
                spec.header(TraceIdHolder.HEADER, traceId);
            }
            if (body != null) {
                spec.contentType(MediaType.APPLICATION_JSON).body(body);
            }
            raw = spec.exchange((req, resp) -> new RawResponse(resp.getStatusCode().value(),
                    new String(resp.getBody().readAllBytes(), StandardCharsets.UTF_8)));
        } catch (RestClientException e) {
            log.warn("AI 服务调用失败 {} {}：{}", method, path, e.getMessage());
            throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
        }
        if (raw == null) {
            throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
        }
        JsonNode data = unwrap(method, path, raw.status(), raw.body());
        if (data == null || data.isNull()) {
            return null;
        }
        return type == JsonNode.class ? type.cast(data) : jsonMapper.treeToValue(data, type);
    }

    /**
     * POST 二进制接口（如 /internal/speech/tts）：2xx 且 Content-Type 不是 JSON 时原样返回响应体与响应头；
     * 其余响应按统一信封解析（业务码透传规则同 JSON 接口，成功信封视为协议错误 C0110）。
     */
    public BinaryResponse postBinary(String path, Object body) {
        BinaryResponse raw;
        try {
            RestClient.RequestBodySpec spec = restClient.post().uri(uri(path, Map.of(), Map.of()))
                    .accept(MediaType.ALL)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body);
            String traceId = TraceIdHolder.get();
            if (traceId != null) {
                spec.header(TraceIdHolder.HEADER, traceId);
            }
            raw = spec.exchange((req, resp) -> new BinaryResponse(resp.getStatusCode().value(),
                    resp.getHeaders().getContentType(), HttpHeaders.copyOf(resp.getHeaders()),
                    resp.getBody().readAllBytes()));
        } catch (RestClientException e) {
            log.warn("AI 服务调用失败 POST {}：{}", path, e.getMessage());
            throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
        }
        if (raw == null) {
            throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
        }
        boolean json = raw.contentType() != null && MediaType.APPLICATION_JSON.isCompatibleWith(raw.contentType());
        if (raw.status() >= 200 && raw.status() < 300 && !json) {
            return raw;
        }
        unwrap(HttpMethod.POST, path, raw.status(), new String(raw.body(), StandardCharsets.UTF_8));
        log.warn("AI 服务二进制接口返回了成功信封 POST {}", path);
        throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
    }

    /**
     * POST 流式二进制接口（如 /internal/speech/tts 的分块音频）：2xx 且 Content-Type 不是 JSON 时返回未关闭的上游输入流，
     * 调用方边读边写出并在结束后关闭（{@link StreamResponse#close()}）；其余响应读完后按统一信封解析抛出业务异常。
     */
    public StreamResponse postStream(String path, Object body) {
        StreamResponse raw;
        try {
            RestClient.RequestBodySpec spec = restClient.post().uri(uri(path, Map.of(), Map.of()))
                    .accept(MediaType.ALL)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body);
            String traceId = TraceIdHolder.get();
            if (traceId != null) {
                spec.header(TraceIdHolder.HEADER, traceId);
            }
            raw = spec.exchange((req, resp) -> {
                int status = resp.getStatusCode().value();
                MediaType contentType = resp.getHeaders().getContentType();
                HttpHeaders headers = HttpHeaders.copyOf(resp.getHeaders());
                boolean json = contentType != null && MediaType.APPLICATION_JSON.isCompatibleWith(contentType);
                if (status >= 200 && status < 300 && !json) {
                    return new StreamResponse(status, contentType, headers, resp.getBody(), null, resp);
                }
                try (resp) {
                    return new StreamResponse(status, contentType, headers, null, resp.getBody().readAllBytes(), null);
                }
            }, false);
        } catch (RestClientException e) {
            log.warn("AI 服务调用失败 POST {}：{}", path, e.getMessage());
            throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
        }
        if (raw == null) {
            throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
        }
        if (raw.body() != null) {
            return raw;
        }
        unwrap(HttpMethod.POST, path, raw.status(), new String(raw.errorBody(), StandardCharsets.UTF_8));
        log.warn("AI 服务流式接口返回了成功信封 POST {}", path);
        throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
    }

    /** 解包信封：成功返回 data（可能为 null）；业务错误码透传；5xx（白名单除外）与非法响应视为 C0110。 */
    private JsonNode unwrap(HttpMethod method, String path, int status, String body) {
        JsonNode envelope;
        try {
            envelope = jsonMapper.readTree(body);
        } catch (Exception e) {
            log.warn("AI 服务响应不是合法 JSON {} {} status={}", method, path, status);
            throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
        }
        String code = envelope == null ? null : envelope.path("code").asString(null);
        if (status >= 500 && !PASS_THROUGH_5XX.contains(code)) {
            log.warn("AI 服务返回 {} {} status={}", method, path, status);
            throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
        }
        if (code == null) {
            throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
        }
        if (!ErrorCode.SUCCESS.getCode().equals(code)) {
            // 业务错误码原样透传；已知码沿用其 HTTP 映射，未知码沿用 Python 返回的状态
            ErrorCode known = ErrorCode.fromCode(code);
            String message = envelope.path("message").asString(known != null ? known.getMessage() : "AI 服务返回错误");
            int httpStatus = known != null ? known.getHttpStatus() : status;
            throw new BizException(code, message, httpStatus, null);
        }
        return envelope.get("data");
    }

    /**
     * 二进制响应。
     *
     * @param status      HTTP 状态码
     * @param contentType 响应 Content-Type（可能为 null）
     * @param headers     响应头
     * @param body        响应体
     */
    public record BinaryResponse(int status, MediaType contentType, HttpHeaders headers, byte[] body) {
    }

    /**
     * 流式二进制响应：成功时 body 为未关闭的上游输入流（errorBody 为 null），关闭时释放上游连接；
     * 失败时 errorBody 为已读完的响应体（body 为 null）。
     */
    public record StreamResponse(int status, MediaType contentType, HttpHeaders headers, InputStream body,
                                 byte[] errorBody, Closeable upstream) implements Closeable {
        @Override
        public void close() throws IOException {
            if (upstream != null) {
                upstream.close();
            }
        }
    }

    private record RawResponse(int status, String body) {
    }

    /** 连通性测试请求。 */
    public record ModelTestRequest(Long modelConfigId) {
    }
}
