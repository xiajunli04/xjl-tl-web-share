package com.xjl.tl.module.document;

import com.xjl.tl.module.document.service.DocStaleTaskDetector;
import com.xjl.tl.support.DocStreamSample;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.connection.stream.StreamReadOptions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * tasks 6.1 / 6.3：事件消费（样例序列驱动的数据库终态、eventSeq 幂等、停机积压补处理、pending 认领、毒消息）
 * 与失联检测。
 */
class DocEventConsumerTest extends DocTaskTestBase {

    private static final String GPU_DOC = "# GPU Basics\n\nA GPU accelerates training.\n\n## Usage\n\nUse the GPU for each epoch.\n";
    private static final String THREE_DOC = "Para one.\n\nPara two.\n\nPara three.\n";

    @Autowired
    private DocStaleTaskDetector staleDetector;
    @Autowired
    private DocProperties docProperties;

    @AfterEach
    void ensureConsumerRunning() {
        // 停机类用例失败时也恢复消费者，避免影响共享上下文中的其他用例
        consumer.start();
    }

    // ---------------- 样例序列 ----------------

    @Test
    void sampleSequenceDrivesDatabaseToExpectedFinalState() throws Exception {
        long id = createTask(GPU_DOC);
        emitSection("2.1", id);
        awaitSeq(id, 20);

        JsonNode t = detail(id);
        assertThat(t.path("status").asString()).isEqualTo("COMPLETED");
        assertThat(t.path("phase").asString()).isEqualTo("assembling");
        assertThat(t.path("progressDone").asInt()).isEqualTo(2);
        assertThat(t.path("progressTotal").asInt()).isEqualTo(2);
        assertThat(t.path("detectedLang").asString()).isEqualTo("en");
        assertThat(t.path("summary").asString()).isEqualTo("本文简要介绍 GPU 在模型训练中的作用及其使用方式。");
        assertThat(t.path("domain").asString()).isEqualTo("计算机");
        assertThat(t.path("genre").asString()).isEqualTo("技术文档");
        assertThat(t.path("promptTokens").asInt()).isEqualTo(1960);
        assertThat(t.path("completionTokens").asInt()).isEqualTo(254);
        assertThat(t.path("latencyMs").asInt()).isEqualTo(21500);
        assertThat(t.path("stats").path("chunks").asInt()).isEqualTo(2);
        assertThat(t.path("stats").path("compliance").path("ok").asInt()).isEqualTo(3);
        JsonNode issue = t.path("consistencyReport").path("issues").get(0);
        assertThat(issue.path("term").asString()).isEqualTo("GPU");
        assertThat(issue.path("chosen").asString()).isEqualTo("图形处理器");
        assertThat(issue.path("fixedSegs").get(0).asInt()).isEqualTo(3);
        assertThat(issue.path("variants").get(0).path("count").asInt()).isEqualTo(2);
        assertThat(t.path("startedAt").isNull()).isFalse();
        assertThat(t.path("finishedAt").isNull()).isFalse();
        assertThat(t.path("errorCode").isNull()).isTrue();
        assertThat(lastEventSeq(id)).isEqualTo(20);
        assertThat(pendingCount()).isZero();

        // 「查看段落」：按 seq 返回 prefix、原文、suffix、译文、是否可翻译、评审分与是否已编辑
        JsonNode segs = segments(id);
        assertThat(segs).hasSize(4);
        JsonNode s0 = segs.get(0);
        assertThat(s0.path("seq").asInt()).isZero();
        assertThat(s0.path("blockType").asString()).isEqualTo("heading");
        assertThat(s0.path("level").asInt()).isEqualTo(1);
        assertThat(s0.path("prefix").asString()).isEqualTo("# ");
        assertThat(s0.path("source").asString()).isEqualTo("GPU Basics");
        assertThat(s0.path("suffix").asString()).isEqualTo("\n\n");
        assertThat(s0.path("translatable").asBoolean()).isTrue();
        assertThat(s0.path("chunkIndex").asInt()).isZero();
        assertThat(s0.path("target").asString()).isEqualTo("图形处理器基础");
        assertThat(s0.path("status").asString()).isEqualTo("DONE");
        assertThat(s0.path("reviewScore").asInt()).isEqualTo(95);
        assertThat(s0.path("reviewRounds").asInt()).isZero();
        assertThat(s0.path("compliance").get(0).path("compliant").asBoolean()).isTrue();
        assertThat(s0.path("edited").asBoolean()).isFalse();
        assertThat(segs.get(1).path("level").isNull()).isTrue();
        JsonNode s3 = segs.get(3);
        assertThat(s3.path("chunkIndex").asInt()).isEqualTo(1);
        // 一致性阶段修正后的译文
        assertThat(s3.path("target").asString()).isEqualTo("每个训练轮次都使用图形处理器。");
        assertThat(s3.path("reviewScore").asInt()).isEqualTo(88);
        assertThat(s3.path("reviewRounds").asInt()).isEqualTo(1);
        assertThat(s3.path("compliance")).hasSize(2);

        JsonNode terms = body(perform(bearer(get("/api/doc-tasks/" + id + "/terms"), token))).path("data");
        assertThat(terms).hasSize(3);
        assertThat(terms).allSatisfy(term -> assertThat(term.path("status").asString()).isEqualTo("PENDING"));

        JsonNode traces = body(perform(bearer(get("/api/doc-tasks/" + id + "/traces"), token))).path("data");
        List<String> nodes = new ArrayList<>();
        traces.forEach(tr -> nodes.add(tr.path("node").asString()));
        assertThat(nodes).containsExactly("parse", "analyze", "align_terms", "confirm_terms", "translate_chunk",
                "translate_chunk", "consistency");
        assertThat(traces.get(4).path("chunkIndex").asInt()).isZero();
        assertThat(traces.get(1).path("promptTokens").asInt()).isEqualTo(310);

        String exported = perform(bearer(get("/api/doc-tasks/" + id + "/export?format=md"), token))
                .getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(exported).isEqualTo("# 图形处理器基础\n\n图形处理器可加速训练。\n\n## 用法\n\n每个训练轮次都使用图形处理器。\n");
    }

    @Test
    void phaseEventsDriveStatusMachine() throws Exception {
        long id = createTask(GPU_DOC);
        List<ObjectNode> sample = DocStreamSample.section("2.1");
        Map<Integer, String> expected = Map.of(1, "PARSING", 4, "ANALYZING", 8, "AWAITING_CONFIRM", 10, "TRANSLATING",
                16, "CONSISTENCY", 19, "CONSISTENCY", 20, "COMPLETED");
        for (int i = 0; i < sample.size(); i++) {
            emit(sample.get(i), id);
            int seq = i + 1;
            if (expected.containsKey(seq)) {
                awaitSeq(id, seq);
                assertThat(detail(id).path("status").asString()).as("eventSeq=" + seq).isEqualTo(expected.get(seq));
            }
        }
    }

    // ---------------- 幂等 ----------------

    @Test
    void duplicateDeliveryDoesNotDoubleCount() throws Exception {
        long id = createTask(GPU_DOC);
        List<ObjectNode> sample = DocStreamSample.section("2.1");
        emit(sample.get(0), id);
        emit(sample.get(1), id);
        Map<String, String> chunk0 = DocStreamSample.toFields(sample.get(11), id);
        emit(chunk0);
        emit(chunk0);
        awaitUntil(() -> pendingCount() == 0 && redis.opsForStream().size(EVENTS) == 4, "4 条事件全部确认");
        awaitSeq(id, 12);
        assertThat(detail(id).path("progressDone").asInt()).isEqualTo(1);

        // 失败后 retry：cached 块以新的 eventSeq 再次上报，不会重复计数
        emitSection("2.2", id);
        awaitSeq(id, 31);
        JsonNode t = detail(id);
        assertThat(t.path("progressDone").asInt()).isEqualTo(1);
        assertThat(t.path("progressTotal").asInt()).isEqualTo(2);
        assertThat(t.path("status").asString()).isEqualTo("TRANSLATING");

        // 迟到的旧事件（eventSeq 更小）被跳过
        emit(sample.get(19), id);
        awaitUntil(() -> pendingCount() == 0 && redis.opsForStream().size(EVENTS) == 7, "旧事件被确认");
        Thread.sleep(200);
        assertThat(detail(id).path("status").asString()).isEqualTo("TRANSLATING");
        assertThat(lastEventSeq(id)).isEqualTo(31);
    }

    // ---------------- 停机与认领 ----------------

    private void emitThreeChunkParsed(long id, int seq) {
        String data = """
                {"segments":[
                  {"seq":0,"blockType":"paragraph","prefix":"","source":"Para one.","suffix":"\\n\\n","translatable":true},
                  {"seq":1,"blockType":"paragraph","prefix":"","source":"Para two.","suffix":"\\n\\n","translatable":true},
                  {"seq":2,"blockType":"paragraph","prefix":"","source":"Para three.","suffix":"\\n","translatable":true}],
                 "chunks":[{"index":0,"segSeqs":[0],"group":0},{"index":1,"segSeqs":[1],"group":0},
                           {"index":2,"segSeqs":[2],"group":0}],
                 "detectedLang":"en","confidence":0.99}""".replace("\n", "");
        emit(event(id, seq, "parsed", data));
    }

    private Map<String, String> chunkDone(long id, int seq, int chunk, String target) {
        return event(id, seq, "chunk_done", "{\"chunk\":" + chunk + ",\"segments\":[{\"seq\":" + chunk
                + ",\"target\":\"" + target + "\",\"reviewScore\":90,\"reviewRounds\":0,\"compliance\":[]}],"
                + "\"usage\":{\"promptTokens\":10,\"completionTokens\":5},\"latencyMs\":100,\"cached\":false}");
    }

    private List<String> targets(long id) throws Exception {
        List<String> out = new ArrayList<>();
        segments(id).forEach(s -> out.add(s.path("target").asString(null)));
        return out;
    }

    @Test
    void backlogProducedWhileSpringIsDownIsProcessedAfterRestart() throws Exception {
        // 对照组：不停机
        long online = createTask(THREE_DOC);
        emit(event(online, 1, "phase", "{\"phase\":\"translating\"}"));
        emitThreeChunkParsed(online, 2);
        emit(chunkDone(online, 3, 0, "第一段。"));
        emit(chunkDone(online, 4, 1, "第二段。"));
        emit(chunkDone(online, 5, 2, "第三段。"));
        awaitSeq(online, 5);

        long id = createTask(THREE_DOC);
        emit(event(id, 1, "phase", "{\"phase\":\"translating\"}"));
        emitThreeChunkParsed(id, 2);
        awaitSeq(id, 2);

        consumer.stop();
        // 等待停止前已发出的阻塞读取结束
        Thread.sleep(500);
        emit(chunkDone(id, 3, 0, "第一段。"));
        emit(chunkDone(id, 4, 1, "第二段。"));
        emit(chunkDone(id, 5, 2, "第三段。"));
        Thread.sleep(800);
        assertThat(lastEventSeq(id)).isEqualTo(2);
        assertThat(detail(id).path("progressDone").asInt()).isZero();

        consumer.start();
        awaitSeq(id, 5);
        JsonNode t = detail(id);
        assertThat(t.path("progressDone").asInt()).isEqualTo(3);
        assertThat(t.path("progressTotal").asInt()).isEqualTo(3);
        assertThat(targets(id)).containsExactly("第一段。", "第二段。", "第三段。");
        // 与不停机时结果一致
        JsonNode o = detail(online);
        assertThat(t.path("progressDone").asInt()).isEqualTo(o.path("progressDone").asInt());
        assertThat(t.path("status").asString()).isEqualTo(o.path("status").asString());
        assertThat(targets(id)).isEqualTo(targets(online));
        awaitUntil(() -> pendingCount() == 0, "全部确认");
    }

    @Test
    void pendingMessagesOfCrashedConsumersAreClaimedOnStartup() throws Exception {
        long id = createTask(THREE_DOC);
        consumer.stop();
        Thread.sleep(500);
        emit(event(id, 1, "phase", "{\"phase\":\"translating\"}"));
        emitThreeChunkParsed(id, 2);
        emit(chunkDone(id, 3, 0, "第一段。"));
        // 另一实例读取后崩溃（未确认）
        List<MapRecord<String, String, String>> taken = redis.<String, String>opsForStream().read(
                Consumer.from("spring", "spring-crashed"), StreamReadOptions.empty().count(2),
                StreamOffset.create(EVENTS, ReadOffset.lastConsumed()));
        assertThat(taken).hasSize(2);
        // 本实例上次停机前读取但未确认
        List<MapRecord<String, String, String>> own = redis.<String, String>opsForStream().read(
                Consumer.from("spring", consumer.consumerName()), StreamReadOptions.empty().count(1),
                StreamOffset.create(EVENTS, ReadOffset.lastConsumed()));
        assertThat(own).hasSize(1);
        assertThat(pendingCount()).isEqualTo(3);
        Thread.sleep(700);

        consumer.start();
        awaitSeq(id, 3);
        awaitUntil(() -> pendingCount() == 0, "pending 消息被认领并确认");
        assertThat(detail(id).path("progressDone").asInt()).isEqualTo(1);
        assertThat(targets(id).getFirst()).isEqualTo("第一段。");
    }

    @Test
    void unknownTasksAndMalformedMessagesAreAcknowledgedAndSkipped() throws Exception {
        long id = createTask(GPU_DOC);
        emit(event(987654321L, 1, "phase", "{\"phase\":\"parsing\"}"));
        Map<String, String> noSeq = event(id, 1, "phase", "{\"phase\":\"parsing\"}");
        noSeq.remove("eventSeq");
        emit(noSeq);
        emit(event(id, 1, "phase", "{not json"));
        emit(Map.of("foo", "bar"));
        emit(event(id, 2, "phase", "{\"phase\":\"parsing\"}"));
        awaitSeq(id, 2);
        awaitUntil(() -> pendingCount() == 0, "全部确认");
        assertThat(detail(id).path("status").asString()).isEqualTo("PARSING");
    }

    @Test
    void failedAndCancelledEventsFollowSample() throws Exception {
        long failed = createTask(GPU_DOC);
        long cancelled = createTask(GPU_DOC);
        List<ObjectNode> sample = DocStreamSample.section("2.3");
        setStatus(failed, "TRANSLATING");
        setStatus(cancelled, "CANCELLING");
        emit(sample.get(0), failed);
        emit(sample.get(1), cancelled);
        awaitSeq(failed, 9);
        awaitSeq(cancelled, 5);
        JsonNode f = detail(failed);
        assertThat(f.path("status").asString()).isEqualTo("FAILED");
        assertThat(f.path("errorCode").asString()).isEqualTo("C0122");
        assertThat(f.path("errorMessage").asString()).isEqualTo("LLM 调用超时");
        assertThat(f.path("retryable").asBoolean()).isTrue();
        assertThat(f.path("finishedAt").isNull()).isFalse();
        JsonNode c = detail(cancelled);
        assertThat(c.path("status").asString()).isEqualTo("CANCELLED");
        assertThat(c.path("finishedAt").isNull()).isFalse();
    }

    @Test
    void candidatesAreAdoptedAutomaticallyWhenConfirmationIsOff() throws Exception {
        Map<String, Object> body = createBody(GPU_DOC);
        body.put("confirmTerms", false);
        long id = body(createRaw(body, token)).path("data").path("id").asLong();
        // 样例 analysis：1 条术语库命中（GPU）+ 2 条抽取结果（epoch、training）
        emit(DocStreamSample.section("2.1").get(4), id);
        awaitSeq(id, 5);
        JsonNode terms = body(perform(bearer(get("/api/doc-tasks/" + id + "/terms"), token))).path("data");
        assertThat(terms).hasSize(3);
        Map<String, String> statusBySource = new HashMap<>();
        terms.forEach(t -> statusBySource.put(t.path("source").asString(), t.path("status").asString()));
        // 术语库命中为硬约束 CONFIRMED，未经确认的抽取结果为软约束 AUTO
        assertThat(statusBySource).containsExactlyInAnyOrderEntriesOf(
                Map.of("GPU", "CONFIRMED", "epoch", "AUTO", "training", "AUTO"));
        assertThat(jdbcTemplate.queryForList(
                "SELECT status FROM biz.doc_task_term WHERE task_id = ? AND origin = 'extracted'", String.class, id))
                .containsOnly("AUTO");
    }

    @Test
    void candidatesStayPendingWhenConfirmationIsOn() throws Exception {
        long id = createTask(GPU_DOC);
        emit(DocStreamSample.section("2.1").get(4), id);
        awaitSeq(id, 5);
        JsonNode terms = body(perform(bearer(get("/api/doc-tasks/" + id + "/terms"), token))).path("data");
        assertThat(terms).hasSize(3);
        assertThat(terms).allSatisfy(term -> assertThat(term.path("status").asString()).isEqualTo("PENDING"));
    }

    @Test
    void editedSegmentsAreNotOverwrittenByLaterEvents() throws Exception {
        long id = createTask(THREE_DOC);
        emitThreeChunkParsed(id, 1);
        emit(chunkDone(id, 2, 0, "第一段。"));
        awaitSeq(id, 2);
        perform(bearer(jsonBody(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .put("/api/doc-tasks/" + id + "/segments/0"), Map.of("target", "用户改过的第一段。")), token));
        emit(chunkDone(id, 3, 0, "缓存的第一段。"));
        emit(event(id, 4, "consistency", "{\"issues\":[],\"segments\":[{\"seq\":0,\"target\":\"一致性修正\"}]}"));
        awaitSeq(id, 4);
        JsonNode s0 = segments(id).get(0);
        assertThat(s0.path("target").asString()).isEqualTo("用户改过的第一段。");
        assertThat(s0.path("edited").asBoolean()).isTrue();
        assertThat(detail(id).path("progressDone").asInt()).isEqualTo(1);
    }

    // ---------------- 失联检测 ----------------

    @Test
    void staleRunningTasksAreMarkedFailedAndRetryable() throws Exception {
        assertThat(docProperties.staleTimeout()).isEqualTo(Duration.ofMinutes(30));
        long stale = createTask(GPU_DOC);
        long awaiting = createTask(GPU_DOC);
        jdbcTemplate.update("UPDATE biz.doc_task SET status = 'AWAITING_CONFIRM', last_event_at = now() - interval '1 hour' "
                + "WHERE id = ?", awaiting);
        jdbcTemplate.update("UPDATE biz.doc_task SET status = 'TRANSLATING', last_event_at = now() - interval '10 seconds' "
                + "WHERE id = ?", stale);
        long fresh = createTask(GPU_DOC);
        setStatus(fresh, "TRANSLATING");
        String other = registerUser(uniqueName("doco"), "Passw0rd!");
        String otherToken = accessToken(other, "Passw0rd!");
        long cancelling = body(createRaw(createBody(GPU_DOC), otherToken)).path("data").path("id").asLong();
        jdbcTemplate.update("UPDATE biz.doc_task SET status = 'CANCELLING', last_event_at = now() - interval '1 hour' "
                + "WHERE id = ?", cancelling);

        // 用很短的阈值（5 秒）执行一次检测
        staleDetector.detect(Duration.ofSeconds(5));

        JsonNode s = detail(stale);
        assertThat(s.path("status").asString()).isEqualTo("FAILED");
        assertThat(s.path("retryable").asBoolean()).isTrue();
        assertThat(s.path("errorCode").asString()).isEqualTo("C0150");
        assertThat(s.path("finishedAt").isNull()).isFalse();
        assertThat(detail(fresh).path("status").asString()).isEqualTo("TRANSLATING");
        assertThat(detail(awaiting).path("status").asString()).isEqualTo("AWAITING_CONFIRM");
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM biz.doc_task WHERE id = ?", String.class, cancelling))
                .isEqualTo("CANCELLED");
        // 失联的任务可以继续
        assertThat(perform(bearer(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .post("/api/doc-tasks/" + stale + "/retry"), token)).getResponse().getStatus()).isEqualTo(200);
    }
}
