package com.xjl.tl.module.translate;

import com.xjl.tl.support.MockAiServer;
import com.xjl.tl.support.StreamingTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * language-detection / tasks 5.2：语种识别转发、空文本、每分钟 120 次限流。
 */
class TranslateDetectTest extends StreamingTestBase {

    private String token;
    private long userId;

    @BeforeEach
    void user() throws Exception {
        String name = registerUser(uniqueName("dt"), "Passw0rd!");
        token = accessToken(name, "Passw0rd!");
        userId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, name);
    }

    @Test
    void detectIsForwardedToAiService() throws Exception {
        String text = "Bonjour tout le monde " + UUID.randomUUID();
        MvcResult r = perform(jsonBody(bearer(post("/api/translate/detect"), token), Map.of("text", text))
                .header("X-Trace-Id", "detect-trace-1"));
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        JsonNode data = body(r).path("data");
        assertThat(data).isEqualTo(jsonMapper.readTree(MockAiServer.DETECT_DATA));
        MockAiServer.Received up = mockAi().requestsContaining(text).getFirst();
        assertThat(up.path()).isEqualTo("/internal/lang/detect");
        assertThat(up.traceId()).isEqualTo("detect-trace-1");
        assertThat(up.internalToken()).isNotBlank();
    }

    @Test
    void blankTextIsRejectedWithA0410() throws Exception {
        MvcResult r = perform(jsonBody(bearer(post("/api/translate/detect"), token), Map.of("text", "   ")));
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(r).path("code").asString()).isEqualTo("A0410");
    }

    @Test
    void detectIsRateLimitedAt120PerMinute() throws Exception {
        long minute = System.currentTimeMillis() / 60_000L;
        redis.opsForValue().set("rate:detect:" + userId + ":" + minute, "120", Duration.ofMinutes(2));
        redis.opsForValue().set("rate:detect:" + userId + ":" + (minute + 1), "120", Duration.ofMinutes(2));
        String text = "Hola " + UUID.randomUUID();
        MvcResult r = perform(jsonBody(bearer(post("/api/translate/detect"), token), Map.of("text", text)));
        assertThat(r.getResponse().getStatus()).isEqualTo(429);
        assertThat(body(r).path("code").asString()).isEqualTo("A0212");
        assertThat(mockAi().requestsContaining(text)).isEmpty();
    }
}
