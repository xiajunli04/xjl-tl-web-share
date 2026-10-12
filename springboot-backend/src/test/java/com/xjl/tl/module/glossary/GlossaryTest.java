package com.xjl.tl.module.glossary;

import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * glossary 规格「术语库管理」/ tasks 4.4：CRUD 与可见性规则。
 */
class GlossaryTest extends IntegrationTestBase {

    static final String BASE = "/api/glossaries";

    private String alice;
    private String bob;

    @BeforeEach
    void users() throws Exception {
        alice = accessToken(registerUser(uniqueName("ga"), "Passw0rd!"), "Passw0rd!");
        bob = accessToken(registerUser(uniqueName("gb"), "Passw0rd!"), "Passw0rd!");
    }

    static Map<String, Object> glossary(String name, String scope) {
        Map<String, Object> m = new HashMap<>();
        m.put("name", name);
        m.put("description", "测试术语库");
        m.put("sourceLang", "en");
        m.put("targetLang", "zh");
        m.put("domain", "计算机");
        if (scope != null) {
            m.put("scope", scope);
        }
        return m;
    }

    private JsonNode create(String token, Map<String, Object> req) throws Exception {
        MvcResult r = perform(jsonBody(bearer(post(BASE), token), req));
        assertThat(body(r).path("code").asString()).as(body(r).toString()).isEqualTo("00000");
        return body(r).path("data");
    }

    private static List<Long> ids(JsonNode page) {
        return page.path("records").valueStream().map(n -> n.path("id").asLong()).toList();
    }

    @Test
    void createPrivateGlossary() throws Exception {
        JsonNode g = create(alice, glossary("CS 术语", null));
        assertThat(g.path("scope").asString()).isEqualTo("PRIVATE");
        assertThat(g.path("termCount").asInt()).isZero();
        assertThat(g.path("editable").asBoolean()).isTrue();
        assertThat(g.path("domain").asString()).isEqualTo("计算机");
        assertThat(g.path("ownerName").asString()).isNotBlank();
        long id = g.path("id").asLong();
        // 只有拥有者可见
        assertThat(ids(body(perform(bearer(get(BASE).param("pageSize", "100"), alice))).path("data"))).contains(id);
        assertThat(ids(body(perform(bearer(get(BASE).param("pageSize", "100"), bob))).path("data"))).doesNotContain(id);
    }

    @Test
    void normalUserCannotCreatePublicGlossary() throws Exception {
        MvcResult r = perform(jsonBody(bearer(post(BASE), alice), glossary("pub", "PUBLIC")));
        assertThat(r.getResponse().getStatus()).isEqualTo(403);
        assertThat(body(r).path("code").asString()).isEqualTo("A0301");
    }

    @Test
    void accessingOthersPrivateGlossaryReturns404() throws Exception {
        long id = create(bob, glossary("bob 的库", null)).path("id").asLong();
        MvcResult terms = perform(bearer(get(BASE + "/" + id + "/terms"), alice));
        assertThat(terms.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(terms).path("code").asString()).isEqualTo("A0404");
        assertThat(perform(bearer(get(BASE + "/" + id), alice)).getResponse().getStatus()).isEqualTo(404);
        MvcResult upd = perform(jsonBody(bearer(put(BASE + "/" + id), alice), glossary("x", null)));
        assertThat(body(upd).path("code").asString()).isEqualTo("A0404");
        assertThat(body(perform(bearer(delete(BASE + "/" + id), alice))).path("code").asString()).isEqualTo("A0404");
    }

    @Test
    void publicGlossaryIsReadOnlyForNormalUsers() throws Exception {
        String admin = adminToken();
        JsonNode pub = create(admin, glossary("公共计算机术语", "PUBLIC"));
        long id = pub.path("id").asLong();
        assertThat(pub.path("editable").asBoolean()).isTrue();

        MvcResult add = perform(jsonBody(bearer(post(BASE + "/" + id + "/terms"), alice),
                Map.of("sourceTerm", "GPU", "targetTerm", "图形处理器")));
        assertThat(add.getResponse().getStatus()).isEqualTo(403);
        assertThat(body(add).path("code").asString()).isEqualTo("A0301");

        JsonNode list = body(perform(bearer(get(BASE).param("scope", "PUBLIC").param("pageSize", "100"), alice))).path("data");
        JsonNode item = list.path("records").valueStream().filter(n -> n.path("id").asLong() == id).findFirst().orElseThrow();
        assertThat(item.path("editable").asBoolean()).isFalse();
        assertThat(item.path("scope").asString()).isEqualTo("PUBLIC");
        // 普通用户可以读公共库的术语，但不能修改或删除公共库
        assertThat(perform(bearer(get(BASE + "/" + id + "/terms"), alice)).getResponse().getStatus()).isEqualTo(200);
        assertThat(perform(jsonBody(bearer(put(BASE + "/" + id), alice), glossary("x", null))).getResponse().getStatus())
                .isEqualTo(403);
        assertThat(perform(bearer(delete(BASE + "/" + id), alice)).getResponse().getStatus()).isEqualTo(403);
    }

    @Test
    void ownerCanUpdateButNotPromoteToPublicAndCanDelete() throws Exception {
        long id = create(alice, glossary("old", null)).path("id").asLong();
        Map<String, Object> req = glossary("new name", null);
        req.put("description", null);
        req.put("targetLang", "ja");
        JsonNode updated = body(perform(jsonBody(bearer(put(BASE + "/" + id), alice), req))).path("data");
        assertThat(updated.path("name").asString()).isEqualTo("new name");
        assertThat(updated.path("targetLang").asString()).isEqualTo("ja");
        assertThat(updated.path("description").isNull()).isTrue();

        MvcResult promote = perform(jsonBody(bearer(put(BASE + "/" + id), alice), glossary("new name", "PUBLIC")));
        assertThat(body(promote).path("code").asString()).isEqualTo("A0301");

        assertThat(body(perform(bearer(delete(BASE + "/" + id), alice))).path("code").asString()).isEqualTo("00000");
        assertThat(jdbcTemplate.queryForObject("SELECT deleted FROM biz.glossary WHERE id = ?", Boolean.class, id)).isTrue();
        assertThat(perform(bearer(get(BASE + "/" + id), alice)).getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void unsupportedLanguageReturnsA0420AndKeywordSearchIsCaseInsensitive() throws Exception {
        Map<String, Object> bad = glossary("bad", null);
        bad.put("sourceLang", "xx");
        MvcResult r = perform(jsonBody(bearer(post(BASE), alice), bad));
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(r).path("code").asString()).isEqualTo("A0420");

        String tag = "Kw" + System.nanoTime();
        long id = create(alice, glossary(tag + " Medical", null)).path("id").asLong();
        JsonNode page = body(perform(bearer(get(BASE).param("keyword", tag.toLowerCase() + " med"), alice))).path("data");
        assertThat(ids(page)).containsExactly(id);
    }

    @Test
    void glossaryWritesAreOperationLogged() throws Exception {
        String trace = "glossary-log-" + System.nanoTime();
        perform(jsonBody(bearer(post(BASE), alice), glossary("logged", null)).header("X-Trace-Id", trace));
        await(() -> jdbcTemplate.queryForObject("SELECT count(*) FROM biz.operation_log WHERE trace_id = ?",
                Integer.class, trace) == 1);
        Map<String, Object> row = jdbcTemplate.queryForMap("SELECT module, action, result_code FROM biz.operation_log WHERE trace_id = ?", trace);
        assertThat(row.get("module")).isEqualTo("术语库");
        assertThat(row.get("action")).isEqualTo("新建术语库");
        assertThat(row.get("result_code")).isEqualTo("00000");
    }
}
