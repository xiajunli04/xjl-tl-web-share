package com.xjl.tl.module.insight.service;

import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.TraceIdHolder;
import com.xjl.tl.common.config.MediaProperties;
import com.xjl.tl.common.config.TranslateProperties;
import com.xjl.tl.infra.ai.AiServiceClient;
import com.xjl.tl.infra.ai.AiStreamClient;
import com.xjl.tl.infra.ai.SseRelay;
import com.xjl.tl.module.insight.dto.InsightDtos.AskRequest;
import com.xjl.tl.module.insight.dto.InsightDtos.InsightRequest;
import com.xjl.tl.module.insight.dto.InsightDtos.InsightResult;
import com.xjl.tl.module.insight.dto.InsightDtos.QaTurn;
import com.xjl.tl.module.insight.dto.InsightDtos.UpstreamAskRequest;
import com.xjl.tl.module.insight.dto.InsightDtos.UpstreamInsightRequest;
import com.xjl.tl.module.translate.SupportedLanguage;
import com.xjl.tl.module.translate.service.TranslateRateLimiter;
import com.xjl.tl.module.translate.service.TranslationRecordService;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.List;
import java.util.Set;

/**
 * 解读（add-speech-and-image-translation D11）：备选译法与关键表达（JSON 代理）、针对译文追问（SSE 转发）。
 * 只读辅助，不落库；限流与文本翻译共用每用户每分钟的计数（A0212）。
 */
@Service
public class InsightService {

    public static final String UPSTREAM_INSIGHTS_PATH = "/internal/insights";
    public static final String UPSTREAM_ASK_PATH = "/internal/insights/ask";
    /** 追问最多携带的历史轮数。 */
    static final int MAX_HISTORY = 6;

    private final AiServiceClient aiServiceClient;
    private final AiStreamClient aiStreamClient;
    private final SseRelay relay;
    private final TranslateRateLimiter rateLimiter;
    private final TranslationRecordService recordService;
    private final MediaProperties mediaProps;
    private final TranslateProperties translateProps;

    public InsightService(AiServiceClient aiServiceClient, AiStreamClient aiStreamClient, SseRelay relay,
                          TranslateRateLimiter rateLimiter, TranslationRecordService recordService,
                          MediaProperties mediaProps, TranslateProperties translateProps) {
        this.aiServiceClient = aiServiceClient;
        this.aiStreamClient = aiStreamClient;
        this.relay = relay;
        this.rateLimiter = rateLimiter;
        this.recordService = recordService;
        this.mediaProps = mediaProps;
        this.translateProps = translateProps;
    }

    public InsightResult insights(Long userId, InsightRequest req) {
        validate(req.source(), req.sourceLang(), req.targetLang());
        if (req.recordId() != null) {
            recordService.getOwned(userId, req.recordId());
        }
        acquireRate(userId);
        return aiServiceClient.post(UPSTREAM_INSIGHTS_PATH, new UpstreamInsightRequest(req.source(), req.translation(),
                req.sourceLang(), req.targetLang(), null), InsightResult.class);
    }

    /** 校验与限流在建立流之前完成（失败返回普通 JSON），之后以 delta / done / error 事件转发。 */
    public Flux<ServerSentEvent<String>> ask(Long userId, AskRequest req) {
        validate(req.source(), req.sourceLang(), req.targetLang());
        List<QaTurn> history = req.history() == null ? List.of() : req.history();
        if (history.size() > MAX_HISTORY) {
            history = history.subList(history.size() - MAX_HISTORY, history.size());
        }
        acquireRate(userId);
        String traceId = TraceIdHolder.get();
        UpstreamAskRequest upstream = new UpstreamAskRequest(req.source(), req.translation(), req.sourceLang(),
                req.targetLang(), null, req.question().trim(), List.copyOf(history));
        SseRelay.Options options = new SseRelay.Options(Set.of("done"), translateProps.heartbeatInterval(),
                translateProps.timeout(), ErrorCode.LLM_TIMEOUT);
        return relay.relay(aiStreamClient.stream(UPSTREAM_ASK_PATH, upstream, traceId),
                e -> Mono.just(relay.forward(e, traceId)), options, null, traceId);
    }

    private void validate(String source, String sourceLang, String targetLang) {
        if (source.length() > mediaProps.insightsMaxChars()) {
            throw FieldError.invalid("source", "解读的原文最长 " + mediaProps.insightsMaxChars() + " 字符");
        }
        SupportedLanguage.requireSource("sourceLang", sourceLang);
        SupportedLanguage.require("targetLang", targetLang);
    }

    private void acquireRate(Long userId) {
        rateLimiter.acquire(TranslateRateLimiter.TRANSLATE, userId, translateProps.translateLimitPerMinute(),
                "翻译请求过于频繁，请稍后再试");
    }
}
