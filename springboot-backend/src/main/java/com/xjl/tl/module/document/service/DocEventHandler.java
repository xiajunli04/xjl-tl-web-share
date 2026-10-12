package com.xjl.tl.module.document.service;

import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.module.document.DocStatus;
import com.xjl.tl.module.document.dto.DocDtos.DocTermVO;
import com.xjl.tl.module.document.repository.DocRepository;
import com.xjl.tl.module.document.repository.DocRepository.SegmentStructure;
import com.xjl.tl.module.document.repository.DocTaskRow;
import com.xjl.tl.module.document.service.DocSseHub.Push;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.UnaryOperator;

/**
 * 事件流 tl:doc-events 的单条事件落库（design D2，样例见 docs/contracts/doc-stream-sample.md 第 2 节）。
 * <p>
 * 一条事件在一个事务内处理：锁定任务行 → 按 eventSeq 去重 → 按类型落库 → 记录 last_event_seq。
 * 返回需要推送给浏览器的事件（data 形式见 design D13），由调用方在提交并 XACK 之后推送。
 */
@Component
public class DocEventHandler {

    private static final Logger log = LoggerFactory.getLogger(DocEventHandler.class);
    private static final String TERM_PENDING = "PENDING";
    private static final String TERM_CONFIRMED = "CONFIRMED";
    private static final String TERM_AUTO = "AUTO";
    private static final String ORIGIN_GLOSSARY = "glossary";

    private final DocRepository repo;
    private final JsonMapper jsonMapper;

    public DocEventHandler(DocRepository repo, JsonMapper jsonMapper) {
        this.repo = repo;
        this.jsonMapper = jsonMapper;
    }

    /** 无法处理的消息（字段缺失、JSON 非法）：确认并丢弃，避免反复投递。 */
    public static class PoisonEventException extends RuntimeException {
        public PoisonEventException(String message) {
            super(message);
        }
    }

    /** 处理结果：applied=false 表示被忽略（任务不存在 / 已删除 / 重复事件）。 */
    public record Outcome(boolean applied, String reason, List<Push> pushes) {
        static Outcome ignored(String reason) {
            return new Outcome(false, reason, List.of());
        }
    }

    @Transactional
    public Outcome handle(Map<String, String> fields) {
        long taskId = parseLong(fields.get("taskId"), "taskId");
        long seqLong = parseLong(fields.get("eventSeq"), "eventSeq");
        if (seqLong > Integer.MAX_VALUE || seqLong < 1) {
            throw new PoisonEventException("eventSeq 超出范围：" + seqLong);
        }
        int eventSeq = (int) seqLong;
        String type = fields.get("type");
        if (type == null || type.isBlank()) {
            throw new PoisonEventException("缺少 type");
        }
        JsonNode data = parseData(fields.get("data"));

        Optional<DocTaskRow> locked = repo.lockTask(taskId);
        if (locked.isEmpty()) {
            return Outcome.ignored("任务不存在或已删除");
        }
        DocTaskRow task = locked.get();
        if (eventSeq <= task.lastEventSeq()) {
            return Outcome.ignored("重复事件（eventSeq=" + eventSeq + " ≤ " + task.lastEventSeq() + "）");
        }

        List<Push> pushes = switch (type) {
            case "phase" -> onPhase(task, data);
            case "parsed" -> onParsed(task, data);
            case "analysis" -> onAnalysis(task, data);
            case "awaiting_confirm" -> onAwaitingConfirm(task, data);
            case "chunk_done" -> onChunkDone(task, data);
            case "consistency" -> onConsistency(task, data);
            case "trace" -> onTrace(task, data);
            case "completed" -> onCompleted(task, data);
            case "failed" -> onFailed(task, data);
            case "cancelled" -> onCancelled(task);
            default -> {
                log.warn("未知的文档事件类型 taskId={} type={}，仅记录序号", taskId, type);
                yield List.of();
            }
        };
        repo.markEvent(taskId, eventSeq);
        return new Outcome(true, null, pushes);
    }

    // ---------------- 各类事件 ----------------

    private List<Push> onPhase(DocTaskRow task, JsonNode data) {
        String phase = truncate(text(data, "phase"), 24);
        String status = DocStatus.fromPhase(phase);
        if (DocStatus.CANCELLING.equals(task.status())) {
            // 取消进行中：在途事件只记录阶段，不把状态改回运行中
            status = null;
        }
        repo.applyPhase(task.id(), phase, status);
        String now = status != null ? status : task.status();
        return List.of(push(task, "phase", map("status", now, "phase", phase)));
    }

    private List<Push> onParsed(DocTaskRow task, JsonNode data) {
        Map<Integer, Integer> chunkOf = new HashMap<>();
        int chunks = 0;
        for (JsonNode c : data.path("chunks")) {
            chunks++;
            int index = c.path("index").asInt(chunks - 1);
            for (JsonNode s : c.path("segSeqs")) {
                chunkOf.put(s.asInt(), index);
            }
        }
        List<SegmentStructure> segments = new ArrayList<>();
        for (JsonNode s : data.path("segments")) {
            if (!s.path("seq").isNumber()) {
                throw new PoisonEventException("parsed 事件中的段落缺少 seq");
            }
            int seq = s.path("seq").asInt();
            segments.add(new SegmentStructure(seq, truncate(text(s, "blockType", "paragraph"), 16),
                    s.path("level").isNumber() ? s.path("level").asInt() : null,
                    text(s, "prefix", ""), text(s, "source", ""), text(s, "suffix", ""),
                    s.path("translatable").asBoolean(true), chunkOf.get(seq)));
        }
        repo.upsertSegments(task.id(), segments);
        String detected = truncate(text(data, "detectedLang"), 8);
        repo.applyParsed(task.id(), chunks, detected);
        DocTaskRow now = reload(task);
        return List.of(push(task, "parsed", map("progressTotal", now.progressTotal(), "detectedLang", now.detectedLang())));
    }

    private List<Push> onAnalysis(DocTaskRow task, JsonNode data) {
        repo.applyAnalysis(task.id(), text(data, "summary"), truncate(text(data, "domain"), 32),
                truncate(text(data, "genre"), 32));
        // 不需要人工确认时，候选术语即任务术语表（由执行端自动采用）：术语库命中为硬约束 CONFIRMED，
        // 抽取结果未经人工确认，只作软约束 AUTO（见 improve-agent-from-experiments D1）
        UnaryOperator<String> statusOf = Boolean.TRUE.equals(task.confirmTerms())
                ? origin -> TERM_PENDING
                : origin -> ORIGIN_GLOSSARY.equals(origin) ? TERM_CONFIRMED : TERM_AUTO;
        repo.insertTermsIfAbsent(task.id(), candidates(data.path("candidates"), statusOf));
        DocTaskRow now = reload(task);
        return List.of(push(task, "analysis", map("summary", now.summary(), "domain", now.domain(), "genre", now.genre())));
    }

    private List<Push> onAwaitingConfirm(DocTaskRow task, JsonNode data) {
        repo.insertTermsIfAbsent(task.id(), candidates(data.path("candidates"), origin -> TERM_PENDING));
        List<Push> pushes = new ArrayList<>();
        if (!DocStatus.CANCELLING.equals(task.status()) && !DocStatus.AWAITING_CONFIRM.equals(task.status())) {
            repo.applyPhase(task.id(), "awaiting_confirm", DocStatus.AWAITING_CONFIRM);
            pushes.add(push(task, "phase", map("status", DocStatus.AWAITING_CONFIRM, "phase", "awaiting_confirm")));
        }
        pushes.add(push(task, "awaiting_confirm", map("terms", repo.terms(task.id()))));
        return pushes;
    }

    private List<Push> onChunkDone(DocTaskRow task, JsonNode data) {
        if (!data.path("chunk").isNumber()) {
            throw new PoisonEventException("chunk_done 缺少 chunk");
        }
        int chunk = data.path("chunk").asInt();
        ArrayNode applied = jsonMapper.createArrayNode();
        for (JsonNode s : data.path("segments")) {
            if (!s.path("seq").isNumber()) {
                continue;
            }
            JsonNode compliance = s.path("compliance").isArray() ? s.get("compliance") : jsonMapper.createArrayNode();
            // 该段命中的翻译记忆（0–1 条），缺省为空数组
            JsonNode tmHits = s.path("tmHits").isArray() ? s.get("tmHits") : jsonMapper.createArrayNode();
            boolean updated = repo.updateSegmentTarget(task.id(), s.path("seq").asInt(), text(s, "target"),
                    intOrNull(s.path("reviewScore")), intOrNull(s.path("reviewRounds")), compliance, tmHits, true);
            if (updated) {
                ObjectNode out = jsonMapper.createObjectNode();
                out.put("seq", s.path("seq").asInt());
                out.put("target", text(s, "target"));
                putInt(out, "reviewScore", intOrNull(s.path("reviewScore")));
                putInt(out, "reviewRounds", intOrNull(s.path("reviewRounds")));
                out.set("compliance", compliance);
                out.set("tmHits", tmHits);
                applied.add(out);
            }
        }
        repo.markChunkDone(task.id(), chunk);
        DocTaskRow now = reload(task);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("chunk", chunk);
        out.put("progressDone", now.progressDone());
        out.put("progressTotal", now.progressTotal());
        out.put("cached", data.path("cached").asBoolean(false));
        out.put("segments", applied);
        return List.of(push(task, "chunk_done", out));
    }

    private List<Push> onConsistency(DocTaskRow task, JsonNode data) {
        ObjectNode report = jsonMapper.createObjectNode();
        report.set("issues", data.path("issues").isArray() ? data.get("issues") : jsonMapper.createArrayNode());
        // 行内保护标记还原失败、保留原文的段落（design D3），可选字段
        if (data.path("protectionFailures").isArray()) {
            report.set("protectionFailures", data.get("protectionFailures"));
        }
        repo.applyConsistencyReport(task.id(), report);
        ArrayNode applied = jsonMapper.createArrayNode();
        for (JsonNode s : data.path("segments")) {
            if (!s.path("seq").isNumber()) {
                continue;
            }
            if (repo.updateSegmentTarget(task.id(), s.path("seq").asInt(), text(s, "target"), null, null, null, null,
                    false)) {
                ObjectNode out = jsonMapper.createObjectNode();
                out.put("seq", s.path("seq").asInt());
                out.put("target", text(s, "target"));
                applied.add(out);
            }
        }
        return List.of(push(task, "consistency", map("report", report, "segments", applied)));
    }

    private List<Push> onTrace(DocTaskRow task, JsonNode data) {
        JsonNode usage = data.path("usage");
        repo.insertTrace(task.id(), intOrNull(data.path("seq")), truncate(text(data, "node", "unknown"), 32),
                intOrNull(data.path("chunk")), truncate(text(data, "status", "completed"), 16), text(data, "summary"),
                intOrNull(data.path("latencyMs")), intOrNull(usage.path("promptTokens")),
                intOrNull(usage.path("completionTokens")));
        // D13 的浏览器事件表不含 trace，前端通过 GET /traces 查看
        return List.of();
    }

    private List<Push> onCompleted(DocTaskRow task, JsonNode data) {
        JsonNode usage = data.path("usage");
        repo.applyCompleted(task.id(), intOrNull(usage.path("promptTokens")), intOrNull(usage.path("completionTokens")),
                intOrNull(data.path("latencyMs")), data.path("stats").isObject() ? data.get("stats") : null);
        return List.of(new Push(task.id(), "completed", reload(task).toVO(), true));
    }

    private List<Push> onFailed(DocTaskRow task, JsonNode data) {
        String code = truncate(text(data, "code", ErrorCode.DOC_TASK_FAILED.getCode()), 8);
        String message = truncate(text(data, "message", ErrorCode.DOC_TASK_FAILED.getMessage()), 500);
        boolean retryable = data.path("retryable").asBoolean(true);
        repo.applyFailed(task.id(), code, message, retryable);
        return List.of(new Push(task.id(), "failed", map("code", code, "message", message, "retryable", retryable), true));
    }

    private List<Push> onCancelled(DocTaskRow task) {
        repo.applyCancelled(task.id());
        return List.of(new Push(task.id(), "cancelled", Map.of(), true));
    }

    // ---------------- 工具 ----------------

    /** 解析候选术语（按源词去重，不区分大小写）；status 由来源（origin）决定。 */
    private List<DocTermVO> candidates(JsonNode array, UnaryOperator<String> statusOf) {
        List<DocTermVO> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (JsonNode c : array) {
            String source = truncate(trim(text(c, "source")), 200);
            String target = truncate(trim(text(c, "target")), 200);
            if (source == null || source.isEmpty() || target == null || !seen.add(source.toLowerCase())) {
                continue;
            }
            String origin = truncate(text(c, "origin", "extracted"), 16);
            out.add(new DocTermVO(null, source, target, origin, c.path("frequency").asInt(0), statusOf.apply(origin)));
        }
        return out;
    }

    private DocTaskRow reload(DocTaskRow task) {
        return repo.findTask(task.id()).orElse(task);
    }

    private static Push push(DocTaskRow task, String event, Object data) {
        return new Push(task.id(), event, data, false);
    }

    /** 保留 null 值的有序 Map（Map.of 不允许 null）。 */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    private JsonNode parseData(String raw) {
        if (raw == null || raw.isBlank()) {
            return jsonMapper.createObjectNode();
        }
        try {
            JsonNode node = jsonMapper.readTree(raw);
            if (node == null || !node.isObject()) {
                throw new PoisonEventException("data 不是 JSON 对象");
            }
            return node;
        } catch (PoisonEventException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new PoisonEventException("data 不是合法 JSON：" + e.getMessage());
        }
    }

    private static long parseLong(String value, String field) {
        if (value == null) {
            throw new PoisonEventException("缺少 " + field);
        }
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException e) {
            throw new PoisonEventException(field + " 不是数字：" + value);
        }
    }

    private static String text(JsonNode node, String field) {
        return text(node, field, null);
    }

    private static String text(JsonNode node, String field, String fallback) {
        JsonNode v = node.path(field);
        return v.isString() ? v.asString() : (v.isNumber() || v.isBoolean() ? v.asString() : fallback);
    }

    private static void putInt(ObjectNode node, String field, Integer value) {
        if (value == null) {
            node.putNull(field);
        } else {
            node.put(field, value);
        }
    }

    private static Integer intOrNull(JsonNode n) {
        return n != null && n.isNumber() ? n.asInt() : null;
    }

    private static String trim(String s) {
        return s == null ? null : s.trim();
    }

    private static String truncate(String s, int max) {
        return s == null || s.length() <= max ? s : s.substring(0, max);
    }
}
