package com.xjl.tl.module.session.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.config.TranslateProperties;
import com.xjl.tl.common.mybatis.SqlUtils;
import com.xjl.tl.infra.ai.AiServiceClient;
import com.xjl.tl.module.glossary.service.GlossaryService;
import com.xjl.tl.module.model.service.ModelConfigService;
import com.xjl.tl.module.session.dto.SessionDtos.EntityVO;
import com.xjl.tl.module.session.dto.SessionDtos.PendingVO;
import com.xjl.tl.module.session.dto.SessionDtos.RecordBrief;
import com.xjl.tl.module.session.dto.SessionDtos.SessionDetailVO;
import com.xjl.tl.module.session.dto.SessionDtos.SessionQuery;
import com.xjl.tl.module.session.dto.SessionDtos.SessionRequest;
import com.xjl.tl.module.session.dto.SessionDtos.SessionSummaryVO;
import com.xjl.tl.module.session.dto.SessionDtos.SessionVO;
import com.xjl.tl.module.session.dto.SessionDtos.TurnVO;
import com.xjl.tl.module.session.entity.TranslationSession;
import com.xjl.tl.module.session.mapper.TranslationSessionMapper;
import com.xjl.tl.module.session.service.SessionTurns.Row;
import com.xjl.tl.module.session.service.SessionTurns.Turn;
import com.xjl.tl.module.translate.SupportedLanguage;
import com.xjl.tl.module.translate.dto.TranslateDtos.SessionPayload;
import com.xjl.tl.module.translate.dto.TranslateDtos.TranslateRequest;
import com.xjl.tl.module.translate.entity.TranslationRecord;
import com.xjl.tl.module.translate.mapper.TranslationRecordMapper;
import com.xjl.tl.module.translate.service.TranslationRecordService;
import com.xjl.tl.module.translate.service.TranslationRun;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

/**
 * 翻译会话（design D1 / D3 / D4）：会话 CRUD 与详情（按轮次组装版本链）、会话默认参数合并、会话载荷组装、
 * 追问 pending 的写入与放弃、会话记忆写回、轮次落库与采用版本切换。
 * 用户只能访问自己的会话，他人或已删除的会话返回 A0404；删除会话后会话内的记录仍保留在历史中。
 */
@Service
public class SessionService {

    public static final String UPSTREAM_THREAD_PATH = "/internal/translate/threads/{threadId}";
    /** 缺省标题取首轮原文的字符数。 */
    static final int DEFAULT_TITLE_LENGTH = 20;
    private static final String DEFAULT_STYLE = "faithful";

    private static final Logger log = LoggerFactory.getLogger(SessionService.class);

    private final TranslationSessionMapper mapper;
    private final TranslationRecordMapper recordMapper;
    private final TranslationRecordService recordService;
    private final GlossaryService glossaryService;
    private final ModelConfigService modelConfigService;
    private final AiServiceClient aiServiceClient;
    private final TranslateProperties props;
    private final JdbcTemplate jdbc;
    private final JsonMapper jsonMapper;

    public SessionService(TranslationSessionMapper mapper, TranslationRecordMapper recordMapper,
                          TranslationRecordService recordService, GlossaryService glossaryService,
                          ModelConfigService modelConfigService, AiServiceClient aiServiceClient,
                          TranslateProperties props, JdbcTemplate jdbc, JsonMapper jsonMapper) {
        this.mapper = mapper;
        this.recordMapper = recordMapper;
        this.recordService = recordService;
        this.glossaryService = glossaryService;
        this.modelConfigService = modelConfigService;
        this.aiServiceClient = aiServiceClient;
        this.props = props;
        this.jdbc = jdbc;
        this.jsonMapper = jsonMapper;
    }

    // ---------------- CRUD ----------------

    @Transactional
    public SessionVO create(Long userId, SessionRequest req) {
        if (!StringUtils.hasText(req.targetLang())) {
            throw FieldError.invalid("targetLang", "目标语言不能为空");
        }
        TranslationSession s = new TranslationSession();
        s.setUserId(userId);
        s.setTitle(StringUtils.hasText(req.title()) ? req.title().trim() : null);
        s.setSourceLang(StringUtils.hasText(req.sourceLang()) ? req.sourceLang() : SupportedLanguage.AUTO);
        s.setTargetLang(req.targetLang());
        s.setStyle(StringUtils.hasText(req.style()) ? req.style() : DEFAULT_STYLE);
        s.setDomain(StringUtils.hasText(req.domain()) ? req.domain().trim() : null);
        s.setGlossaryIds(glossaryIds(userId, req.glossaryIds() == null ? List.of() : req.glossaryIds()));
        s.setModelConfigId(req.modelConfigId());
        s.setClarifyEnabled(req.clarifyEnabled() == null || req.clarifyEnabled());
        validateParams(s);
        s.setMemoryEntities(jsonMapper.createArrayNode());
        s.setMemorizedUntil(0);
        s.setTurnCount(0);
        s.setDeleted(false);
        mapper.insert(s);
        return toVO(mapper.selectById(s.getId()));
    }

    public PageResult<SessionSummaryVO> page(Long userId, SessionQuery q) {
        String kw = q.getKeyword();
        LambdaQueryWrapper<TranslationSession> w = new LambdaQueryWrapper<TranslationSession>()
                .eq(TranslationSession::getUserId, userId)
                .apply(StringUtils.hasText(kw), "title ILIKE {0}", StringUtils.hasText(kw) ? SqlUtils.containsPattern(kw) : null)
                .orderByDesc(TranslationSession::getUpdatedAt)
                .orderByDesc(TranslationSession::getId);
        Page<TranslationSession> page = mapper.selectPage(q.toPage(), w);
        return PageResult.of(page, SessionService::toSummary);
    }

    public SessionDetailVO detail(Long userId, Long id) {
        TranslationSession s = requireOwned(userId, id);
        List<TurnVO> turns = new ArrayList<>();
        for (Turn t : SessionTurns.build(rows(id))) {
            if (t.adopted() == null) {
                continue;
            }
            List<RecordBrief> versions = t.versions().stream()
                    .map(v -> new RecordBrief(v.id(), v.sourceText(), v.targetText(), v.mode(), v.path(),
                            v.reviseInstruction(), v.clarification(), v.revisionOf(), v.id() == t.adopted().id(),
                            v.reviewScore(), v.createdAt()))
                    .toList();
            turns.add(new TurnVO(t.seq(), versions, t.adopted().id()));
        }
        List<EntityVO> entities = new ArrayList<>();
        if (s.getMemoryEntities() != null) {
            for (JsonNode e : s.getMemoryEntities()) {
                entities.add(new EntityVO(text(e, "source"), text(e, "target"), text(e, "note")));
            }
        }
        return new SessionDetailVO(s.getId(), s.getTitle(), s.getSourceLang(), s.getTargetLang(), s.getTurnCount(),
                s.getPending() != null, s.getUpdatedAt(), s.getCreatedAt(), s.getStyle(), s.getDomain(),
                ids(s.getGlossaryIds()), s.getModelConfigId(), s.getClarifyEnabled(), s.getMemorySummary(), entities,
                s.getMemorizedUntil(), pendingVO(s.getPending()), turns);
    }

    /** 修改标题与默认参数：只修改请求中给出的字段（空白标题视为未给出）。 */
    @Transactional
    public SessionVO update(Long userId, Long id, SessionRequest req) {
        TranslationSession s = requireOwned(userId, id);
        if (StringUtils.hasText(req.title())) {
            s.setTitle(req.title().trim());
        }
        if (StringUtils.hasText(req.sourceLang())) {
            s.setSourceLang(req.sourceLang());
        }
        if (StringUtils.hasText(req.targetLang())) {
            s.setTargetLang(req.targetLang());
        }
        if (StringUtils.hasText(req.style())) {
            s.setStyle(req.style());
        }
        if (req.domain() != null) {
            s.setDomain(StringUtils.hasText(req.domain()) ? req.domain().trim() : null);
        }
        if (req.glossaryIds() != null) {
            s.setGlossaryIds(glossaryIds(userId, req.glossaryIds()));
        }
        if (req.modelConfigId() != null) {
            s.setModelConfigId(req.modelConfigId());
        }
        if (req.clarifyEnabled() != null) {
            s.setClarifyEnabled(req.clarifyEnabled());
        }
        validateParams(s);
        // 领域可被清空：updateById 会忽略 null 字段，单独处理
        mapper.update(null, new LambdaUpdateWrapper<TranslationSession>()
                .eq(TranslationSession::getId, id)
                .set(TranslationSession::getTitle, s.getTitle())
                .set(TranslationSession::getSourceLang, s.getSourceLang())
                .set(TranslationSession::getTargetLang, s.getTargetLang())
                .set(TranslationSession::getStyle, s.getStyle())
                .set(TranslationSession::getDomain, s.getDomain())
                .set(TranslationSession::getModelConfigId, s.getModelConfigId())
                .set(TranslationSession::getClarifyEnabled, s.getClarifyEnabled())
                .set(TranslationSession::getUpdatedAt, OffsetDateTime.now()));
        if (req.glossaryIds() != null) {
            TranslationSession patch = new TranslationSession();
            patch.setId(id);
            patch.setGlossaryIds(s.getGlossaryIds());
            mapper.updateById(patch);
        }
        return toVO(mapper.selectById(id));
    }

    /** 逻辑删除；会话内的记录保留（session_id 不变）。有待回答的追问时通知 AI 服务清理检查点。 */
    public void delete(Long userId, Long id) {
        TranslationSession s = requireOwned(userId, id);
        mapper.deleteById(id);
        String threadId = threadIdOf(s.getPending());
        if (threadId != null) {
            deleteThread(threadId);
        }
    }

    // ---------------- 翻译参数与会话载荷 ----------------

    /** 会话存在、未删除且属于当前用户，否则 A0404。 */
    public TranslationSession requireOwned(Long userId, Long id) {
        TranslationSession s = mapper.selectById(id);
        if (s == null || !userId.equals(s.getUserId())) {
            throw new BizException(ErrorCode.NOT_FOUND, "会话不存在");
        }
        return s;
    }

    /** 合并会话默认参数：请求中显式给出的参数优先。 */
    public TranslateRequest mergeDefaults(TranslationSession s, TranslateRequest req) {
        return new TranslateRequest(req.text(),
                StringUtils.hasText(req.sourceLang()) ? req.sourceLang() : s.getSourceLang(),
                StringUtils.hasText(req.targetLang()) ? req.targetLang() : s.getTargetLang(),
                req.mode(),
                StringUtils.hasText(req.style()) ? req.style() : s.getStyle(),
                StringUtils.hasText(req.domain()) ? req.domain() : s.getDomain(),
                req.glossaryIds() != null ? req.glossaryIds() : ids(s.getGlossaryIds()),
                req.modelConfigId() != null ? req.modelConfigId() : s.getModelConfigId(),
                req.reviewModelConfigId(),
                s.getId());
    }

    /** 新一轮的轮次号。 */
    public int nextTurnSeq(TranslationSession s) {
        return (s.getTurnCount() == null ? 0 : s.getTurnCount()) + 1;
    }

    /** 组装会话载荷（契约 A）。 */
    public SessionPayload payload(TranslationSession s, int turnSeq) {
        List<Turn> turns = SessionTurns.build(rows(s.getId()));
        int memorizedUntil = s.getMemorizedUntil() == null ? 0 : s.getMemorizedUntil();
        return new SessionPayload(s.getId(), !Boolean.FALSE.equals(s.getClarifyEnabled()),
                SessionTurns.recentTurns(turns, turnSeq, memorizedUntil), s.getMemorySummary(),
                s.getMemoryEntities() == null ? jsonMapper.createArrayNode() : s.getMemoryEntities(),
                SessionTurns.toMemorize(turns, turnSeq, memorizedUntil), memorizedUntil, turnSeq);
    }

    /** 会话内未删除的记录，否则 A0404。 */
    public TranslationRecord requireRecord(TranslationSession s, Long recordId) {
        TranslationRecord r = recordMapper.selectById(recordId);
        if (r == null || !s.getId().equals(r.getSessionId()) || !s.getUserId().equals(r.getUserId())) {
            throw new BizException(ErrorCode.NOT_FOUND, "该会话中不存在此翻译记录");
        }
        return r;
    }

    /** 记录所属轮次的轮次号。 */
    public int turnSeqOf(TranslationSession s, Long recordId) {
        List<Row> rows = rows(s.getId());
        Turn turn = SessionTurns.turnOf(SessionTurns.build(rows), rows, recordId);
        if (turn == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "该会话中不存在此翻译记录");
        }
        return turn.seq();
    }

    // ---------------- 追问 ----------------

    /** 放弃等待回答的追问：清空 pending 并通知 AI 服务删除检查点（失败只记日志）。返回刷新后的会话。 */
    public TranslationSession abandonPending(TranslationSession s) {
        String threadId = threadIdOf(s.getPending());
        if (threadId == null) {
            return s;
        }
        mapper.clearPendingIf(s.getId(), threadId);
        log.info("放弃会话追问 sessionId={} threadId={}", s.getId(), threadId);
        deleteThread(threadId);
        s.setPending(null);
        return s;
    }

    /** 写入等待回答的追问。 */
    public void savePending(Long sessionId, JsonNode pending) {
        mapper.savePending(sessionId, pending);
    }

    /** pending 的 threadId 一致时清空（追问已失效或已完成）。 */
    public void clearPending(Long sessionId, String threadId) {
        mapper.clearPendingIf(sessionId, threadId);
    }

    public static String threadIdOf(JsonNode pending) {
        if (pending == null || !pending.isObject()) {
            return null;
        }
        JsonNode t = pending.get("threadId");
        return t != null && t.isString() && !t.asString().isEmpty() ? t.asString() : null;
    }

    private void deleteThread(String threadId) {
        try {
            aiServiceClient.delete(UPSTREAM_THREAD_PATH, Map.of("threadId", threadId), Map.of(), JsonNode.class);
        } catch (RuntimeException e) {
            log.warn("通知 AI 服务删除追问检查点失败 threadId={}：{}", threadId, e.getMessage());
        }
    }

    // ---------------- 会话记忆 ----------------

    /** memory 事件：{summary, entities, memorizedUntil} 写回会话。 */
    public void applyMemory(Long sessionId, JsonNode data) {
        JsonNode entities = data.path("entities");
        ArrayNode list = jsonMapper.createArrayNode();
        if (entities.isArray()) {
            for (JsonNode e : entities) {
                if (e.isObject()) {
                    list.add(e);
                }
            }
        }
        mapper.applyMemory(sessionId, text(data, "summary"), list, data.path("memorizedUntil").asInt(0));
    }

    // ---------------- 轮次落库 / 采用版本 ----------------

    /**
     * 会话内翻译完成：写入记录与轨迹（同一事务），并更新会话——
     * 新一轮：轮次数 +1、标题缺省取首轮原文前 20 个字符；修订：同分支其余版本不再采用；
     * 追问恢复：清空对应的 pending。
     */
    @Transactional
    public Long saveTurn(Long userId, TranslationRun run, JsonNode fin) {
        Long recordId = recordService.save(userId, run, fin);
        TranslationRun.SessionTurn st = run.session();
        if (st.isRevision()) {
            adoptInBranch(st.sessionId(), recordId);
            mapper.touch(st.sessionId());
        } else {
            mapper.afterTurn(st.sessionId(), defaultTitle(run.request().text()));
        }
        if (st.isResume()) {
            mapper.clearPendingIf(st.sessionId(), st.resumedThreadId());
        }
        return recordId;
    }

    /** 把记录设为所在分支的采用版本。 */
    @Transactional
    public SessionDetailVO adopt(Long userId, Long sessionId, Long recordId) {
        TranslationSession s = requireOwned(userId, sessionId);
        requireRecord(s, recordId);
        adoptInBranch(sessionId, recordId);
        mapper.touch(sessionId);
        return detail(userId, sessionId);
    }

    /** 同一分支（同一根记录的全部版本）只有 recordId 为采用版本。 */
    private void adoptInBranch(Long sessionId, Long recordId) {
        List<Row> rows = rows(sessionId);
        Map<Long, Row> byId = new HashMap<>();
        rows.forEach(r -> byId.put(r.id(), r));
        Long root = byId.containsKey(recordId) ? SessionTurns.rootOf(byId.get(recordId), byId) : recordId;
        Long[] branch = rows.stream()
                .filter(r -> root.equals(SessionTurns.rootOf(r, byId)))
                .map(Row::id)
                .toArray(Long[]::new);
        jdbc.update("UPDATE biz.translation_record SET adopted = (id = ?) WHERE id = ANY (?)", ps -> {
            ps.setLong(1, recordId);
            ps.setArray(2, ps.getConnection().createArrayOf("bigint", branch));
        });
    }

    // ---------------- 内部 ----------------

    /** 会话内的全部记录（含已删除，用于稳定的轮次编号），按创建顺序。 */
    private List<Row> rows(Long sessionId) {
        return jdbc.query("""
                SELECT id, source_text, target_text, revision_of, revise_instruction, adopted, deleted, mode, path,
                  review_score, clarification, created_at
                FROM biz.translation_record WHERE session_id = ? ORDER BY created_at, id""",
                (rs, i) -> {
                    long rev = rs.getLong("revision_of");
                    Long revisionOf = rs.wasNull() ? null : rev;
                    int score = rs.getInt("review_score");
                    Integer reviewScore = rs.wasNull() ? null : score;
                    String clarification = rs.getString("clarification");
                    return new Row(rs.getLong("id"), rs.getString("source_text"), rs.getString("target_text"),
                            revisionOf, rs.getString("revise_instruction"), rs.getBoolean("adopted"),
                            rs.getBoolean("deleted"), rs.getString("mode"), rs.getString("path"), reviewScore,
                            clarification == null ? null : jsonMapper.readTree(clarification),
                            rs.getObject("created_at", OffsetDateTime.class));
                }, sessionId);
    }

    private void validateParams(TranslationSession s) {
        SupportedLanguage.requireSource("sourceLang", s.getSourceLang());
        SupportedLanguage.require("targetLang", s.getTargetLang());
        if (s.getSourceLang().equals(s.getTargetLang())) {
            throw FieldError.invalid("targetLang", "源语言与目标语言不能相同");
        }
        if (s.getModelConfigId() != null) {
            modelConfigService.requireEnabled(s.getModelConfigId());
        }
    }

    private Long[] glossaryIds(Long userId, List<Long> requested) {
        List<Long> distinct = List.copyOf(new LinkedHashSet<>(requested));
        if (distinct.size() > props.maxGlossaries()) {
            throw FieldError.invalid("glossaryIds", "最多选择 " + props.maxGlossaries() + " 个术语库");
        }
        glossaryService.requireReadable(userId, distinct);
        return distinct.toArray(new Long[0]);
    }

    /** 缺省标题：首轮原文合并空白后的前 20 个字符。 */
    static String defaultTitle(String source) {
        String normalized = source == null ? "" : source.strip().replaceAll("\\s+", " ");
        return normalized.isEmpty() ? null : SessionTurns.truncate(normalized, DEFAULT_TITLE_LENGTH);
    }

    private static PendingVO pendingVO(JsonNode p) {
        if (p == null || !p.isObject()) {
            return null;
        }
        List<String> options = new ArrayList<>();
        for (JsonNode o : p.path("options")) {
            options.add(o.asString());
        }
        return new PendingVO(text(p, "threadId"), text(p, "question"), options, text(p, "span"), text(p, "reason"),
                text(p, "source"));
    }

    private static SessionSummaryVO toSummary(TranslationSession s) {
        return new SessionSummaryVO(s.getId(), s.getTitle(), s.getSourceLang(), s.getTargetLang(), s.getTurnCount(),
                s.getPending() != null, s.getUpdatedAt(), s.getCreatedAt());
    }

    private static SessionVO toVO(TranslationSession s) {
        return new SessionVO(s.getId(), s.getTitle(), s.getSourceLang(), s.getTargetLang(), s.getTurnCount(),
                s.getPending() != null, s.getUpdatedAt(), s.getCreatedAt(), s.getStyle(), s.getDomain(),
                ids(s.getGlossaryIds()), s.getModelConfigId(), s.getClarifyEnabled());
    }

    private static List<Long> ids(Long[] ids) {
        return ids == null ? List.of() : Arrays.asList(ids);
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v != null && v.isString() ? v.asString() : null;
    }
}
