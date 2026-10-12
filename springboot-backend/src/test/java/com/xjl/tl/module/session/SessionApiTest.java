package com.xjl.tl.module.session;

import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * translation-session / tasks 3.1、3.3（采用）、3.7：会话 CRUD、用户隔离、删除后记录保留、详情的版本链与采用版本、
 * 历史记录的会话字段。
 */
class SessionApiTest extends SessionTestSupport {

    /** 直接插入会话内记录（不经过翻译流）。 */
    private long insertRecord(long sessionId, String source, String target, Long revisionOf, boolean adopted,
                              String minuteOffset) {
        return jdbcTemplate.queryForObject("""
                INSERT INTO biz.translation_record (user_id, source_text, target_text, source_lang, detected_lang,
                  target_lang, path, mode, style, session_id, revision_of, revise_instruction, adopted, clarification,
                  review_score, created_at)
                VALUES (?, ?, ?, 'auto', 'en', 'zh', ?, ?, 'faithful', ?, ?, ?, ?, CAST(? AS jsonb), 90,
                  now() + CAST(? AS interval)) RETURNING id""", Long.class,
                userId, source, target, revisionOf == null ? "fast" : "revise", revisionOf == null ? "auto" : "revise",
                sessionId, revisionOf, revisionOf == null ? null : "更口语一些", adopted,
                revisionOf == null ? "{\"question\":\"bank 指什么？\",\"answer\":\"银行\"}" : null, minuteOffset);
    }

    @Test
    void createAppliesDefaultsAndValidates() throws Exception {
        MvcResult r = postJson("/api/translate/sessions", Map.of("targetLang", "zh"), token);
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        JsonNode s = body(r).path("data");
        assertThat(s.path("title").isNull()).isTrue();
        assertThat(s.path("sourceLang").asString()).isEqualTo("auto");
        assertThat(s.path("targetLang").asString()).isEqualTo("zh");
        assertThat(s.path("style").asString()).isEqualTo("faithful");
        assertThat(s.path("clarifyEnabled").asBoolean()).isTrue();
        assertThat(s.path("turnCount").asInt()).isZero();
        assertThat(s.path("hasPending").asBoolean()).isFalse();
        assertThat(s.path("glossaryIds").isArray()).isTrue();
        assertThat(names(s)).containsExactlyInAnyOrder("id", "title", "sourceLang", "targetLang", "turnCount",
                "hasPending", "updatedAt", "createdAt", "style", "domain", "glossaryIds", "modelConfigId",
                "clarifyEnabled");

        assertThat(body(postJson("/api/translate/sessions", Map.of("sourceLang", "en"), token)).path("code").asString())
                .isEqualTo("A0410");
        assertThat(body(postJson("/api/translate/sessions", Map.of("sourceLang", "zh", "targetLang", "zh"), token))
                .path("code").asString()).isEqualTo("A0410");
        assertThat(body(postJson("/api/translate/sessions", Map.of("targetLang", "xx"), token)).path("code").asString())
                .isEqualTo("A0420");
        assertThat(body(postJson("/api/translate/sessions", Map.of("targetLang", "zh", "style", "poetic"), token))
                .path("code").asString()).isEqualTo("A0410");
        long disabled = insertModelConfig("ss-off", false);
        assertThat(body(postJson("/api/translate/sessions", Map.of("targetLang", "zh", "modelConfigId", disabled), token))
                .path("code").asString()).isEqualTo("C0130");
        String other = registerUser(uniqueName("so"), "Passw0rd!");
        long otherId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, other);
        long privateGlossary = jdbcTemplate.queryForObject("""
                INSERT INTO biz.glossary (owner_id, name, source_lang, target_lang, scope)
                VALUES (?, 'p', 'en', 'zh', 'PRIVATE') RETURNING id""", Long.class, otherId);
        MvcResult g = postJson("/api/translate/sessions", Map.of("targetLang", "zh", "glossaryIds", List.of(privateGlossary)), token);
        assertThat(g.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(g).path("code").asString()).isEqualTo("A0404");
        Map<String, Object> many = new HashMap<>();
        many.put("targetLang", "zh");
        many.put("glossaryIds", List.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11));
        assertThat(body(postJson("/api/translate/sessions", many, token)).path("code").asString()).isEqualTo("A0410");
    }

    private static List<String> names(JsonNode n) {
        return List.copyOf(n.propertyNames());
    }

    @Test
    void listIsNewestFirstWithKeywordAndIsolated() throws Exception {
        long a = createSession(Map.of("title", "客服对话 A", "targetLang", "zh"));
        long b = createSession(Map.of("title", "产品手册", "targetLang", "ja"));
        jdbcTemplate.update("UPDATE biz.translation_session SET updated_at = now() - interval '1 hour' WHERE id = ?", a);
        JsonNode page = body(perform(bearer(get("/api/translate/sessions"), token))).path("data");
        assertThat(page.path("total").asInt()).isEqualTo(2);
        assertThat(page.path("records").get(0).path("id").asLong()).isEqualTo(b);
        assertThat(names(page.path("records").get(0))).containsExactlyInAnyOrder("id", "title", "sourceLang",
                "targetLang", "turnCount", "hasPending", "updatedAt", "createdAt");
        JsonNode filtered = body(perform(bearer(get("/api/translate/sessions").param("keyword", "客服"), token))).path("data");
        assertThat(filtered.path("records").size()).isEqualTo(1);
        assertThat(filtered.path("records").get(0).path("id").asLong()).isEqualTo(a);

        String other = registerUser(uniqueName("so"), "Passw0rd!");
        String otherToken = accessToken(other, "Passw0rd!");
        assertThat(body(perform(bearer(get("/api/translate/sessions"), otherToken))).path("data").path("total").asInt())
                .isZero();
        for (MvcResult r : List.of(
                perform(bearer(get("/api/translate/sessions/" + a), otherToken)),
                perform(jsonBody(bearer(put("/api/translate/sessions/" + a), otherToken), Map.of("title", "x"))),
                perform(bearer(delete("/api/translate/sessions/" + a), otherToken)),
                perform(bearer(put("/api/translate/sessions/" + a + "/records/1/adopt"), otherToken)))) {
            assertThat(r.getResponse().getStatus()).isEqualTo(404);
            assertThat(body(r).path("code").asString()).isEqualTo("A0404");
        }
    }

    @Test
    void updateChangesOnlyGivenFields() throws Exception {
        long id = createSession(Map.of("title", "旧标题", "targetLang", "zh", "domain", "医学"));
        long glossary = jdbcTemplate.queryForObject("""
                INSERT INTO biz.glossary (owner_id, name, source_lang, target_lang, scope)
                VALUES (?, 'mine', 'en', 'zh', 'PRIVATE') RETURNING id""", Long.class, userId);
        Map<String, Object> req = new HashMap<>();
        req.put("style", "fluent");
        req.put("clarifyEnabled", false);
        req.put("glossaryIds", List.of(glossary, glossary));
        req.put("domain", "");
        JsonNode s = body(perform(jsonBody(bearer(put("/api/translate/sessions/" + id), token), req))).path("data");
        assertThat(s.path("title").asString()).isEqualTo("旧标题");
        assertThat(s.path("style").asString()).isEqualTo("fluent");
        assertThat(s.path("clarifyEnabled").asBoolean()).isFalse();
        assertThat(s.path("domain").isNull()).isTrue();
        assertThat(s.path("glossaryIds").size()).isEqualTo(1);
        assertThat(s.path("targetLang").asString()).isEqualTo("zh");

        Map<String, Object> rename = Map.of("title", " 新标题 ", "sourceLang", "en", "targetLang", "ja",
                "modelConfigId", insertModelConfig("ss-on", true));
        s = body(perform(jsonBody(bearer(put("/api/translate/sessions/" + id), token), rename))).path("data");
        assertThat(s.path("title").asString()).isEqualTo("新标题");
        assertThat(s.path("sourceLang").asString()).isEqualTo("en");
        assertThat(s.path("targetLang").asString()).isEqualTo("ja");
        assertThat(s.path("style").asString()).isEqualTo("fluent");
        assertThat(s.path("glossaryIds").size()).isEqualTo(1);

        MvcResult same = perform(jsonBody(bearer(put("/api/translate/sessions/" + id), token), Map.of("targetLang", "en")));
        assertThat(body(same).path("code").asString()).isEqualTo("A0410");
    }

    @Test
    void detailGroupsVersionsByTurnAndAdoptSwitchesVersion() throws Exception {
        long id = createSession();
        long t1 = insertRecord(id, "I bought the X200.", "我买了 X200。", null, true, "0 minute");
        long t2 = insertRecord(id, "It broke.", "它坏了。", null, false, "1 minute");
        long t2v2 = insertRecord(id, "It broke.", "它坏掉啦。", t2, true, "2 minute");
        jdbcTemplate.update("""
                UPDATE biz.translation_session SET memory_summary = '用户买了耳机', memorized_until = 0, turn_count = 2,
                  memory_entities = '[{"source":"X200","target":"X200","note":"耳机型号"}]'::jsonb,
                  pending = '{"threadId":"turn:abc","question":"bank 指什么？","options":["银行","河岸"],"span":"bank",
                  "reason":"多义词","source":"Send it to the bank.","request":{}}'::jsonb WHERE id = ?""", id);
        JsonNode d = detail(id);
        assertThat(d.path("hasPending").asBoolean()).isTrue();
        assertThat(d.path("memorySummary").asString()).isEqualTo("用户买了耳机");
        assertThat(d.path("memoryEntities").get(0).path("note").asString()).isEqualTo("耳机型号");
        JsonNode pending = d.path("pending");
        assertThat(names(pending)).containsExactlyInAnyOrder("threadId", "question", "options", "span", "reason", "source");
        assertThat(pending.path("options").get(1).asString()).isEqualTo("河岸");
        JsonNode turns = d.path("turns");
        assertThat(turns.size()).isEqualTo(2);
        assertThat(turns.get(0).path("seq").asInt()).isEqualTo(1);
        assertThat(turns.get(0).path("adoptedRecordId").asLong()).isEqualTo(t1);
        assertThat(turns.get(0).path("versions").get(0).path("clarification").path("answer").asString()).isEqualTo("银行");
        JsonNode v = turns.get(1).path("versions");
        assertThat(v.size()).isEqualTo(2);
        assertThat(v.get(0).path("id").asLong()).isEqualTo(t2);
        assertThat(v.get(0).path("adopted").asBoolean()).isFalse();
        assertThat(v.get(1).path("revisionOf").asLong()).isEqualTo(t2);
        assertThat(v.get(1).path("reviseInstruction").asString()).isEqualTo("更口语一些");
        assertThat(v.get(1).path("mode").asString()).isEqualTo("revise");
        assertThat(names(v.get(1))).containsExactlyInAnyOrder("id", "sourceText", "targetText", "mode", "path",
                "reviseInstruction", "clarification", "revisionOf", "adopted", "reviewScore", "createdAt");
        assertThat(turns.get(1).path("adoptedRecordId").asLong()).isEqualTo(t2v2);

        JsonNode adopted = body(perform(bearer(put("/api/translate/sessions/" + id + "/records/" + t2 + "/adopt"), token)))
                .path("data");
        assertThat(adopted.path("turns").get(1).path("adoptedRecordId").asLong()).isEqualTo(t2);
        assertThat(jdbcTemplate.queryForList("SELECT adopted FROM biz.translation_record WHERE id IN (?, ?) ORDER BY id",
                Boolean.class, t2, t2v2)).containsExactly(true, false);
        assertThat(jdbcTemplate.queryForObject("SELECT adopted FROM biz.translation_record WHERE id = ?", Boolean.class, t1))
                .isTrue();

        // 记录不属于该会话
        long otherSession = createSession();
        MvcResult wrong = perform(bearer(put("/api/translate/sessions/" + otherSession + "/records/" + t1 + "/adopt"), token));
        assertThat(wrong.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(wrong).path("code").asString()).isEqualTo("A0404");

        // 历史列表与详情带会话字段
        JsonNode list = body(perform(bearer(get("/api/translations"), token))).path("data").path("records");
        JsonNode newest = list.get(0);
        assertThat(newest.path("id").asLong()).isEqualTo(t2v2);
        assertThat(newest.path("sessionId").asLong()).isEqualTo(id);
        assertThat(newest.path("revisionOf").asLong()).isEqualTo(t2);
        assertThat(newest.path("reviseInstruction").asString()).isEqualTo("更口语一些");
        assertThat(newest.path("adopted").asBoolean()).isFalse();
        assertThat(newest.has("clarification")).isTrue();
        JsonNode rd = body(perform(bearer(get("/api/translations/" + t1), token))).path("data");
        assertThat(rd.path("sessionId").asLong()).isEqualTo(id);
        assertThat(rd.path("revisionOf").isNull()).isTrue();
        assertThat(rd.path("clarification").path("question").asString()).isEqualTo("bank 指什么？");
        assertThat(rd.path("adopted").asBoolean()).isTrue();
    }

    @Test
    void deletedRecordKeepsTurnNumberingAndIsHidden() throws Exception {
        long id = createSession();
        long t1 = insertRecord(id, "one", "一", null, true, "0 minute");
        insertRecord(id, "two", "二", null, true, "1 minute");
        perform(bearer(delete("/api/translations/" + t1), token));
        JsonNode turns = detail(id).path("turns");
        assertThat(turns.size()).isEqualTo(1);
        assertThat(turns.get(0).path("seq").asInt()).isEqualTo(2);
    }

    @Test
    void deleteSessionKeepsRecordsInHistory() throws Exception {
        long id = createSession();
        long r1 = insertRecord(id, "one", "一", null, true, "0 minute");
        long r2 = insertRecord(id, "two", "二", null, true, "1 minute");
        long r3 = insertRecord(id, "three", "三", null, true, "2 minute");
        jdbcTemplate.update("""
                UPDATE biz.translation_session SET pending = '{"threadId":"turn:del-me","question":"q"}'::jsonb
                WHERE id = ?""", id);
        MvcResult r = perform(bearer(delete("/api/translate/sessions/" + id), token));
        assertThat(body(r).path("code").asString()).isEqualTo("00000");
        assertThat(body(perform(bearer(get("/api/translate/sessions"), token))).path("data").path("total").asInt()).isZero();
        assertThat(perform(bearer(get("/api/translate/sessions/" + id), token)).getResponse().getStatus()).isEqualTo(404);
        JsonNode list = body(perform(bearer(get("/api/translations"), token))).path("data");
        assertThat(list.path("total").asInt()).isEqualTo(3);
        for (long rid : List.of(r1, r2, r3)) {
            assertThat(body(perform(bearer(get("/api/translations/" + rid), token))).path("data").path("sessionId").asLong())
                    .isEqualTo(id);
        }
        // 未回答的追问随会话删除一并清理检查点
        assertThat(mockAi().requests("/internal/translate/threads/turn:del-me")).hasSize(1);
    }
}
