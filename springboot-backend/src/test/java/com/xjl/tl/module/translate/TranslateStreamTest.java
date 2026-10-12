package com.xjl.tl.module.translate;

import com.xjl.tl.common.config.AppProperties;
import com.xjl.tl.infra.ai.AiStreamClient;
import com.xjl.tl.module.translate.service.TranslateService;
import com.xjl.tl.support.MockAiServer;
import com.xjl.tl.support.SampleStreams;
import com.xjl.tl.support.SseTestClient.Event;
import com.xjl.tl.support.SseTestClient.Session;
import com.xjl.tl.support.StreamingTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.tomcat.TomcatWebServer;
import org.springframework.boot.web.server.context.WebServerApplicationContext;
import org.springframework.context.ApplicationContext;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.util.ClassUtils;
import tools.jackson.databind.JsonNode;

import java.net.ServerSocket;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * translation-streaming / tasks 5.1、5.3、5.4：两跳 SSE 转发、落库与 recordId、心跳、超时、取消、错误事件、
 * 建立流之前的校验与限流。使用真实 Tomcat 与模拟的 Python 上游。
 */
class TranslateStreamTest extends StreamingTestBase {

    private static final Duration WAIT = Duration.ofSeconds(10);

    @Autowired
    private ApplicationContext context;
    @Autowired
    private TranslateService translateService;
    @Autowired
    private AppProperties appProperties;

    private String token;
    private long userId;

    @BeforeEach
    void user() throws Exception {
        String name = registerUser(uniqueName("st"), "Passw0rd!");
        token = accessToken(name, "Passw0rd!");
        userId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, name);
    }

    private Map<String, Object> request(String text) {
        Map<String, Object> m = new HashMap<>();
        m.put("text", text);
        m.put("sourceLang", "auto");
        m.put("targetLang", "zh");
        return m;
    }

    private static String text(String scenario) {
        return "Good morning " + UUID.randomUUID() + (scenario == null ? "" : " [[mock:" + scenario + "]]");
    }

    private int recordCount() {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM biz.translation_record WHERE user_id = ?",
                Integer.class, userId);
    }

    private static List<Event> nonComments(List<Event> events) {
        return events.stream().filter(e -> !e.isComment()).toList();
    }

    // ---------------- 基础设施 ----------------

    @Test
    void applicationStillRunsOnTomcat() {
        assertThat(context).isInstanceOf(WebServerApplicationContext.class);
        assertThat(((WebServerApplicationContext) context).getWebServer()).isInstanceOf(TomcatWebServer.class);
        // 只引入了 spring-webflux（WebClient），没有 Reactor Netty 服务器
        assertThat(ClassUtils.isPresent("reactor.netty.http.server.HttpServer", null)).isFalse();
    }

    // ---------------- 正常流程 ----------------

    @Test
    void fastPathForwardsEventsVerbatimAndFinalCarriesRecordId() throws Exception {
        String text = text(null);
        try (Session s = sse().open(token, request(text))) {
            assertThat(s.status()).isEqualTo(200);
            assertThat(s.header("Content-Type")).startsWith("text/event-stream");
            assertThat(s.header("Cache-Control")).isEqualTo("no-cache");
            assertThat(s.header("X-Accel-Buffering")).isEqualTo("no");
            List<Event> events = nonComments(s.readAll(WAIT));

            List<SampleStreams.Event> expected = SampleStreams.upstream("fast");
            assertThat(events).extracting(Event::event).containsExactlyElementsOf(
                    expected.stream().map(SampleStreams.Event::event).toList());
            // 非 final 事件原样透传
            for (int i = 0; i < expected.size() - 1; i++) {
                assertThat(events.get(i).data()).isEqualTo(expected.get(i).data());
            }
            JsonNode fin = jsonMapper.readTree(events.getLast().data());
            long recordId = fin.path("recordId").asLong();
            assertThat(recordId).isPositive();
            assertThat(fin.path("translation").asString()).isEqualTo("早上好");

            Map<String, Object> row = jdbcTemplate.queryForMap(
                    "SELECT user_id, source_text, target_text, source_lang, detected_lang, target_lang, path, mode, style, "
                            + "prompt_tokens, completion_tokens, latency_ms, review_rounds, review_score FROM biz.translation_record WHERE id = ?",
                    recordId);
            assertThat(((Number) row.get("user_id")).longValue()).isEqualTo(userId);
            assertThat(row.get("source_text")).isEqualTo(text);
            assertThat(row.get("target_text")).isEqualTo("早上好");
            assertThat(row.get("source_lang")).isEqualTo("auto");
            assertThat(row.get("detected_lang")).isEqualTo("en");
            assertThat(row.get("path")).isEqualTo("fast");
            assertThat(row.get("mode")).isEqualTo("auto");
            assertThat(row.get("style")).isEqualTo("faithful");
            assertThat(row.get("prompt_tokens")).isEqualTo(96);
            assertThat(row.get("completion_tokens")).isEqualTo(4);
            assertThat(row.get("latency_ms")).isEqualTo(1880);
            assertThat(row.get("review_rounds")).isEqualTo(0);
            assertThat(row.get("review_score")).isNull();

            // 历史列表中可以查到
            MvcResult list = perform(bearer(get("/api/translations"), token));
            assertThat(body(list).path("data").path("records").get(0).path("id").asLong()).isEqualTo(recordId);
        }
        // 上游收到内部令牌、traceId 与 userId
        MockAiServer.Received up = mockAi().requestsContaining(text).getFirst();
        assertThat(up.internalToken()).isEqualTo(appProperties.ai().internalToken());
        assertThat(up.traceId()).isNotBlank();
        assertThat(up.body().path("userId").asLong()).isEqualTo(userId);
        assertThat(up.body().path("mode").asString()).isEqualTo("auto");
    }

    @Test
    void standardPathPersistsRecordAndTracesInOneGo() throws Exception {
        String text = text("standard");
        long recordId;
        try (Session s = sse().open(token, request(text))) {
            List<Event> events = nonComments(s.readAll(WAIT));
            assertThat(events.getLast().event()).isEqualTo("final");
            recordId = jsonMapper.readTree(events.getLast().data()).path("recordId").asLong();
            // 含换行的 delta 原样到达
            Event firstDelta = events.stream().filter(e -> e.event().equals("delta")).findFirst().orElseThrow();
            assertThat(jsonMapper.readTree(firstDelta.data()).path("text").asString()).isEqualTo("机器学习模型\n通常在 ");
        }
        MvcResult r = perform(bearer(get("/api/translations/" + recordId), token));
        JsonNode d = body(r).path("data");
        assertThat(d.path("reviewRounds").asInt()).isEqualTo(1);
        assertThat(d.path("reviewScore").asInt()).isEqualTo(93);
        assertThat(d.path("path").asString()).isEqualTo("standard");
        assertThat(d.path("domain").asString()).isEqualTo("计算机");
        assertThat(d.path("targetText").asString()).isEqualTo("机器学习模型\n通常在 图形处理器上训练。");
        assertThat(d.path("termHits").size()).isEqualTo(2);
        assertThat(d.path("compliance").size()).isEqualTo(2);
        assertThat(d.path("compliance").get(0).path("compliant").asBoolean()).isTrue();
        JsonNode traces = d.path("traces");
        assertThat(traces.valueStream().map(t -> t.path("node").asString()).toList())
                .containsExactly("analyze", "plan", "retrieve", "translate", "review", "refine", "review", "finalize");
        assertThat(traces.valueStream().map(t -> t.path("seq").asInt()).toList()).containsExactly(1, 2, 3, 4, 5, 6, 7, 8);
        JsonNode analyze = traces.get(0);
        assertThat(analyze.path("status").asString()).isEqualTo("completed");
        assertThat(analyze.path("latencyMs").asInt()).isEqualTo(35);
        assertThat(analyze.path("detail").path("detect").path("lang").asString()).isEqualTo("en");
        assertThat(analyze.path("detail").path("terms").path("skippedGlossaries").get(0).asInt()).isEqualTo(9);
        assertThat(traces.get(1).path("detail").path("plan").path("path").asString()).isEqualTo("standard");
        assertThat(traces.get(1).path("promptTokens").asInt()).isEqualTo(120);
        assertThat(traces.get(3).path("detail").path("output").path("text").asString()).isEqualTo("机器学习模型\n通常在 显卡上训练。");
        assertThat(traces.get(4).path("detail").path("review").path("score").asInt()).isEqualTo(72);
        assertThat(traces.get(5).path("detail").path("output").path("round").asInt()).isEqualTo(1);
        assertThat(traces.get(6).path("detail").path("review").path("passed").asBoolean()).isTrue();
        assertThat(traces.get(7).path("summary").asString()).isEqualTo("术语遵循 2/2");
    }

    @Test
    void firstEventArrivesWithinOneSecondAndHeartbeatsKeepConnectionAlive() throws Exception {
        // 上游 start 之后静默 1.5 秒：若任一跳缓冲，start 不会提前到达
        try (Session s = sse().open(token, request(text("pause")))) {
            Event first = s.next(WAIT);
            assertThat(first).isNotNull();
            assertThat(first.event()).isEqualTo("start");
            assertThat(first.elapsedMs()).isLessThan(1000);
            List<Event> all = s.readAll(WAIT);
            Event fin = all.getLast();
            assertThat(fin.event()).isEqualTo("final");
            assertThat(fin.elapsedMs()).isGreaterThanOrEqualTo(1500);
            // 静默期间至少收到一次 ": ping" 心跳
            assertThat(all).anySatisfy(e -> {
                assertThat(e.isComment()).isTrue();
                assertThat(e.data()).isEqualTo(" ping");
                assertThat(e.elapsedMs()).isBetween(first.elapsedMs(), fin.elapsedMs());
            });
        }
    }

    @Test
    void deltaWithNewlineAndLeadingSpacesIsPreserved() throws Exception {
        try (Session s = sse().open(token, request(text("newline")))) {
            List<Event> events = nonComments(s.readAll(WAIT));
            List<Event> deltas = events.stream().filter(e -> e.event().equals("delta")).toList();
            assertThat(jsonMapper.readTree(deltas.get(1).data()).path("text").asString()).isEqualTo("\n  world");
            JsonNode fin = jsonMapper.readTree(events.getLast().data());
            assertThat(fin.path("translation").asString()).isEqualTo("hello\n  world");
            assertThat(jdbcTemplate.queryForObject("SELECT target_text FROM biz.translation_record WHERE id = ?",
                    String.class, fin.path("recordId").asLong())).isEqualTo("hello\n  world");
        }
    }

    // ---------------- 错误事件 ----------------

    @Test
    void upstreamLlmAuthErrorIsForwardedAndNothingPersisted() throws Exception {
        try (Session s = sse().open(token, request(text("error")))) {
            List<Event> events = nonComments(s.readAll(WAIT));
            Event last = events.getLast();
            assertThat(last.event()).isEqualTo("error");
            assertThat(jsonMapper.readTree(last.data()).path("code").asString()).isEqualTo("C0121");
            assertThat(events).noneMatch(e -> e.event().equals("final"));
        }
        assertThat(recordCount()).isZero();
    }

    @Test
    void upstreamEndingWithoutFinalBecomesC0140() throws Exception {
        try (Session s = sse().open(token, request(text("truncated")))) {
            Event last = nonComments(s.readAll(WAIT)).getLast();
            assertThat(last.event()).isEqualTo("error");
            assertThat(jsonMapper.readTree(last.data()).path("code").asString()).isEqualTo("C0140");
        }
        assertThat(recordCount()).isZero();
    }

    @Test
    void upstreamEnvelopeErrorsBeforeStreamKeepCodeAndMessage() throws Exception {
        Map<String, String> expected = Map.of(
                "http400", "A0420|不支持的语种：xx",
                "http401", "B0100|内部服务鉴权失败",
                "http500", "B0001|系统执行出错",
                // 非信封响应（如网关错误页）无法解析，视为 AI 服务不可用
                "http502", "C0110|AI 服务不可用");
        for (Map.Entry<String, String> c : expected.entrySet()) {
            try (Session s = sse().open(token, request(text(c.getKey())))) {
                assertThat(s.status()).isEqualTo(200);
                List<Event> events = nonComments(s.readAll(WAIT));
                assertThat(events).as(c.getKey()).hasSize(1);
                assertThat(events.getFirst().event()).isEqualTo("error");
                JsonNode data = jsonMapper.readTree(events.getFirst().data());
                String[] codeAndMessage = c.getValue().split("\\|");
                assertThat(data.path("code").asString()).as(c.getKey()).isEqualTo(codeAndMessage[0]);
                assertThat(data.path("message").asString()).as(c.getKey()).isEqualTo(codeAndMessage[1]);
            }
        }
        assertThat(recordCount()).isZero();
    }

    @Test
    void firstRoundPassWithNullScoreAndSkippedRefine() throws Exception {
        Map<String, Object> req = request(text("passfirst"));
        req.put("sourceLang", "en");
        req.put("mode", "standard");
        req.put("style", "fluent");
        long recordId;
        try (Session s = sse().open(token, req)) {
            List<Event> events = nonComments(s.readAll(WAIT));
            recordId = jsonMapper.readTree(events.getLast().data()).path("recordId").asLong();
        }
        JsonNode d = body(perform(bearer(get("/api/translations/" + recordId), token))).path("data");
        assertThat(d.path("reviewRounds").asInt()).isZero();
        assertThat(d.path("reviewScore").isNull()).isTrue();
        assertThat(d.path("detectedLang").isNull()).as("指定源语言时没有 detect 事件").isTrue();
        assertThat(d.path("sourceLang").asString()).isEqualTo("en");
        assertThat(d.path("mode").asString()).isEqualTo("standard");
        assertThat(d.path("style").asString()).isEqualTo("fluent");
        assertThat(d.path("termHits").get(0).path("glossaryId").asInt()).isEqualTo(7);
        JsonNode traces = d.path("traces");
        assertThat(traces.valueStream().map(t -> t.path("node").asString() + ":" + t.path("status").asString()).toList())
                .containsExactly("analyze:completed", "plan:completed", "retrieve:completed", "translate:completed",
                        "review:completed", "refine:skipped", "finalize:completed");
        assertThat(traces.get(4).path("detail").path("review").path("score").isNull()).isTrue();
        assertThat(traces.get(5).path("summary").asString()).isEqualTo("评审通过，无需修正");
    }

    @Test
    void unreachableAiServiceEmitsC0110ErrorEvent() throws Exception {
        int freePort;
        try (ServerSocket socket = new ServerSocket(0)) {
            freePort = socket.getLocalPort();
        }
        AppProperties.Ai ai = appProperties.ai();
        AppProperties unreachable = new AppProperties(null, null, null, null,
                new AppProperties.Ai("http://127.0.0.1:" + freePort, ai.internalToken(), ai.connectTimeout(), ai.readTimeout()));
        Object original = ReflectionTestUtils.getField(translateService, "aiStreamClient");
        ReflectionTestUtils.setField(translateService, "aiStreamClient", new AiStreamClient(unreachable, jsonMapper));
        try (Session s = sse().open(token, request(text(null)))) {
            assertThat(s.status()).isEqualTo(200);
            List<Event> events = nonComments(s.readAll(WAIT));
            assertThat(events).hasSize(1);
            assertThat(events.getFirst().event()).isEqualTo("error");
            JsonNode err = jsonMapper.readTree(events.getFirst().data());
            assertThat(err.path("code").asString()).isEqualTo("C0110");
            assertThat(err.path("message").asString()).isEqualTo("AI 服务不可用");
            assertThat(err.path("traceId").asString()).isNotBlank();
        } finally {
            ReflectionTestUtils.setField(translateService, "aiStreamClient", original);
        }
        assertThat(recordCount()).isZero();
    }

    // ---------------- 取消与超时 ----------------

    @Test
    void clientCancelClosesUpstreamConnectionAndPersistsNothing() throws Exception {
        String text = text("stall");
        Session s = sse().open(token, request(text));
        Event first = s.next(WAIT);
        assertThat(first.event()).isEqualTo("start");
        s.close();
        // Spring 下一次写心跳时发现客户端已断开 → 取消 Flux → 断开与上游的连接
        assertThat(mockAi().closedLatch(text).await(5, TimeUnit.SECONDS)).as("上游连接应被关闭").isTrue();
        Thread.sleep(300);
        assertThat(recordCount()).isZero();
    }

    @Test
    void totalTimeoutEmitsC0141AndClosesUpstream() throws Exception {
        String text = text("stall");
        try (Session s = sse().open(token, request(text))) {
            List<Event> events = nonComments(s.readAll(Duration.ofMillis(TIMEOUT_MS + 6000)));
            Event last = events.getLast();
            assertThat(last.event()).isEqualTo("error");
            assertThat(jsonMapper.readTree(last.data()).path("code").asString()).isEqualTo("C0141");
            assertThat(last.elapsedMs()).isGreaterThanOrEqualTo(TIMEOUT_MS - 100);
        }
        assertThat(mockAi().closedLatch(text).await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(recordCount()).isZero();
    }

    // ---------------- 建立流之前的校验与限流 ----------------

    @Test
    void validationErrorsReturnPlainJsonBeforeStream() throws Exception {
        String marker = UUID.randomUUID().toString();
        Map<String, Object> badLang = request("hello " + marker);
        badLang.put("targetLang", "xx");
        try (Session s = sse().open(token, badLang)) {
            assertThat(s.status()).isEqualTo(400);
            assertThat(s.header("Content-Type")).startsWith("application/json");
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0420");
        }
        Map<String, Object> sameLang = request("hello " + marker);
        sameLang.put("sourceLang", "zh");
        try (Session s = sse().open(token, sameLang)) {
            assertThat(s.status()).isEqualTo(400);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
        try (Session s = sse().open(token, request("a".repeat(5001) + marker))) {
            assertThat(s.status()).isEqualTo(400);
            JsonNode b = s.jsonBody();
            assertThat(b.path("code").asString()).isEqualTo("A0410");
            assertThat(b.path("message").asString()).contains("文档翻译");
        }
        try (Session s = sse().open(token, request("   "))) {
            assertThat(s.status()).isEqualTo(400);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
        Map<String, Object> badStyle = request("hello " + marker);
        badStyle.put("style", "poetic");
        try (Session s = sse().open(token, badStyle)) {
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
        assertThat(mockAi().requestsContaining(marker)).isEmpty();
    }

    @Test
    void otherUsersPrivateGlossaryIsRejectedBeforeStream() throws Exception {
        String other = registerUser(uniqueName("go"), "Passw0rd!");
        long otherId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, other);
        long privateId = jdbcTemplate.queryForObject("""
                INSERT INTO biz.glossary (owner_id, name, source_lang, target_lang, scope)
                VALUES (?, 'p', 'en', 'zh', 'PRIVATE') RETURNING id""", Long.class, otherId);
        long publicId = jdbcTemplate.queryForObject("""
                INSERT INTO biz.glossary (owner_id, name, source_lang, target_lang, scope)
                VALUES (?, 'pub', 'en', 'zh', 'PUBLIC') RETURNING id""", Long.class, otherId);
        String marker = UUID.randomUUID().toString();
        Map<String, Object> req = request("hello " + marker);
        req.put("glossaryIds", List.of(publicId, privateId));
        try (Session s = sse().open(token, req)) {
            assertThat(s.status()).isEqualTo(404);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0404");
        }
        assertThat(mockAi().requestsContaining(marker)).isEmpty();
        // 公共术语库可以使用，并原样转发给上游
        Map<String, Object> ok = request("hello " + marker);
        ok.put("glossaryIds", List.of(publicId));
        try (Session s = sse().open(token, ok)) {
            assertThat(nonComments(s.readAll(WAIT)).getLast().event()).isEqualTo("final");
        }
        assertThat(mockAi().requestsContaining(marker).getFirst().body().path("glossaryIds").get(0).asLong())
                .isEqualTo(publicId);
    }

    @Test
    void disabledModelIsRejectedBeforeStream() throws Exception {
        long modelId = jdbcTemplate.queryForObject("""
                INSERT INTO biz.model_config (name, provider, base_url, model_name, api_key_cipher, api_key_mask, enabled)
                VALUES ('off', 'OPENAI_COMPATIBLE', 'https://x', 'm', 'v1:x', '****', false) RETURNING id""", Long.class);
        Map<String, Object> req = request(text(null));
        req.put("modelConfigId", modelId);
        try (Session s = sse().open(token, req)) {
            assertThat(s.status()).isEqualTo(400);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("C0130");
        }
    }

    @Test
    void upstreamRequestCarriesResolvedReviewModel() throws Exception {
        // 没有评审模型：字段存在且为 null（评审使用译者模型）
        String none = text(null);
        try (Session s = sse().open(token, request(none))) {
            assertThat(nonComments(s.readAll(WAIT)).getLast().event()).isEqualTo("final");
        }
        JsonNode body = mockAi().requestsContaining(none).getFirst().body();
        assertThat(body.has("reviewModelConfigId")).isTrue();
        assertThat(body.path("reviewModelConfigId").isNull()).isTrue();

        // 管理员设置的评审模型
        long reviewer = insertModelConfig("st-reviewer", true);
        perform(bearer(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .put("/api/admin/model-configs/" + reviewer + "/review-default"), adminToken()));
        String byAdmin = text(null);
        try (Session s = sse().open(token, request(byAdmin))) {
            assertThat(nonComments(s.readAll(WAIT)).getLast().event()).isEqualTo("final");
        }
        assertThat(mockAi().requestsContaining(byAdmin).getFirst().body().path("reviewModelConfigId").asLong())
                .isEqualTo(reviewer);

        // 显式指定优先
        long explicit = insertModelConfig("st-explicit", true);
        String byRequest = text(null);
        Map<String, Object> req = request(byRequest);
        req.put("reviewModelConfigId", explicit);
        try (Session s = sse().open(token, req)) {
            assertThat(nonComments(s.readAll(WAIT)).getLast().event()).isEqualTo("final");
        }
        assertThat(mockAi().requestsContaining(byRequest).getFirst().body().path("reviewModelConfigId").asLong())
                .isEqualTo(explicit);
    }

    @Test
    void disabledReviewModelIsRejectedBeforeStream() throws Exception {
        long disabled = insertModelConfig("st-reviewer-off", false);
        String text = text(null);
        Map<String, Object> req = request(text);
        req.put("reviewModelConfigId", disabled);
        try (Session s = sse().open(token, req)) {
            assertThat(s.status()).isEqualTo(400);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("C0130");
        }
        assertThat(mockAi().requestsContaining(text)).isEmpty();
    }

    @Test
    void twentyFirstTranslationInOneMinuteIsRejectedWith429() throws Exception {
        long minute = System.currentTimeMillis() / 60_000L;
        // 预置当前（及下一）分钟窗口已用满 20 次，避免测试跨分钟边界
        redis.opsForValue().set("rate:translate:" + userId + ":" + minute, "20", Duration.ofMinutes(2));
        redis.opsForValue().set("rate:translate:" + userId + ":" + (minute + 1), "20", Duration.ofMinutes(2));
        String text = text(null);
        try (Session s = sse().open(token, request(text))) {
            assertThat(s.status()).isEqualTo(429);
            assertThat(s.header("Content-Type")).startsWith("application/json");
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0212");
        }
        assertThat(mockAi().requestsContaining(text)).as("超限请求不调用 AI 服务").isEmpty();
    }

    @Test
    void rateLimitCountsEachTranslation() throws Exception {
        try (Session s = sse().open(token, request(text(null)))) {
            s.readAll(WAIT);
        }
        long minute = System.currentTimeMillis() / 60_000L;
        String current = redis.opsForValue().get("rate:translate:" + userId + ":" + minute);
        String previous = redis.opsForValue().get("rate:translate:" + userId + ":" + (minute - 1));
        assertThat(current != null ? current : previous).isEqualTo("1");
    }
}
