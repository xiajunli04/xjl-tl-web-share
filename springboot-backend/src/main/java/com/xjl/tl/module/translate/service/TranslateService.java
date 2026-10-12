package com.xjl.tl.module.translate.service;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.TraceIdHolder;
import com.xjl.tl.common.config.TranslateProperties;
import com.xjl.tl.infra.ai.AiServiceClient;
import com.xjl.tl.infra.ai.AiStreamClient;
import com.xjl.tl.module.glossary.service.GlossaryService;
import com.xjl.tl.module.model.service.ModelConfigService;
import com.xjl.tl.module.session.dto.SessionDtos.ClarifyRequest;
import com.xjl.tl.module.session.dto.SessionDtos.ReviseRequest;
import com.xjl.tl.module.session.entity.TranslationSession;
import com.xjl.tl.module.session.service.SessionLock;
import com.xjl.tl.module.session.service.SessionService;
import com.xjl.tl.module.translate.SupportedLanguage;
import com.xjl.tl.module.translate.dto.TranslateDtos.DetectRequest;
import com.xjl.tl.module.translate.dto.TranslateDtos.DetectResult;
import com.xjl.tl.module.translate.dto.TranslateDtos.RevisePayload;
import com.xjl.tl.module.translate.dto.TranslateDtos.TranslateRequest;
import com.xjl.tl.module.translate.dto.TranslateDtos.UpstreamResumeRequest;
import com.xjl.tl.module.translate.dto.TranslateDtos.UpstreamTranslateRequest;
import com.xjl.tl.module.translate.entity.TranslationRecord;
import com.xjl.tl.module.translate.service.TranslationRun.SessionTurn;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.function.Supplier;

/**
 * 语种识别与翻译流转发（见 design D5 / D8），以及会话内的翻译、修订与追问恢复（add-session-context-and-memory D1 / D3 / D4）。
 * <p>
 * 流式翻译分两段：
 * <ol>
 *   <li>建立流之前（请求线程同步执行）：参数校验 → 会话归属与默认参数 → 术语库权限 → 模型可用性 → 限流 → 会话锁；
 *       失败抛出 BizException，返回普通 JSON</li>
 *   <li>建立流之后：转发上游事件，归集轨迹；final 时在 boundedElastic 线程上落库并补上 recordId / sessionId / revisionOf；
 *       memory 事件写回会话记忆，clarify 事件写入会话 pending（不落库）；合并心跳；总超时、上游不可达或异常结束时
 *       生成 error 事件；客户端取消时断开上游且不落库；流结束（含出错、取消）时释放会话锁</li>
 * </ol>
 * 普通翻译、修订与追问恢复共用同一套两跳转发与落库逻辑，只是上游路径、请求体与运行状态不同。
 */
@Service
public class TranslateService {

    public static final String UPSTREAM_STREAM_PATH = "/internal/translate/stream";
    public static final String UPSTREAM_RESUME_PATH = "/internal/translate/resume";
    public static final String UPSTREAM_DETECT_PATH = "/internal/lang/detect";
    public static final String EVENT_FINAL = "final";
    public static final String EVENT_ERROR = "error";
    public static final String EVENT_CLARIFY = "clarify";
    public static final String EVENT_MEMORY = "memory";
    public static final String MODE_REVISE = "revise";
    /** 心跳注释：输出为 ": ping"。 */
    static final ServerSentEvent<String> PING = ServerSentEvent.<String>builder().comment(" ping").build();

    private static final Logger log = LoggerFactory.getLogger(TranslateService.class);

    private final TranslateProperties props;
    private final AiServiceClient aiServiceClient;
    private final AiStreamClient aiStreamClient;
    private final GlossaryService glossaryService;
    private final ModelConfigService modelConfigService;
    private final TranslationRecordService recordService;
    private final TranslateRateLimiter rateLimiter;
    private final SessionService sessionService;
    private final SessionLock sessionLock;
    private final JsonMapper jsonMapper;

    public TranslateService(TranslateProperties props, AiServiceClient aiServiceClient, AiStreamClient aiStreamClient,
                            GlossaryService glossaryService, ModelConfigService modelConfigService,
                            TranslationRecordService recordService, TranslateRateLimiter rateLimiter,
                            SessionService sessionService, SessionLock sessionLock, JsonMapper jsonMapper) {
        this.props = props;
        this.aiServiceClient = aiServiceClient;
        this.aiStreamClient = aiStreamClient;
        this.glossaryService = glossaryService;
        this.modelConfigService = modelConfigService;
        this.recordService = recordService;
        this.rateLimiter = rateLimiter;
        this.sessionService = sessionService;
        this.sessionLock = sessionLock;
        this.jsonMapper = jsonMapper;
    }

    // ---------------- 语种识别 ----------------

    public DetectResult detect(Long userId, DetectRequest req) {
        if (!StringUtils.hasText(req.text())) {
            throw FieldError.invalid("text", "文本不能为空");
        }
        checkLength(req.text());
        rateLimiter.acquire(TranslateRateLimiter.DETECT, userId, props.detectLimitPerMinute(), "语种识别请求过于频繁，请稍后再试");
        return aiServiceClient.post(UPSTREAM_DETECT_PATH, new DetectRequest(req.text()), DetectResult.class);
    }

    // ---------------- 流式翻译 ----------------

    /**
     * 校验并建立翻译事件流。本方法内抛出的异常都发生在建立流之前。
     * 带 sessionId 时为会话内的新一轮翻译（见 {@link #sessionStream}）。
     */
    public Flux<ServerSentEvent<String>> stream(Long userId, TranslateRequest req) {
        if (req.sessionId() != null) {
            return sessionStream(userId, req);
        }
        UpstreamTranslateRequest upstream = validate(userId, req);
        Long modelId = resolveModel(upstream.modelConfigId());
        acquireRate(userId);
        return launch(userId, () -> new TranslationRun(jsonMapper, upstream, modelId), UPSTREAM_STREAM_PATH, null, null);
    }

    /**
     * 会话内的新一轮：合并会话默认参数（请求显式值优先）→ 校验 → 获取会话锁（冲突 A0214）→
     * 放弃未回答的追问 → 组装会话载荷（轮次号 = 已有轮次数 + 1）。
     */
    private Flux<ServerSentEvent<String>> sessionStream(Long userId, TranslateRequest req) {
        TranslationSession session = sessionService.requireOwned(userId, req.sessionId());
        UpstreamTranslateRequest base = validate(userId, sessionService.mergeDefaults(session, req));
        Long modelId = resolveModel(base.modelConfigId());
        acquireRate(userId);
        SessionLock.Handle lock = sessionLock.acquire(session.getId());
        try {
            // 持锁后重新读取，pending 与轮次数以最新为准
            TranslationSession fresh = sessionService.abandonPending(sessionService.requireOwned(userId, session.getId()));
            int turnSeq = sessionService.nextTurnSeq(fresh);
            UpstreamTranslateRequest upstream = base.withSession(sessionService.payload(fresh, turnSeq), null);
            SessionTurn turn = new SessionTurn(fresh.getId(), turnSeq, null, null, null, null);
            return launch(userId, () -> new TranslationRun(jsonMapper, upstream, modelId, turn), UPSTREAM_STREAM_PATH,
                    null, lock);
        } catch (RuntimeException e) {
            lock.release();
            throw e;
        }
    }

    /**
     * 修订：记录须属于该会话（否则 A0404）。沿用原记录的原文、语种（识别结果优先）、目标语言、风格、领域与术语库，
     * 模型取会话设置（缺省为默认模型）；mode=revise，携带修订载荷与会话载荷（轮次号为被修订轮的 seq）。
     */
    public Flux<ServerSentEvent<String>> revise(Long userId, Long sessionId, ReviseRequest req) {
        TranslationSession session = sessionService.requireOwned(userId, sessionId);
        TranslationRecord base = sessionService.requireRecord(session, req.recordId());
        String instruction = req.instruction().trim();
        String sourceLang = StringUtils.hasText(base.getDetectedLang()) ? base.getDetectedLang() : base.getSourceLang();
        Long modelId = resolveModel(session.getModelConfigId());
        Long reviewModelId = modelConfigService.resolveReviewModelId(null);
        List<Long> glossaryIds = base.getGlossaryIds() == null ? List.of() : Arrays.asList(base.getGlossaryIds());
        acquireRate(userId);
        SessionLock.Handle lock = sessionLock.acquire(sessionId);
        try {
            TranslationSession fresh = sessionService.requireOwned(userId, sessionId);
            int turnSeq = sessionService.turnSeqOf(fresh, base.getId());
            UpstreamTranslateRequest upstream = new UpstreamTranslateRequest(base.getSourceText(), sourceLang,
                    base.getTargetLang(), MODE_REVISE, base.getStyle(), base.getDomain(), glossaryIds,
                    session.getModelConfigId(), reviewModelId, userId, sessionService.payload(fresh, turnSeq),
                    new RevisePayload(base.getId(), base.getSourceText(), base.getTargetText(), instruction));
            SessionTurn turn = new SessionTurn(sessionId, turnSeq, base.getId(), instruction, null, null);
            return launch(userId, () -> new TranslationRun(jsonMapper, upstream, modelId, turn), UPSTREAM_STREAM_PATH,
                    null, lock);
        } catch (RuntimeException e) {
            lock.release();
            throw e;
        }
    }

    /**
     * 回答追问：threadId 须与会话 pending 一致（否则 A0440），转发到 /internal/translate/resume。
     * 运行状态由 pending 中保存的请求与中断前快照恢复，成功落库时中断前后的轨迹合并在同一条记录下。
     */
    public Flux<ServerSentEvent<String>> clarify(Long userId, Long sessionId, ClarifyRequest req) {
        sessionService.requireOwned(userId, sessionId);
        SessionLock.Handle lock = sessionLock.acquire(sessionId);
        try {
            TranslationSession fresh = sessionService.requireOwned(userId, sessionId);
            JsonNode pending = fresh.getPending();
            // pending 不一致，或缺少恢复所需的原请求（无法落库），均视为追问已失效
            if (!req.threadId().equals(SessionService.threadIdOf(pending))
                    || !pending.path("request").path("text").isString()) {
                throw new BizException(ErrorCode.CLARIFY_EXPIRED);
            }
            String answer = req.answer().trim();
            UpstreamTranslateRequest request = jsonMapper.treeToValue(pending.get("request"), UpstreamTranslateRequest.class);
            Long modelId = pending.path("modelConfigId").isNumber() ? pending.get("modelConfigId").asLong() : null;
            ObjectNode fallback = jsonMapper.createObjectNode();
            fallback.set("question", pending.get("question"));
            fallback.set("options", pending.get("options"));
            fallback.set("span", pending.get("span"));
            fallback.put("answer", answer);
            SessionTurn turn = new SessionTurn(sessionId, pending.path("turnSeq").asInt(sessionService.nextTurnSeq(fresh)),
                    null, null, req.threadId(), fallback);
            JsonNode snapshot = pending.get("snapshot");
            return launch(userId, () -> {
                TranslationRun run = new TranslationRun(jsonMapper, request, modelId, turn);
                run.restore(snapshot);
                return run;
            }, UPSTREAM_RESUME_PATH, new UpstreamResumeRequest(req.threadId(), answer, userId), lock);
        } catch (RuntimeException e) {
            lock.release();
            throw e;
        }
    }

    /**
     * 建立事件流。
     *
     * @param runs 每次订阅创建独立的运行状态
     * @param body 上游请求体；null 表示使用运行状态中的翻译请求
     * @param lock 会话锁；流结束、出错或被取消时释放（非会话请求为 null）
     */
    private Flux<ServerSentEvent<String>> launch(Long userId, Supplier<TranslationRun> runs, String path, Object body,
                                                 SessionLock.Handle lock) {
        String traceId = TraceIdHolder.get();
        Flux<ServerSentEvent<String>> flux = Flux.defer(() -> {
            TranslationRun run = runs.get();
            return run(userId, run, path, body != null ? body : run.request(), traceId);
        });
        return lock == null ? flux : flux.doFinally(signal -> lock.release());
    }

    private Flux<ServerSentEvent<String>> run(Long userId, TranslationRun run, String path, Object body, String traceId) {
        Flux<ServerSentEvent<String>> main = aiStreamClient.stream(path, body, traceId)
                // 上游注释（心跳）不转发，由本服务自己发送心跳
                .filter(e -> e.event() != null || e.data() != null)
                .concatMap(e -> handle(userId, run, e, traceId))
                .onErrorResume(err -> {
                    if (!run.terminate()) {
                        return Flux.empty();
                    }
                    return Flux.just(upstreamFailure(run, err, traceId));
                })
                .concatWith(Flux.defer(() -> run.terminate()
                        ? Flux.just(errorEvent(ErrorCode.AGENT_FAILED.getCode(), "AI 服务提前结束了事件流", traceId))
                        : Flux.empty()));
        Flux<ServerSentEvent<String>> heartbeat = Flux.interval(props.heartbeatInterval(), props.heartbeatInterval())
                .map(i -> PING);
        Flux<ServerSentEvent<String>> timeout = Mono.delay(props.timeout())
                // 已收到 final（正在落库）时不再超时，避免"已入库但客户端收到超时"
                .filter(i -> !run.isFinalReceived() && run.terminate())
                .map(i -> {
                    log.warn("翻译超时 traceId={} timeout={}", traceId, props.timeout());
                    return errorEvent(ErrorCode.TRANSLATE_TIMEOUT, traceId);
                })
                .flux();
        return Flux.merge(main, heartbeat, timeout)
                .takeUntil(TranslateService::isTerminal)
                .doOnCancel(() -> log.info("客户端取消翻译，断开上游连接 traceId={}", traceId));
    }

    /**
     * 处理一条上游事件：普通事件归集后原样转发；final 落库后补 recordId 等；error 原样转发并结束；
     * clarify 写入 pending 后转发并结束；memory 写回会话记忆后转发。
     */
    private Flux<ServerSentEvent<String>> handle(Long userId, TranslationRun run, ServerSentEvent<String> e, String traceId) {
        if (run.isTerminated()) {
            return Flux.empty();
        }
        String event = e.event() == null ? "message" : e.event();
        String data = e.data() == null ? "" : e.data();
        run.markSawEvent();
        SessionTurn session = run.session();
        if (EVENT_ERROR.equals(event)) {
            run.terminate();
            log.info("上游返回 error 事件 traceId={} data={}", traceId, data);
            ServerSentEvent<String> out = ServerSentEvent.builder(withTraceId(data, traceId)).event(EVENT_ERROR).build();
            JsonNode err = parse(data);
            if (session != null && session.isResume() && err != null
                    && ErrorCode.CLARIFY_EXPIRED.getCode().equals(err.path("code").asString(null))) {
                // AI 服务已没有该追问的检查点：pending 失效，一并清空
                return blocking(traceId, () -> {
                    sessionService.clearPending(session.sessionId(), session.resumedThreadId());
                    return out;
                }).onErrorReturn(out).flux();
            }
            return Flux.just(out);
        }
        if (EVENT_FINAL.equals(event)) {
            run.markFinalReceived();
            run.terminate();
            return blocking(traceId, () -> persist(userId, run, data))
                    .onErrorResume(err -> {
                        log.error("翻译结果落库失败 traceId={}", traceId, err);
                        return Mono.just(err instanceof BizException be
                                ? errorEvent(be.getCode(), be.getMessage(), traceId)
                                : errorEvent(ErrorCode.SYSTEM_ERROR.getCode(), "翻译结果保存失败", traceId));
                    })
                    .flux();
        }
        JsonNode parsed = parse(data);
        run.collect(event, parsed);
        ServerSentEvent<String> forward = ServerSentEvent.builder(data).event(event).build();
        if (EVENT_CLARIFY.equals(event)) {
            run.terminate();
            if (session == null || parsed == null || !parsed.isObject()) {
                return Flux.just(forward);
            }
            return blocking(traceId, () -> {
                sessionService.savePending(session.sessionId(), pending(run, parsed));
                return forward;
            }).onErrorResume(err -> {
                log.error("保存追问失败 traceId={}", traceId, err);
                return Mono.just(errorEvent(ErrorCode.SYSTEM_ERROR.getCode(), "追问保存失败，请重试", traceId));
            }).flux();
        }
        if (EVENT_MEMORY.equals(event) && session != null && parsed != null && parsed.isObject()) {
            return blocking(traceId, () -> {
                sessionService.applyMemory(session.sessionId(), parsed);
                return forward;
            }).onErrorResume(err -> {
                // 写回失败不影响本轮翻译：下一轮会重新计算待压缩轮次
                log.warn("写回会话记忆失败 traceId={}：{}", traceId, err.toString());
                return Mono.just(forward);
            }).flux();
        }
        return Flux.just(forward);
    }

    /**
     * 追问 pending：对外字段 {threadId, question, options, span, reason, source}，
     * 以及恢复所需的 turnSeq、modelConfigId、请求（去掉会话载荷）与中断前的归集快照。
     */
    private ObjectNode pending(TranslationRun run, JsonNode clarify) {
        ObjectNode p = jsonMapper.createObjectNode();
        p.set("threadId", clarify.get("threadId"));
        p.set("question", clarify.get("question"));
        p.set("options", clarify.path("options").isArray() ? clarify.get("options") : jsonMapper.createArrayNode());
        p.set("span", clarify.get("span"));
        p.set("reason", clarify.get("reason"));
        p.put("source", run.request().text());
        p.put("turnSeq", run.session().turnSeq());
        if (run.modelConfigId() == null) {
            p.putNull("modelConfigId");
        } else {
            p.put("modelConfigId", run.modelConfigId());
        }
        p.set("request", jsonMapper.valueToTree(run.request().withSession(null, null)));
        p.set("snapshot", run.snapshot());
        return p;
    }

    private ServerSentEvent<String> persist(Long userId, TranslationRun run, String data) {
        JsonNode fin = parse(data);
        if (fin == null || !fin.isObject()) {
            throw new BizException(ErrorCode.AGENT_FAILED, "Agent 返回的 final 事件格式不正确");
        }
        SessionTurn session = run.session();
        Long recordId = session == null ? recordService.save(userId, run, fin) : sessionService.saveTurn(userId, run, fin);
        ObjectNode out = ((ObjectNode) fin).deepCopy();
        out.put("recordId", recordId);
        if (session == null) {
            out.putNull("sessionId");
            out.putNull("revisionOf");
        } else {
            out.put("sessionId", session.sessionId());
            if (session.revisionOf() == null) {
                out.putNull("revisionOf");
            } else {
                out.put("revisionOf", session.revisionOf());
            }
        }
        return ServerSentEvent.builder(jsonMapper.writeValueAsString(out)).event(EVENT_FINAL).build();
    }

    /** 在 boundedElastic 线程上执行阻塞操作（落库），期间沿用请求的 traceId。 */
    private static Mono<ServerSentEvent<String>> blocking(String traceId, Callable<ServerSentEvent<String>> task) {
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

    /** 上游异常：业务码透传；尚未收到任何事件视为 AI 服务不可用，否则视为 Agent 执行失败。 */
    private ServerSentEvent<String> upstreamFailure(TranslationRun run, Throwable err, String traceId) {
        if (err instanceof BizException be) {
            log.warn("翻译流上游错误 traceId={} code={}", traceId, be.getCode());
            return errorEvent(be.getCode(), be.getMessage(), traceId);
        }
        log.warn("翻译流上游异常 traceId={} sawEvent={}：{}", traceId, run.sawEvent(), err.toString());
        return run.sawEvent() ? errorEvent(ErrorCode.AGENT_FAILED, traceId) : errorEvent(ErrorCode.AI_SERVICE_UNAVAILABLE, traceId);
    }

    /** 终止事件：final、error，以及等待用户回答的 clarify。 */
    static boolean isTerminal(ServerSentEvent<String> e) {
        return EVENT_FINAL.equals(e.event()) || EVENT_ERROR.equals(e.event()) || EVENT_CLARIFY.equals(e.event());
    }

    private ServerSentEvent<String> errorEvent(ErrorCode code, String traceId) {
        return errorEvent(code.getCode(), code.getMessage(), traceId);
    }

    /** error 事件 data：{code, message, traceId}，traceId 便于前端错误状态展示与排查。 */
    private ServerSentEvent<String> errorEvent(String code, String message, String traceId) {
        ObjectNode n = jsonMapper.createObjectNode();
        n.put("code", code);
        n.put("message", message);
        if (traceId != null) {
            n.put("traceId", traceId);
        }
        return ServerSentEvent.builder(jsonMapper.writeValueAsString(n)).event(EVENT_ERROR).build();
    }

    /** 透传上游 error 事件时补上 traceId（上游未提供时）。 */
    private String withTraceId(String data, String traceId) {
        JsonNode node = parse(data);
        if (traceId == null || !(node instanceof ObjectNode obj) || obj.has("traceId")) {
            return data;
        }
        obj.put("traceId", traceId);
        return jsonMapper.writeValueAsString(obj);
    }

    private JsonNode parse(String data) {
        try {
            return jsonMapper.readTree(data);
        } catch (RuntimeException ex) {
            return null;
        }
    }

    // ---------------- 校验 ----------------

    private UpstreamTranslateRequest validate(Long userId, TranslateRequest req) {
        if (!StringUtils.hasText(req.text())) {
            throw FieldError.invalid("text", "原文不能为空");
        }
        checkLength(req.text());
        if (!StringUtils.hasText(req.targetLang())) {
            throw FieldError.invalid("targetLang", "目标语言不能为空");
        }
        String source = StringUtils.hasText(req.sourceLang()) ? req.sourceLang() : SupportedLanguage.AUTO;
        SupportedLanguage.requireSource("sourceLang", source);
        SupportedLanguage.require("targetLang", req.targetLang());
        if (source.equals(req.targetLang())) {
            throw FieldError.invalid("targetLang", "源语言与目标语言不能相同");
        }
        List<Long> glossaryIds = req.glossaryIds() == null ? List.of() : List.copyOf(new LinkedHashSet<>(req.glossaryIds()));
        if (glossaryIds.size() > props.maxGlossaries()) {
            throw FieldError.invalid("glossaryIds", "最多选择 " + props.maxGlossaries() + " 个术语库");
        }
        glossaryService.requireReadable(userId, glossaryIds);
        String mode = StringUtils.hasText(req.mode()) ? req.mode() : "auto";
        String style = StringUtils.hasText(req.style()) ? req.style() : "faithful";
        String domain = StringUtils.hasText(req.domain()) ? req.domain().trim() : null;
        // 评审模型每次请求时解析：显式指定（须启用）→ 管理员设置的评审模型 → null（与译者相同）
        Long reviewModelId = modelConfigService.resolveReviewModelId(req.reviewModelConfigId());
        return new UpstreamTranslateRequest(req.text(), source, req.targetLang(), mode, style, domain, glossaryIds,
                req.modelConfigId(), reviewModelId, userId, null, null);
    }

    /** 记录中保存的模型：显式指定的须已启用（否则 C0130），未指定时为当前默认模型。 */
    private Long resolveModel(Long modelId) {
        if (modelId != null) {
            modelConfigService.requireEnabled(modelId);
            return modelId;
        }
        return modelConfigService.defaultModelId();
    }

    private void acquireRate(Long userId) {
        rateLimiter.acquire(TranslateRateLimiter.TRANSLATE, userId, props.translateLimitPerMinute(),
                "翻译请求过于频繁，请稍后再试");
    }

    private void checkLength(String text) {
        if (text.length() > props.maxTextLength()) {
            throw FieldError.invalid("text", "原文最长 " + props.maxTextLength() + " 字符，长文本请使用文档翻译（即将推出）");
        }
    }
}
