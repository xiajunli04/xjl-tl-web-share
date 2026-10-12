package com.xjl.tl.module.document;

import com.xjl.tl.module.document.service.DocEventConsumer;
import com.xjl.tl.support.DocStreamSample;
import com.xjl.tl.support.StreamingTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.connection.stream.StreamRecords;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * 文档任务集成测试基类：共享 StreamingTestBase 的上下文（真实 Tomcat、事件消费者已启动、模拟 AI 服务）。
 * 测试代码直接向 Testcontainers Redis 的 tl:doc-events 写入样例事件来模拟 Python。
 */
public abstract class DocTaskTestBase extends StreamingTestBase {

    public static final String TASKS = "tl:doc-tasks";
    public static final String EVENTS = "tl:doc-events";
    protected static final Duration WAIT = Duration.ofSeconds(15);

    @Autowired
    protected DocEventConsumer consumer;

    protected String token;
    protected long userId;

    @BeforeEach
    void docSetUp() throws Exception {
        // 基类每个用例前 FLUSHDB，消费组随之被删除：这里立即重建（与线上启动时的幂等创建一致）
        consumer.ensureGroups();
        String name = registerUser(uniqueName("doc"), "Passw0rd!");
        token = accessToken(name, "Passw0rd!");
        userId = userId(name);
    }

    protected long userId(String username) {
        return jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, username);
    }

    // ---------------- 请求 ----------------

    protected Map<String, Object> createBody(String text) {
        Map<String, Object> m = new HashMap<>();
        m.put("text", text);
        m.put("format", "md");
        m.put("sourceLang", "auto");
        m.put("targetLang", "zh");
        m.put("strategy", "serial");
        m.put("confirmTerms", true);
        return m;
    }

    protected MvcResult createRaw(Map<String, Object> body, String token) throws Exception {
        return perform(bearer(post("/api/doc-tasks").contentType(MediaType.APPLICATION_JSON).content(json(body)), token));
    }

    /** 创建任务并返回 id。 */
    protected long createTask(String text) throws Exception {
        MvcResult r = createRaw(createBody(text), token);
        JsonNode b = body(r);
        if (r.getResponse().getStatus() != 200) {
            throw new IllegalStateException("创建任务失败：" + b);
        }
        return b.path("data").path("id").asLong();
    }

    protected JsonNode detail(long id) throws Exception {
        return body(perform(bearer(get("/api/doc-tasks/" + id), token))).path("data");
    }

    protected JsonNode segments(long id) throws Exception {
        return body(perform(bearer(get("/api/doc-tasks/" + id + "/segments"), token))).path("data");
    }

    protected void setStatus(long id, String status) {
        jdbcTemplate.update("UPDATE biz.doc_task SET status = ? WHERE id = ?", status, id);
    }

    // ---------------- 流 ----------------

    /** 写入一条事件（模拟 Python）。 */
    protected RecordId emit(Map<String, String> fields) {
        return redis.opsForStream().add(StreamRecords.newRecord().in(EVENTS).ofMap(fields));
    }

    protected RecordId emit(ObjectNode sampleMessage, long taskId) {
        return emit(DocStreamSample.toFields(sampleMessage, taskId));
    }

    /** 依次写入样例小节中的全部事件。 */
    protected void emitSection(String section, long taskId) {
        DocStreamSample.section(section).forEach(m -> emit(m, taskId));
    }

    /** 构造一条事件。 */
    protected Map<String, String> event(long taskId, int seq, String type, String data) {
        Map<String, String> m = new HashMap<>();
        m.put("taskId", String.valueOf(taskId));
        m.put("eventSeq", String.valueOf(seq));
        m.put("type", type);
        m.put("traceId", "doc-" + taskId + "-t");
        m.put("data", data);
        return m;
    }

    /** 任务流中的全部命令。 */
    protected List<MapRecord<String, String, String>> commands() {
        return redis.<String, String>opsForStream().range(TASKS, Range.unbounded());
    }

    protected List<Map<String, String>> commandsFor(long taskId) {
        return commands().stream().map(MapRecord::getValue)
                .filter(v -> String.valueOf(taskId).equals(v.get("taskId")))
                .toList();
    }

    protected long pendingCount() {
        var summary = redis.opsForStream().pending(EVENTS, "spring");
        return summary == null ? 0 : summary.getTotalPendingMessages();
    }

    // ---------------- 等待 ----------------

    protected int lastEventSeq(long taskId) {
        return jdbcTemplate.queryForObject("SELECT last_event_seq FROM biz.doc_task WHERE id = ?", Integer.class, taskId);
    }

    protected void awaitSeq(long taskId, int seq) throws InterruptedException {
        awaitUntil(() -> lastEventSeq(taskId) >= seq, "等待 eventSeq ≥ " + seq + "（当前 " + lastEventSeq(taskId) + "）");
    }

    protected static void awaitUntil(BooleanSupplier condition, String message) throws InterruptedException {
        long deadline = System.currentTimeMillis() + WAIT.toMillis();
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("等待超时：" + message);
    }
}
