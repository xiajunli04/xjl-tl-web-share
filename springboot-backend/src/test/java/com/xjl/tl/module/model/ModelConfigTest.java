package com.xjl.tl.module.model;

import com.xjl.tl.common.crypto.AesGcmCipher;
import com.xjl.tl.module.model.service.ModelConfigService;
import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * model-config：模型配置管理、密钥加密存储、默认模型与评审模型。
 */
class ModelConfigTest extends IntegrationTestBase {

    private static final String API_KEY = "sk-deepseek-secret-abcd";
    private static final String BASE = "/api/admin/model-configs";

    @Autowired
    private AesGcmCipher cipher;
    @Autowired
    private ModelConfigService modelConfigService;

    private String admin;

    @BeforeEach
    void setUp() throws Exception {
        admin = adminToken();
    }

    private Map<String, Object> deepseek(String name, String apiKey) {
        Map<String, Object> m = new HashMap<>();
        m.put("name", name);
        m.put("provider", "OPENAI_COMPATIBLE");
        m.put("baseUrl", "https://api.deepseek.com/v1");
        m.put("modelName", "deepseek-chat");
        m.put("apiKey", apiKey);
        m.put("params", Map.of("temperature", 0.3, "maxTokens", 1024, "timeoutSeconds", 30));
        m.put("remark", "测试");
        return m;
    }

    private JsonNode create(String name) throws Exception {
        MvcResult r = perform(jsonBody(bearer(post(BASE), admin), deepseek(name, API_KEY)));
        assertThat(body(r).path("code").asString()).as(body(r).toString()).isEqualTo("00000");
        return body(r).get("data");
    }

    @Test
    void createDeepSeekReturnsMaskOnly() throws Exception {
        MvcResult r = perform(jsonBody(bearer(post(BASE), admin), deepseek("DeepSeek", API_KEY)));
        String raw = r.getResponse().getContentAsString();
        JsonNode data = body(r).get("data");
        assertThat(data.path("apiKeyMask").asString()).isEqualTo("sk-****abcd");
        assertThat(data.path("provider").asString()).isEqualTo("OPENAI_COMPATIBLE");
        assertThat(data.path("baseUrl").asString()).isEqualTo("https://api.deepseek.com/v1");
        assertThat(data.path("modelName").asString()).isEqualTo("deepseek-chat");
        assertThat(data.path("params").path("maxTokens").asInt()).isEqualTo(1024);
        assertThat(data.path("params").path("temperature").asDouble()).isEqualTo(0.3);
        assertThat(data.path("isDefault").asBoolean()).isFalse();
        assertThat(data.path("enabled").asBoolean()).isTrue();
        assertThat(data.has("apiKey")).isFalse();
        assertThat(data.has("apiKeyCipher")).isFalse();
        assertThat(raw).doesNotContain(API_KEY).doesNotContain("v1:");
        // 详情接口同样只返回掩码
        MvcResult detail = perform(bearer(get(BASE + "/" + data.path("id").asLong()), admin));
        assertThat(detail.getResponse().getContentAsString()).doesNotContain(API_KEY).contains("sk-****abcd");
    }

    @Test
    void createWithoutApiKeyIsRejected() throws Exception {
        MvcResult r = perform(jsonBody(bearer(post(BASE), admin), deepseek("NoKey", "")));
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(r).path("code").asString()).isEqualTo("A0410");
        assertThat(body(r).path("data").get(0).path("field").asString()).isEqualTo("apiKey");
    }

    @Test
    void databaseStoresOnlyCipherAndParamsAsJsonb() throws Exception {
        long id = create("Cipher").path("id").asLong();
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "SELECT api_key_cipher, api_key_mask, params::text AS params FROM biz.model_config WHERE id = ?", id);
        String stored = (String) row.get("api_key_cipher");
        assertThat(stored).startsWith("v1:").doesNotContain(API_KEY);
        assertThat(cipher.decrypt(stored)).isEqualTo(API_KEY);
        assertThat(row.get("api_key_mask")).isEqualTo("sk-****abcd");
        assertThat((String) row.get("params")).contains("\"maxTokens\": 1024").contains("\"timeoutSeconds\": 30");
    }

    @Test
    void editWithBlankApiKeyKeepsOriginal() throws Exception {
        long id = create("Edit").path("id").asLong();
        String before = jdbcTemplate.queryForObject("SELECT api_key_cipher FROM biz.model_config WHERE id = ?", String.class, id);
        Map<String, Object> req = deepseek("Edited", null);
        req.put("modelName", "deepseek-reasoner");
        MvcResult r = perform(jsonBody(bearer(put(BASE + "/" + id), admin), req));
        JsonNode data = body(r).get("data");
        assertThat(data.path("name").asString()).isEqualTo("Edited");
        assertThat(data.path("modelName").asString()).isEqualTo("deepseek-reasoner");
        assertThat(data.path("apiKeyMask").asString()).isEqualTo("sk-****abcd");
        String after = jdbcTemplate.queryForObject("SELECT api_key_cipher FROM biz.model_config WHERE id = ?", String.class, id);
        assertThat(after).isEqualTo(before);

        // 提供新密钥时更新
        perform(jsonBody(bearer(put(BASE + "/" + id), admin), deepseek("Edited", "sk-another-key-9999")));
        String updated = jdbcTemplate.queryForObject("SELECT api_key_cipher FROM biz.model_config WHERE id = ?", String.class, id);
        assertThat(cipher.decrypt(updated)).isEqualTo("sk-another-key-9999");
    }

    @Test
    void switchDefaultModel() throws Exception {
        long a = create("A").path("id").asLong();
        long b = create("B").path("id").asLong();
        assertThat(body(perform(bearer(put(BASE + "/" + a + "/default"), admin))).path("code").asString()).isEqualTo("00000");
        assertThat(isDefault(a)).isTrue();
        perform(bearer(put(BASE + "/" + b + "/default"), admin));
        assertThat(isDefault(b)).isTrue();
        assertThat(isDefault(a)).isFalse();
        assertThat(jdbcTemplate.queryForObject(
                "SELECT count(*) FROM biz.model_config WHERE is_default AND NOT deleted AND capability = 'CHAT'", Integer.class)).isEqualTo(1);
    }

    @Test
    void disablingDefaultClearsDefaultFlag() throws Exception {
        long id = create("Def").path("id").asLong();
        perform(bearer(put(BASE + "/" + id + "/default"), admin));
        MvcResult r = perform(jsonBody(bearer(put(BASE + "/" + id + "/enabled"), admin), Map.of("enabled", false)));
        assertThat(body(r).path("code").asString()).isEqualTo("00000");
        Map<String, Object> row = jdbcTemplate.queryForMap("SELECT enabled, is_default FROM biz.model_config WHERE id = ?", id);
        assertThat(row.get("enabled")).isEqualTo(false);
        assertThat(row.get("is_default")).isEqualTo(false);
        assertThat(jdbcTemplate.queryForObject(
                "SELECT count(*) FROM biz.model_config WHERE is_default AND NOT deleted AND capability = 'CHAT'", Integer.class)).isZero();
        // 停用的配置不能设为默认
        MvcResult again = perform(bearer(put(BASE + "/" + id + "/default"), admin));
        assertThat(body(again).path("code").asString()).isEqualTo("A0410");
    }

    @Test
    void deletingDefaultClearsDefaultAndHidesConfig() throws Exception {
        long id = create("Del").path("id").asLong();
        perform(bearer(put(BASE + "/" + id + "/default"), admin));
        assertThat(body(perform(bearer(delete(BASE + "/" + id), admin))).path("code").asString()).isEqualTo("00000");
        Map<String, Object> row = jdbcTemplate.queryForMap("SELECT deleted, is_default FROM biz.model_config WHERE id = ?", id);
        assertThat(row.get("deleted")).isEqualTo(true);
        assertThat(row.get("is_default")).isEqualTo(false);
        MvcResult r = perform(bearer(get(BASE + "/" + id), admin));
        assertThat(r.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(r).path("code").asString()).isEqualTo("A0404");
    }

    @Test
    void pageWithKeyword() throws Exception {
        String tag = "kw" + System.nanoTime() % 100000;
        create(tag + "-one");
        create(tag + "-two");
        MvcResult r = perform(bearer(get(BASE).param("keyword", tag).param("pageSize", "1"), admin));
        JsonNode data = body(r).get("data");
        assertThat(data.path("total").asLong()).isEqualTo(2);
        assertThat(data.path("records").size()).isEqualTo(1);
        assertThat(data.path("records").get(0).path("name").asString()).isEqualTo(tag + "-two");
    }

    @Test
    void invalidProviderAndUrlRejected() throws Exception {
        Map<String, Object> req = deepseek("Bad", API_KEY);
        req.put("provider", "GEMINI");
        req.put("baseUrl", "ftp://x");
        MvcResult r = perform(jsonBody(bearer(post(BASE), admin), req));
        assertThat(body(r).path("code").asString()).isEqualTo("A0410");
        assertThat(body(r).path("data").size()).isEqualTo(2);
    }

    // ---------------- 评审模型 ----------------

    @Test
    void switchReviewModelKeepsAtMostOneAndMayCoincideWithDefault() throws Exception {
        long a = create("RevA").path("id").asLong();
        long b = create("RevB").path("id").asLong();
        assertThat(create("RevNew").path("isReviewDefault").asBoolean()).isFalse();
        assertThat(code(perform(bearer(put(BASE + "/" + a + "/review-default"), admin)))).isEqualTo("00000");
        assertThat(isReviewDefault(a)).isTrue();
        assertThat(modelConfigService.reviewModelId()).isEqualTo(a);
        // 重复设置是幂等的
        assertThat(code(perform(bearer(put(BASE + "/" + a + "/review-default"), admin)))).isEqualTo("00000");

        perform(bearer(put(BASE + "/" + b + "/review-default"), admin));
        assertThat(isReviewDefault(b)).isTrue();
        assertThat(isReviewDefault(a)).isFalse();
        assertThat(reviewCount()).isEqualTo(1);
        assertThat(modelConfigService.reviewModelId()).isEqualTo(b);
        JsonNode detail = body(perform(bearer(get(BASE + "/" + b), admin))).path("data");
        assertThat(detail.path("isReviewDefault").asBoolean()).isTrue();

        // 同一配置可以同时是默认模型和评审模型
        perform(bearer(put(BASE + "/" + b + "/default"), admin));
        detail = body(perform(bearer(get(BASE + "/" + b), admin))).path("data");
        assertThat(detail.path("isDefault").asBoolean()).isTrue();
        assertThat(detail.path("isReviewDefault").asBoolean()).isTrue();
    }

    @Test
    void reviewModelIdIsNullWithoutReviewModel() {
        assertThat(modelConfigService.reviewModelId()).isNull();
        assertThat(modelConfigService.resolveReviewModelId(null)).isNull();
    }

    @Test
    void disablingReviewModelClearsFlagAndDisabledConfigCannotBecomeReviewModel() throws Exception {
        long id = create("RevOff").path("id").asLong();
        perform(bearer(put(BASE + "/" + id + "/review-default"), admin));
        MvcResult r = perform(jsonBody(bearer(put(BASE + "/" + id + "/enabled"), admin), Map.of("enabled", false)));
        assertThat(code(r)).isEqualTo("00000");
        assertThat(isReviewDefault(id)).isFalse();
        assertThat(reviewCount()).isZero();
        assertThat(modelConfigService.reviewModelId()).isNull();

        MvcResult again = perform(bearer(put(BASE + "/" + id + "/review-default"), admin));
        assertThat(again.getResponse().getStatus()).isEqualTo(400);
        assertThat(code(again)).isEqualTo("C0130");
        assertThat(isReviewDefault(id)).isFalse();

        // 编辑接口停用同样清除评审标记
        long other = create("RevEdit").path("id").asLong();
        perform(bearer(put(BASE + "/" + other + "/review-default"), admin));
        Map<String, Object> req = deepseek("RevEdit", null);
        req.put("enabled", false);
        assertThat(code(perform(jsonBody(bearer(put(BASE + "/" + other), admin), req)))).isEqualTo("00000");
        assertThat(isReviewDefault(other)).isFalse();
    }

    @Test
    void deletingReviewModelClearsFlag() throws Exception {
        long id = create("RevDel").path("id").asLong();
        perform(bearer(put(BASE + "/" + id + "/review-default"), admin));
        assertThat(code(perform(bearer(delete(BASE + "/" + id), admin)))).isEqualTo("00000");
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "SELECT deleted, is_review_default FROM biz.model_config WHERE id = ?", id);
        assertThat(row.get("deleted")).isEqualTo(true);
        assertThat(row.get("is_review_default")).isEqualTo(false);
        assertThat(modelConfigService.reviewModelId()).isNull();
        // 删除后可以设置新的评审模型
        long next = create("RevNext").path("id").asLong();
        assertThat(code(perform(bearer(put(BASE + "/" + next + "/review-default"), admin)))).isEqualTo("00000");
    }

    @Test
    void clearReviewModelIsIdempotent() throws Exception {
        long id = create("RevClr").path("id").asLong();
        perform(bearer(put(BASE + "/" + id + "/review-default"), admin));
        for (int i = 0; i < 2; i++) {
            MvcResult r = perform(bearer(delete(BASE + "/" + id + "/review-default"), admin));
            assertThat(r.getResponse().getStatus()).isEqualTo(200);
            assertThat(code(r)).isEqualTo("00000");
        }
        assertThat(isReviewDefault(id)).isFalse();
        assertThat(reviewCount()).isZero();
        // 取消不是评审模型的配置也不影响当前评审模型
        long other = create("RevKeep").path("id").asLong();
        perform(bearer(put(BASE + "/" + other + "/review-default"), admin));
        assertThat(code(perform(bearer(delete(BASE + "/" + id + "/review-default"), admin)))).isEqualTo("00000");
        assertThat(isReviewDefault(other)).isTrue();
    }

    @Test
    void reviewModelEndpointsReturnA0404ForMissingConfig() throws Exception {
        MvcResult set = perform(bearer(put(BASE + "/987654321/review-default"), admin));
        assertThat(set.getResponse().getStatus()).isEqualTo(404);
        assertThat(code(set)).isEqualTo("A0404");
        MvcResult clear = perform(bearer(delete(BASE + "/987654321/review-default"), admin));
        assertThat(clear.getResponse().getStatus()).isEqualTo(404);
        assertThat(code(clear)).isEqualTo("A0404");
    }

    @Test
    void reviewModelEndpointsAreAdminOnlyAndLogged() throws Exception {
        long id = create("RevAuth").path("id").asLong();
        String user = registerUser(uniqueName("rev"), "Passw0rd!");
        String userToken = accessToken(user, "Passw0rd!");
        assertThat(perform(bearer(put(BASE + "/" + id + "/review-default"), userToken)).getResponse().getStatus())
                .isEqualTo(403);
        assertThat(perform(bearer(delete(BASE + "/" + id + "/review-default"), userToken)).getResponse().getStatus())
                .isEqualTo(403);
        assertThat(isReviewDefault(id)).isFalse();

        perform(bearer(put(BASE + "/" + id + "/review-default"), admin));
        perform(bearer(delete(BASE + "/" + id + "/review-default"), admin));
        await(() -> jdbcTemplate.queryForObject("""
                SELECT count(*) FROM biz.operation_log
                WHERE module = '模型配置' AND action IN ('设为评审模型', '取消评审模型')""", Integer.class) >= 2);
    }

    // ---------------- 能力类型（add-speech-and-image-translation D12） ----------------

    private Map<String, Object> withCapability(String name, String capability, String provider) {
        Map<String, Object> m = deepseek(name, API_KEY);
        m.put("capability", capability);
        m.put("provider", provider);
        return m;
    }

    private long createWith(Map<String, Object> req) throws Exception {
        MvcResult r = perform(jsonBody(bearer(post(BASE), admin), req));
        assertThat(code(r)).as(body(r).toString()).isEqualTo("00000");
        return body(r).path("data").path("id").asLong();
    }

    @Test
    void legacyConfigDefaultsToChatCapability() throws Exception {
        JsonNode data = create("Legacy");
        assertThat(data.path("capability").asString()).isEqualTo("CHAT");
        assertThat(data.path("supportsVision").asBoolean()).isFalse();
    }

    @Test
    void realtimeTranslateWithDashscopeAndExtraParams() throws Exception {
        Map<String, Object> req = withCapability("Qwen LiveTranslate", "REALTIME_TRANSLATE", "DASHSCOPE");
        req.put("baseUrl", "wss://dashscope.aliyuncs.com/api-ws/v1/realtime");
        req.put("modelName", "qwen3.8-livetranslate-flash-realtime");
        req.put("params", Map.of("extra", Map.of("voice", "Tina")));
        long id = createWith(req);
        JsonNode data = body(perform(bearer(get(BASE + "/" + id), admin))).path("data");
        assertThat(data.path("capability").asString()).isEqualTo("REALTIME_TRANSLATE");
        assertThat(data.path("provider").asString()).isEqualTo("DASHSCOPE");
        assertThat(data.path("params").path("extra").path("voice").asString()).isEqualTo("Tina");
    }

    @Test
    void invalidCapabilityProviderCombinationRejected() throws Exception {
        MvcResult r = perform(jsonBody(bearer(post(BASE), admin), withCapability("Bad TTS", "TTS", "ANTHROPIC")));
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        assertThat(code(r)).isEqualTo("A0410");
        MvcResult r2 = perform(jsonBody(bearer(post(BASE), admin), withCapability("Bad Img", "IMAGE_TRANSLATE", "OPENAI_COMPATIBLE")));
        assertThat(code(r2)).isEqualTo("A0410");
    }

    @Test
    void realtimeChatCapability() throws Exception {
        Map<String, Object> req = withCapability("Qwen Omni Realtime", "REALTIME_CHAT", "DASHSCOPE");
        req.put("baseUrl", "wss://dashscope.aliyuncs.com/api-ws/v1/realtime");
        req.put("modelName", "qwen3-omni-flash-realtime");
        long id = createWith(req);
        JsonNode data = body(perform(bearer(get(BASE + "/" + id), admin))).path("data");
        assertThat(data.path("capability").asString()).isEqualTo("REALTIME_CHAT");
        assertThat(data.path("provider").asString()).isEqualTo("DASHSCOPE");
        MvcResult bad = perform(jsonBody(bearer(post(BASE), admin), withCapability("Bad RT", "REALTIME_CHAT", "VOLCENGINE")));
        assertThat(bad.getResponse().getStatus()).isEqualTo(400);
        assertThat(code(bad)).isEqualTo("A0410");
    }

    @Test
    void defaultsAreUniquePerCapability() throws Exception {
        long chat = create("ChatDef").path("id").asLong();
        long tts = createWith(withCapability("TtsDef", "TTS", "OPENAI_COMPATIBLE"));
        perform(bearer(put(BASE + "/" + chat + "/default"), admin));
        perform(bearer(put(BASE + "/" + tts + "/default"), admin));
        assertThat(isDefault(chat)).isTrue();
        assertThat(isDefault(tts)).isTrue();
        assertThat(modelConfigService.defaultModelId()).isEqualTo(chat);
        assertThat(modelConfigService.defaultModelId("TTS")).isEqualTo(tts);
        long tts2 = createWith(withCapability("TtsDef2", "TTS", "OPENAI_COMPATIBLE"));
        perform(bearer(put(BASE + "/" + tts2 + "/default"), admin));
        assertThat(isDefault(tts)).isFalse();
        assertThat(isDefault(chat)).isTrue();
    }

    @Test
    void reviewModelMustBeChat() throws Exception {
        long tts = createWith(withCapability("TtsReview", "TTS", "OPENAI_COMPATIBLE"));
        MvcResult r = perform(bearer(put(BASE + "/" + tts + "/review-default"), admin));
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        assertThat(code(r)).isEqualTo("A0410");
    }

    @Test
    void optionsFilterByCapabilityAndVision() throws Exception {
        String tag = "opt" + System.nanoTime() % 100000;
        Map<String, Object> vision = deepseek(tag + "-vision", API_KEY);
        vision.put("supportsVision", true);
        long visionId = createWith(vision);
        long plainId = create(tag + "-plain").path("id").asLong();
        long asrId = createWith(withCapability(tag + "-asr", "ASR", "OPENAI_COMPATIBLE"));
        String user = accessToken(registerUser(uniqueName("mo"), "Passw0rd!"), "Passw0rd!");

        JsonNode chat = body(perform(bearer(get("/api/model-configs/options"), user))).path("data");
        assertThat(ids(chat)).contains(visionId, plainId).doesNotContain(asrId);
        JsonNode onlyVision = body(perform(bearer(get("/api/model-configs/options").param("vision", "true"), user))).path("data");
        assertThat(ids(onlyVision)).contains(visionId).doesNotContain(plainId, asrId);
        JsonNode asr = body(perform(bearer(get("/api/model-configs/options").param("capability", "ASR"), user))).path("data");
        assertThat(ids(asr)).contains(asrId).doesNotContain(visionId);
        assertThat(asr.get(0).path("capability").asString()).isEqualTo("ASR");
        assertThat(asr.toString()).doesNotContain("baseUrl").doesNotContain("apiKeyMask");
    }

    @Test
    void visionFlagIgnoredForNonChat() throws Exception {
        Map<String, Object> req = withCapability("AsrVision", "ASR", "OPENAI_COMPATIBLE");
        req.put("supportsVision", true);
        long id = createWith(req);
        assertThat(jdbcTemplate.queryForObject("SELECT supports_vision FROM biz.model_config WHERE id = ?", Boolean.class, id))
                .isFalse();
    }

    private static java.util.List<Long> ids(JsonNode arr) {
        java.util.List<Long> out = new java.util.ArrayList<>();
        arr.forEach(n -> out.add(n.path("id").asLong()));
        return out;
    }

    private String code(MvcResult r) throws Exception {
        return body(r).path("code").asString();
    }

    private boolean isReviewDefault(long id) {
        return Boolean.TRUE.equals(jdbcTemplate.queryForObject(
                "SELECT is_review_default FROM biz.model_config WHERE id = ?", Boolean.class, id));
    }

    private int reviewCount() {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM biz.model_config WHERE is_review_default AND NOT deleted", Integer.class);
    }

    private boolean isDefault(long id) {
        return Boolean.TRUE.equals(jdbcTemplate.queryForObject("SELECT is_default FROM biz.model_config WHERE id = ?",
                Boolean.class, id));
    }
}
