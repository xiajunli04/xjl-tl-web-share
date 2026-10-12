package com.xjl.tl.module.document.repository;

import com.xjl.tl.common.mybatis.SqlUtils;
import com.xjl.tl.module.document.DocStatus;
import com.xjl.tl.module.document.dto.DocDtos.DocOptions;
import com.xjl.tl.module.document.dto.DocDtos.DocSegmentVO;
import com.xjl.tl.module.document.dto.DocDtos.DocTermVO;
import com.xjl.tl.module.document.dto.DocDtos.DocTraceVO;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.namedparam.SqlParameterSource;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;
import org.springframework.util.StringUtils;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * 文档任务相关表的数据访问（biz.doc_task / doc_segment / doc_task_term / doc_task_trace）。
 * <p>
 * 事件落库需要 FOR UPDATE、ON CONFLICT 与批量写入，使用 NamedParameterJdbcTemplate 直接写 SQL。
 * jsonb 参数以字符串传入并 CAST，bigint[] 以数组字面量传入并 CAST。
 */
@Repository
public class DocRepository {

    /** 不含原文的任务列。 */
    private static final String TASK_COLUMNS = """
            id, user_id, title, format, char_count, source_lang, detected_lang, target_lang, style, domain, genre,
            glossary_ids, model_config_id, review_model_config_id, strategy, confirm_terms, options, status, phase,
            progress_done, progress_total, summary, consistency_report, stats, error_code, error_message, retryable,
            last_event_seq, last_event_at, prompt_tokens, completion_tokens, latency_ms, created_at, started_at,
            finished_at""";

    private final NamedParameterJdbcTemplate jdbc;
    private final JsonMapper jsonMapper;
    private final RowMapper<DocTaskRow> taskMapper;

    public DocRepository(NamedParameterJdbcTemplate jdbc, JsonMapper jsonMapper) {
        this.jdbc = jdbc;
        this.jsonMapper = jsonMapper;
        this.taskMapper = this::mapTask;
    }

    // ---------------- 任务 ----------------

    /** 新建任务需要的字段。 */
    public record NewTask(Long userId, String title, String format, String sourceText, int charCount,
                          String sourceLang, String targetLang, String style, String domain, List<Long> glossaryIds,
                          Long modelConfigId, Long reviewModelConfigId, String strategy, boolean confirmTerms,
                          DocOptions options) {
    }

    public long insertTask(NewTask t) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.update("""
                INSERT INTO biz.doc_task (user_id, title, format, source_text, char_count, source_lang, target_lang, style,
                  domain, glossary_ids, model_config_id, review_model_config_id, strategy, confirm_terms, options,
                  status, last_event_at)
                VALUES (:userId, :title, :format, :sourceText, :charCount, :sourceLang, :targetLang, :style, :domain,
                  CAST(:glossaryIds AS bigint[]), :modelConfigId, :reviewModelConfigId, :strategy, :confirmTerms,
                  CAST(:options AS jsonb), 'PENDING', now())""",
                new MapSqlParameterSource()
                        .addValue("userId", t.userId())
                        .addValue("title", t.title())
                        .addValue("format", t.format())
                        .addValue("sourceText", t.sourceText())
                        .addValue("charCount", t.charCount())
                        .addValue("sourceLang", t.sourceLang())
                        .addValue("targetLang", t.targetLang())
                        .addValue("style", t.style())
                        .addValue("domain", t.domain())
                        .addValue("glossaryIds", arrayLiteral(t.glossaryIds()))
                        .addValue("modelConfigId", t.modelConfigId())
                        .addValue("reviewModelConfigId", t.reviewModelConfigId())
                        .addValue("strategy", t.strategy())
                        .addValue("confirmTerms", t.confirmTerms())
                        .addValue("options", json(t.options())),
                keys, new String[]{"id"});
        return keys.getKeyAs(Long.class);
    }

    /** 未删除的任务。 */
    public Optional<DocTaskRow> findTask(long id) {
        return jdbc.query("SELECT " + TASK_COLUMNS + " FROM biz.doc_task WHERE id = :id AND deleted = false",
                new MapSqlParameterSource("id", id), taskMapper).stream().findFirst();
    }

    /** 加行锁读取未删除的任务（事件落库与用户操作互斥）。 */
    public Optional<DocTaskRow> lockTask(long id) {
        return jdbc.query("SELECT " + TASK_COLUMNS + " FROM biz.doc_task WHERE id = :id AND deleted = false FOR UPDATE",
                new MapSqlParameterSource("id", id), taskMapper).stream().findFirst();
    }

    public String sourceText(long id) {
        return jdbc.queryForObject("SELECT source_text FROM biz.doc_task WHERE id = :id",
                new MapSqlParameterSource("id", id), String.class);
    }

    public record Page(List<DocTaskRow> rows, long total) {
    }

    public Page page(long userId, String status, String keyword, int pageNum, int pageSize) {
        StringBuilder where = new StringBuilder(" WHERE user_id = :userId AND deleted = false");
        MapSqlParameterSource p = new MapSqlParameterSource("userId", userId);
        if (StringUtils.hasText(status)) {
            where.append(" AND status = :status");
            p.addValue("status", status);
        }
        if (StringUtils.hasText(keyword)) {
            where.append(" AND title ILIKE :kw");
            p.addValue("kw", SqlUtils.containsPattern(keyword));
        }
        Long total = jdbc.queryForObject("SELECT count(*) FROM biz.doc_task" + where, p, Long.class);
        p.addValue("limit", pageSize).addValue("offset", (long) (pageNum - 1) * pageSize);
        List<DocTaskRow> rows = jdbc.query("SELECT " + TASK_COLUMNS + " FROM biz.doc_task" + where
                + " ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset", p, taskMapper);
        return new Page(rows, total == null ? 0 : total);
    }

    /** 事务级咨询锁：同一用户的创建 / 继续串行执行，避免并发绕过数量限制。 */
    public void lockUser(long userId) {
        jdbc.queryForList("SELECT pg_advisory_xact_lock(:key)",
                new MapSqlParameterSource("key", 0x444F_4300_0000_0000L + userId));
    }

    public int countRunning(long userId) {
        Integer n = jdbc.queryForObject("""
                SELECT count(*) FROM biz.doc_task
                WHERE user_id = :userId AND deleted = false AND status IN (:statuses)""",
                new MapSqlParameterSource("userId", userId).addValue("statuses", DocStatus.RUNNING), Integer.class);
        return n == null ? 0 : n;
    }

    public void softDelete(long id) {
        jdbc.update("UPDATE biz.doc_task SET deleted = true WHERE id = :id", new MapSqlParameterSource("id", id));
    }

    /** 设置状态与阶段（用户操作：取消、术语确认后继续）。phase 为 null 时保持原值。 */
    public void setStatus(long id, String status, String phase) {
        jdbc.update("""
                UPDATE biz.doc_task SET status = :status, phase = COALESCE(:phase, phase), last_event_at = now()
                WHERE id = :id""",
                new MapSqlParameterSource("id", id).addValue("status", status).addValue("phase", phase));
    }

    /** 继续执行：回到 PENDING，清空错误与结束时间，重置失联计时。 */
    public void resetForRetry(long id) {
        jdbc.update("""
                UPDATE biz.doc_task SET status = 'PENDING', error_code = NULL, error_message = NULL, retryable = false,
                  finished_at = NULL, last_event_at = now()
                WHERE id = :id""", new MapSqlParameterSource("id", id));
    }

    /** 命令写入任务流失败：直接置为 FAILED（可重试）。 */
    public void markDispatchFailed(long id, String code, String message) {
        jdbc.update("""
                UPDATE biz.doc_task SET status = 'FAILED', error_code = :code, error_message = :message, retryable = true,
                  finished_at = now()
                WHERE id = :id""",
                new MapSqlParameterSource("id", id).addValue("code", code).addValue("message", message));
    }

    /** 失联检测：把超时未收到事件的任务标记为终结状态，返回被标记的任务 id。 */
    public List<Long> markStale(Collection<String> fromStatuses, String toStatus, String code, String message,
                                boolean retryable, OffsetDateTime cutoff) {
        return jdbc.queryForList("""
                UPDATE biz.doc_task SET status = :to, error_code = :code, error_message = :message,
                  retryable = :retryable, finished_at = now()
                WHERE deleted = false AND status IN (:from)
                  AND COALESCE(last_event_at, started_at, created_at) < :cutoff
                RETURNING id""",
                new MapSqlParameterSource("from", fromStatuses).addValue("to", toStatus).addValue("code", code)
                        .addValue("message", message).addValue("retryable", retryable).addValue("cutoff", cutoff),
                Long.class);
    }

    // ---------------- 事件落库 ----------------

    /** 记录已处理的事件序号。 */
    public void markEvent(long taskId, int eventSeq) {
        jdbc.update("UPDATE biz.doc_task SET last_event_seq = :seq, last_event_at = now() WHERE id = :id",
                new MapSqlParameterSource("id", taskId).addValue("seq", eventSeq));
    }

    /** phase 事件：status 为 null 时只更新 phase；进入运行状态时清空上次的失败信息。 */
    public void applyPhase(long taskId, String phase, String status) {
        jdbc.update("""
                UPDATE biz.doc_task SET phase = :phase,
                  status = COALESCE(:status, status),
                  started_at = COALESCE(started_at, now()),
                  error_code = CASE WHEN CAST(:status AS varchar) IS NULL THEN error_code ELSE NULL END,
                  error_message = CASE WHEN CAST(:status AS varchar) IS NULL THEN error_message ELSE NULL END,
                  retryable = CASE WHEN CAST(:status AS varchar) IS NULL THEN retryable ELSE false END,
                  finished_at = CASE WHEN CAST(:status AS varchar) IS NULL THEN finished_at ELSE NULL END
                WHERE id = :id""",
                new MapSqlParameterSource("id", taskId).addValue("phase", phase).addValue("status", status));
    }

    /** 段落结构（parsed 事件）。 */
    public record SegmentStructure(int seq, String blockType, Integer level, String prefix, String source,
                                   String suffix, boolean translatable, Integer chunkIndex) {
    }

    /** parsed：按 (task_id, seq) 幂等写入段落结构，保留已有译文；删除不再存在的段落。 */
    public void upsertSegments(long taskId, List<SegmentStructure> segments) {
        SqlParameterSource[] batch = segments.stream().map(s -> new MapSqlParameterSource()
                        .addValue("taskId", taskId)
                        .addValue("seq", s.seq())
                        .addValue("blockType", s.blockType())
                        .addValue("level", s.level())
                        .addValue("prefix", s.prefix())
                        .addValue("source", s.source())
                        .addValue("suffix", s.suffix())
                        .addValue("translatable", s.translatable())
                        .addValue("chunkIndex", s.chunkIndex()))
                .toArray(SqlParameterSource[]::new);
        jdbc.batchUpdate("""
                INSERT INTO biz.doc_segment (task_id, seq, block_type, level, prefix, source_text, suffix, translatable,
                  chunk_index)
                VALUES (:taskId, :seq, :blockType, :level, :prefix, :source, :suffix, :translatable, :chunkIndex)
                ON CONFLICT (task_id, seq) DO UPDATE SET block_type = EXCLUDED.block_type, level = EXCLUDED.level,
                  prefix = EXCLUDED.prefix, source_text = EXCLUDED.source_text, suffix = EXCLUDED.suffix,
                  translatable = EXCLUDED.translatable, chunk_index = EXCLUDED.chunk_index, updated_at = now()""",
                batch);
        jdbc.update("DELETE FROM biz.doc_segment WHERE task_id = :taskId AND NOT (seq = ANY (CAST(:seqs AS int[])))",
                new MapSqlParameterSource("taskId", taskId).addValue("seqs",
                        "{" + segments.stream().map(s -> String.valueOf(s.seq())).collect(Collectors.joining(",")) + "}"));
    }

    public void applyParsed(long taskId, int progressTotal, String detectedLang) {
        jdbc.update("""
                UPDATE biz.doc_task SET progress_total = :total, detected_lang = COALESCE(:lang, detected_lang)
                WHERE id = :id""",
                new MapSqlParameterSource("id", taskId).addValue("total", progressTotal).addValue("lang", detectedLang));
        refreshProgress(taskId);
    }

    public void applyAnalysis(long taskId, String summary, String domain, String genre) {
        jdbc.update("""
                UPDATE biz.doc_task SET summary = COALESCE(:summary, summary), domain = COALESCE(domain, :domain),
                  genre = COALESCE(:genre, genre)
                WHERE id = :id""",
                new MapSqlParameterSource("id", taskId).addValue("summary", summary).addValue("domain", domain)
                        .addValue("genre", genre));
    }

    /** 候选术语：同一源词（不区分大小写）已存在时保留原记录（不覆盖用户的确认结果）。 */
    public void insertTermsIfAbsent(long taskId, List<DocTermVO> terms) {
        if (terms.isEmpty()) {
            return;
        }
        SqlParameterSource[] batch = terms.stream().map(t -> new MapSqlParameterSource()
                        .addValue("taskId", taskId)
                        .addValue("source", t.source())
                        .addValue("target", t.target())
                        .addValue("origin", t.origin())
                        .addValue("frequency", t.frequency() == null ? 0 : t.frequency())
                        .addValue("status", t.status()))
                .toArray(SqlParameterSource[]::new);
        jdbc.batchUpdate("""
                INSERT INTO biz.doc_task_term (task_id, source_term, target_term, origin, frequency, status)
                VALUES (:taskId, :source, :target, :origin, :frequency, :status)
                ON CONFLICT (task_id, lower(source_term)) DO NOTHING""", batch);
    }

    /** 段落译文（chunk_done / consistency）。已被用户编辑的段落不覆盖，返回是否实际更新。 */
    public boolean updateSegmentTarget(long taskId, int seq, String target, Integer reviewScore, Integer reviewRounds,
                                       JsonNode compliance, JsonNode tmHits, boolean full) {
        MapSqlParameterSource p = new MapSqlParameterSource("taskId", taskId).addValue("seq", seq)
                .addValue("target", target);
        if (!full) {
            return jdbc.update("""
                    UPDATE biz.doc_segment SET target_text = :target, updated_at = now()
                    WHERE task_id = :taskId AND seq = :seq AND edited = false""", p) > 0;
        }
        p.addValue("score", reviewScore).addValue("rounds", reviewRounds)
                .addValue("compliance", compliance == null ? "[]" : json(compliance))
                .addValue("tmHits", tmHits == null ? "[]" : json(tmHits));
        return jdbc.update("""
                UPDATE biz.doc_segment SET target_text = :target, review_score = :score, review_rounds = :rounds,
                  compliance = CAST(:compliance AS jsonb), tm_hits = CAST(:tmHits AS jsonb), status = 'DONE',
                  updated_at = now()
                WHERE task_id = :taskId AND seq = :seq AND edited = false""", p) > 0;
    }

    /** 分块完成：该块的全部段落（含不可翻译段与已编辑段）置为 DONE，并按段落表重新统计进度。 */
    public void markChunkDone(long taskId, int chunk) {
        jdbc.update("""
                UPDATE biz.doc_segment SET status = 'DONE', updated_at = now()
                WHERE task_id = :taskId AND chunk_index = :chunk AND status <> 'DONE'""",
                new MapSqlParameterSource("taskId", taskId).addValue("chunk", chunk));
        refreshProgress(taskId);
    }

    /** progress_done = 已完成分块的去重数量，因此重复投递或 retry 时的 cached 块不会重复计数。 */
    public void refreshProgress(long taskId) {
        jdbc.update("""
                UPDATE biz.doc_task SET progress_done = (
                  SELECT count(DISTINCT chunk_index) FROM biz.doc_segment
                  WHERE task_id = :taskId AND status = 'DONE' AND chunk_index IS NOT NULL)
                WHERE id = :taskId""", new MapSqlParameterSource("taskId", taskId));
    }

    public void applyConsistencyReport(long taskId, JsonNode report) {
        jdbc.update("UPDATE biz.doc_task SET consistency_report = CAST(:report AS jsonb) WHERE id = :id",
                new MapSqlParameterSource("id", taskId).addValue("report", json(report)));
    }

    public void insertTrace(long taskId, Integer seq, String node, Integer chunk, String status, String summary,
                            Integer latencyMs, Integer promptTokens, Integer completionTokens) {
        jdbc.update("""
                INSERT INTO biz.doc_task_trace (task_id, seq, node, chunk_index, status, summary, latency_ms,
                  prompt_tokens, completion_tokens)
                VALUES (:taskId, :seq, :node, :chunk, :status, :summary, :latency, :prompt, :completion)""",
                new MapSqlParameterSource("taskId", taskId).addValue("seq", seq == null ? 0 : seq)
                        .addValue("node", node).addValue("chunk", chunk).addValue("status", status)
                        .addValue("summary", summary).addValue("latency", latencyMs)
                        .addValue("prompt", promptTokens).addValue("completion", completionTokens));
        if (promptTokens != null || completionTokens != null) {
            // 运行中的累计用量（completed 时以执行端汇总为准）
            jdbc.update("""
                    UPDATE biz.doc_task SET prompt_tokens = COALESCE(prompt_tokens, 0) + :prompt,
                      completion_tokens = COALESCE(completion_tokens, 0) + :completion
                    WHERE id = :id""",
                    new MapSqlParameterSource("id", taskId)
                            .addValue("prompt", promptTokens == null ? 0 : promptTokens)
                            .addValue("completion", completionTokens == null ? 0 : completionTokens));
        }
    }

    public void applyCompleted(long taskId, Integer promptTokens, Integer completionTokens, Integer latencyMs,
                               JsonNode stats) {
        jdbc.update("""
                UPDATE biz.doc_task SET status = 'COMPLETED', phase = COALESCE(phase, 'assembling'),
                  prompt_tokens = COALESCE(:prompt, prompt_tokens), completion_tokens = COALESCE(:completion, completion_tokens),
                  latency_ms = COALESCE(:latency, latency_ms), stats = COALESCE(CAST(:stats AS jsonb), stats),
                  error_code = NULL, error_message = NULL, retryable = false, finished_at = now(),
                  started_at = COALESCE(started_at, now())
                WHERE id = :id""",
                new MapSqlParameterSource("id", taskId).addValue("prompt", promptTokens)
                        .addValue("completion", completionTokens).addValue("latency", latencyMs)
                        .addValue("stats", stats == null ? null : json(stats)));
    }

    public void applyFailed(long taskId, String code, String message, boolean retryable) {
        jdbc.update("""
                UPDATE biz.doc_task SET status = 'FAILED', error_code = :code, error_message = :message,
                  retryable = :retryable, finished_at = now()
                WHERE id = :id""",
                new MapSqlParameterSource("id", taskId).addValue("code", code).addValue("message", message)
                        .addValue("retryable", retryable));
    }

    public void applyCancelled(long taskId) {
        jdbc.update("""
                UPDATE biz.doc_task SET status = 'CANCELLED', retryable = false, finished_at = now()
                WHERE id = :id""", new MapSqlParameterSource("id", taskId));
    }

    // ---------------- 段落 ----------------

    private static final String SEGMENT_COLUMNS = """
            seq, block_type, level, prefix, source_text, suffix, translatable, chunk_index, target_text, status,
            review_score, review_rounds, compliance, edited, tm_hits""";

    public List<DocSegmentVO> segments(long taskId) {
        return jdbc.query("SELECT " + SEGMENT_COLUMNS + " FROM biz.doc_segment WHERE task_id = :taskId ORDER BY seq",
                new MapSqlParameterSource("taskId", taskId), this::mapSegment);
    }

    public Optional<DocSegmentVO> segment(long taskId, int seq) {
        return jdbc.query("SELECT " + SEGMENT_COLUMNS + " FROM biz.doc_segment WHERE task_id = :taskId AND seq = :seq",
                new MapSqlParameterSource("taskId", taskId).addValue("seq", seq), this::mapSegment).stream().findFirst();
    }

    /** 与 seq 相邻的可翻译段落（before=true 取前一段，否则取后一段）。 */
    public Optional<DocSegmentVO> neighbor(long taskId, int seq, boolean before) {
        String sql = "SELECT " + SEGMENT_COLUMNS + " FROM biz.doc_segment WHERE task_id = :taskId AND translatable"
                + (before ? " AND seq < :seq ORDER BY seq DESC" : " AND seq > :seq ORDER BY seq") + " LIMIT 1";
        return jdbc.query(sql, new MapSqlParameterSource("taskId", taskId).addValue("seq", seq), this::mapSegment)
                .stream().findFirst();
    }

    /** 后编辑：只改译文并标记 edited，不改变段落状态（进度只由执行端事件驱动）。 */
    public void editSegment(long taskId, int seq, String target) {
        jdbc.update("""
                UPDATE biz.doc_segment SET target_text = :target, edited = true, updated_at = now()
                WHERE task_id = :taskId AND seq = :seq""",
                new MapSqlParameterSource("taskId", taskId).addValue("seq", seq).addValue("target", target));
    }

    /** 已被用户编辑的段落 seq。 */
    public List<Integer> editedSeqs(long taskId) {
        return jdbc.queryForList("SELECT seq FROM biz.doc_segment WHERE task_id = :taskId AND edited",
                new MapSqlParameterSource("taskId", taskId), Integer.class);
    }

    // ---------------- 术语 ----------------

    public List<DocTermVO> terms(long taskId) {
        return jdbc.query("""
                SELECT id, source_term, target_term, origin, frequency, status FROM biz.doc_task_term
                WHERE task_id = :taskId ORDER BY frequency DESC, id""",
                new MapSqlParameterSource("taskId", taskId),
                (rs, i) -> new DocTermVO(rs.getLong("id"), rs.getString("source_term"), rs.getString("target_term"),
                        rs.getString("origin"), rs.getInt("frequency"), rs.getString("status")));
    }

    public void updateTerm(long taskId, long termId, String source, String target, String status) {
        jdbc.update("""
                UPDATE biz.doc_task_term SET source_term = :source, target_term = :target, status = :status
                WHERE task_id = :taskId AND id = :id""",
                new MapSqlParameterSource("taskId", taskId).addValue("id", termId).addValue("source", source)
                        .addValue("target", target).addValue("status", status));
    }

    public void insertTerm(long taskId, String source, String target, String origin, String status) {
        jdbc.update("""
                INSERT INTO biz.doc_task_term (task_id, source_term, target_term, origin, frequency, status)
                VALUES (:taskId, :source, :target, :origin, 0, :status)""",
                new MapSqlParameterSource("taskId", taskId).addValue("source", source).addValue("target", target)
                        .addValue("origin", origin).addValue("status", status));
    }

    /** 本次确认中未出现的待确认术语视为拒绝。 */
    public void rejectPendingExcept(long taskId, Collection<Long> keepIds) {
        MapSqlParameterSource p = new MapSqlParameterSource("taskId", taskId);
        String extra = "";
        if (!keepIds.isEmpty()) {
            extra = " AND id NOT IN (:ids)";
            p.addValue("ids", keepIds);
        }
        jdbc.update("UPDATE biz.doc_task_term SET status = 'REJECTED' WHERE task_id = :taskId AND status = 'PENDING'"
                + extra, p);
    }

    // ---------------- 轨迹 ----------------

    public List<DocTraceVO> traces(long taskId) {
        return jdbc.query("""
                SELECT seq, node, chunk_index, status, summary, latency_ms, prompt_tokens, completion_tokens, created_at
                FROM biz.doc_task_trace WHERE task_id = :taskId ORDER BY id""",
                new MapSqlParameterSource("taskId", taskId),
                (rs, i) -> new DocTraceVO(rs.getInt("seq"), rs.getString("node"), intOrNull(rs, "chunk_index"),
                        rs.getString("status"), rs.getString("summary"), intOrNull(rs, "latency_ms"),
                        intOrNull(rs, "prompt_tokens"), intOrNull(rs, "completion_tokens"),
                        rs.getObject("created_at", OffsetDateTime.class)));
    }

    // ---------------- 映射 ----------------

    private DocTaskRow mapTask(ResultSet rs, int i) throws SQLException {
        return new DocTaskRow(rs.getLong("id"), rs.getLong("user_id"), rs.getString("title"), rs.getString("format"),
                rs.getInt("char_count"), rs.getString("source_lang"), rs.getString("detected_lang"),
                rs.getString("target_lang"), rs.getString("style"), rs.getString("domain"), rs.getString("genre"),
                longs(rs.getArray("glossary_ids")), longOrNull(rs, "model_config_id"),
                longOrNull(rs, "review_model_config_id"), rs.getString("strategy"),
                rs.getBoolean("confirm_terms"), options(rs.getString("options")), rs.getString("status"),
                rs.getString("phase"), rs.getInt("progress_done"), rs.getInt("progress_total"),
                rs.getString("summary"), jsonOrNull(rs.getString("consistency_report")),
                jsonOrNull(rs.getString("stats")), rs.getString("error_code"), rs.getString("error_message"),
                rs.getBoolean("retryable"), rs.getInt("last_event_seq"),
                rs.getObject("last_event_at", OffsetDateTime.class), intOrNull(rs, "prompt_tokens"),
                intOrNull(rs, "completion_tokens"), intOrNull(rs, "latency_ms"),
                rs.getObject("created_at", OffsetDateTime.class), rs.getObject("started_at", OffsetDateTime.class),
                rs.getObject("finished_at", OffsetDateTime.class));
    }

    private DocSegmentVO mapSegment(ResultSet rs, int i) throws SQLException {
        JsonNode compliance = jsonOrNull(rs.getString("compliance"));
        JsonNode tmHits = jsonOrNull(rs.getString("tm_hits"));
        return new DocSegmentVO(rs.getInt("seq"), rs.getString("block_type"), intOrNull(rs, "level"),
                rs.getString("prefix"), rs.getString("source_text"), rs.getString("suffix"),
                rs.getBoolean("translatable"), intOrNull(rs, "chunk_index"), rs.getString("target_text"),
                rs.getString("status"), intOrNull(rs, "review_score"), intOrNull(rs, "review_rounds"),
                compliance == null ? jsonMapper.createArrayNode() : compliance, rs.getBoolean("edited"),
                tmHits == null ? jsonMapper.createArrayNode() : tmHits);
    }

    private DocOptions options(String json) {
        if (json == null) {
            return DocOptions.DEFAULTS;
        }
        return jsonMapper.readValue(json, DocOptions.class).normalized();
    }

    private JsonNode jsonOrNull(String json) {
        return json == null ? null : jsonMapper.readTree(json);
    }

    private String json(Object value) {
        return jsonMapper.writeValueAsString(value);
    }

    private static String arrayLiteral(List<Long> ids) {
        return "{" + (ids == null ? "" : ids.stream().map(String::valueOf).collect(Collectors.joining(","))) + "}";
    }

    private static List<Long> longs(Array array) throws SQLException {
        if (array == null) {
            return List.of();
        }
        Object[] values = (Object[]) array.getArray();
        List<Long> out = new ArrayList<>(values.length);
        Arrays.stream(values).forEach(v -> out.add(((Number) v).longValue()));
        return out;
    }

    private static Integer intOrNull(ResultSet rs, String col) throws SQLException {
        int v = rs.getInt(col);
        return rs.wasNull() ? null : v;
    }

    private static Long longOrNull(ResultSet rs, String col) throws SQLException {
        long v = rs.getLong(col);
        return rs.wasNull() ? null : v;
    }
}
