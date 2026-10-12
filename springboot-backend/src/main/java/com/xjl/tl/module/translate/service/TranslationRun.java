package com.xjl.tl.module.translate.service;

import com.xjl.tl.module.translate.dto.TranslateDtos.UpstreamTranslateRequest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;

/**
 * 一次翻译的运行状态：在转发事件的同时归集 detect / terms / plan / review / delta 与节点轨迹，
 * 收到 final 后据此落库（见 design D5 / D6）。
 * <p>
 * 事件由 Reactor 串行投递（concatMap），归集逻辑无需加锁；跨线程读取的标志位使用原子类型。
 * <p>
 * 会话内的翻译带 {@link SessionTurn}；追问恢复时用 {@link #restore(JsonNode)} 载入中断前的归集结果与轨迹，
 * 落库时中断前后的轨迹合并在同一条记录下。
 */
public class TranslationRun {

    /** 追问中断时 clarify 节点的状态。 */
    public static final String STATUS_INTERRUPTED = "interrupted";

    private final JsonMapper jsonMapper;
    private final UpstreamTranslateRequest request;
    /** 记录中保存的模型 id：请求未指定时为发起时的默认模型。 */
    private final Long modelConfigId;
    /** 会话信息；非会话翻译为 null。 */
    private final SessionTurn session;

    private JsonNode detect;
    private JsonNode terms;
    private JsonNode plan;
    private Integer lastReviewScore;
    private int refineCompleted;
    /** 追问中断前已归集的轨迹（按原顺序）。 */
    private final List<NodeTrace> prior = new ArrayList<>();
    private final List<NodeTrace> closed = new ArrayList<>();
    private final List<NodeTrace> open = new ArrayList<>();

    private final AtomicBoolean sawEvent = new AtomicBoolean();
    private final AtomicBoolean terminated = new AtomicBoolean();
    private final AtomicBoolean finalReceived = new AtomicBoolean();

    public TranslationRun(JsonMapper jsonMapper, UpstreamTranslateRequest request, Long modelConfigId) {
        this(jsonMapper, request, modelConfigId, null);
    }

    public TranslationRun(JsonMapper jsonMapper, UpstreamTranslateRequest request, Long modelConfigId,
                          SessionTurn session) {
        this.jsonMapper = jsonMapper;
        this.request = request;
        this.modelConfigId = modelConfigId;
        this.session = session;
    }

    /**
     * 会话内一次翻译的上下文。
     *
     * @param sessionId             会话 id
     * @param turnSeq               本轮轮次号（修订为被修订轮的 seq）
     * @param revisionOf            修订来源记录 id（仅修订）
     * @param reviseInstruction     修订要求（仅修订）
     * @param resumedThreadId       恢复的追问 threadId（仅追问恢复）
     * @param clarificationFallback 追问问答兜底（final 未提供 clarification 时使用，仅追问恢复）
     */
    public record SessionTurn(Long sessionId, Integer turnSeq, Long revisionOf, String reviseInstruction,
                              String resumedThreadId, JsonNode clarificationFallback) {

        public boolean isRevision() {
            return revisionOf != null;
        }

        public boolean isResume() {
            return resumedThreadId != null;
        }
    }

    /** 节点轨迹（一次节点执行：started → completed，或单独的 skipped）。 */
    public static final class NodeTrace {
        private final String node;
        private final int order;
        private String status;
        private String summary;
        private Integer latencyMs;
        private Integer promptTokens;
        private Integer completionTokens;
        private final ObjectNode detail;

        NodeTrace(String node, int order, ObjectNode detail) {
            this.node = node;
            this.order = order;
            this.detail = detail;
        }

        public String node() {
            return node;
        }

        public String status() {
            return status;
        }

        public String summary() {
            return summary;
        }

        public Integer latencyMs() {
            return latencyMs;
        }

        public Integer promptTokens() {
            return promptTokens;
        }

        public Integer completionTokens() {
            return completionTokens;
        }

        public ObjectNode detail() {
            return detail;
        }
    }

    // ---------------- 归集 ----------------

    /** 归集一条非终止事件（start / node / detect / terms / plan / delta / review / memory），以及 clarify。 */
    public void collect(String event, JsonNode data) {
        sawEvent.set(true);
        if (event == null || data == null || !data.isObject()) {
            return;
        }
        switch (event) {
            case "node" -> onNode(data);
            case "detect" -> {
                detect = data;
                attach().set("detect", data);
            }
            case "terms" -> {
                terms = data;
                attach().set("terms", data);
            }
            case "plan" -> {
                plan = data;
                attach().set("plan", data);
            }
            case "review" -> {
                // 取最后一次评审的分数；score 为 null 表示评审 JSON 解析失败、视为通过
                lastReviewScore = intOrNull(data.path("score"));
                attach().set("review", data);
            }
            // 会话记忆压缩结果与追问内容挂到所属节点（memorize / clarify）的详情上
            case "memory", "clarify" -> attach().set(event, data);
            case "delta" -> {
                int round = data.path("round").asInt(0);
                ObjectNode detail = attach();
                JsonNode output = detail.get("output");
                String text = output != null && output.path("round").asInt(-1) == round
                        ? output.path("text").asString("") : "";
                ObjectNode o = jsonMapper.createObjectNode();
                o.put("round", round);
                o.put("text", text + data.path("text").asString(""));
                detail.set("output", o);
            }
            default -> {
                // start 等事件无需归集
            }
        }
    }

    private void onNode(JsonNode data) {
        String node = data.path("node").asString(null);
        if (node == null) {
            return;
        }
        String status = data.path("status").asString("");
        int seq = data.path("seq").asInt(Integer.MAX_VALUE);
        NodeTrace trace;
        if ("started".equals(status)) {
            open.add(new NodeTrace(node, seq, jsonMapper.createObjectNode()));
            return;
        }
        trace = removeOpen(node);
        if (trace == null) {
            trace = new NodeTrace(node, seq, jsonMapper.createObjectNode());
        }
        trace.status = status.isEmpty() ? "completed" : status;
        trace.summary = data.path("summary").asString(null);
        trace.latencyMs = intOrNull(data.path("latencyMs"));
        trace.promptTokens = intOrNull(data.path("usage").path("promptTokens"));
        trace.completionTokens = intOrNull(data.path("usage").path("completionTokens"));
        // 节点事件的可选 detail（如 retrieve 的 tmHits、sessionTurns）合并进该节点的轨迹详情
        if (data.get("detail") instanceof ObjectNode extra) {
            trace.detail.setAll(extra);
        }
        closed.add(trace);
        if ("refine".equals(node) && "completed".equals(trace.status)) {
            refineCompleted++;
        }
    }

    /** 归属的节点详情：最近一个进行中的节点；没有则归到最近结束的节点。 */
    private ObjectNode attach() {
        if (!open.isEmpty()) {
            return open.getLast().detail;
        }
        if (!closed.isEmpty()) {
            return closed.getLast().detail;
        }
        // 节点事件之前出现的事件：挂到一个占位的 analyze 节点上
        NodeTrace placeholder = new NodeTrace("analyze", 0, jsonMapper.createObjectNode());
        open.add(placeholder);
        return placeholder.detail;
    }

    private NodeTrace removeOpen(String node) {
        for (int i = open.size() - 1; i >= 0; i--) {
            if (open.get(i).node.equals(node)) {
                return open.remove(i);
            }
        }
        return null;
    }

    private static Integer intOrNull(JsonNode n) {
        return n != null && n.isNumber() ? n.asInt() : null;
    }

    // ---------------- 追问中断与恢复 ----------------

    /**
     * 中断时的归集结果快照（写入会话 pending，恢复时载入）：
     * {detect, terms, plan, lastReviewScore, refineCompleted, traces:[{node, status, summary, latencyMs, promptTokens, completionTokens, detail}]}。
     */
    public ObjectNode snapshot() {
        ObjectNode s = jsonMapper.createObjectNode();
        s.set("detect", detect);
        s.set("terms", terms);
        s.set("plan", plan);
        if (lastReviewScore == null) {
            s.putNull("lastReviewScore");
        } else {
            s.put("lastReviewScore", lastReviewScore);
        }
        s.put("refineCompleted", refineCompleted);
        ArrayNode list = s.putArray("traces");
        for (NodeTrace t : traces()) {
            ObjectNode o = list.addObject();
            o.put("node", t.node);
            o.put("status", t.status);
            o.put("summary", t.summary);
            putInt(o, "latencyMs", t.latencyMs);
            putInt(o, "promptTokens", t.promptTokens);
            putInt(o, "completionTokens", t.completionTokens);
            o.set("detail", t.detail);
        }
        return s;
    }

    /** 载入中断前的快照（见 {@link #snapshot()}）；本次运行的轨迹排在其后。 */
    public void restore(JsonNode snapshot) {
        if (snapshot == null || !snapshot.isObject()) {
            return;
        }
        detect = objectOrNull(snapshot.get("detect"));
        terms = objectOrNull(snapshot.get("terms"));
        plan = objectOrNull(snapshot.get("plan"));
        lastReviewScore = intOrNull(snapshot.get("lastReviewScore"));
        refineCompleted = snapshot.path("refineCompleted").asInt(0);
        int order = 0;
        for (JsonNode o : snapshot.path("traces")) {
            ObjectNode detail = o.get("detail") instanceof ObjectNode d ? d.deepCopy() : jsonMapper.createObjectNode();
            NodeTrace t = new NodeTrace(o.path("node").asString("unknown"), order++, detail);
            t.status = o.path("status").asString("completed");
            t.summary = o.path("summary").asString(null);
            t.latencyMs = intOrNull(o.get("latencyMs"));
            t.promptTokens = intOrNull(o.get("promptTokens"));
            t.completionTokens = intOrNull(o.get("completionTokens"));
            prior.add(t);
        }
    }

    private static JsonNode objectOrNull(JsonNode n) {
        return n != null && n.isObject() ? n : null;
    }

    private static void putInt(ObjectNode o, String field, Integer v) {
        if (v == null) {
            o.putNull(field);
        } else {
            o.put(field, v);
        }
    }

    // ---------------- 结果 ----------------

    /**
     * 按执行顺序排列的轨迹；未收到 completed 的节点保留 started 状态。
     * 恢复执行时，中断前的轨迹在前；若恢复后再次推送了中断节点（如 clarify），以恢复后的为准。
     */
    public List<NodeTrace> traces() {
        List<NodeTrace> current = new ArrayList<>(closed);
        for (NodeTrace t : open) {
            if (t.status == null) {
                t.status = "started";
            }
            current.add(t);
        }
        current.sort(Comparator.comparingInt(t -> t.order));
        if (prior.isEmpty()) {
            return current;
        }
        Set<String> rerun = current.stream().map(t -> t.node).collect(Collectors.toSet());
        List<NodeTrace> all = new ArrayList<>();
        for (NodeTrace p : prior) {
            if (!(STATUS_INTERRUPTED.equals(p.status) && rerun.contains(p.node))) {
                all.add(p);
            }
        }
        all.addAll(current);
        return all;
    }

    public UpstreamTranslateRequest request() {
        return request;
    }

    public Long modelConfigId() {
        return modelConfigId;
    }

    public SessionTurn session() {
        return session;
    }

    public JsonNode detect() {
        return detect;
    }

    public JsonNode terms() {
        return terms;
    }

    public JsonNode plan() {
        return plan;
    }

    public Integer lastReviewScore() {
        return lastReviewScore;
    }

    /** 修正轮次：refine 节点 status=completed 的次数（含中断前）。 */
    public int reviewRounds() {
        return refineCompleted;
    }

    public boolean sawEvent() {
        return sawEvent.get();
    }

    public void markSawEvent() {
        sawEvent.set(true);
    }

    /** 标记已终止（final、error 或 clarify），返回是否为首次标记。 */
    public boolean terminate() {
        return terminated.compareAndSet(false, true);
    }

    public boolean isTerminated() {
        return terminated.get();
    }

    public void markFinalReceived() {
        finalReceived.set(true);
    }

    public boolean isFinalReceived() {
        return finalReceived.get();
    }
}
