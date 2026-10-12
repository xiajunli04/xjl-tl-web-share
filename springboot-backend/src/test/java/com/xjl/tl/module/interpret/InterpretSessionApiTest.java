package com.xjl.tl.module.interpret;

import com.xjl.tl.module.interpret.room.RoomRegistry;
import com.xjl.tl.module.interpret.service.WsTicketService;
import com.xjl.tl.support.MockAiServer;
import com.xjl.tl.support.StreamingTestBase;
import com.xjl.tl.support.WsTestClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.net.http.WebSocketHandshakeException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * live-interpretation「同传会话与模式」「多语会议室」「实时音频通道」（握手部分）/ tasks 6.5：创建校验、单用户单活跃、
 * 房间码与加入上限、票据（一次性、过期）、握手 Origin 与票据校验、越权 A0404。
 */
class InterpretSessionApiTest extends StreamingTestBase {

    static final String SESSIONS = "/api/interpret/sessions";

    @Autowired
    private RoomRegistry registry;
    @Autowired
    private WsTicketService ticketService;

    private String token;
    private long userId;

    @BeforeEach
    void user() throws Exception {
        String name = registerUser(uniqueName("ip"), "Passw0rd!");
        token = accessToken(name, "Passw0rd!");
        userId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, name);
    }

    static Map<String, Object> create(String mode, String engine, List<String> languages) {
        Map<String, Object> m = new HashMap<>();
        m.put("mode", mode);
        m.put("engine", engine);
        m.put("languages", languages);
        return m;
    }

    private String newToken() throws Exception {
        String name = registerUser(uniqueName("ipo"), "Passw0rd!");
        return accessToken(name, "Passw0rd!");
    }

    private void end(long id, String tk) throws Exception {
        perform(bearer(post(SESSIONS + "/" + id + "/end"), tk));
    }

    @Test
    void createListenSessionReturnsTicketAndActiveRow() throws Exception {
        Map<String, Object> req = create("LISTEN", null, List.of("zh"));
        req.put("sourceHints", List.of("en", "ja"));
        req.put("domainHint", "技术发布会");
        JsonNode r = body(postJson(SESSIONS, req, token));
        assertThat(r.path("code").asString()).isEqualTo("00000");
        JsonNode d = r.path("data");
        long id = d.path("sessionId").asLong();
        assertThat(d.path("participantId").asString()).isEqualTo("p1");
        assertThat(d.path("isHost").asBoolean()).isTrue();
        assertThat(d.path("engine").asString()).isEqualTo("cascade");
        assertThat(d.path("mode").asString()).isEqualTo("LISTEN");
        assertThat(d.path("languages").get(0).asString()).isEqualTo("zh");
        assertThat(d.path("roomCode").isNull()).isTrue();
        assertThat(d.path("wsUrl").asString()).isEqualTo("/ws/interpret");
        String ticket = d.path("wsTicket").asString();
        assertThat(ticket).hasSize(43);
        Long ttl = redis.getExpire("ws:ticket:" + ticket);
        assertThat(ttl).isBetween(1L, 60L);

        Map<String, Object> row = jdbcTemplate.queryForMap("SELECT * FROM biz.interpret_session WHERE id = ?", id);
        assertThat(row.get("status")).isEqualTo("ACTIVE");
        assertThat(row.get("user_id")).isEqualTo(userId);
        assertThat(row.get("title")).isEqualTo("同传收听 · 中文");
        JsonNode detail = body(perform(bearer(get(SESSIONS + "/" + id), token))).path("data");
        assertThat(detail.path("options").path("sourceHints")).hasSize(2);
        assertThat(detail.path("options").path("domainHint").asString()).isEqualTo("技术发布会");
        assertThat(detail.path("options").path("tts").asBoolean()).isTrue();
        assertThat(detail.path("stats").isNull()).isTrue();

        // 单用户单活跃
        MvcResult busy = postJson(SESSIONS, create("CONVERSE", "cascade", List.of("zh", "en")), token);
        assertThat(busy.getResponse().getStatus()).isEqualTo(409);
        assertThat(body(busy).path("code").asString()).isEqualTo("A0214");
        // 冲突时带上进行中的会话，供前端提供「继续 / 结束并重新开始」
        assertThat(body(busy).path("data").path("id").asLong()).isEqualTo(id);
        assertThat(body(busy).path("data").path("mode").asString()).isEqualTo("LISTEN");
        // 刷新页面后据此恢复
        JsonNode active = body(perform(bearer(get(SESSIONS + "/active"), token))).path("data");
        assertThat(active.path("id").asLong()).isEqualTo(id);
        assertThat(active.path("status").asString()).isEqualTo("ACTIVE");

        // 结束后可再创建
        JsonNode ended = body(perform(bearer(post(SESSIONS + "/" + id + "/end"), token))).path("data");
        assertThat(ended.path("status").asString()).isEqualTo("ENDED");
        assertThat(ended.path("stats").path("utterances").asInt()).isZero();
        assertThat(ended.path("durationMs").asInt()).isGreaterThanOrEqualTo(0);
        JsonNode conv = body(postJson(SESSIONS, create("CONVERSE", "cascade", List.of("zh", "en")), token)).path("data");
        assertThat(jdbcTemplate.queryForObject("SELECT title FROM biz.interpret_session WHERE id = ?", String.class,
                conv.path("sessionId").asLong())).isEqualTo("双向对话 · 中文 ⇄ 英语");
        assertThat(jdbcTemplate.queryForObject("SELECT options->>'converseRouting' FROM biz.interpret_session WHERE id = ?",
                String.class, conv.path("sessionId").asLong())).isEqualTo("auto");
        end(conv.path("sessionId").asLong(), token);
        assertThat(body(perform(bearer(get(SESSIONS + "/active"), token))).path("data").isNull()).isTrue();
    }

    @Test
    void createValidation() throws Exception {
        record Case(Map<String, Object> req, int status, String code) {
        }
        Map<String, Object> s2sAuto = create("CONVERSE", "qwen-livetranslate", List.of("zh", "en"));
        s2sAuto.put("converseRouting", "auto");
        List<Case> cases = new ArrayList<>(List.of(
                new Case(create("CONVERSE", "cascade", List.of("en", "en")), 400, "A0410"),
                new Case(create("CONVERSE", "cascade", List.of("en")), 400, "A0410"),
                new Case(create("LISTEN", "cascade", List.of("en", "zh")), 400, "A0410"),
                new Case(create("ROOM", "cascade", List.of()), 400, "A0410"),
                new Case(create("ROOM", "cascade", List.of("zh", "en")), 400, "A0410"),
                new Case(create("WATCH", "cascade", List.of("zh")), 400, "A0410"),
                new Case(create("LISTEN", "cascade", List.of("xx")), 400, "A0420"),
                new Case(s2sAuto, 400, "A0410"),
                new Case(create("LISTEN", "openai-realtime", List.of("zh")), 503, "C0173"),
                new Case(create("LISTEN", "doubao-ast", List.of("zh")), 503, "C0173"),
                // 千问引擎的语言列表不含阿拉伯语
                new Case(create("LISTEN", "qwen-livetranslate", List.of("ar")), 400, "A0410")));
        Map<String, Object> badModel = create("LISTEN", "cascade", List.of("zh"));
        badModel.put("modelConfigId", 999_999);
        cases.add(new Case(badModel, 400, "C0130"));
        Map<String, Object> foreignGlossary = create("LISTEN", "cascade", List.of("zh"));
        foreignGlossary.put("glossaryIds", List.of(987_654));
        cases.add(new Case(foreignGlossary, 404, "A0404"));
        for (Case c : cases) {
            MvcResult r = postJson(SESSIONS, c.req(), token);
            assertThat(r.getResponse().getStatus()).as("%s", c.req()).isEqualTo(c.status());
            assertThat(body(r).path("code").asString()).as("%s", c.req()).isEqualTo(c.code());
        }
        MvcResult unavailable = postJson(SESSIONS, create("LISTEN", "openai-realtime", List.of("zh")), token);
        assertThat(body(unavailable).path("message").asString()).contains("未配置 OpenAI 实时同传");
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM biz.interpret_session WHERE user_id = ?",
                Integer.class, userId)).isZero();

        // S2S 双向对话缺省为按键说话
        JsonNode ok = body(postJson(SESSIONS, create("CONVERSE", "qwen-livetranslate", List.of("zh", "en")), token)).path("data");
        assertThat(jdbcTemplate.queryForObject("SELECT options->>'converseRouting' FROM biz.interpret_session WHERE id = ?",
                String.class, ok.path("sessionId").asLong())).isEqualTo("ptt");
        end(ok.path("sessionId").asLong(), token);
    }

    @Test
    void createChatSessionValidatesEngineAndScenario() throws Exception {
        // add-ai-avatar-and-landing 2.1：CHAT 只允许级联引擎、场景合法、语言恰为 [我的语言, 对话语言]
        Map<String, Object> s2s = create("CHAT", "qwen-livetranslate", List.of("zh", "en"));
        MvcResult r1 = postJson(SESSIONS, s2s, token);
        assertThat(r1.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(r1).path("code").asString()).isEqualTo("A0410");
        assertThat(body(r1).path("message").asString()).contains("AI 对话仅支持平台级联或实时语音模型");
        Map<String, Object> badScenario = create("CHAT", "cascade", List.of("zh", "en"));
        badScenario.put("chatScenario", "karaoke");
        assertThat(body(postJson(SESSIONS, badScenario, token)).path("code").asString()).isEqualTo("A0410");
        assertThat(body(postJson(SESSIONS, create("CHAT", "cascade", List.of("zh")), token)).path("code").asString())
                .isEqualTo("A0410");

        Map<String, Object> ok = create("CHAT", null, List.of("zh", "en"));
        ok.put("chatScenario", "travel");
        JsonNode d = body(postJson(SESSIONS, ok, token)).path("data");
        long id = d.path("sessionId").asLong();
        assertThat(d.path("mode").asString()).isEqualTo("CHAT");
        assertThat(d.path("engine").asString()).isEqualTo("cascade");
        assertThat(jdbcTemplate.queryForObject("SELECT options->>'chatScenario' FROM biz.interpret_session WHERE id = ?",
                String.class, id)).isEqualTo("travel");
        assertThat(jdbcTemplate.queryForObject("SELECT title FROM biz.interpret_session WHERE id = ?", String.class, id))
                .startsWith("AI 对话");
        end(id, token);

        assertThat(jdbcTemplate.queryForObject("SELECT options->>'latencyMode' FROM biz.interpret_session WHERE id = ?",
                String.class, id)).isEqualTo("balanced");

        // 两种语言可以相同（用母语聊天），场景缺省 free
        JsonNode same = body(postJson(SESSIONS, create("CHAT", "cascade", List.of("en", "en")), token)).path("data");
        assertThat(jdbcTemplate.queryForObject("SELECT options->>'chatScenario' FROM biz.interpret_session WHERE id = ?",
                String.class, same.path("sessionId").asLong())).isEqualTo("free");
        end(same.path("sessionId").asLong(), token);
    }

    @Test
    void chatWithRealtimeVoiceModelAndLatencyMode() throws Exception {
        // improve-speech-playback-latency 5.4：CHAT 可选实时语音模型；其他模式拒绝；响应速度只能是 balanced / fast
        JsonNode d = body(postJson(SESSIONS, create("CHAT", "realtime-chat", List.of("zh", "en")), token)).path("data");
        long id = d.path("sessionId").asLong();
        assertThat(d.path("engine").asString()).isEqualTo("realtime-chat");
        end(id, token);

        MvcResult listen = postJson(SESSIONS, create("LISTEN", "realtime-chat", List.of("en")), token);
        assertThat(listen.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(listen).path("message").asString()).contains("实时语音模型只用于 AI 对话");

        Map<String, Object> turbo = create("LISTEN", "cascade", List.of("en"));
        turbo.put("latencyMode", "turbo");
        assertThat(body(postJson(SESSIONS, turbo, token)).path("code").asString()).isEqualTo("A0410");

        Map<String, Object> fast = create("LISTEN", "cascade", List.of("en"));
        fast.put("latencyMode", "fast");
        long fastId = body(postJson(SESSIONS, fast, token)).path("data").path("sessionId").asLong();
        assertThat(jdbcTemplate.queryForObject("SELECT options->>'latencyMode' FROM biz.interpret_session WHERE id = ?",
                String.class, fastId)).isEqualTo("fast");
        end(fastId, token);
    }

    @Test
    void realtimeVoiceModelUnavailableReturnsC0173() throws Exception {
        MockAiServer.realtimeChatAvailable = false;
        try {
            perform(bearer(get("/api/speech/engines").param("refresh", "true"), token));  // 刷新 Spring 的引擎缓存
            MvcResult r = postJson(SESSIONS, create("CHAT", "realtime-chat", List.of("zh", "en")), token);
            assertThat(r.getResponse().getStatus()).isEqualTo(503);
            assertThat(body(r).path("code").asString()).isEqualTo("C0173");
            assertThat(body(r).path("message").asString()).contains("未配置实时语音对话模型");
        } finally {
            MockAiServer.realtimeChatAvailable = true;
            perform(bearer(get("/api/speech/engines").param("refresh", "true"), token));
        }
    }

    @Test
    void roomCodeJoinAndLimits() throws Exception {
        // 先准备好用户：加入后未连接的成员只保留宽限期（测试中 3 秒），主持人未连接超过宽限期房间也会关闭
        List<String> tokens = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            tokens.add(newToken());
        }
        java.util.Iterator<String> pool = tokens.iterator();
        JsonNode host = body(postJson(SESSIONS, create("ROOM", "cascade", List.of("zh")), token)).path("data");
        long id = host.path("sessionId").asLong();
        String code = host.path("roomCode").asString();
        assertThat(code).hasSize(6).matches("[" + RoomRegistry.CODE_ALPHABET + "]{6}");
        assertThat(jdbcTemplate.queryForObject("SELECT title FROM biz.interpret_session WHERE id = ?", String.class, id))
                .isEqualTo("会议室 " + code);

        MvcResult missing = postJson("/api/interpret/rooms/ZZZZZZ/join", Map.of("lang", "en"), token);
        assertThat(missing.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(missing).path("code").asString()).isEqualTo("A0452");

        // 成员加入（房间码不区分大小写），显示名缺省为用户名
        String memberToken = pool.next();
        JsonNode m = body(postJson("/api/interpret/rooms/" + code.toLowerCase() + "/join",
                Map.of("lang", "en"), memberToken)).path("data");
        assertThat(m.path("participantId").asString()).isEqualTo("p2");
        assertThat(m.path("isHost").asBoolean()).isFalse();
        assertThat(m.path("languages").get(0).asString()).isEqualTo("en");
        assertThat(m.path("roomCode").asString()).isEqualTo(code);
        // 同一用户再次加入恢复原身份
        JsonNode again = body(postJson("/api/interpret/rooms/" + code + "/join",
                Map.of("lang", "en", "participantId", "p2", "displayName", "甲"), memberToken)).path("data");
        assertThat(again.path("participantId").asString()).isEqualTo("p2");
        // 主持人凭房间码加入仍是主持人
        assertThat(body(postJson("/api/interpret/rooms/" + code + "/join", Map.of("lang", "zh"), token))
                .path("data").path("isHost").asBoolean()).isTrue();

        // 语言数上限：级联 6 种（zh、en 已有，再加 4 种可以，第 7 种拒绝）
        List<String> langs = List.of("ja", "ko", "fr", "de");
        for (String l : langs) {
            assertThat(body(postJson("/api/interpret/rooms/" + code + "/join", Map.of("lang", l), pool.next()))
                    .path("code").asString()).isEqualTo("00000");
        }
        MvcResult tooManyLangs = postJson("/api/interpret/rooms/" + code + "/join", Map.of("lang", "es"), pool.next());
        assertThat(tooManyLangs.getResponse().getStatus()).isEqualTo(409);
        assertThat(body(tooManyLangs).path("code").asString()).isEqualTo("A0451");
        // 人数上限 8：已有 6 人，再加 2 人后第 9 人拒绝
        for (int i = 0; i < 2; i++) {
            assertThat(body(postJson("/api/interpret/rooms/" + code + "/join", Map.of("lang", "en"), pool.next()))
                    .path("code").asString()).isEqualTo("00000");
        }
        MvcResult full = postJson("/api/interpret/rooms/" + code + "/join", Map.of("lang", "en"), pool.next());
        assertThat(full.getResponse().getStatus()).isEqualTo(409);
        assertThat(body(full).path("code").asString()).isEqualTo("A0451");
        assertThat(body(full).path("message").asString()).contains("8");

        // 结束后房间关闭
        end(id, token);
        assertThat(body(postJson("/api/interpret/rooms/" + code + "/join", Map.of("lang", "en"), pool.next()))
                .path("code").asString()).isEqualTo("A0452");
    }

    @Test
    void s2sRoomAllowsAtMostFourLanguages() throws Exception {
        List<String> tokens = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            tokens.add(newToken());
        }
        JsonNode host = body(postJson(SESSIONS, create("ROOM", "qwen-livetranslate", List.of("zh")), token)).path("data");
        String code = host.path("roomCode").asString();
        assertThat(body(postJson("/api/interpret/rooms/" + code + "/join", Map.of("lang", "ar"), tokens.get(0)))
                .path("code").asString()).as("引擎不支持的语言").isEqualTo("A0410");
        assertThat(body(postJson("/api/interpret/rooms/" + code + "/join", Map.of("lang", "xx"), tokens.get(0)))
                .path("code").asString()).isEqualTo("A0420");
        for (int i = 0; i < 3; i++) {
            assertThat(body(postJson("/api/interpret/rooms/" + code + "/join", Map.of("lang", List.of("en", "ja", "ko").get(i)),
                    tokens.get(i + 1))).path("code").asString()).isEqualTo("00000");
        }
        MvcResult fifth = postJson("/api/interpret/rooms/" + code + "/join", Map.of("lang", "fr"), tokens.get(4));
        assertThat(body(fifth).path("code").asString()).isEqualTo("A0451");
        assertThat(body(fifth).path("message").asString()).contains("4");
        // 已有语言的新成员可以加入
        assertThat(body(postJson("/api/interpret/rooms/" + code + "/join", Map.of("lang", "en"), tokens.get(5)))
                .path("code").asString()).isEqualTo("00000");
        end(host.path("sessionId").asLong(), token);
    }

    @Test
    void ticketReissueAndOwnership() throws Exception {
        JsonNode created = body(postJson(SESSIONS, create("LISTEN", "cascade", List.of("en")), token)).path("data");
        long id = created.path("sessionId").asLong();
        JsonNode t = body(perform(bearer(post(SESSIONS + "/" + id + "/ticket"), token))).path("data");
        assertThat(t.path("participantId").asString()).isEqualTo("p1");
        assertThat(t.path("wsTicket").asString()).isNotEqualTo(created.path("wsTicket").asString());

        String other = newToken();
        for (MvcResult r : List.of(
                perform(bearer(get(SESSIONS + "/" + id), other)),
                perform(bearer(get(SESSIONS + "/" + id + "/segments"), other)),
                perform(bearer(post(SESSIONS + "/" + id + "/ticket"), other)),
                perform(bearer(post(SESSIONS + "/" + id + "/end"), other)),
                perform(bearer(jsonBody(put(SESSIONS + "/" + id + "/favorite"), Map.of("favorite", true)), other)),
                perform(bearer(delete(SESSIONS + "/" + id), other)))) {
            assertThat(r.getResponse().getStatus()).isEqualTo(404);
            assertThat(body(r).path("code").asString()).isEqualTo("A0404");
        }
        assertThat(body(perform(bearer(get(SESSIONS), other))).path("data").path("total").asLong()).isZero();

        end(id, token);
        MvcResult afterEnd = perform(bearer(post(SESSIONS + "/" + id + "/ticket"), token));
        assertThat(afterEnd.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(afterEnd).path("code").asString()).isEqualTo("A0452");
        // 结束是幂等的
        assertThat(body(perform(bearer(post(SESSIONS + "/" + id + "/end"), token))).path("data").path("status").asString())
                .isEqualTo("ENDED");
    }

    @Test
    void staleActiveSessionWithoutRoomIsEndedOnNextCreate() throws Exception {
        long stale = jdbcTemplate.queryForObject("""
                INSERT INTO biz.interpret_session (user_id, mode, engine, languages, status, title)
                VALUES (?, 'LISTEN', 'cascade', '["en"]'::jsonb, 'ACTIVE', '残留') RETURNING id""", Long.class, userId);
        MvcResult ticket = perform(bearer(post(SESSIONS + "/" + stale + "/ticket"), token));
        assertThat(body(ticket).path("code").asString()).isEqualTo("A0452");
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM biz.interpret_session WHERE id = ?", String.class, stale))
                .isEqualTo("ENDED");

        long stale2 = jdbcTemplate.queryForObject("""
                INSERT INTO biz.interpret_session (user_id, mode, engine, languages, status, title)
                VALUES (?, 'LISTEN', 'cascade', '["en"]'::jsonb, 'ACTIVE', '残留2') RETURNING id""", Long.class, userId);
        JsonNode created = body(postJson(SESSIONS, create("LISTEN", "cascade", List.of("en")), token));
        assertThat(created.path("code").asString()).isEqualTo("00000");
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM biz.interpret_session WHERE id = ?", String.class, stale2))
                .isEqualTo("ENDED");
        end(created.path("data").path("sessionId").asLong(), token);
    }

    // ---------------- 握手 ----------------

    @Test
    void handshakeRejectsInvalidTicketWithA0453AndForeignOriginWith403() throws Exception {
        MvcResult bad = perform(get("/ws/interpret").param("ticket", "not-a-ticket")
                .header("Origin", WsTestClient.ORIGIN).header("Upgrade", "websocket").header("Connection", "Upgrade")
                .header("Sec-WebSocket-Version", "13").header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="));
        assertThat(bad.getResponse().getStatus()).isEqualTo(401);
        assertThat(body(bad).path("code").asString()).isEqualTo("A0453");

        JsonNode created = body(postJson(SESSIONS, create("LISTEN", "cascade", List.of("en")), token)).path("data");
        String ticket = created.path("wsTicket").asString();
        MvcResult badOrigin = perform(get("/ws/interpret").param("ticket", ticket)
                .header("Origin", "http://evil.example").header("Upgrade", "websocket").header("Connection", "Upgrade")
                .header("Sec-WebSocket-Version", "13").header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="));
        assertThat(badOrigin.getResponse().getStatus()).isEqualTo(403);
        assertThat(redis.hasKey("ws:ticket:" + ticket)).as("来源不合法时不消耗票据").isTrue();
        // 前端同源代理（局域网访问）会去掉 Origin：不带 Origin 时只校验票据
        MvcResult noOrigin = perform(get("/ws/interpret").param("ticket", "not-a-ticket").header("Upgrade", "websocket")
                .header("Connection", "Upgrade").header("Sec-WebSocket-Version", "13")
                .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="));
        assertThat(noOrigin.getResponse().getStatus()).isEqualTo(401);
        assertThat(body(noOrigin).path("code").asString()).isEqualTo("A0453");
        end(created.path("sessionId").asLong(), token);
    }

    @Test
    void ticketIsSingleUseAndExpires() throws Exception {
        JsonNode created = body(postJson(SESSIONS, create("LISTEN", "cascade", List.of("en")), token)).path("data");
        long id = created.path("sessionId").asLong();
        String ticket = created.path("wsTicket").asString();
        try (WsTestClient c = WsTestClient.connect(port, ticket)) {
            JsonNode ready = c.expect("ready");
            assertThat(ready.path("sessionId").asLong()).isEqualTo(id);
            assertThat(ready.path("isHost").asBoolean()).isTrue();
            assertThat(redis.hasKey("ws:ticket:" + ticket)).isFalse();
            // 重复使用
            assertThatThrownBy(() -> WsTestClient.connect(port, ticket))
                    .isInstanceOf(CompletionException.class)
                    .cause().isInstanceOf(WebSocketHandshakeException.class)
                    .satisfies(e -> assertThat(((WebSocketHandshakeException) e).getResponse().statusCode()).isEqualTo(401));
        }
        // 过期
        String expiring = body(perform(bearer(post(SESSIONS + "/" + id + "/ticket"), token))).path("data")
                .path("wsTicket").asString();
        redis.expire("ws:ticket:" + expiring, Duration.ofMillis(1));
        Thread.sleep(50);
        assertThatThrownBy(() -> WsTestClient.connect(port, expiring))
                .cause().isInstanceOf(WebSocketHandshakeException.class)
                .satisfies(e -> assertThat(((WebSocketHandshakeException) e).getResponse().statusCode()).isEqualTo(401));
        assertThat(ticketService.consume(null)).isNull();
        assertThat(ticketService.consume("x".repeat(200))).isNull();
        redis.opsForValue().set("ws:ticket:broken", "{not json");
        assertThat(ticketService.consume("broken")).isNull();
        end(id, token);
    }

    @Test
    void ticketForEndedSessionClosesWithFatalError() throws Exception {
        JsonNode created = body(postJson(SESSIONS, create("LISTEN", "cascade", List.of("en")), token)).path("data");
        long id = created.path("sessionId").asLong();
        String ticket = created.path("wsTicket").asString();
        end(id, token);
        try (WsTestClient c = WsTestClient.connect(port, ticket)) {
            JsonNode err = c.expect("error");
            assertThat(err.path("code").asString()).isEqualTo("A0452");
            assertThat(err.path("fatal").asBoolean()).isTrue();
            assertThat(c.awaitClose(Duration.ofSeconds(5))).isEqualTo(4404);
        }
        assertThat(registry.find(id)).isNull();
    }
}
