package com.xjl.tl.module.session;

import com.xjl.tl.support.SseTestClient.Event;
import com.xjl.tl.support.SseTestClient.Session;
import com.xjl.tl.support.StreamingTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 会话测试公共部分：每个用例一个新用户，创建会话、发起会话内翻译等辅助方法。
 */
abstract class SessionTestSupport extends StreamingTestBase {

    protected static final Duration WAIT = Duration.ofSeconds(10);

    protected String token;
    protected long userId;

    @BeforeEach
    void sessionUser() throws Exception {
        String name = registerUser(uniqueName("ss"), "Passw0rd!");
        token = accessToken(name, "Passw0rd!");
        userId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, name);
    }

    protected long createSession(Map<String, Object> body) throws Exception {
        MvcResult r = postJson("/api/translate/sessions", body, token);
        JsonNode b = body(r);
        if (r.getResponse().getStatus() != 200) {
            throw new IllegalStateException("创建会话失败：" + b);
        }
        return b.path("data").path("id").asLong();
    }

    protected long createSession() throws Exception {
        return createSession(Map.of("targetLang", "zh"));
    }

    protected JsonNode detail(long sessionId) throws Exception {
        return body(perform(bearer(get("/api/translate/sessions/" + sessionId), token))).path("data");
    }

    protected Map<String, Object> turnBody(long sessionId, String text) {
        Map<String, Object> m = new HashMap<>();
        m.put("text", text);
        m.put("sessionId", sessionId);
        return m;
    }

    /** 读取完整事件流（去掉心跳注释）。 */
    protected static List<Event> events(Session s) throws InterruptedException {
        return s.readAll(WAIT).stream().filter(e -> !e.isComment()).toList();
    }

    /** 会话内翻译一轮，返回 final 的 data。 */
    protected JsonNode turn(long sessionId, String text) throws Exception {
        try (Session s = sse().open(token, turnBody(sessionId, text))) {
            List<Event> events = events(s);
            Event last = events.getLast();
            if (!"final".equals(last.event())) {
                throw new IllegalStateException("翻译未以 final 结束：" + events);
            }
            return jsonMapper.readTree(last.data());
        }
    }

    protected JsonNode data(Event e) {
        return jsonMapper.readTree(e.data());
    }
}
