package com.xjl.tl.module.insight;

import com.xjl.tl.support.SseTestClient.Event;
import com.xjl.tl.support.SseTestClient.Session;
import com.xjl.tl.support.StreamingTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * translation-insights / tasks 6.2：解读 JSON 代理、追问 SSE 转发、原文过长 A0410、限流复用翻译计数、
 * 与历史接口 /api/translations/{id} 的路径共存。
 */
class InsightApiTest extends StreamingTestBase {

    private static final String BASE = "/api/translations/insights";
    private static final Duration WAIT = Duration.ofSeconds(10);

    private String token;
    private long userId;

    @BeforeEach
    void user() throws Exception {
        String name = registerUser(uniqueName("in"), "Passw0rd!");
        token = accessToken(name, "Passw0rd!");
        userId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, name);
    }

    private Map<String, Object> request(String source) {
        Map<String, Object> m = new HashMap<>();
        m.put("source", source);
        m.put("translation", "下着倾盆大雨。");
        m.put("sourceLang", "en");
        m.put("targetLang", "zh");
        return m;
    }

    private long insertRecord(long owner) {
        return jdbcTemplate.queryForObject("""
                INSERT INTO biz.translation_record (user_id, source_text, target_text, source_lang, target_lang, path, mode, style)
                VALUES (?, 'Hello', '你好', 'en', 'zh', 'fast', 'auto', 'faithful') RETURNING id""", Long.class, owner);
    }

    @Test
    void insightsReturnAlternativesExpressionsAndSummary() throws Exception {
        Map<String, Object> req = request("It's raining cats and dogs.");
        req.put("recordId", insertRecord(userId));
        JsonNode r = body(postJson(BASE, req, token));
        assertThat(r.path("code").asString()).isEqualTo("00000");
        JsonNode data = r.path("data");
        assertThat(data.path("alternatives")).hasSize(2);
        assertThat(data.path("alternatives").get(0).path("register").asString()).isEqualTo("中性");
        assertThat(data.path("expressions").get(0).path("source").asString()).isEqualTo("raining cats and dogs");
        assertThat(data.path("summary").asString()).contains("习语");
        assertThat(data.has("usage")).isFalse();
        JsonNode up = mockAi().requests("/internal/insights").getLast().body();
        assertThat(up.path("source").asString()).isEqualTo("It's raining cats and dogs.");
        assertThat(up.path("translation").asString()).isEqualTo("下着倾盆大雨。");
        assertThat(up.has("recordId")).isFalse();
        assertThat(up.path("modelConfigId").isNull()).isTrue();
    }

    @Test
    void validationHappensBeforeCallingAiService() throws Exception {
        int calls = mockAi().requests("/internal/insights").size();
        MvcResult tooLong = postJson(BASE, request("a".repeat(2001)), token);
        assertThat(tooLong.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(tooLong).path("code").asString()).isEqualTo("A0410");
        Map<String, Object> badLang = request("Hi");
        badLang.put("targetLang", "xx");
        assertThat(body(postJson(BASE, badLang, token)).path("code").asString()).isEqualTo("A0420");
        Map<String, Object> blank = request(" ");
        assertThat(body(postJson(BASE, blank, token)).path("code").asString()).isEqualTo("A0410");
        // 别人的记录
        String other = registerUser(uniqueName("in2"), "Passw0rd!");
        long otherId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, other);
        Map<String, Object> foreign = request("Hi");
        foreign.put("recordId", insertRecord(otherId));
        MvcResult notFound = postJson(BASE, foreign, token);
        assertThat(notFound.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(notFound).path("code").asString()).isEqualTo("A0404");
        assertThat(mockAi().requests("/internal/insights")).hasSize(calls);
        // AI 服务返回的业务错误透传
        assertThat(body(postJson(BASE, request("x [[mock:http400]]"), token)).path("code").asString()).isEqualTo("A0410");
    }

    @Test
    void insightsPathDoesNotCollideWithHistoryId() throws Exception {
        long id = insertRecord(userId);
        // 字面路径 /insights 由解读接口处理（POST），历史详情仍按数字 id 解析
        assertThat(body(postJson(BASE, request("Hi"), token)).path("code").asString()).isEqualTo("00000");
        JsonNode detail = body(perform(bearer(get("/api/translations/" + id), token)));
        assertThat(detail.path("data").path("id").asLong()).isEqualTo(id);
        // GET /insights 不会被当作记录 id 读取历史（id 必须是数字）
        MvcResult asId = perform(bearer(get(BASE), token));
        assertThat(body(asId).path("code").asString()).isNotEqualTo("00000");
        assertThat(asId.getResponse().getStatus()).isIn(400, 405);
    }

    @Test
    void sharesTranslateRateLimit() throws Exception {
        for (int i = 0; i < 20; i++) {
            assertThat(body(postJson(BASE, request("Hi"), token)).path("code").asString()).isEqualTo("00000");
        }
        MvcResult limited = postJson(BASE, request("Hi"), token);
        assertThat(limited.getResponse().getStatus()).isEqualTo(429);
        assertThat(body(limited).path("code").asString()).isEqualTo("A0212");
        MvcResult translate = postJson("/api/translate/stream", Map.of("text", "Hi", "targetLang", "zh"), token);
        assertThat(body(translate).path("code").asString()).as("与文本翻译共用计数").isEqualTo("A0212");
    }

    @Test
    void askStreamsDeltasAndDoneWithTrimmedHistory() throws Exception {
        Map<String, Object> req = request("It's raining cats and dogs.");
        req.put("question", "为什么不直译？");
        List<Map<String, String>> history = new ArrayList<>();
        for (int i = 1; i <= 8; i++) {
            history.add(Map.of("q", "问" + i, "a", "答" + i));
        }
        req.put("history", history);
        try (Session s = sse().post(BASE + "/ask", token, req)) {
            assertThat(s.status()).isEqualTo(200);
            assertThat(s.header("Content-Type")).startsWith("text/event-stream");
            List<Event> events = s.readAll(WAIT).stream().filter(e -> !e.isComment()).toList();
            assertThat(events).extracting(Event::event).containsExactly("delta", "delta", "done");
            assertThat(events.get(0).data()).contains("因为");
        }
        JsonNode up = mockAi().requests("/internal/insights/ask").getLast().body();
        assertThat(up.path("question").asString()).isEqualTo("为什么不直译？");
        assertThat(up.path("history")).hasSize(6);
        assertThat(up.path("history").get(0).path("q").asString()).isEqualTo("问3");
    }

    @Test
    void askForwardsUpstreamErrorAndValidatesBeforeStreaming() throws Exception {
        Map<String, Object> req = request("Hi");
        req.put("question", "怎么说更口语？[[mock:error]]");
        try (Session s = sse().post(BASE + "/ask", token, req)) {
            List<Event> events = s.readAll(WAIT).stream().filter(e -> !e.isComment()).toList();
            assertThat(events).extracting(Event::event).containsExactly("delta", "error");
            assertThat(events.getLast().data()).contains("C0120").contains("traceId");
        }
        Map<String, Object> tooLong = request("a".repeat(2001));
        tooLong.put("question", "?");
        try (Session s = sse().post(BASE + "/ask", token, tooLong)) {
            assertThat(s.status()).isEqualTo(400);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
        Map<String, Object> noQuestion = request("Hi");
        assertThat(body(perform(bearer(jsonBody(post(BASE + "/ask"), noQuestion), token))).path("code").asString())
                .isEqualTo("A0410");
    }
}
