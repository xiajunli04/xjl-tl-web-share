package com.xjl.tl.module.translate;

import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * translation-history 规格「历史检索」「收藏与删除」/ tasks 5.5。
 * 记录直接写库构造（落库流程见 TranslateStreamTest）。
 */
class TranslationHistoryTest extends IntegrationTestBase {

    private static final String BASE = "/api/translations";

    private String token;
    private long userId;

    @BeforeEach
    void user() throws Exception {
        String name = registerUser(uniqueName("ht"), "Passw0rd!");
        token = accessToken(name, "Passw0rd!");
        userId = userId(name);
    }

    private long userId(String name) {
        return jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, name);
    }

    private long insert(long owner, String source, String target, String sourceLang, String detected, String targetLang,
                        String createdAt) {
        long id = jdbcTemplate.queryForObject("""
                INSERT INTO biz.translation_record (user_id, source_text, target_text, source_lang, detected_lang, target_lang,
                  path, mode, style, glossary_ids, review_score, review_rounds, compliance, term_hits, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'standard', 'auto', 'faithful', '{7}', 90, 1,
                  '[{"source":"GPU","target":"图形处理器","compliant":true}]'::jsonb, '[]'::jsonb, ?::timestamptz)
                RETURNING id""", Long.class, owner, source, target, sourceLang, detected, targetLang, createdAt);
        jdbcTemplate.update("""
                INSERT INTO biz.agent_trace (record_id, seq, node, status, summary, detail, latency_ms)
                VALUES (?, 2, 'plan', 'completed', '快速路径', '{"plan":{"path":"fast"}}'::jsonb, 1),
                       (?, 1, 'analyze', 'completed', '识别为英语', '{"detect":{"lang":"en"}}'::jsonb, 12)""", id, id);
        return id;
    }

    private JsonNode page(Map<String, String> params) throws Exception {
        var req = bearer(get(BASE), token);
        params.forEach(req::param);
        return body(perform(req)).path("data");
    }

    private static List<Long> ids(JsonNode page) {
        return page.path("records").valueStream().map(n -> n.path("id").asLong()).toList();
    }

    @Test
    void keywordMatchesSourceOrTargetAndListIsNewestFirst() throws Exception {
        long a = insert(userId, "卷积神经网络很强大", "CNNs are powerful", "zh", null, "en", "2026-09-01T10:00:00+08:00");
        long b = insert(userId, "Neural networks", "神经网络", "auto", "en", "zh", "2026-09-02T10:00:00+08:00");
        long c = insert(userId, "Good morning", "早上好", "en", null, "zh", "2026-09-03T10:00:00+08:00");
        assertThat(ids(page(Map.of()))).containsExactly(c, b, a);
        assertThat(ids(page(Map.of("keyword", "神经网络")))).containsExactly(b, a);
        // ILIKE：不区分大小写，% 与 _ 按字面匹配
        assertThat(ids(page(Map.of("keyword", "NEURAL")))).containsExactly(b);
        assertThat(ids(page(Map.of("keyword", "100%")))).isEmpty();
        JsonNode first = page(Map.of("keyword", "Neural")).path("records").get(0);
        assertThat(first.path("sourcePreview").asString()).isEqualTo("Neural networks");
        assertThat(first.path("sourceLang").asString()).as("自动识别的记录显示识别结果").isEqualTo("en");
        assertThat(first.path("reviewScore").asInt()).isEqualTo(90);
    }

    @Test
    void filtersByLanguagesFavoriteAndTimeRange() throws Exception {
        long a = insert(userId, "今日はいい天気", "今天天气很好", "ja", null, "zh", "2026-09-01T10:00:00+08:00");
        long b = insert(userId, "Bonjour", "你好", "auto", "fr", "zh", "2026-09-05T10:00:00+08:00");
        long c = insert(userId, "Hello", "こんにちは", "en", null, "ja", "2026-09-10T10:00:00+08:00");
        assertThat(ids(page(Map.of("sourceLang", "fr")))).containsExactly(b);
        assertThat(ids(page(Map.of("targetLang", "zh")))).containsExactly(b, a);
        assertThat(ids(page(Map.of("startTime", "2026-09-02T00:00:00+08:00", "endTime", "2026-09-10T00:00:00+08:00"))))
                .containsExactly(b);
        // 收藏后按"只看收藏"筛选
        MvcResult fav = perform(jsonBody(bearer(put(BASE + "/" + c + "/favorite"), token), Map.of("favorite", true)));
        assertThat(body(fav).path("code").asString()).isEqualTo("00000");
        assertThat(ids(page(Map.of("favorite", "true")))).containsExactly(c);
        perform(jsonBody(bearer(put(BASE + "/" + c + "/favorite"), token), Map.of("favorite", false)));
        assertThat(ids(page(Map.of("favorite", "true")))).isEmpty();
    }

    @Test
    void detailContainsTracesOrderedBySeq() throws Exception {
        long id = insert(userId, "GPU", "图形处理器", "en", null, "zh", "2026-09-01T10:00:00+08:00");
        JsonNode d = body(perform(bearer(get(BASE + "/" + id), token))).path("data");
        assertThat(d.path("sourceText").asString()).isEqualTo("GPU");
        assertThat(d.path("glossaryIds").get(0).asLong()).isEqualTo(7);
        assertThat(d.path("compliance").get(0).path("compliant").asBoolean()).isTrue();
        assertThat(d.path("reviewRounds").asInt()).isEqualTo(1);
        JsonNode traces = d.path("traces");
        assertThat(traces.get(0).path("node").asString()).isEqualTo("analyze");
        assertThat(traces.get(0).path("detail").path("detect").path("lang").asString()).isEqualTo("en");
        assertThat(traces.get(1).path("node").asString()).isEqualTo("plan");
    }

    @Test
    void otherUsersRecordsAreIsolated() throws Exception {
        String other = registerUser(uniqueName("ho"), "Passw0rd!");
        long foreign = insert(userId(other), "secret text", "秘密", "en", null, "zh", "2026-09-01T10:00:00+08:00");
        assertThat(ids(page(Map.of()))).doesNotContain(foreign);
        MvcResult r = perform(bearer(get(BASE + "/" + foreign), token));
        assertThat(r.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(r).path("code").asString()).isEqualTo("A0404");
        assertThat(body(perform(jsonBody(bearer(put(BASE + "/" + foreign + "/favorite"), token), Map.of("favorite", true))))
                .path("code").asString()).isEqualTo("A0404");
        assertThat(body(perform(bearer(delete(BASE + "/" + foreign), token))).path("code").asString()).isEqualTo("A0404");
        assertThat(jdbcTemplate.queryForObject("SELECT favorite FROM biz.translation_record WHERE id = ?", Boolean.class, foreign))
                .isFalse();
    }

    @Test
    void deletedRecordDisappearsFromListAndDetail() throws Exception {
        long id = insert(userId, "to delete", "删除", "en", null, "zh", "2026-09-01T10:00:00+08:00");
        assertThat(body(perform(bearer(delete(BASE + "/" + id), token))).path("code").asString()).isEqualTo("00000");
        assertThat(jdbcTemplate.queryForObject("SELECT deleted FROM biz.translation_record WHERE id = ?", Boolean.class, id)).isTrue();
        assertThat(ids(page(Map.of()))).doesNotContain(id);
        assertThat(perform(bearer(get(BASE + "/" + id), token)).getResponse().getStatus()).isEqualTo(404);
    }
}
