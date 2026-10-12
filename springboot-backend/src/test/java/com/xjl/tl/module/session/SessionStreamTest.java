package com.xjl.tl.module.session;

import com.xjl.tl.support.MockAiServer;
import com.xjl.tl.support.SseTestClient.Event;
import com.xjl.tl.support.SseTestClient.Session;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * translation-session / tasks 3.2–3.4：会话默认参数、会话载荷（指代借助前文）、并发锁、会话记忆写回、
 * 修订与采用、歧义追问的中断 / 恢复 / 放弃 / 失效。使用真实 Tomcat 与模拟的 Python 上游。
 */
class SessionStreamTest extends SessionTestSupport {

    private static String marker() {
        return UUID.randomUUID().toString().substring(0, 8);
    }

    private MockAiServer.Received upstream(String text) {
        return mockAi().requestsContaining(text).getLast();
    }

    private int recordCount() {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM biz.translation_record WHERE user_id = ?",
                Integer.class, userId);
    }

    // ---------------- 默认参数与会话载荷 ----------------

    @Test
    void sessionDefaultsApplyAndExplicitValuesWin() throws Exception {
        long id = createSession(Map.of("targetLang", "ja", "style", "fluent", "domain", "法律"));
        String text = "Your order has been shipped and will arrive soon " + marker();
        JsonNode fin = turn(id, text);
        assertThat(fin.path("sessionId").asLong()).isEqualTo(id);
        assertThat(fin.has("revisionOf")).isTrue();
        assertThat(fin.path("revisionOf").isNull()).isTrue();
        long recordId = fin.path("recordId").asLong();

        JsonNode body = upstream(text).body();
        assertThat(body.path("targetLang").asString()).isEqualTo("ja");
        assertThat(body.path("style").asString()).isEqualTo("fluent");
        assertThat(body.path("domain").asString()).isEqualTo("法律");
        assertThat(body.path("sourceLang").asString()).isEqualTo("auto");
        assertThat(body.path("revise").isNull()).isTrue();
        JsonNode session = body.path("session");
        assertThat(session.path("sessionId").asLong()).isEqualTo(id);
        assertThat(session.path("turnSeq").asInt()).isEqualTo(1);
        assertThat(session.path("clarifyEnabled").asBoolean()).isTrue();
        assertThat(session.path("recentTurns").size()).isZero();
        assertThat(session.path("toMemorize").size()).isZero();
        assertThat(session.path("memorizedUntil").asInt()).isZero();
        assertThat(session.path("entities").isArray()).isTrue();
        assertThat(session.has("summary")).isTrue();

        Map<String, Object> row = jdbcTemplate.queryForMap(
                "SELECT session_id, style, target_lang, adopted, revision_of FROM biz.translation_record WHERE id = ?",
                recordId);
        assertThat(((Number) row.get("session_id")).longValue()).isEqualTo(id);
        assertThat(row.get("style")).isEqualTo("fluent");
        assertThat(row.get("target_lang")).isEqualTo("ja");
        assertThat(row.get("adopted")).isEqualTo(true);
        assertThat(row.get("revision_of")).isNull();
        JsonNode d = detail(id);
        assertThat(d.path("turnCount").asInt()).isEqualTo(1);
        assertThat(d.path("title").asString()).isEqualTo("Your order has been ");

        // 请求中显式给出的参数优先
        String explicit = "Second line " + marker();
        Map<String, Object> req = turnBody(id, explicit);
        req.put("style", "creative");
        req.put("targetLang", "en");
        req.put("sourceLang", "zh");
        try (Session s = sse().open(token, req)) {
            assertThat(events(s).getLast().event()).isEqualTo("final");
        }
        JsonNode second = upstream(explicit).body();
        assertThat(second.path("style").asString()).isEqualTo("creative");
        assertThat(second.path("targetLang").asString()).isEqualTo("en");
        assertThat(second.path("domain").asString()).isEqualTo("法律");
        assertThat(second.path("session").path("turnSeq").asInt()).isEqualTo(2);
        assertThat(detail(id).path("title").asString()).as("标题只取首轮").isEqualTo("Your order has been ");
    }

    @Test
    void secondTurnCarriesPreviousTurnAsContext() throws Exception {
        long id = createSession(Map.of("targetLang", "zh", "clarifyEnabled", false));
        String first = "I bought the X200 headphones last week. " + marker();
        turn(id, first);
        String second = "It stopped working yesterday. " + marker();
        turn(id, second);
        JsonNode session = upstream(second).body().path("session");
        assertThat(session.path("turnSeq").asInt()).isEqualTo(2);
        assertThat(session.path("clarifyEnabled").asBoolean()).isFalse();
        JsonNode recent = session.path("recentTurns");
        assertThat(recent.size()).isEqualTo(1);
        assertThat(recent.get(0).path("seq").asInt()).isEqualTo(1);
        assertThat(recent.get(0).path("source").asString()).isEqualTo(first);
        assertThat(recent.get(0).path("target").asString()).isEqualTo("译：" + first);
        assertThat(recent.get(0).has("instruction")).isTrue();
    }

    @Test
    void otherUsersSessionIsRejectedBeforeStream() throws Exception {
        long id = createSession();
        String other = registerUser(uniqueName("so"), "Passw0rd!");
        String otherToken = accessToken(other, "Passw0rd!");
        String text = "hello " + marker();
        try (Session s = sse().open(otherToken, turnBody(id, text))) {
            assertThat(s.status()).isEqualTo(404);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0404");
        }
        assertThat(mockAi().requestsContaining(text)).isEmpty();
    }

    // ---------------- 并发 ----------------

    @Test
    void concurrentRequestInSameSessionIsRejectedAndLockReleasedOnCancel() throws Exception {
        long id = createSession();
        String done = "Done before " + marker();
        long recordId = turn(id, done).path("recordId").asLong();
        String stall = "Hold on " + marker() + " [[mock:stall]]";
        Session first = sse().open(token, turnBody(id, stall));
        assertThat(first.next(WAIT).event()).isEqualTo("start");

        try (Session second = sse().post("/api/translate/sessions/" + id + "/revise", token,
                Map.of("recordId", recordId, "instruction", "更口语一些"))) {
            assertThat(second.status()).isEqualTo(409);
            assertThat(second.header("Content-Type")).startsWith("application/json");
            assertThat(second.jsonBody().path("code").asString()).isEqualTo("A0214");
        }
        String blocked = "Blocked " + marker();
        try (Session third = sse().open(token, turnBody(id, blocked))) {
            assertThat(third.status()).isEqualTo(409);
            assertThat(third.jsonBody().path("code").asString()).isEqualTo("A0214");
        }
        assertThat(mockAi().requestsContaining(blocked)).isEmpty();
        // 其他会话不受影响
        long other = createSession();
        turn(other, "Another session " + marker());

        first.close();
        assertThat(mockAi().closedLatch(stall).await(5, TimeUnit.SECONDS)).isTrue();
        // 取消后释放锁
        await(() -> redis.opsForValue().get("lock:session:" + id) == null);
        turn(id, "After cancel " + marker());
    }

    // ---------------- 会话记忆 ----------------

    @Test
    void memoryEventIsForwardedAndWrittenBackToSession() throws Exception {
        long id = createSession();
        String text = "Ninth turn " + marker() + " [[mock:memory]]";
        long recordId;
        try (Session s = sse().open(token, turnBody(id, text))) {
            List<Event> events = events(s);
            List<String> names = events.stream().map(Event::event).toList();
            assertThat(names).contains("memory");
            assertThat(names.indexOf("memory")).isLessThan(names.indexOf("final"));
            recordId = data(events.getLast()).path("recordId").asLong();
        }
        JsonNode d = detail(id);
        assertThat(d.path("memorySummary").asString()).isEqualTo("用户上周购买了 X200 耳机");
        assertThat(d.path("memorizedUntil").asInt()).isEqualTo(3);
        assertThat(d.path("memoryEntities").size()).as("非对象的实体被忽略").isEqualTo(1);
        assertThat(d.path("memoryEntities").get(0).path("source").asString()).isEqualTo("X200");
        JsonNode traces = body(perform(bearer(get("/api/translations/" + recordId), token))).path("data").path("traces");
        JsonNode memorize = traces.valueStream().filter(t -> "memorize".equals(t.path("node").asString()))
                .findFirst().orElseThrow();
        assertThat(memorize.path("detail").path("memory").path("memorizedUntil").asInt()).isEqualTo(3);

        // 下一轮载荷带上摘要、实体与 memorizedUntil
        String next = "Next " + marker();
        turn(id, next);
        JsonNode session = upstream(next).body().path("session");
        assertThat(session.path("summary").asString()).isEqualTo("用户上周购买了 X200 耳机");
        assertThat(session.path("entities").get(0).path("note").asString()).isEqualTo("耳机型号");
        assertThat(session.path("memorizedUntil").asInt()).isEqualTo(3);
    }

    @Test
    void nodeDetailIsMergedIntoTrace() throws Exception {
        long id = createSession();
        String text = "Restart the Pod " + marker() + " [[mock:detail]]";
        long recordId = turn(id, text).path("recordId").asLong();
        JsonNode traces = body(perform(bearer(get("/api/translations/" + recordId), token))).path("data").path("traces");
        JsonNode retrieve = traces.valueStream().filter(t -> "retrieve".equals(t.path("node").asString()))
                .findFirst().orElseThrow();
        assertThat(retrieve.path("detail").path("tmHits").get(0).path("fuzzy").asDouble()).isEqualTo(0.92);
        assertThat(retrieve.path("detail").path("sessionTurns").asInt()).isEqualTo(2);
    }

    // ---------------- 修订与采用 ----------------

    @Test
    void reviseCreatesAdoptedVersionAndAdoptCanSwitchBack() throws Exception {
        long id = createSession();
        String first = "It is broken " + marker();
        JsonNode v1 = turn(id, first);
        long v1Id = v1.path("recordId").asLong();

        long v2Id;
        try (Session s = sse().post("/api/translate/sessions/" + id + "/revise", token,
                Map.of("recordId", v1Id, "instruction", " 更口语一些 "))) {
            assertThat(s.status()).isEqualTo(200);
            List<Event> events = events(s);
            Event plan = events.stream().filter(e -> "plan".equals(e.event())).findFirst().orElseThrow();
            assertThat(data(plan).path("path").asString()).isEqualTo("revise");
            assertThat(events.stream().filter(e -> "node".equals(e.event())).map(this::data)
                    .filter(n -> "skipped".equals(n.path("status").asString())).map(n -> n.path("node").asString()))
                    .containsExactly("retrieve", "review");
            JsonNode fin = data(events.getLast());
            assertThat(fin.path("revisionOf").asLong()).isEqualTo(v1Id);
            assertThat(fin.path("sessionId").asLong()).isEqualTo(id);
            v2Id = fin.path("recordId").asLong();
        }
        JsonNode up = mockAi().requests("/internal/translate/stream").getLast().body();
        assertThat(up.path("mode").asString()).isEqualTo("revise");
        assertThat(up.path("text").asString()).isEqualTo(first);
        assertThat(up.path("sourceLang").asString()).as("沿用原记录的识别语种").isEqualTo("en");
        assertThat(up.path("revise").path("recordId").asLong()).isEqualTo(v1Id);
        assertThat(up.path("revise").path("baseSource").asString()).isEqualTo(first);
        assertThat(up.path("revise").path("baseTarget").asString()).isEqualTo("译：" + first);
        assertThat(up.path("revise").path("instruction").asString()).isEqualTo("更口语一些");
        assertThat(up.path("session").path("turnSeq").asInt()).isEqualTo(1);

        Map<String, Object> row = jdbcTemplate.queryForMap("""
                SELECT session_id, revision_of, mode, path, revise_instruction, adopted FROM biz.translation_record
                WHERE id = ?""", v2Id);
        assertThat(((Number) row.get("session_id")).longValue()).isEqualTo(id);
        assertThat(((Number) row.get("revision_of")).longValue()).isEqualTo(v1Id);
        assertThat(row.get("mode")).isEqualTo("revise");
        assertThat(row.get("path")).isEqualTo("revise");
        assertThat(row.get("revise_instruction")).isEqualTo("更口语一些");
        assertThat(row.get("adopted")).isEqualTo(true);
        assertThat(jdbcTemplate.queryForObject("SELECT adopted FROM biz.translation_record WHERE id = ?", Boolean.class, v1Id))
                .isFalse();
        JsonNode d = detail(id);
        assertThat(d.path("turnCount").asInt()).as("修订不增加轮次").isEqualTo(1);
        assertThat(d.path("turns").get(0).path("versions").size()).isEqualTo(2);
        assertThat(d.path("turns").get(0).path("adoptedRecordId").asLong()).isEqualTo(v2Id);

        // 修订的修订仍属于同一轮
        long v3Id;
        try (Session s = sse().post("/api/translate/sessions/" + id + "/revise", token,
                Map.of("recordId", v2Id, "instruction", "更简洁"))) {
            v3Id = data(events(s).getLast()).path("recordId").asLong();
        }
        assertThat(detail(id).path("turns").get(0).path("versions").size()).isEqualTo(3);

        // 切回 v1：之后的会话上下文使用 v1 的译文
        JsonNode adopted = body(perform(bearer(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .put("/api/translate/sessions/" + id + "/records/" + v1Id + "/adopt"), token))).path("data");
        assertThat(adopted.path("turns").get(0).path("adoptedRecordId").asLong()).isEqualTo(v1Id);
        assertThat(jdbcTemplate.queryForList("SELECT id FROM biz.translation_record WHERE session_id = ? AND adopted",
                Long.class, id)).containsExactly(v1Id);
        String next = "Next turn " + marker();
        turn(id, next);
        JsonNode recent = upstream(next).body().path("session").path("recentTurns");
        assertThat(recent.get(0).path("target").asString()).isEqualTo("译：" + first);
        assertThat(v3Id).isPositive();
    }

    @Test
    void reviseRejectsRecordOutsideSessionAndInvalidInstruction() throws Exception {
        long id = createSession();
        long otherSession = createSession();
        long foreign = turn(otherSession, "Elsewhere " + marker()).path("recordId").asLong();
        try (Session s = sse().post("/api/translate/sessions/" + id + "/revise", token,
                Map.of("recordId", foreign, "instruction", "更口语"))) {
            assertThat(s.status()).isEqualTo(404);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0404");
        }
        try (Session s = sse().post("/api/translate/sessions/" + id + "/revise", token,
                Map.of("recordId", foreign, "instruction", "  "))) {
            assertThat(s.status()).isEqualTo(400);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
        try (Session s = sse().post("/api/translate/sessions/" + id + "/revise", token,
                Map.of("recordId", foreign, "instruction", "x".repeat(501)))) {
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
    }

    // ---------------- 歧义追问 ----------------

    /** 发起一次触发追问的翻译，返回 clarify 事件的 data。 */
    private JsonNode askClarify(long id, String text) throws Exception {
        try (Session s = sse().open(token, turnBody(id, text))) {
            List<Event> events = events(s);
            assertThat(events.getLast().event()).isEqualTo("clarify");
            assertThat(events).noneMatch(e -> "final".equals(e.event()));
            return data(events.getLast());
        }
    }

    @Test
    void clarifyThenAnswerResumesAndPersistsOneRecordWithMergedTraces() throws Exception {
        long id = createSession();
        int before = recordCount();
        String text = "Please send it to the bank. " + marker() + " [[mock:clarify]]";
        JsonNode clarify = askClarify(id, text);
        String threadId = clarify.path("threadId").asString();
        assertThat(threadId).startsWith("turn:");
        assertThat(recordCount()).as("追问不写记录").isEqualTo(before);
        JsonNode d = detail(id);
        assertThat(d.path("hasPending").asBoolean()).isTrue();
        assertThat(d.path("turnCount").asInt()).isZero();
        JsonNode pending = d.path("pending");
        assertThat(pending.path("threadId").asString()).isEqualTo(threadId);
        assertThat(pending.path("question").asString()).isEqualTo("bank 指什么？");
        assertThat(pending.path("options").size()).isEqualTo(2);
        assertThat(pending.path("span").asString()).isEqualTo("bank");
        assertThat(pending.path("reason").asString()).isEqualTo("多义词");
        assertThat(pending.path("source").asString()).isEqualTo(text);
        assertThat(redis.opsForValue().get("lock:session:" + id)).as("clarify 结束后释放锁").isNull();
        JsonNode list = body(perform(bearer(get("/api/translate/sessions"), token))).path("data").path("records");
        assertThat(list.get(0).path("hasPending").asBoolean()).isTrue();

        // threadId 不一致
        try (Session s = sse().post("/api/translate/sessions/" + id + "/clarify", token,
                Map.of("threadId", "turn:other", "answer", "银行"))) {
            assertThat(s.status()).isEqualTo(409);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0440");
        }

        long recordId;
        try (Session s = sse().post("/api/translate/sessions/" + id + "/clarify", token,
                Map.of("threadId", threadId, "answer", "银行"))) {
            assertThat(s.status()).isEqualTo(200);
            List<Event> events = events(s);
            assertThat(events.getFirst().event()).isEqualTo("start");
            JsonNode fin = data(events.getLast());
            assertThat(events.getLast().event()).isEqualTo("final");
            assertThat(fin.path("translation").asString()).isEqualTo("请把它寄到银行。");
            assertThat(fin.path("clarification").path("answer").asString()).isEqualTo("银行");
            assertThat(fin.path("sessionId").asLong()).isEqualTo(id);
            recordId = fin.path("recordId").asLong();
        }
        JsonNode resumeBody = mockAi().requests("/internal/translate/resume").getLast().body();
        assertThat(resumeBody.path("threadId").asString()).isEqualTo(threadId);
        assertThat(resumeBody.path("answer").asString()).isEqualTo("银行");
        assertThat(resumeBody.path("userId").asLong()).isEqualTo(userId);

        assertThat(recordCount()).isEqualTo(before + 1);
        JsonNode r = body(perform(bearer(get("/api/translations/" + recordId), token))).path("data");
        assertThat(r.path("sourceText").asString()).isEqualTo(text);
        assertThat(r.path("detectedLang").asString()).as("中断前的 detect 被恢复").isEqualTo("en");
        assertThat(r.path("sessionId").asLong()).isEqualTo(id);
        assertThat(r.path("clarification").path("question").asString()).isEqualTo("bank 指什么？");
        assertThat(r.path("clarification").path("answer").asString()).isEqualTo("银行");
        JsonNode traces = r.path("traces");
        assertThat(traces.valueStream().map(t -> t.path("node").asString()).toList())
                .containsExactly("analyze", "plan", "clarify", "retrieve", "translate", "review", "finalize");
        assertThat(traces.get(2).path("status").asString()).isEqualTo("completed");
        assertThat(traces.get(0).path("detail").path("detect").path("lang").asString()).isEqualTo("en");
        assertThat(traces.get(3).path("detail").path("tmHits").size()).isEqualTo(1);
        assertThat(traces.valueStream().map(t -> t.path("seq").asInt()).toList()).containsExactly(1, 2, 3, 4, 5, 6, 7);

        d = detail(id);
        assertThat(d.path("pending").isNull()).isTrue();
        assertThat(d.path("turnCount").asInt()).isEqualTo(1);
        assertThat(d.path("turns").get(0).path("versions").get(0).path("clarification").path("answer").asString())
                .isEqualTo("银行");

        // 再次回答同一追问：已没有 pending
        try (Session s = sse().post("/api/translate/sessions/" + id + "/clarify", token,
                Map.of("threadId", threadId, "answer", "银行"))) {
            assertThat(s.status()).isEqualTo(409);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0440");
        }
    }

    @Test
    void newTurnAbandonsPendingAndOldAnswerExpires() throws Exception {
        long id = createSession();
        String threadId = askClarify(id, "Send it to the bank " + marker() + " [[mock:clarify]]")
                .path("threadId").asString();
        assertThat(mockAi().hasThread(threadId)).isTrue();
        String next = "Your order has been shipped. " + marker();
        JsonNode fin = turn(id, next);
        assertThat(fin.path("translation").asString()).isEqualTo("译：" + next);
        assertThat(mockAi().requests("/internal/translate/threads/" + threadId)).hasSize(1);
        assertThat(mockAi().requests("/internal/translate/threads/" + threadId).getFirst().method()).isEqualTo("DELETE");
        assertThat(mockAi().hasThread(threadId)).isFalse();
        assertThat(detail(id).path("pending").isNull()).isTrue();
        assertThat(upstream(next).body().path("session").path("turnSeq").asInt()).isEqualTo(1);
        try (Session s = sse().post("/api/translate/sessions/" + id + "/clarify", token,
                Map.of("threadId", threadId, "answer", "银行"))) {
            assertThat(s.status()).isEqualTo(409);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0440");
        }
    }

    @Test
    void upstreamExpiredThreadClearsPending() throws Exception {
        long id = createSession();
        String threadId = askClarify(id, "To the bank " + marker() + " [[mock:clarify]]").path("threadId").asString();
        // AI 服务侧检查点已被清理（例如超过 24 小时）
        jdbcTemplate.update("UPDATE biz.translation_session SET pending = jsonb_set(pending, '{threadId}', '\"turn:gone\"') WHERE id = ?", id);
        try (Session s = sse().post("/api/translate/sessions/" + id + "/clarify", token,
                Map.of("threadId", "turn:gone", "answer", "银行"))) {
            assertThat(s.status()).isEqualTo(200);
            Event last = events(s).getLast();
            assertThat(last.event()).isEqualTo("error");
            assertThat(data(last).path("code").asString()).isEqualTo("A0440");
        }
        assertThat(detail(id).path("pending").isNull()).isTrue();
        assertThat(threadId).isNotBlank();
    }

    @Test
    void clarificationFallsBackToPendingWhenFinalOmitsIt() throws Exception {
        long id = createSession();
        String threadId = askClarify(id, "Bank " + marker() + " [[mock:clarify]]").path("threadId").asString();
        long recordId;
        try (Session s = sse().post("/api/translate/sessions/" + id + "/clarify", token,
                Map.of("threadId", threadId, "answer", " 河岸 [[mock:noclar]] "))) {
            recordId = data(events(s).getLast()).path("recordId").asLong();
        }
        JsonNode c = body(perform(bearer(get("/api/translations/" + recordId), token))).path("data").path("clarification");
        assertThat(c.path("question").asString()).isEqualTo("bank 指什么？");
        assertThat(c.path("span").asString()).isEqualTo("bank");
        assertThat(c.path("options").size()).isEqualTo(2);
        assertThat(c.path("answer").asString()).isEqualTo("河岸 [[mock:noclar]]");
    }

    @Test
    void clarifyWithoutPendingOrInvalidBodyIsRejected() throws Exception {
        long id = createSession();
        try (Session s = sse().post("/api/translate/sessions/" + id + "/clarify", token,
                Map.of("threadId", "turn:none", "answer", "银行"))) {
            assertThat(s.status()).isEqualTo(409);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0440");
        }
        assertThat(redis.opsForValue().get("lock:session:" + id)).as("校验失败也释放锁").isNull();
        // pending 缺少恢复所需的原请求
        jdbcTemplate.update("UPDATE biz.translation_session SET pending = '{\"threadId\":\"turn:bare\"}'::jsonb WHERE id = ?", id);
        try (Session s = sse().post("/api/translate/sessions/" + id + "/clarify", token,
                Map.of("threadId", "turn:bare", "answer", "银行"))) {
            assertThat(s.status()).isEqualTo(409);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0440");
        }
        try (Session s = sse().post("/api/translate/sessions/" + id + "/clarify", token,
                Map.of("threadId", "turn:none", "answer", "x".repeat(201)))) {
            assertThat(s.status()).isEqualTo(400);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
        try (Session s = sse().post("/api/translate/sessions/999999/clarify", token,
                Map.of("threadId", "turn:none", "answer", "银行"))) {
            assertThat(s.status()).isEqualTo(404);
        }
    }

    @Test
    void nonSessionClarifyEventIsForwardedWithoutPending() throws Exception {
        String text = "Bank " + marker() + " [[mock:clarify]]";
        Map<String, Object> req = Map.of("text", text, "targetLang", "zh");
        try (Session s = sse().open(token, req)) {
            List<Event> events = events(s);
            assertThat(events.getLast().event()).isEqualTo("clarify");
        }
        assertThat(recordCount()).isZero();
        // 非会话请求的 final 也带 sessionId / revisionOf（为 null）
        try (Session s = sse().open(token, Map.of("text", "Hi " + marker(), "targetLang", "zh"))) {
            JsonNode fin = data(events(s).getLast());
            assertThat(fin.has("sessionId")).isTrue();
            assertThat(fin.path("sessionId").isNull()).isTrue();
            assertThat(fin.path("revisionOf").isNull()).isTrue();
        }
        try (Session s = sse().open(token, Map.of("text", "Hi " + marker()))) {
            assertThat(s.status()).isEqualTo(400);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
    }
}
