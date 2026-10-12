package com.xjl.tl.module.memory;

import com.xjl.tl.support.MockAiServer;
import com.xjl.tl.support.StreamingTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * translation-memory / tasks 3.5：/api/tm 转发到 Python 内部接口并带 userId、记录归属校验、C0160 透传。
 */
class TmApiTest extends StreamingTestBase {

    private String token;
    private long userId;

    @BeforeEach
    void user() throws Exception {
        String name = registerUser(uniqueName("tm"), "Passw0rd!");
        token = accessToken(name, "Passw0rd!");
        userId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, name);
    }

    private long insertRecord(long owner, String source, String sourceLang, String detected) {
        return jdbcTemplate.queryForObject("""
                INSERT INTO biz.translation_record (user_id, source_text, target_text, source_lang, detected_lang,
                  target_lang, path, mode, style)
                VALUES (?, ?, '重启 Pod。', ?, ?, 'zh', 'fast', 'auto', 'faithful') RETURNING id""", Long.class,
                owner, source, sourceLang, detected);
    }

    private MockAiServer.Received last(String path) {
        return mockAi().requests(path).getLast();
    }

    @Test
    void listForwardsFiltersAndUserId() throws Exception {
        MvcResult r = perform(bearer(get("/api/tm").param("pageNum", "2").param("pageSize", "20")
                .param("keyword", "Pod & {x}").param("sourceLang", "en").param("targetLang", ""), token));
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        JsonNode data = body(r).path("data");
        assertThat(data.path("total").asInt()).isEqualTo(21);
        assertThat(data.path("pageNum").asInt()).isEqualTo(2);
        JsonNode entry = data.path("records").get(0);
        assertThat(entry.path("sourceText").asString()).isEqualTo("Restart the Pod.");
        assertThat(entry.path("originRef").asString()).isEqualTo("42:5");
        assertThat(entry.path("hitCount").asInt()).isEqualTo(3);
        assertThat(entry.has("embedding")).isFalse();

        MockAiServer.Received up = last("/internal/tm/entries");
        assertThat(up.method()).isEqualTo("GET");
        String query = URLDecoder.decode(up.query(), StandardCharsets.UTF_8);
        assertThat(query).contains("userId=" + userId, "pageNum=2", "pageSize=20", "keyword=Pod & {x}", "sourceLang=en");
        assertThat(query).doesNotContain("targetLang");
        assertThat(up.internalToken()).isNotBlank();
    }

    @Test
    void deleteForwardsAndPassesThroughNotFound() throws Exception {
        MvcResult ok = perform(bearer(delete("/api/tm/7"), token));
        assertThat(body(ok).path("code").asString()).isEqualTo("00000");
        MockAiServer.Received up = last("/internal/tm/entries/7");
        assertThat(up.method()).isEqualTo("DELETE");
        assertThat(up.query()).isEqualTo("userId=" + userId);

        MvcResult missing = perform(bearer(delete("/api/tm/404"), token));
        assertThat(missing.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(missing).path("code").asString()).isEqualTo("A0404");
    }

    @Test
    void fromRecordChecksOwnershipAndUsesDetectedLanguage() throws Exception {
        long mine = insertRecord(userId, "Restart the Pod.", "auto", "en");
        MvcResult r = perform(bearer(post("/api/tm/from-record/" + mine), token));
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        assertThat(body(r).path("data").path("written").asInt()).isEqualTo(1);
        JsonNode body = last("/internal/tm/entries").body();
        assertThat(body.path("userId").asLong()).isEqualTo(userId);
        JsonNode e = body.path("entries").get(0);
        assertThat(e.path("sourceLang").asString()).isEqualTo("en");
        assertThat(e.path("targetLang").asString()).isEqualTo("zh");
        assertThat(e.path("sourceText").asString()).isEqualTo("Restart the Pod.");
        assertThat(e.path("targetText").asString()).isEqualTo("重启 Pod。");
        assertThat(e.path("origin").asString()).isEqualTo("workbench");
        assertThat(e.path("originRef").asString()).isEqualTo(String.valueOf(mine));

        // 采用备选译法后传入的译文优先（add-speech-and-image-translation D11）
        perform(jsonBody(bearer(post("/api/tm/from-record/" + mine), token), Map.of("targetText", "重新启动 Pod。")));
        assertThat(last("/internal/tm/entries").body().path("entries").get(0).path("targetText").asString())
                .isEqualTo("重新启动 Pod。");

        // 用户指定源语言时取 source_lang
        long specified = insertRecord(userId, "Bonjour", "fr", null);
        perform(bearer(post("/api/tm/from-record/" + specified), token));
        assertThat(last("/internal/tm/entries").body().path("entries").get(0).path("sourceLang").asString()).isEqualTo("fr");

        // 他人的记录：A0404，不调用 AI 服务
        String other = registerUser(uniqueName("to"), "Passw0rd!");
        long otherId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, other);
        long foreign = insertRecord(otherId, "secret", "en", null);
        int before = mockAi().requests("/internal/tm/entries").size();
        MvcResult denied = perform(bearer(post("/api/tm/from-record/" + foreign), token));
        assertThat(denied.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(denied).path("code").asString()).isEqualTo("A0404");
        assertThat(mockAi().requests("/internal/tm/entries")).hasSize(before);

        // 语种无法确定 / 原文超长
        long unknown = insertRecord(userId, "???", "auto", null);
        assertThat(body(perform(bearer(post("/api/tm/from-record/" + unknown), token))).path("code").asString())
                .isEqualTo("A0410");
        long longText = insertRecord(userId, "a".repeat(5001), "en", null);
        assertThat(body(perform(bearer(post("/api/tm/from-record/" + longText), token))).path("code").asString())
                .isEqualTo("A0410");
    }

    @Test
    void modelUnavailableC0160IsPassedThrough() throws Exception {
        long record = insertRecord(userId, "Restart [[mock:c0160]]", "en", null);
        MvcResult r = perform(bearer(post("/api/tm/from-record/" + record), token));
        assertThat(r.getResponse().getStatus()).isEqualTo(503);
        assertThat(body(r).path("code").asString()).isEqualTo("C0160");
        assertThat(body(r).path("message").asString()).isEqualTo("翻译记忆服务不可用");
    }

    @Test
    void searchForwardsWithLimitAndReportsAvailability() throws Exception {
        MvcResult r = postJson("/api/tm/search",
                Map.of("text", "Restart the Pod now.", "sourceLang", "en", "targetLang", "zh"), token);
        JsonNode data = body(r).path("data");
        assertThat(data.path("available").asBoolean()).isTrue();
        JsonNode hit = data.path("hits").get(0);
        assertThat(hit.path("fuzzy").asDouble()).isEqualTo(0.92);
        assertThat(hit.path("semantic").asDouble()).isEqualTo(0.95);
        assertThat(hit.path("originRef").asString()).isEqualTo("123");
        JsonNode up = last("/internal/tm/search").body();
        assertThat(up.path("userId").asLong()).isEqualTo(userId);
        assertThat(up.path("limit").asInt()).isEqualTo(3);
        assertThat(up.path("text").asString()).isEqualTo("Restart the Pod now.");

        JsonNode down = body(postJson("/api/tm/search",
                Map.of("text", "x [[mock:c0160]]", "sourceLang", "en", "targetLang", "zh"), token)).path("data");
        assertThat(down.path("available").asBoolean()).isFalse();
        assertThat(down.path("hits").size()).isZero();

        assertThat(body(postJson("/api/tm/search", Map.of("text", "x", "sourceLang", "xx", "targetLang", "zh"), token))
                .path("code").asString()).isEqualTo("A0420");
        assertThat(body(postJson("/api/tm/search", Map.of("text", " ", "sourceLang", "en", "targetLang", "zh"), token))
                .path("code").asString()).isEqualTo("A0410");
    }
}
