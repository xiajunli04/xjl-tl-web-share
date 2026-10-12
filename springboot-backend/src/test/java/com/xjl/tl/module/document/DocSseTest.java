package com.xjl.tl.module.document;

import com.xjl.tl.support.DocStreamSample;
import com.xjl.tl.support.SseTestClient.Event;
import com.xjl.tl.support.SseTestClient.Session;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * tasks 6.2：GET /api/doc-tasks/{id}/events（snapshot + 实时事件、心跳、终结后关闭、用户隔离），
 * 事件名与 data 按 design D13 的浏览器事件表。
 */
class DocSseTest extends DocTaskTestBase {

    private static final Duration NEXT = Duration.ofSeconds(10);

    private JsonNode data(Event e) {
        return jsonMapper.readTree(e.data());
    }

    private Event next(Session s) throws InterruptedException {
        Event e = s.next(NEXT);
        assertThat(e).as("在 " + NEXT + " 内收到下一个事件，已收到：" + s.received()).isNotNull();
        return e;
    }

    /** 12 段、12 块的文档。 */
    private void emitTwelveChunkParsed(long id, int seq) {
        StringBuilder segs = new StringBuilder();
        StringBuilder chunks = new StringBuilder();
        for (int i = 0; i < 12; i++) {
            if (i > 0) {
                segs.append(',');
                chunks.append(',');
            }
            segs.append("{\"seq\":").append(i).append(",\"blockType\":\"paragraph\",\"prefix\":\"\",\"source\":\"P")
                    .append(i).append(".\",\"suffix\":\"\\n\\n\",\"translatable\":true}");
            chunks.append("{\"index\":").append(i).append(",\"segSeqs\":[").append(i).append("],\"group\":0}");
        }
        emit(event(id, seq, "parsed", "{\"segments\":[" + segs + "],\"chunks\":[" + chunks
                + "],\"detectedLang\":\"en\",\"confidence\":0.9}"));
    }

    private Map<String, String> chunkDone(long id, int seq, int chunk) {
        return event(id, seq, "chunk_done", "{\"chunk\":" + chunk + ",\"segments\":[{\"seq\":" + chunk
                + ",\"target\":\"段" + chunk + "。\",\"reviewScore\":90,\"reviewRounds\":0,\"compliance\":[]}],"
                + "\"usage\":{\"promptTokens\":10,\"completionTokens\":5},\"latencyMs\":100,\"cached\":false}");
    }

    @Test
    void subscribingMidwayReceivesSnapshotFirstThenLiveEventsUntilCompleted() throws Exception {
        long id = createTask("doc");
        emit(event(id, 1, "phase", "{\"phase\":\"translating\"}"));
        emitTwelveChunkParsed(id, 2);
        for (int c = 0; c < 5; c++) {
            emit(chunkDone(id, 3 + c, c));
        }
        awaitSeq(id, 7);

        try (Session s = sse().get("/api/doc-tasks/" + id + "/events", token)) {
            assertThat(s.status()).isEqualTo(200);
            assertThat(s.header("Content-Type")).startsWith("text/event-stream");
            assertThat(s.header("Cache-Control")).isEqualTo("no-cache");
            assertThat(s.header("X-Accel-Buffering")).isEqualTo("no");

            Event snapshot = next(s);
            assertThat(snapshot.event()).isEqualTo("snapshot");
            JsonNode snap = data(snapshot);
            assertThat(snap.path("id").asLong()).isEqualTo(id);
            assertThat(snap.path("status").asString()).isEqualTo("TRANSLATING");
            assertThat(snap.path("progressDone").asInt()).isEqualTo(5);
            assertThat(snap.path("progressTotal").asInt()).isEqualTo(12);
            assertThat(snap.has("consistencyReport")).isTrue();

            // 心跳（测试环境 300ms）
            Thread.sleep(HEARTBEAT_MS * 3);

            emit(chunkDone(id, 8, 5));
            Event chunk = next(s);
            assertThat(chunk.event()).isEqualTo("chunk_done");
            JsonNode cd = data(chunk);
            assertThat(cd.path("chunk").asInt()).isEqualTo(5);
            assertThat(cd.path("progressDone").asInt()).isEqualTo(6);
            assertThat(cd.path("progressTotal").asInt()).isEqualTo(12);
            assertThat(cd.path("cached").asBoolean()).isFalse();
            JsonNode seg = cd.path("segments").get(0);
            assertThat(seg.propertyNames()).containsExactlyInAnyOrder("seq", "target", "reviewScore", "reviewRounds",
                    "compliance", "tmHits");
            assertThat(seg.path("tmHits").isArray()).isTrue();
            assertThat(seg.path("target").asString()).isEqualTo("段5。");

            emit(event(id, 9, "phase", "{\"phase\":\"consistency\"}"));
            Event phase = next(s);
            assertThat(phase.event()).isEqualTo("phase");
            assertThat(data(phase).path("status").asString()).isEqualTo("CONSISTENCY");
            assertThat(data(phase).path("phase").asString()).isEqualTo("consistency");

            emit(event(id, 10, "consistency", "{\"issues\":[{\"term\":\"P\",\"variants\":[{\"text\":\"段\",\"count\":2}],"
                    + "\"chosen\":\"段\",\"fixedSegs\":[1],\"unresolvedSegs\":[]}],\"segments\":[{\"seq\":1,\"target\":\"段一。\"}]}"));
            Event consistency = next(s);
            assertThat(consistency.event()).isEqualTo("consistency");
            assertThat(data(consistency).path("report").path("issues").get(0).path("chosen").asString()).isEqualTo("段");
            assertThat(data(consistency).path("segments").get(0).path("target").asString()).isEqualTo("段一。");

            emit(event(id, 11, "completed", "{\"usage\":{\"promptTokens\":100,\"completionTokens\":50},\"latencyMs\":999,"
                    + "\"stats\":{\"chunks\":12,\"cachedChunks\":0,\"refined\":0,\"compliance\":{\"ok\":0,\"total\":0}}}"));
            Event completed = next(s);
            assertThat(completed.event()).isEqualTo("completed");
            assertThat(data(completed).path("status").asString()).isEqualTo("COMPLETED");
            assertThat(data(completed).path("stats").path("chunks").asInt()).isEqualTo(12);
            // 终结事件后连接关闭
            assertThat(s.next(NEXT)).isNull();
            assertThat(s.ended()).isTrue();
            assertThat(s.received()).anySatisfy(e -> {
                assertThat(e.isComment()).isTrue();
                assertThat(e.data()).isEqualTo("ping");
            });
        }
    }

    @Test
    void sampleEventsAreForwardedInBrowserFormat() throws Exception {
        long id = createTask("# GPU Basics\n\nA GPU accelerates training.\n");
        List<ObjectNode> sample = DocStreamSample.section("2.1");
        try (Session s = sse().get("/api/doc-tasks/" + id + "/events", token)) {
            assertThat(next(s).event()).isEqualTo("snapshot");
            sample.subList(0, 9).forEach(m -> emit(m, id));

            List<Event> events = new ArrayList<>();
            for (int i = 0; i < 6; i++) {
                events.add(next(s));
            }
            assertThat(events).extracting(Event::event)
                    .containsExactly("phase", "parsed", "phase", "analysis", "phase", "awaiting_confirm");
            assertThat(data(events.get(0)).path("status").asString()).isEqualTo("PARSING");
            assertThat(data(events.get(1)).path("progressTotal").asInt()).isEqualTo(2);
            assertThat(data(events.get(1)).path("detectedLang").asString()).isEqualTo("en");
            JsonNode analysis = data(events.get(3));
            assertThat(analysis.path("summary").asString()).isEqualTo("本文简要介绍 GPU 在模型训练中的作用及其使用方式。");
            assertThat(analysis.path("domain").asString()).isEqualTo("计算机");
            assertThat(analysis.path("genre").asString()).isEqualTo("技术文档");
            assertThat(data(events.get(4)).path("status").asString()).isEqualTo("AWAITING_CONFIRM");
            JsonNode terms = data(events.get(5)).path("terms");
            assertThat(terms).hasSize(3);
            assertThat(terms.get(0).propertyNames())
                    .containsExactlyInAnyOrder("id", "source", "target", "origin", "frequency", "status");

            // 用户确认术语 → phase TRANSLATING
            List<Map<String, Object>> decisions = new ArrayList<>();
            terms.forEach(t -> decisions.add(Map.of("id", t.path("id").asLong(), "source", t.path("source").asString(),
                    "target", t.path("target").asString(), "status", "CONFIRMED")));
            perform(bearer(jsonBody(post("/api/doc-tasks/" + id + "/terms/confirm"), Map.of("terms", decisions)), token));
            Event translating = next(s);
            assertThat(translating.event()).isEqualTo("phase");
            assertThat(data(translating).path("status").asString()).isEqualTo("TRANSLATING");

            // 用户取消 → phase CANCELLING；执行端回报 cancelled → 推送并关闭
            perform(bearer(post("/api/doc-tasks/" + id + "/cancel"), token));
            Event cancelling = next(s);
            assertThat(data(cancelling).path("status").asString()).isEqualTo("CANCELLING");
            emit(event(id, 10, "cancelled", "{}"));
            Event cancelled = next(s);
            assertThat(cancelled.event()).isEqualTo("cancelled");
            assertThat(data(cancelled).isEmpty()).isTrue();
            assertThat(s.next(NEXT)).isNull();
        }
    }

    @Test
    void failedEventIsPushedAndClosesStream() throws Exception {
        long id = createTask("doc");
        try (Session s = sse().get("/api/doc-tasks/" + id + "/events", token)) {
            assertThat(next(s).event()).isEqualTo("snapshot");
            emit(event(id, 1, "failed", "{\"code\":\"C0122\",\"message\":\"LLM 调用超时\",\"retryable\":true}"));
            Event failed = next(s);
            assertThat(failed.event()).isEqualTo("failed");
            JsonNode d = data(failed);
            assertThat(d.path("code").asString()).isEqualTo("C0122");
            assertThat(d.path("message").asString()).isEqualTo("LLM 调用超时");
            assertThat(d.path("retryable").asBoolean()).isTrue();
            assertThat(s.next(NEXT)).isNull();
        }
    }

    @Test
    void terminalTaskSendsSnapshotThenCloses() throws Exception {
        long id = createTask("doc");
        setStatus(id, "COMPLETED");
        try (Session s = sse().get("/api/doc-tasks/" + id + "/events", token)) {
            List<Event> events = s.readAll(NEXT).stream().filter(e -> !e.isComment()).toList();
            assertThat(events).hasSize(1);
            assertThat(events.getFirst().event()).isEqualTo("snapshot");
            assertThat(data(events.getFirst()).path("status").asString()).isEqualTo("COMPLETED");
        }
    }

    @Test
    void othersTaskCannotBeSubscribed() throws Exception {
        long id = createTask("doc");
        String other = registerUser(uniqueName("doco"), "Passw0rd!");
        try (Session s = sse().get("/api/doc-tasks/" + id + "/events", accessToken(other, "Passw0rd!"))) {
            assertThat(s.status()).isEqualTo(404);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0404");
        }
    }

}
