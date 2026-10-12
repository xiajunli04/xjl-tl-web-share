package com.xjl.tl.module.interpret.service;

import com.xjl.tl.common.config.MediaProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 同传转写段写入器（add-speech-and-image-translation D9 / Risks「音频转发占用 Spring 线程」）。
 * <ul>
 *   <li>同一 utterance 的 transcript.final、各目标 translation.final 与 metrics 合并为一条 interpret_segment：
 *       全部到齐即完成，否则自 transcript.final 起 {@code segment-wait-timeout}（5 s）超时后按已有内容完成</li>
 *   <li>完成的段每 {@code segment-flush-interval}（1 s）或累计 {@code segment-flush-batch}（20 条）批量写入</li>
 *   <li>会话结束：强制完成该会话的待合并段、写入，再统计并把会话改为 ENDED（ended_at / duration_ms / stats）</li>
 * </ul>
 * 所有状态只在一个单线程调度器上访问；WebSocket / Python 回调线程只投递任务，不做阻塞操作。
 */
@Component
public class SegmentWriter implements DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(SegmentWriter.class);
    /** 已完成的 utterance 记录上限（用于忽略迟到事件）。 */
    private static final int RECENT_LIMIT = 2000;
    private static final String INSERT_SQL = """
            INSERT INTO biz.interpret_segment (session_id, seq, speaker_participant, speaker_name, speaker_user_id,
              source_lang, source_text, translations, metrics, started_ms, ended_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)
            ON CONFLICT (session_id, seq) DO NOTHING""";

    private final JdbcTemplate jdbc;
    private final JsonMapper jsonMapper;
    private final MediaProperties props;
    private final ScheduledExecutorService executor;

    /** 待合并：键为 sessionId|utteranceId，按创建顺序。 */
    private final Map<String, Pending> pending = new LinkedHashMap<>();
    private final List<Row> queue = new ArrayList<>();
    private final Map<Long, Integer> nextSeq = new HashMap<>();
    private final Map<String, Integer> recent = new LinkedHashMap<>(256, 0.75f, false) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Integer> eldest) {
            return size() > RECENT_LIMIT;
        }
    };

    public SegmentWriter(JdbcTemplate jdbc, JsonMapper jsonMapper, MediaProperties props) {
        this.jdbc = jdbc;
        this.jsonMapper = jsonMapper;
        this.props = props;
        this.executor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "interpret-segment-writer");
            t.setDaemon(true);
            return t;
        });
        long flushMs = Math.max(20, props.segmentFlushInterval().toMillis());
        long scanMs = Math.max(20, Math.min(250, props.segmentWaitTimeout().toMillis() / 4));
        executor.scheduleWithFixedDelay(this::safeFlush, flushMs, flushMs, TimeUnit.MILLISECONDS);
        executor.scheduleWithFixedDelay(this::expire, scanMs, scanMs, TimeUnit.MILLISECONDS);
    }

    /** 发言人信息。 */
    public record Speaker(String participantId, String displayName, Long userId) {
    }

    /**
     * 会话结束统计所需的房间信息。
     *
     * @param sessionId    会话 id
     * @param e2eValues    会话内全部 metrics.e2eMs
     * @param participants 参与过的成员数
     * @param languages    出现过的语言
     */
    public record FinishInfo(long sessionId, List<Integer> e2eValues, int participants, Collection<String> languages) {
    }

    private static final class Pending {
        final long sessionId;
        final String utteranceId;
        final long createdAt = System.currentTimeMillis();
        Speaker speaker;
        String sourceLang;
        String sourceText;
        Integer startedMs;
        Integer endedMs;
        Set<String> expected = Set.of();
        boolean transcribed;
        final Map<String, String> translations = new LinkedHashMap<>();
        JsonNode metrics;

        Pending(long sessionId, String utteranceId) {
            this.sessionId = sessionId;
            this.utteranceId = utteranceId;
        }

        boolean complete() {
            return transcribed && translations.keySet().containsAll(expected) && metrics != null;
        }
    }

    private record Row(long sessionId, int seq, Speaker speaker, String sourceLang, String sourceText,
                       String translations, String metrics, Integer startedMs, Integer endedMs) {
    }

    // ---------------- 事件投递（任意线程） ----------------

    /**
     * 原文定稿。
     *
     * @param expected 期望到齐的译文语言（发言流当前目标去掉源语种）
     */
    public void transcript(long sessionId, String utteranceId, Speaker speaker, String lang, String text,
                           Integer startedMs, Integer endedMs, Set<String> expected) {
        executor.execute(() -> {
            Pending p = pendingFor(sessionId, utteranceId);
            if (p == null) {
                return;
            }
            p.speaker = speaker;
            p.sourceLang = lang;
            p.sourceText = text;
            p.startedMs = startedMs;
            p.endedMs = endedMs;
            p.expected = Set.copyOf(expected);
            p.transcribed = true;
            completeIfReady(p);
        });
    }

    /** 某个目标语言的译文定稿。 */
    public void translation(long sessionId, String utteranceId, Speaker speaker, String lang, String text) {
        executor.execute(() -> {
            Pending p = pendingFor(sessionId, utteranceId);
            if (p == null) {
                // 超时写入之后才到的译文（级联链路首段译音合成较慢时）：回填到已写入的行，不丢弃
                backfill(sessionId, utteranceId, "translations = translations || ?::jsonb",
                        jsonMapper.writeValueAsString(Map.of(lang, text)));
                return;
            }
            if (p.speaker == null) {
                p.speaker = speaker;
            }
            p.translations.put(lang, text);
            completeIfReady(p);
        });
    }

    /** 本句指标（按契约在该句全部事件之后到达）。 */
    public void metrics(long sessionId, String utteranceId, Speaker speaker, JsonNode metrics) {
        executor.execute(() -> {
            Pending p = pendingFor(sessionId, utteranceId);
            if (p == null) {
                backfill(sessionId, utteranceId, "metrics = coalesce(metrics, ?::jsonb)", jsonMapper.writeValueAsString(metrics));
                return;
            }
            if (p.speaker == null) {
                p.speaker = speaker;
            }
            p.metrics = metrics;
            completeIfReady(p);
        });
    }

    /**
     * 撤回一句（transcript.discard，improve-speech-endpointing-and-live-ux D4 / D6）：移除待合并段；
     * 已进入写入队列的从队列移除，已写入的删除该行。之后该句的迟到事件一律忽略。
     */
    public void discard(long sessionId, String utteranceId) {
        executor.execute(() -> {
            String key = sessionId + "|" + utteranceId;
            pending.remove(key);
            Integer seq = recent.put(key, -1);
            if (seq == null || seq <= 0) {
                return;
            }
            if (queue.removeIf(r -> r.sessionId() == sessionId && r.seq() == seq)) {
                return;
            }
            try {
                jdbc.update("DELETE FROM biz.interpret_segment WHERE session_id = ? AND seq = ?", sessionId, seq);
            } catch (RuntimeException e) {
                log.warn("撤回同传转写段失败 session={} seq={}", sessionId, seq, e);
            }
        });
    }

    /**
     * 结束会话：完成该会话全部待合并段并写入，统计后把会话改为 ENDED。返回结束事件使用的统计
     * {utterances, avgE2eMs, p50E2eMs, participants, languages, durationMs}。
     */
    public CompletableFuture<ObjectNode> finish(FinishInfo info) {
        CompletableFuture<ObjectNode> result = new CompletableFuture<>();
        executor.execute(() -> {
            try {
                Iterator<Pending> it = pending.values().iterator();
                while (it.hasNext()) {
                    Pending p = it.next();
                    if (p.sessionId == info.sessionId()) {
                        it.remove();
                        enqueue(p);
                    }
                }
                flush();
                result.complete(endSession(info));
            } catch (RuntimeException e) {
                log.error("结束同传会话失败 sessionId={}", info.sessionId(), e);
                result.completeExceptionally(e);
            } finally {
                nextSeq.remove(info.sessionId());
            }
        });
        return result;
    }

    // ---------------- 写线程内部 ----------------

    private Pending pendingFor(long sessionId, String utteranceId) {
        String key = sessionId + "|" + utteranceId;
        if (recent.containsKey(key)) {
            // 已写入后的迟到事件（如超时之后才到的 metrics）
            return null;
        }
        return pending.computeIfAbsent(key, k -> new Pending(sessionId, utteranceId));
    }

    /** 迟到事件回填：先写出队列中的段（保证目标行已存在），再更新该行。 */
    private void backfill(long sessionId, String utteranceId, String setClause, String json) {
        Integer seq = recent.get(sessionId + "|" + utteranceId);
        if (seq == null || seq <= 0) {
            return;
        }
        try {
            flush();
            jdbc.update("UPDATE biz.interpret_segment SET " + setClause + " WHERE session_id = ? AND seq = ?",
                    json, sessionId, seq);
        } catch (RuntimeException e) {
            log.warn("同传转写段回填失败 session={} seq={}", sessionId, seq, e);
        }
    }

    private void completeIfReady(Pending p) {
        if (p.complete()) {
            pending.remove(p.sessionId + "|" + p.utteranceId);
            enqueue(p);
        }
    }

    /** 超时：自创建起超过 segment-wait-timeout 的待合并段按已有内容完成。 */
    private void expire() {
        try {
            long deadline = System.currentTimeMillis() - props.segmentWaitTimeout().toMillis();
            Iterator<Pending> it = pending.values().iterator();
            while (it.hasNext()) {
                Pending p = it.next();
                if (p.createdAt <= deadline) {
                    it.remove();
                    enqueue(p);
                }
            }
        } catch (RuntimeException e) {
            log.error("同传转写段超时处理失败", e);
        }
    }

    /** 进入写入队列（没有原文也没有译文的段直接丢弃）；达到批量条数时立即写入。 */
    private void enqueue(Pending p) {
        String key = p.sessionId + "|" + p.utteranceId;
        if (!p.transcribed && p.translations.isEmpty()) {
            recent.put(key, -1);
            return;
        }
        int seq = nextSeq.computeIfAbsent(p.sessionId, id -> {
            Integer max = jdbc.queryForObject(
                    "SELECT coalesce(max(seq), 0) FROM biz.interpret_segment WHERE session_id = ?", Integer.class, id);
            return max == null ? 1 : max + 1;
        });
        nextSeq.put(p.sessionId, seq + 1);
        recent.put(key, seq);
        Speaker s = p.speaker != null ? p.speaker : new Speaker(p.utteranceId.split(":")[0], null, null);
        queue.add(new Row(p.sessionId, seq, s, truncate(p.sourceLang, 8), p.sourceText == null ? "" : p.sourceText,
                jsonMapper.writeValueAsString(p.translations),
                p.metrics == null ? null : jsonMapper.writeValueAsString(p.metrics), p.startedMs, p.endedMs));
        if (queue.size() >= props.segmentFlushBatch()) {
            flush();
        }
    }

    private void safeFlush() {
        try {
            flush();
        } catch (RuntimeException e) {
            log.error("同传转写段写入失败", e);
        }
    }

    /** 批量写入队列中的段；失败时记录日志并丢弃本批（避免一条坏数据阻塞后续写入）。 */
    private void flush() {
        if (queue.isEmpty()) {
            return;
        }
        List<Row> batch = new ArrayList<>(queue);
        queue.clear();
        try {
            jdbc.batchUpdate(INSERT_SQL, batch, batch.size(), (ps, r) -> {
                ps.setLong(1, r.sessionId());
                ps.setInt(2, r.seq());
                ps.setString(3, truncate(r.speaker().participantId(), 32));
                ps.setString(4, truncate(r.speaker().displayName(), 64));
                ps.setObject(5, r.speaker().userId());
                ps.setString(6, r.sourceLang());
                ps.setString(7, r.sourceText());
                ps.setString(8, r.translations());
                ps.setString(9, r.metrics());
                ps.setObject(10, r.startedMs());
                ps.setObject(11, r.endedMs());
            });
        } catch (RuntimeException e) {
            log.error("同传转写段批量写入失败，丢弃 {} 条", batch.size(), e);
        }
    }

    private ObjectNode endSession(FinishInfo info) {
        Integer utterances = jdbc.queryForObject("SELECT count(*) FROM biz.interpret_segment WHERE session_id = ?",
                Integer.class, info.sessionId());
        ObjectNode stats = jsonMapper.createObjectNode();
        stats.put("utterances", utterances == null ? 0 : utterances);
        List<Integer> e2e = info.e2eValues().stream().filter(v -> v != null && v >= 0).sorted().toList();
        if (e2e.isEmpty()) {
            stats.putNull("avgE2eMs");
            stats.putNull("p50E2eMs");
        } else {
            stats.put("avgE2eMs", Math.round(e2e.stream().mapToInt(Integer::intValue).average().orElse(0)));
            int n = e2e.size();
            stats.put("p50E2eMs", n % 2 == 1 ? e2e.get(n / 2) : Math.round((e2e.get(n / 2 - 1) + e2e.get(n / 2)) / 2.0));
        }
        stats.put("participants", info.participants());
        stats.set("languages", jsonMapper.valueToTree(List.copyOf(info.languages())));
        String json = jsonMapper.writeValueAsString(stats);
        List<Integer> durations = jdbc.queryForList("""
                UPDATE biz.interpret_session
                   SET status = 'ENDED', ended_at = now(), stats = ?::jsonb,
                       duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int)
                 WHERE id = ? AND status = 'ACTIVE'
                RETURNING duration_ms""", Integer.class, json, info.sessionId());
        ObjectNode event = stats.deepCopy();
        if (durations.isEmpty()) {
            // 已经结束过（并发结束）：沿用库中的时长
            List<Integer> existing = jdbc.queryForList("SELECT duration_ms FROM biz.interpret_session WHERE id = ?",
                    Integer.class, info.sessionId());
            event.put("durationMs", existing.isEmpty() || existing.getFirst() == null ? 0 : existing.getFirst());
        } else {
            event.put("durationMs", durations.getFirst());
        }
        return event;
    }

    private static String truncate(String v, int max) {
        return v == null || v.length() <= max ? v : v.substring(0, max);
    }

    /** 等待写线程处理完已投递的任务（测试与关闭时使用）。 */
    public void drain(long timeoutMs) {
        try {
            executor.submit(this::safeFlush).get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            log.warn("等待同传转写段写入超时：{}", e.toString());
        }
    }

    @Override
    public void destroy() {
        drain(3000);
        executor.shutdownNow();
    }
}
