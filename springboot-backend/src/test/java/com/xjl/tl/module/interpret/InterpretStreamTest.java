package com.xjl.tl.module.interpret;

import com.xjl.tl.module.interpret.room.RoomRegistry;
import com.xjl.tl.support.MockInterpretServer;
import com.xjl.tl.support.StreamingTestBase;
import com.xjl.tl.support.WsTestClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import static com.xjl.tl.module.interpret.InterpretSessionApiTest.SESSIONS;
import static com.xjl.tl.module.interpret.InterpretSessionApiTest.create;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * live-interpretation「实时音频通道」「多语会议室」「同传记录持久化」/ tasks 6.6–6.8：真实 Tomcat + 模拟 Python 同传 WS 服务。
 * 覆盖事件补 speaker 与 utteranceId 改写、三人三语 targets 与 audio 路由、Python 断开的非致命错误与重建、
 * 段合并与超时、结束统计、自动结束、主持人离开、重连恢复身份、并发上限与控制帧。
 */
class InterpretStreamTest extends StreamingTestBase {

    private static final Map<String, String> FLUSH = Map.of("type", "flush");

    @Autowired
    private RoomRegistry registry;

    private String token;
    private long userId;

    @BeforeEach
    void user() throws Exception {
        String name = registerUser(uniqueName("is"), "Passw0rd!");
        token = accessToken(name, "Passw0rd!");
        userId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, name);
    }

    private String newToken() throws Exception {
        String name = registerUser(uniqueName("iso"), "Passw0rd!");
        return accessToken(name, "Passw0rd!");
    }

    private JsonNode createSession(String tk, Map<String, Object> req) throws Exception {
        JsonNode r = body(postJson(SESSIONS, req, tk));
        assertThat(r.path("code").asString()).as("%s", r).isEqualTo("00000");
        return r.path("data");
    }

    private JsonNode join(String tk, String code, Map<String, Object> req) throws Exception {
        JsonNode r = body(postJson("/api/interpret/rooms/" + code + "/join", req, tk));
        assertThat(r.path("code").asString()).as("%s", r).isEqualTo("00000");
        return r.path("data");
    }

    private WsTestClient connect(JsonNode joinVo) throws Exception {
        WsTestClient c = WsTestClient.connect(port, joinVo.path("wsTicket").asString());
        c.expect("ready");
        return c;
    }

    /** 上行一帧音频并等待 Python 收到首帧 config。 */
    private MockInterpretServer.Stream speak(WsTestClient c, String streamId) throws Exception {
        c.sendAudio(1280);
        awaitUntil(8000, () -> {
            MockInterpretServer.Stream s = mockInterpret().latest(streamId);
            return s != null && s.config != null && !s.closed;
        });
        return mockInterpret().latest(streamId);
    }

    private static void awaitUntil(long timeoutMs, BooleanSupplier condition) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("等待超时");
    }

    private int segments(long sessionId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM biz.interpret_segment WHERE session_id = ?",
                Integer.class, sessionId);
    }

    private static List<String> strings(JsonNode arr) {
        return arr.valueStream().map(JsonNode::asString).toList();
    }

    @Test
    void browserDisconnectDrainsPendingUtteranceBeforeClosingStream() throws Exception {
        // 联调发现：刷新页面时正在翻译的那句被丢弃；断线改为收尾，Python 处理完后该句仍能落库
        Map<String, Object> req = create("LISTEN", "cascade", List.of("en"));
        req.put("domainHint", "[[drain]]");
        JsonNode vo = createSession(token, req);
        long id = vo.path("sessionId").asLong();
        MockInterpretServer.Stream py;
        try (WsTestClient c = WsTestClient.connect(port, vo.path("wsTicket").asString())) {
            c.expect("ready");
            py = speak(c, "s-" + id + "-p1");
        }
        awaitUntil(8000, () -> py.closed);
        assertThat(py.controls).anyMatch(n -> "end".equals(n.path("type").asString()));
        awaitUntil(8000, () -> segments(id) == 1);
        assertThat(jdbcTemplate.queryForObject(
                "SELECT translations->>'en' FROM biz.interpret_segment WHERE session_id = ?", String.class, id))
                .isEqualTo("[en]第1句");
        assertThat(registry.find(id)).as("会话仍在宽限期内，可恢复").isNotNull();
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
    }

    @Test
    void endWaitsForPythonToDrainPendingUtterances() throws Exception {
        // 联调发现：结束时最后一句的译文还在路上，旧实现立即关闭连接导致该句以空译文落库
        Map<String, Object> req = create("LISTEN", "cascade", List.of("en"));
        req.put("domainHint", "[[drain]]");
        JsonNode vo = createSession(token, req);
        long id = vo.path("sessionId").asLong();
        try (WsTestClient c = WsTestClient.connect(port, vo.path("wsTicket").asString())) {
            c.expect("ready");
            speak(c, "s-" + id + "-p1");
            c.sendText("{\"type\":\"end\"}");
            // 前端在 WS end 之后紧接着调用 REST 结束接口：应等待同一次收尾，统计不得被兜底逻辑覆盖
            JsonNode vo2 = body(perform(bearer(post(SESSIONS + "/" + id + "/end"), token))).path("data");
            assertThat(vo2.path("status").asString()).isEqualTo("ENDED");
            assertThat(vo2.path("stats").path("utterances").asInt()).isEqualTo(1);
            assertThat(vo2.path("stats").path("avgE2eMs").asInt()).isEqualTo(1100);
            assertThat(c.expect("translation.final").path("text").asString()).isEqualTo("[en]第1句");
            c.expect("metrics");
            JsonNode ended = c.expect("ended");
            assertThat(ended.path("stats").path("utterances").asInt()).isEqualTo(1);
            assertThat(c.awaitClose(Duration.ofSeconds(10))).isEqualTo(1000);
        }
        assertThat(jdbcTemplate.queryForObject(
                "SELECT translations->>'en' FROM biz.interpret_segment WHERE session_id = ?", String.class, id))
                .isEqualTo("[en]第1句");
    }

    @Test
    void listenRelaysEventsWithSpeakerAndPersistsOnEnd() throws Exception {
        Map<String, Object> req = create("LISTEN", "cascade", List.of("en"));
        req.put("domainHint", "技术发布会");
        req.put("voices", Map.of("en", "en-US-AvaMultilingualNeural"));
        JsonNode vo = createSession(token, req);
        long id = vo.path("sessionId").asLong();
        String streamId = "s-" + id + "-p1";
        try (WsTestClient c = WsTestClient.connect(port, vo.path("wsTicket").asString())) {
            JsonNode ready = c.expect("ready");
            assertThat(ready.path("mode").asString()).isEqualTo("LISTEN");
            assertThat(strings(ready.path("languages"))).containsExactly("en");
            assertThat(ready.path("roomCode").isNull()).isTrue();
            JsonNode participants = c.expect("participants");
            assertThat(participants.path("list").get(0).path("online").asBoolean()).isTrue();

            c.sendText("{\"type\":\"ping\"}");
            c.expect("pong");

            MockInterpretServer.Stream py = speak(c, streamId);
            c.sendAudio(1280);
            c.sendAudio(1280);
            awaitUntil(5000, () -> py.audioFrames.get() == 3);
            assertThat(py.internalToken).isEqualTo("test-internal-token");
            JsonNode cfg = py.config;
            assertThat(cfg.path("type").asString()).isEqualTo("config");
            assertThat(cfg.path("sessionId").asLong()).isEqualTo(id);
            assertThat(cfg.path("userId").asLong()).isEqualTo(userId);
            assertThat(cfg.path("mode").asString()).isEqualTo("LISTEN");
            assertThat(cfg.path("engine").asString()).isEqualTo("cascade");
            assertThat(strings(cfg.path("sourceLangs"))).containsExactly("auto");
            assertThat(strings(cfg.path("targetLangs"))).containsExactly("en");
            assertThat(cfg.path("domainHint").asString()).isEqualTo("技术发布会");
            assertThat(cfg.path("tts").asBoolean()).isTrue();
            assertThat(cfg.path("gender").asString()).isEqualTo("female");
            assertThat(cfg.path("voices").path("en").asString()).isEqualTo("en-US-AvaMultilingualNeural");
            assertThat(cfg.path("modelConfigId").isNull()).isTrue();

            c.sendJson(FLUSH);
            JsonNode partial = c.expect("transcript.partial");
            assertThat(partial.path("utteranceId").asString()).isEqualTo("p1:1");
            assertThat(partial.path("speaker").path("participantId").asString()).isEqualTo("p1");
            assertThat(partial.path("speaker").path("lang").asString()).isEqualTo("en");
            JsonNode fin = c.expect("transcript.final");
            assertThat(fin.path("text").asString()).isEqualTo("第1句");
            assertThat(fin.path("lang").asString()).isEqualTo("zh");
            assertThat(c.expect("translation.delta").path("utteranceId").asString()).isEqualTo("p1:1");
            assertThat(c.expect("translation.final").path("text").asString()).isEqualTo("[en]第1句");
            JsonNode audio = c.expect("audio");
            assertThat(audio.path("lang").asString()).isEqualTo("en");
            assertThat(audio.path("format").asString()).isEqualTo("pcm16");
            assertThat(audio.path("last").asBoolean()).isTrue();
            JsonNode metrics = c.expect("metrics");
            assertThat(metrics.path("e2eMs").asInt()).isEqualTo(1100);
            long metricsAt = System.currentTimeMillis();
            assertThat(c.received("ready")).as("Python 的 ready 不转发").hasSize(1);
            assertThat(c.received("participants")).anyMatch(p -> p.path("list").get(0).path("speaking").asBoolean());
            // 说话状态 1.5 秒后过期
            assertThat(c.next(p -> "participants".equals(p.path("type").asString())
                    && !p.path("list").get(0).path("speaking").asBoolean(), Duration.ofSeconds(4))).isNotNull();

            // 原文、译文与指标到齐即写入（不等 5 秒超时）
            awaitUntil(3000, () -> segments(id) == 1);
            assertThat(System.currentTimeMillis() - metricsAt).isLessThan(3000);
            Map<String, Object> row = jdbcTemplate.queryForMap("""
                    SELECT seq, speaker_participant, speaker_user_id, source_lang, source_text, translations::text AS t,
                           metrics->>'e2eMs' AS e2e, started_ms, ended_ms FROM biz.interpret_segment WHERE session_id = ?""", id);
            assertThat(row.get("seq")).isEqualTo(1);
            assertThat(row.get("speaker_participant")).isEqualTo("p1");
            assertThat(row.get("speaker_user_id")).isEqualTo(userId);
            assertThat(row.get("source_lang")).isEqualTo("zh");
            assertThat(row.get("source_text")).isEqualTo("第1句");
            assertThat(row.get("t")).isEqualTo("{\"en\": \"[en]第1句\"}");
            assertThat(row.get("e2e")).isEqualTo("1100");
            assertThat((Integer) row.get("started_ms")).isGreaterThanOrEqualTo(100);
            assertThat((Integer) row.get("ended_ms")).isGreaterThan((Integer) row.get("started_ms"));

            JsonNode ended = body(perform(bearer(post(SESSIONS + "/" + id + "/end"), token))).path("data");
            assertThat(ended.path("status").asString()).isEqualTo("ENDED");
            assertThat(ended.path("stats").path("utterances").asInt()).isEqualTo(1);
            assertThat(ended.path("stats").path("avgE2eMs").asInt()).isEqualTo(1100);
            assertThat(ended.path("stats").path("p50E2eMs").asInt()).isEqualTo(1100);
            assertThat(ended.path("stats").path("participants").asInt()).isEqualTo(1);
            assertThat(strings(ended.path("stats").path("languages"))).containsExactly("en");
            assertThat(ended.path("endedAt").isNull()).isFalse();
            JsonNode endedEvent = c.expect("ended");
            assertThat(endedEvent.path("reason").asString()).isEqualTo("user_end");
            assertThat(endedEvent.path("stats").path("utterances").asInt()).isEqualTo(1);
            assertThat(endedEvent.path("stats").has("durationMs")).isTrue();
            assertThat(c.awaitClose(Duration.ofSeconds(5))).isEqualTo(1000);
            awaitUntil(5000, () -> py.closed);
            assertThat(py.controls).anyMatch(n -> "end".equals(n.path("type").asString()));
        }
        assertThat(registry.find(id)).isNull();

        // 历史：列表、关键词（标题或转写）、模式筛选、转写分页、收藏、删除
        assertThat(body(perform(bearer(get(SESSIONS).param("keyword", "第1句"), token))).path("data").path("total").asLong())
                .isEqualTo(1);
        assertThat(body(perform(bearer(get(SESSIONS).param("keyword", "[en]第1"), token))).path("data").path("total").asLong())
                .as("匹配译文").isEqualTo(1);
        assertThat(body(perform(bearer(get(SESSIONS).param("keyword", "同传收听"), token))).path("data").path("total").asLong())
                .isEqualTo(1);
        assertThat(body(perform(bearer(get(SESSIONS).param("keyword", "不存在"), token))).path("data").path("total").asLong())
                .isZero();
        assertThat(body(perform(bearer(get(SESSIONS).param("mode", "ROOM"), token))).path("data").path("total").asLong())
                .isZero();
        JsonNode segs = body(perform(bearer(get(SESSIONS + "/" + id + "/segments").param("pageSize", "500"), token)))
                .path("data");
        assertThat(segs.path("pageSize").asInt()).isEqualTo(100);
        JsonNode seg = segs.path("records").get(0);
        assertThat(seg.path("translations").path("en").asString()).isEqualTo("[en]第1句");
        assertThat(seg.path("metrics").path("e2eMs").asInt()).isEqualTo(1100);
        assertThat(seg.path("speakerParticipant").asString()).isEqualTo("p1");
        perform(bearer(jsonBody(put(SESSIONS + "/" + id + "/favorite"), Map.of("favorite", true)), token));
        assertThat(body(perform(bearer(get(SESSIONS).param("favorite", "true"), token))).path("data").path("total").asLong())
                .isEqualTo(1);
        assertThat(body(perform(bearer(delete(SESSIONS + "/" + id), token))).path("code").asString()).isEqualTo("00000");
        assertThat(perform(bearer(get(SESSIONS + "/" + id), token)).getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void roomWithThreeLanguagesRoutesAudioByLanguageAndUpdatesTargets() throws Exception {
        String tokenA = newToken();
        String tokenB = newToken();
        JsonNode host = createSession(token, create("ROOM", "cascade", List.of("zh")));
        long id = host.path("sessionId").asLong();
        String code = host.path("roomCode").asString();
        JsonNode a = join(tokenA, code, Map.of("lang", "en", "displayName", "甲"));
        JsonNode b = join(tokenB, code, Map.of("lang", "ja", "displayName", "乙"));
        try (WsTestClient ch = connect(host); WsTestClient ca = connect(a); WsTestClient cb = connect(b)) {
            JsonNode readyB = cb.received("ready").getFirst();
            assertThat(readyB.path("participantId").asString()).isEqualTo("p3");
            assertThat(readyB.path("isHost").asBoolean()).isFalse();
            assertThat(strings(readyB.path("languages"))).containsExactly("ja");
            assertThat(readyB.path("roomCode").asString()).isEqualTo(code);

            MockInterpretServer.Stream py = speak(ch, "s-" + id + "-p1");
            assertThat(py.config.path("mode").asString()).isEqualTo("ROOM");
            assertThat(strings(py.config.path("sourceLangs"))).containsExactly("zh");
            assertThat(strings(py.config.path("targetLangs"))).containsExactly("en", "ja");
            assertThat(py.config.path("tts").asBoolean()).isTrue();

            ch.sendJson(FLUSH);
            for (WsTestClient c : List.of(ch, ca, cb)) {
                JsonNode fin = c.expect("transcript.final");
                assertThat(fin.path("utteranceId").asString()).isEqualTo("p1:1");
                assertThat(fin.path("speaker").path("displayName").asString()).isEqualTo("主持人");
                c.expect("metrics");
                assertThat(c.received("translation.final")).extracting(n -> n.path("lang").asString())
                        .containsExactlyInAnyOrder("en", "ja");
            }
            assertThat(ch.received("audio")).as("发言人不收音频").isEmpty();
            assertThat(ca.received("audio")).extracting(n -> n.path("lang").asString()).containsExactly("en");
            assertThat(cb.received("audio")).extracting(n -> n.path("lang").asString()).containsExactly("ja");

            // 成员发言：目标为其他成员语言（zh、ja）
            MockInterpretServer.Stream pyA = speak(ca, "s-" + id + "-p2");
            assertThat(strings(pyA.config.path("targetLangs"))).containsExactly("zh", "ja");
            assertThat(strings(pyA.config.path("sourceLangs"))).containsExactly("en");

            // 乙离开：主持人与甲的发言流目标更新
            cb.sendJson(Map.of("type", "end"));
            assertThat(cb.awaitClose(Duration.ofSeconds(5))).isEqualTo(1000);
            awaitUntil(5000, () -> py.targets.equals(List.of("en")));
            assertThat(py.controls).anyMatch(n -> "targets".equals(n.path("type").asString()));
            awaitUntil(5000, () -> pyA.targets.equals(List.of("zh")));
            JsonNode afterLeave = ch.next(p -> "participants".equals(p.path("type").asString())
                    && p.path("list").size() == 2, Duration.ofSeconds(5));
            assertThat(afterLeave).isNotNull();

            awaitUntil(5000, () -> segments(id) == 1);
            String translations = jdbcTemplate.queryForObject(
                    "SELECT translations::text FROM biz.interpret_segment WHERE session_id = ?", String.class, id);
            assertThat(translations).contains("\"en\"").contains("\"ja\"");

            // 主持人结束：成员收到 host_left，主持人收到 user_end
            perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
            assertThat(ca.expect("ended").path("reason").asString()).isEqualTo("host_left");
            JsonNode hostEnded = ch.expect("ended");
            assertThat(hostEnded.path("reason").asString()).isEqualTo("user_end");
            assertThat(hostEnded.path("stats").path("participants").asInt()).isEqualTo(3);
            assertThat(strings(hostEnded.path("stats").path("languages"))).containsExactlyInAnyOrder("zh", "en", "ja");
        }
    }

    @Test
    void memberReconnectWithinGraceKeepsIdentity() throws Exception {
        String tokenA = newToken();
        JsonNode host = createSession(token, create("ROOM", "cascade", List.of("zh")));
        long id = host.path("sessionId").asLong();
        String code = host.path("roomCode").asString();
        try (WsTestClient ch = connect(host)) {
            JsonNode a = join(tokenA, code, Map.of("lang", "en"));
            WsTestClient ca = connect(a);
            ca.abort();
            JsonNode offline = ch.next(p -> "participants".equals(p.path("type").asString())
                    && p.path("list").size() == 2 && !p.path("list").get(1).path("online").asBoolean(), Duration.ofSeconds(5));
            assertThat(offline).as("断线成员仍在列表中，online=false").isNotNull();
            JsonNode again = join(tokenA, code, Map.of("lang", "en", "participantId", "p2"));
            assertThat(again.path("participantId").asString()).isEqualTo("p2");
            try (WsTestClient ca2 = connect(again)) {
                assertThat(ca2.received("ready").getFirst().path("participantId").asString()).isEqualTo("p2");
            }
            // 宽限期过后（3 秒）成员被移出
            assertThat(ch.next(p -> "participants".equals(p.path("type").asString()) && p.path("list").size() == 1,
                    Duration.ofSeconds(8))).isNotNull();
            perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
        }
    }

    @Test
    void pythonDisconnectSendsNonFatalErrorAndRebuildsOnce() throws Exception {
        Map<String, Object> req = create("LISTEN", "cascade", List.of("en"));
        req.put("domainHint", "[[drop]]");
        JsonNode vo = createSession(token, req);
        long id = vo.path("sessionId").asLong();
        String streamId = "s-" + id + "-p1";
        try (WsTestClient c = connect(vo)) {
            speak(c, streamId);
            c.sendJson(FLUSH);
            JsonNode err = c.expect("error");
            assertThat(err.path("code").asString()).isEqualTo("C0174");
            assertThat(err.path("fatal").asBoolean()).isFalse();
            assertThat(err.path("message").asString()).contains("正在重连");
            awaitUntil(5000, () -> mockInterpret().connections(streamId) == 2);
            awaitUntil(5000, () -> mockInterpret().latest(streamId).config != null);
            c.sendJson(FLUSH);
            JsonNode fin = c.expect("transcript.final");
            assertThat(fin.path("utteranceId").asString()).isEqualTo("p1:1");
            c.expect("metrics");
            assertThat(c.isClosed()).isFalse();
        }
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
    }

    @Test
    void secondPythonDisconnectDropsStreamUntilNextAudio() throws Exception {
        Map<String, Object> req = create("LISTEN", "cascade", List.of("en"));
        req.put("domainHint", "[[dropalways]]");
        JsonNode vo = createSession(token, req);
        long id = vo.path("sessionId").asLong();
        String streamId = "s-" + id + "-p1";
        int before = registry.activeStreams();
        try (WsTestClient c = connect(vo)) {
            speak(c, streamId);
            assertThat(registry.activeStreams()).isEqualTo(before + 1);
            c.sendJson(FLUSH);
            assertThat(c.expect("error").path("code").asString()).isEqualTo("C0174");
            awaitUntil(5000, () -> mockInterpret().connections(streamId) == 2
                    && mockInterpret().latest(streamId).config != null);
            c.sendJson(FLUSH);
            JsonNode second = c.expect("error");
            assertThat(second.path("code").asString()).isEqualTo("C0174");
            assertThat(second.path("message").asString()).doesNotContain("正在重连");
            awaitUntil(5000, () -> registry.activeStreams() == before);
            Thread.sleep(300);
            assertThat(mockInterpret().connections(streamId)).as("不再自动重建").isEqualTo(2);
        }
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
    }

    @Test
    void segmentIsWrittenAfterTimeoutWhenTargetsAreMissing() throws Exception {
        String tokenA = newToken();
        String tokenB = newToken();
        Map<String, Object> req = create("ROOM", "cascade", List.of("zh"));
        req.put("domainHint", "[[partial]]");
        JsonNode host = createSession(token, req);
        long id = host.path("sessionId").asLong();
        String code = host.path("roomCode").asString();
        join(tokenA, code, Map.of("lang", "en"));
        join(tokenB, code, Map.of("lang", "ja"));
        try (WsTestClient ch = connect(host)) {
            speak(ch, "s-" + id + "-p1");
            ch.sendJson(FLUSH);
            ch.expect("translation.final");
            Thread.sleep(300);
            assertThat(segments(id)).as("ja 译文与指标未到齐，等待超时").isZero();
            awaitUntil(4000, () -> segments(id) == 1);
            Map<String, Object> row = jdbcTemplate.queryForMap(
                    "SELECT translations::text AS t, metrics FROM biz.interpret_segment WHERE session_id = ?", id);
            assertThat(row.get("t")).isEqualTo("{\"en\": \"[en]第1句\"}");
            assertThat(row.get("metrics")).isNull();
            perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
            JsonNode ended = ch.expect("ended");
            assertThat(ended.path("stats").path("avgE2eMs").isNull()).isTrue();
        }
    }

    @Test
    void sessionEndsAutomaticallyAfterAllConnectionsLeave() throws Exception {
        JsonNode vo = createSession(token, create("LISTEN", "cascade", List.of("en")));
        long id = vo.path("sessionId").asLong();
        WsTestClient c = connect(vo);
        c.close();
        awaitUntil(10_000, () -> "ENDED".equals(jdbcTemplate.queryForObject(
                "SELECT status FROM biz.interpret_session WHERE id = ?", String.class, id)));
        assertThat(registry.find(id)).isNull();
        assertThat(jdbcTemplate.queryForObject("SELECT stats->>'utterances' FROM biz.interpret_session WHERE id = ?",
                String.class, id)).isEqualTo("0");
    }

    @Test
    void roomClosesWhenHostLeavesBeyondGrace() throws Exception {
        String tokenA = newToken();
        JsonNode host = createSession(token, create("ROOM", "cascade", List.of("zh")));
        long id = host.path("sessionId").asLong();
        JsonNode a = join(tokenA, host.path("roomCode").asString(), Map.of("lang", "en"));
        WsTestClient ch = connect(host);
        try (WsTestClient ca = connect(a)) {
            ch.abort();
            JsonNode ended = ca.next("ended", Duration.ofSeconds(10));
            assertThat(ended).isNotNull();
            assertThat(ended.path("reason").asString()).isEqualTo("host_left");
            assertThat(ca.awaitClose(Duration.ofSeconds(5))).isEqualTo(1000);
        }
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM biz.interpret_session WHERE id = ?", String.class, id))
                .isEqualTo("ENDED");
    }

    @Test
    void converseForwardsPttAndRoutesByDetectedLanguage() throws Exception {
        JsonNode vo = createSession(token, create("CONVERSE", "cascade", List.of("zh", "en")));
        long id = vo.path("sessionId").asLong();
        String streamId = "s-" + id + "-p1";
        try (WsTestClient c = connect(vo)) {
            c.sendJson(Map.of("type", "ptt", "side", "A"));
            awaitUntil(5000, () -> mockInterpret().latest(streamId) != null && mockInterpret().latest(streamId).config != null);
            MockInterpretServer.Stream py = mockInterpret().latest(streamId);
            assertThat(strings(py.config.path("sourceLangs"))).containsExactly("zh", "en");
            assertThat(strings(py.config.path("targetLangs"))).containsExactly("zh", "en");
            assertThat(py.config.path("converseRouting").asString()).isEqualTo("auto");
            awaitUntil(5000, () -> py.controls.stream().anyMatch(n -> "ptt".equals(n.path("type").asString())
                    && "A".equals(n.path("side").asString())));
            c.sendJson(Map.of("type", "mute", "muted", true));
            awaitUntil(5000, () -> py.controls.stream().anyMatch(n -> "mute".equals(n.path("type").asString())));
            c.sendJson(Map.of("type", "flush", "mockLang", "en"));
            JsonNode tr = c.expect("translation.final");
            assertThat(tr.path("lang").asString()).isEqualTo("zh");
            c.expect("metrics");
            awaitUntil(3000, () -> segments(id) == 1);
            // 主持人发送 end 结束会话
            c.sendJson(Map.of("type", "end"));
            assertThat(c.expect("ended").path("reason").asString()).isEqualTo("user_end");
        }
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM biz.interpret_session WHERE id = ?", String.class, id))
                .isEqualTo("ENDED");
    }

    @Test
    void chatSendsChatConfigAndPersistsAiSpeakerAndForwardsInterrupt() throws Exception {
        // add-ai-avatar-and-landing 2.2 / 2.3
        Map<String, Object> req = create("CHAT", "cascade", List.of("zh", "en"));
        req.put("chatScenario", "restaurant");
        req.put("latencyMode", "fast");
        JsonNode vo = createSession(token, req);
        long id = vo.path("sessionId").asLong();
        try (WsTestClient c = connect(vo)) {
            MockInterpretServer.Stream py = speak(c, "s-" + id + "-p1");
            assertThat(py.config.path("mode").asString()).isEqualTo("CHAT");
            assertThat(strings(py.config.path("sourceLangs"))).containsExactly("zh", "en");
            assertThat(strings(py.config.path("targetLangs"))).isEmpty();
            JsonNode chat = py.config.path("chat");
            assertThat(chat.path("scenario").asString()).isEqualTo("restaurant");
            assertThat(chat.path("myLang").asString()).isEqualTo("zh");
            assertThat(chat.path("aiLang").asString()).isEqualTo("en");
            assertThat(chat.path("persona").asString()).isEqualTo("Lumi");
            assertThat(chat.path("greet").asBoolean()).isTrue();
            assertThat(py.config.path("latencyMode").asString()).isEqualTo("fast");  // improve-speech-playback-latency 5.4

            c.sendJson(FLUSH);
            JsonNode user = c.expect("transcript.final");
            assertThat(user.path("speaker").path("participantId").asString()).isEqualTo("p1");
            JsonNode ai = c.expect("transcript.final");
            assertThat(ai.path("role").asString()).isEqualTo("assistant");
            assertThat(ai.path("utteranceId").asString()).isEqualTo("p1:2");
            assertThat(ai.path("speaker").path("participantId").asString()).isEqualTo("ai");
            assertThat(ai.path("speaker").path("displayName").asString()).isEqualTo("Lumi");
            assertThat(ai.path("speaker").path("lang").asString()).isEqualTo("en");
            assertThat(c.expect("translation.final").path("lang").asString()).isEqualTo("zh");
            assertThat(c.expect("audio").path("lang").asString()).isEqualTo("en");
            c.expect("metrics");
            // AI 句带母语字幕落库，用户句无需等待译文
            awaitUntil(5000, () -> segments(id) == 2);
            assertThat(jdbcTemplate.queryForList("""
                    SELECT speaker_participant FROM biz.interpret_segment WHERE session_id = ? ORDER BY seq""",
                    String.class, id)).containsExactly("p1", "ai");
            assertThat(jdbcTemplate.queryForObject("""
                    SELECT translations->>'zh' FROM biz.interpret_segment
                    WHERE session_id = ? AND speaker_participant = 'ai'""", String.class, id)).isEqualTo("[zh]回复2");

            c.sendJson(Map.of("type", "interrupt"));
            JsonNode interrupted = c.expect("reply.interrupted");
            assertThat(interrupted.path("utteranceId").asString()).isEqualTo("p1:2");
            assertThat(interrupted.path("speaker").path("participantId").asString()).isEqualTo("ai");
        }
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
    }

    @Test
    void chatKeepsMemoryPrivateAndRestoresHistoryWhenPythonRebuilds() throws Exception {
        // improve-prompts-and-context-memory 6.1 / 6.2：memory 只暂存不转发；重建发言流时 config 带回历史与摘要
        Map<String, Object> req = create("CHAT", "cascade", List.of("zh", "en"));
        req.put("domainHint", "[[memory]]");
        JsonNode vo = createSession(token, req);
        long id = vo.path("sessionId").asLong();
        String streamId = "s-" + id + "-p1";
        try (WsTestClient c = connect(vo)) {
            MockInterpretServer.Stream first = speak(c, streamId);
            assertThat(first.config.path("history").isArray()).isTrue();
            assertThat(first.config.path("history")).isEmpty();
            assertThat(first.config.path("chat").path("memory").isNull()).isTrue();
            assertThat(first.config.path("chat").path("greet").asBoolean()).isTrue();
            for (int turn = 0; turn < 2; turn++) {
                c.sendJson(FLUSH);
                c.next(n -> "metrics".equals(n.path("type").asString())
                        && "assistant".equals(n.path("role").asString()), Duration.ofSeconds(8));
            }
            c.sendJson(Map.of("type", "flush", "mockDrop", true));
            assertThat(c.expect("error").path("code").asString()).isEqualTo("C0174");
            awaitUntil(5000, () -> mockInterpret().connections(streamId) == 2
                    && mockInterpret().latest(streamId).config != null);
            JsonNode config = mockInterpret().latest(streamId).config;
            JsonNode history = config.path("history");
            assertThat(history.valueStream().map(h -> h.path("role").asString()).toList())
                    .containsExactly("user", "assistant", "user", "assistant");
            assertThat(history.valueStream().map(h -> h.path("text").asString()).toList())
                    .containsExactly("第1句", "[en]回复2", "第3句", "[en]回复4");
            assertThat(history.get(1).path("lang").asString()).isEqualTo("en");
            assertThat(history.get(1).path("translations").path("zh").asString()).isEqualTo("[zh]回复2");
            assertThat(config.path("chat").path("memory").asString()).isEqualTo("摘要至第4句");
            assertThat(config.path("chat").path("greet").asBoolean()).isFalse();
            assertThat(c.received("memory")).as("memory 事件不转发给浏览器").isEmpty();
        }
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
    }

    @Test
    void chatRestoresHistoryAfterBrowserReconnectsWithinGrace() throws Exception {
        // improve-prompts-and-context-memory 6.2：刷新页面后继续会话，被打断的回复以"已生成部分 + …"恢复
        JsonNode vo = createSession(token, create("CHAT", "cascade", List.of("zh", "en")));
        long id = vo.path("sessionId").asLong();
        String streamId = "s-" + id + "-p1";
        WsTestClient c = connect(vo);
        speak(c, streamId);
        c.sendJson(FLUSH);
        c.next(n -> "metrics".equals(n.path("type").asString())
                && "assistant".equals(n.path("role").asString()), Duration.ofSeconds(8));
        c.sendJson(Map.of("type", "interrupt"));
        c.expect("reply.interrupted");
        c.abort();
        awaitUntil(8000, () -> mockInterpret().latest(streamId).closed);
        JsonNode again = body(perform(bearer(post(SESSIONS + "/" + id + "/ticket"), token))).path("data");
        try (WsTestClient c2 = connect(again)) {
            c2.sendAudio(1280);
            awaitUntil(8000, () -> mockInterpret().connections(streamId) == 2
                    && mockInterpret().latest(streamId).config != null);
            JsonNode config = mockInterpret().latest(streamId).config;
            assertThat(config.path("history").valueStream().map(h -> h.path("text").asString()).toList())
                    .containsExactly("第1句", "AI 回复…");
            assertThat(config.path("chat").path("greet").asBoolean()).isFalse();
            assertThat(config.path("chat").path("memory").isNull()).isTrue();
        }
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
    }

    @Test
    void discardedUtteranceIsBroadcastButNeitherPersistedNorRestored() throws Exception {
        // improve-speech-endpointing-and-live-ux 3.1：语气词 / 噪声被撤回；holdMs 随指标落库
        JsonNode vo = createSession(token, create("LISTEN", "cascade", List.of("en")));
        long id = vo.path("sessionId").asLong();
        String streamId = "s-" + id + "-p1";
        try (WsTestClient c = connect(vo)) {
            speak(c, streamId);
            c.sendJson(Map.of("type", "flush", "mockDiscard", true));
            JsonNode hold = c.expect("transcript.partial");
            assertThat(hold.path("hold").asBoolean()).isTrue();
            JsonNode discard = c.expect("transcript.discard");
            assertThat(discard.path("utteranceId").asString()).isEqualTo("p1:1");
            assertThat(discard.path("speaker").path("participantId").asString()).isEqualTo("p1");
            c.sendJson(FLUSH);
            assertThat(c.expect("metrics").path("holdMs").asInt()).isEqualTo(20);
            awaitUntil(5000, () -> segments(id) == 1);
            assertThat(jdbcTemplate.queryForObject("""
                    SELECT metrics->>'holdMs' FROM biz.interpret_segment WHERE session_id = ?""", String.class, id))
                    .isEqualTo("20");
            c.sendJson(Map.of("type", "flush", "mockDrop", true));
            assertThat(c.expect("error").path("code").asString()).isEqualTo("C0174");
            awaitUntil(5000, () -> mockInterpret().connections(streamId) == 2
                    && mockInterpret().latest(streamId).config != null);
            JsonNode history = mockInterpret().latest(streamId).config.path("history");
            assertThat(history.valueStream().map(h -> h.path("text").asString()).toList()).containsExactly("第2句");
        }
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
        assertThat(segments(id)).isEqualTo(1);
    }

    @Test
    void chatYieldWithdrawsPersistedReply() throws Exception {
        // improve-speech-endpointing-and-live-ux 3.1：AI 回复让位后历史中没有该回复
        JsonNode vo = createSession(token, create("CHAT", "cascade", List.of("zh", "en")));
        long id = vo.path("sessionId").asLong();
        try (WsTestClient c = connect(vo)) {
            speak(c, "s-" + id + "-p1");
            c.sendJson(FLUSH);
            c.next(n -> "metrics".equals(n.path("type").asString())
                    && "assistant".equals(n.path("role").asString()), Duration.ofSeconds(8));
            awaitUntil(5000, () -> segments(id) == 2);
            c.sendJson(Map.of("type", "interrupt", "yield", true));
            JsonNode discard = c.expect("transcript.discard");
            assertThat(discard.path("utteranceId").asString()).isEqualTo("p1:2");
            assertThat(discard.path("role").asString()).isEqualTo("assistant");
            awaitUntil(5000, () -> segments(id) == 1);
            assertThat(mockInterpret().latest("s-" + id + "-p1").controls)
                    .anyMatch(n -> "interrupt".equals(n.path("type").asString()) && n.path("yield").asBoolean());
        }
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
        assertThat(jdbcTemplate.queryForList("""
                SELECT speaker_participant FROM biz.interpret_segment WHERE session_id = ?""", String.class, id))
                .containsExactly("p1");
    }

    @Test
    void listenRebuildCarriesRecentUtterancesWithTranslations() throws Exception {
        // improve-prompts-and-context-memory 6.2：同传重建发言流时 history 带原文与各语言译文
        JsonNode vo = createSession(token, create("LISTEN", "cascade", List.of("en")));
        long id = vo.path("sessionId").asLong();
        String streamId = "s-" + id + "-p1";
        try (WsTestClient c = connect(vo)) {
            speak(c, streamId);
            c.sendJson(FLUSH);
            c.expect("metrics");
            c.sendJson(Map.of("type", "flush", "mockDrop", true));
            assertThat(c.expect("error").path("code").asString()).isEqualTo("C0174");
            awaitUntil(5000, () -> mockInterpret().connections(streamId) == 2
                    && mockInterpret().latest(streamId).config != null);
            JsonNode history = mockInterpret().latest(streamId).config.path("history");
            assertThat(history).hasSize(1);
            assertThat(history.get(0).path("role").asString()).isEqualTo("user");
            assertThat(history.get(0).path("lang").asString()).isEqualTo("zh");
            assertThat(history.get(0).path("text").asString()).isEqualTo("第1句");
            assertThat(history.get(0).path("translations").path("en").asString()).isEqualTo("[en]第1句");
            assertThat(mockInterpret().latest(streamId).config.has("chat")).isFalse();
        }
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
    }

    @Test
    void interruptIsIgnoredOutsideChat() throws Exception {
        JsonNode vo = createSession(token, create("LISTEN", "cascade", List.of("en")));
        long id = vo.path("sessionId").asLong();
        try (WsTestClient c = connect(vo)) {
            MockInterpretServer.Stream py = speak(c, "s-" + id + "-p1");
            c.sendJson(Map.of("type", "interrupt"));
            assertThat(c.next("error", Duration.ofMillis(800))).isNull();
            c.sendJson(FLUSH);
            c.expect("metrics");
            assertThat(py.controls).noneMatch(n -> "interrupt".equals(n.path("type").asString()));
        }
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
    }

    @Test
    void streamLimitAndPythonFatalErrorAndBadControlFrames() throws Exception {
        Map<String, Object> req = create("LISTEN", "cascade", List.of("en"));
        req.put("domainHint", "[[reject]]");
        JsonNode vo = createSession(token, req);
        long id = vo.path("sessionId").asLong();
        try (WsTestClient c = connect(vo)) {
            // 全局并发上限
            AtomicInteger active = (AtomicInteger) ReflectionTestUtils.getField(registry, "activeStreams");
            int saved = active.get();
            active.set(20);
            try {
                c.sendAudio(1280);
                JsonNode limit = c.expect("error");
                assertThat(limit.path("code").asString()).isEqualTo("A0212");
                assertThat(limit.path("fatal").asBoolean()).isFalse();
            } finally {
                active.set(saved);
            }
            Thread.sleep(3100);
            // Python 报告致命错误：原样转发，不再发送 C0174 也不重建
            c.sendAudio(1280);
            JsonNode fatal = c.expect("error");
            assertThat(fatal.path("code").asString()).isEqualTo("A0212");
            assertThat(fatal.path("fatal").asBoolean()).isTrue();
            assertThat(c.next("error", Duration.ofMillis(800))).isNull();
            assertThat(mockInterpret().connections("s-" + id + "-p1")).isEqualTo(1);

            c.sendJson(Map.of("type", "dance"));
            assertThat(c.expect("error").path("code").asString()).isEqualTo("A0410");
            c.sendText("not json");
            assertThat(c.expect("error").path("message").asString()).contains("JSON");
        }
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
    }

    @Test
    void newConnectionReplacesOldOne() throws Exception {
        JsonNode vo = createSession(token, create("LISTEN", "cascade", List.of("en")));
        long id = vo.path("sessionId").asLong();
        try (WsTestClient first = connect(vo)) {
            JsonNode t = body(perform(bearer(post(SESSIONS + "/" + id + "/ticket"), token))).path("data");
            try (WsTestClient second = connect(t)) {
                assertThat(first.awaitClose(Duration.ofSeconds(5))).isEqualTo(4409);
                second.sendText("{\"type\":\"ping\"}");
                second.expect("pong");
            }
        }
        perform(bearer(post(SESSIONS + "/" + id + "/end"), token));
    }
}
