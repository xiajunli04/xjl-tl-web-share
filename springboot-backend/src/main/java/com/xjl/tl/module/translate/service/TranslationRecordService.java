package com.xjl.tl.module.translate.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.mybatis.SqlUtils;
import com.xjl.tl.module.translate.SupportedLanguage;
import com.xjl.tl.module.translate.dto.TranslateDtos.TraceVO;
import com.xjl.tl.module.translate.dto.TranslateDtos.TranslationDetailVO;
import com.xjl.tl.module.translate.dto.TranslateDtos.TranslationQuery;
import com.xjl.tl.module.translate.dto.TranslateDtos.TranslationSummaryVO;
import com.xjl.tl.module.translate.dto.TranslateDtos.UpstreamTranslateRequest;
import com.xjl.tl.module.translate.entity.AgentTrace;
import com.xjl.tl.module.translate.entity.TranslationRecord;
import com.xjl.tl.module.translate.mapper.AgentTraceMapper;
import com.xjl.tl.module.translate.mapper.TranslationRecordMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.Arrays;
import java.util.List;

/**
 * 翻译记录：final 时落库（记录 + 轨迹同一事务），以及历史检索、详情、收藏、逻辑删除（均做用户隔离）。
 */
@Service
public class TranslationRecordService {

    private static final int PREVIEW_LENGTH = 100;

    private final TranslationRecordMapper recordMapper;
    private final AgentTraceMapper traceMapper;
    private final JsonMapper jsonMapper;

    public TranslationRecordService(TranslationRecordMapper recordMapper, AgentTraceMapper traceMapper,
                                    JsonMapper jsonMapper) {
        this.recordMapper = recordMapper;
        this.traceMapper = traceMapper;
        this.jsonMapper = jsonMapper;
    }

    // ---------------- 落库 ----------------

    /**
     * 收到 final 后写入翻译记录与 Agent 轨迹（同一事务），返回记录 id。阻塞调用，须在 boundedElastic 等线程上执行。
     */
    @Transactional
    public Long save(Long userId, TranslationRun run, JsonNode fin) {
        String translation = fin.path("translation").asString(null);
        if (translation == null) {
            throw new BizException(ErrorCode.AGENT_FAILED, "Agent 返回的结果缺少译文");
        }
        UpstreamTranslateRequest req = run.request();
        TranslationRecord r = new TranslationRecord();
        r.setUserId(userId);
        r.setSourceText(req.text());
        r.setTargetText(translation);
        r.setSourceLang(req.sourceLang());
        // 识别结果只取 detect 事件；用户指定源语言时没有 detect 事件，为 null
        r.setDetectedLang(truncate(run.detect() == null ? null : run.detect().path("lang").asString(null), null, 8));
        r.setTargetLang(req.targetLang());
        r.setPath(firstText(fin.path("path"), run.plan() == null ? null : run.plan().path("path")));
        r.setMode(req.mode());
        r.setStyle(req.style());
        r.setDomain(truncate(firstText(fin.path("domain"),
                run.plan() == null ? null : run.plan().path("domain")), req.domain(), 32));
        r.setGlossaryIds(req.glossaryIds() == null ? new Long[0] : req.glossaryIds().toArray(new Long[0]));
        r.setModelConfigId(run.modelConfigId());
        r.setReviewScore(run.lastReviewScore());
        r.setReviewRounds(run.reviewRounds());
        r.setCompliance(arrayOrEmpty(fin.path("compliance")));
        r.setTermHits(arrayOrEmpty(run.terms() == null ? null : run.terms().path("hits")));
        r.setPromptTokens(intOrNull(fin.path("usage").path("promptTokens")));
        r.setCompletionTokens(intOrNull(fin.path("usage").path("completionTokens")));
        r.setLatencyMs(intOrNull(fin.path("latencyMs")));
        r.setFavorite(false);
        r.setDeleted(false);
        r.setAdopted(true);
        TranslationRun.SessionTurn session = run.session();
        if (session != null) {
            r.setSessionId(session.sessionId());
            r.setRevisionOf(session.revisionOf());
            r.setReviseInstruction(truncate(session.reviseInstruction(), null, 500));
            // 追问问答以 final 中的为准（Python 恢复后填写），缺失时用 pending 与回答拼出的兜底
            JsonNode clarification = fin.path("clarification");
            r.setClarification(clarification.isObject() ? clarification : session.clarificationFallback());
        }
        recordMapper.insert(r);

        int seq = 1;
        for (TranslationRun.NodeTrace t : run.traces()) {
            AgentTrace at = new AgentTrace();
            at.setRecordId(r.getId());
            at.setSeq(seq++);
            at.setNode(truncate(t.node(), null, 32));
            at.setStatus(truncate(t.status(), null, 16));
            at.setSummary(t.summary());
            at.setDetail(t.detail());
            at.setLatencyMs(t.latencyMs());
            at.setPromptTokens(t.promptTokens());
            at.setCompletionTokens(t.completionTokens());
            traceMapper.insert(at);
        }
        return r.getId();
    }

    // ---------------- 历史 ----------------

    public PageResult<TranslationSummaryVO> page(Long userId, TranslationQuery q) {
        String kw = q.getKeyword();
        String pattern = StringUtils.hasText(kw) ? SqlUtils.containsPattern(kw) : null;
        String src = q.getSourceLang();
        QueryWrapper<TranslationRecord> w = new QueryWrapper<TranslationRecord>()
                .select("id", "left(source_text, " + PREVIEW_LENGTH + ") AS source_text",
                        "left(target_text, " + PREVIEW_LENGTH + ") AS target_text",
                        "source_lang", "detected_lang", "target_lang", "path", "review_score", "favorite",
                        "latency_ms", "created_at", "session_id", "revision_of", "revise_instruction",
                        "clarification", "adopted")
                .eq("user_id", userId)
                .apply(pattern != null, "(source_text ILIKE {0} OR target_text ILIKE {0})", pattern)
                .apply(StringUtils.hasText(src),
                        "(source_lang = {0} OR (source_lang = '" + SupportedLanguage.AUTO + "' AND detected_lang = {0}))", src)
                .eq(StringUtils.hasText(q.getTargetLang()), "target_lang", q.getTargetLang())
                .eq(q.getFavorite() != null, "favorite", q.getFavorite())
                .ge(q.getStartTime() != null, "created_at", q.getStartTime())
                .lt(q.getEndTime() != null, "created_at", q.getEndTime())
                .orderByDesc("created_at", "id");
        Page<TranslationRecord> page = recordMapper.selectPage(q.toPage(), w);
        return PageResult.of(page, TranslationRecordService::toSummary);
    }

    public TranslationDetailVO detail(Long userId, Long id) {
        TranslationRecord r = getOwned(userId, id);
        List<TraceVO> traces = traceMapper.selectList(new LambdaQueryWrapper<AgentTrace>()
                        .eq(AgentTrace::getRecordId, id)
                        .orderByAsc(AgentTrace::getSeq))
                .stream()
                .map(t -> new TraceVO(t.getSeq(), t.getNode(), t.getStatus(), t.getSummary(), t.getDetail(),
                        t.getLatencyMs(), t.getPromptTokens(), t.getCompletionTokens()))
                .toList();
        return new TranslationDetailVO(r.getId(), r.getSourceText(), r.getTargetText(), r.getSourceLang(),
                r.getDetectedLang(), r.getTargetLang(), r.getMode(), r.getPath(), r.getStyle(), r.getDomain(),
                r.getGlossaryIds() == null ? List.of() : Arrays.asList(r.getGlossaryIds()), r.getModelConfigId(),
                r.getReviewScore(), r.getReviewRounds(), r.getCompliance(), r.getTermHits(), r.getPromptTokens(),
                r.getCompletionTokens(), r.getLatencyMs(), r.getFavorite(), r.getCreatedAt(), traces, r.getSessionId(),
                r.getRevisionOf(), r.getReviseInstruction(), r.getClarification(), r.getAdopted());
    }

    @Transactional
    public void setFavorite(Long userId, Long id, boolean favorite) {
        getOwned(userId, id);
        recordMapper.update(null, new LambdaUpdateWrapper<TranslationRecord>()
                .eq(TranslationRecord::getId, id)
                .set(TranslationRecord::getFavorite, favorite));
    }

    @Transactional
    public void delete(Long userId, Long id) {
        getOwned(userId, id);
        recordMapper.deleteById(id);
    }

    // ---------------- 内部 ----------------

    /** 当前用户的记录：他人记录与不存在 / 已删除一样返回 A0404。 */
    public TranslationRecord getOwned(Long userId, Long id) {
        TranslationRecord r = recordMapper.selectById(id);
        if (r == null || !userId.equals(r.getUserId())) {
            throw new BizException(ErrorCode.NOT_FOUND, "翻译记录不存在");
        }
        return r;
    }

    private static TranslationSummaryVO toSummary(TranslationRecord r) {
        String src = SupportedLanguage.AUTO.equals(r.getSourceLang()) && r.getDetectedLang() != null
                ? r.getDetectedLang() : r.getSourceLang();
        return new TranslationSummaryVO(r.getId(), r.getSourceText(), r.getTargetText(), src, r.getTargetLang(),
                r.getPath(), r.getReviewScore(), r.getFavorite(), r.getLatencyMs(), r.getCreatedAt(), r.getSessionId(),
                r.getRevisionOf(), r.getReviseInstruction(), r.getClarification(), r.getAdopted());
    }

    private JsonNode arrayOrEmpty(JsonNode n) {
        return n != null && n.isArray() ? n : jsonMapper.createArrayNode();
    }

    private static String firstText(JsonNode a, JsonNode b) {
        if (a != null && a.isString()) {
            return a.asString();
        }
        return b != null && b.isString() ? b.asString() : null;
    }

    private static String truncate(String value, String fallback, int max) {
        String v = value != null ? value : fallback;
        return v == null || v.length() <= max ? v : v.substring(0, max);
    }

    private static Integer intOrNull(JsonNode n) {
        return n != null && n.isNumber() ? n.asInt() : null;
    }
}
