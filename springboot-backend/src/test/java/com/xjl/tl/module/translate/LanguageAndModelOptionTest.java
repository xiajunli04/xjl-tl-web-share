package com.xjl.tl.module.translate;

import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * tasks 4.2 / 4.3：语种清单接口；可用模型选项（model-config 规格「可用模型选项」）。
 */
class LanguageAndModelOptionTest extends IntegrationTestBase {

    @Test
    void languagesReturnsFifteenSupportedLanguages() throws Exception {
        String user = registerUser(uniqueName("lang"), "Passw0rd!");
        MvcResult r = perform(bearer(get("/api/translate/languages"), accessToken(user, "Passw0rd!")));
        JsonNode data = body(r).path("data");
        assertThat(data.size()).isEqualTo(15);
        Set<String> codes = new HashSet<>();
        data.forEach(n -> codes.add(n.path("code").asString()));
        assertThat(codes).containsExactlyInAnyOrder("zh", "en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "ar",
                "th", "vi", "id", "tr");
        JsonNode ja = data.valueStream().filter(n -> n.path("code").asString().equals("ja")).findFirst().orElseThrow();
        assertThat(ja.path("name").asString()).isEqualTo("日语");
        assertThat(ja.path("nativeName").asString()).isEqualTo("日本語");
    }

    @Test
    void languagesRequireLogin() throws Exception {
        assertThat(perform(get("/api/translate/languages")).getResponse().getStatus()).isEqualTo(401);
    }

    @Test
    void userGetsEnabledModelOptionsWithDefaultFirstAndNoSecrets() throws Exception {
        String admin = adminToken();
        long a = createModel(admin, "OptA-" + System.nanoTime());
        long b = createModel(admin, "OptB-" + System.nanoTime());
        perform(bearer(put("/api/admin/model-configs/" + b + "/default"), admin));
        perform(bearer(put("/api/admin/model-configs/" + a + "/review-default"), admin));

        String user = registerUser(uniqueName("opt"), "Passw0rd!");
        MvcResult r = perform(bearer(get("/api/model-configs/options"), accessToken(user, "Passw0rd!")));
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        String raw = r.getResponse().getContentAsString();
        assertThat(raw).doesNotContain("apiKeyMask").doesNotContain("baseUrl").doesNotContain("sk-");
        JsonNode data = body(r).path("data");
        assertThat(data.get(0).path("id").asLong()).isEqualTo(b);
        assertThat(data.get(0).path("isDefault").asBoolean()).isTrue();
        assertThat(data.get(0).path("isReviewDefault").asBoolean()).isFalse();
        assertThat(Set.copyOf(data.get(0).propertyNames()))
                .containsExactlyInAnyOrder("id", "name", "capability", "provider", "isDefault", "isReviewDefault",
                        "supportsVision");
        assertThat(ids(data)).contains(a);
        JsonNode review = data.valueStream().filter(n -> n.path("id").asLong() == a).findFirst().orElseThrow();
        assertThat(review.path("isReviewDefault").asBoolean()).isTrue();
        assertThat(review.path("isDefault").asBoolean()).isFalse();

        // 停用后不再出现
        perform(jsonBody(bearer(put("/api/admin/model-configs/" + a + "/enabled"), admin), Map.of("enabled", false)));
        MvcResult after = perform(bearer(get("/api/model-configs/options"), accessToken(user, "Passw0rd!")));
        assertThat(ids(body(after).path("data"))).doesNotContain(a).contains(b);
    }

    private static List<Long> ids(JsonNode data) {
        return data.valueStream().map(n -> n.path("id").asLong()).toList();
    }

    private long createModel(String admin, String name) throws Exception {
        MvcResult r = perform(jsonBody(bearer(post("/api/admin/model-configs"), admin), Map.of(
                "name", name, "provider", "OPENAI_COMPATIBLE", "baseUrl", "https://api.example.com/v1",
                "modelName", "m", "apiKey", "sk-option-secret-1234")));
        return body(r).path("data").path("id").asLong();
    }
}
