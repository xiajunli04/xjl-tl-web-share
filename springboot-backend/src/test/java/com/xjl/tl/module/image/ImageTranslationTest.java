package com.xjl.tl.module.image;

import com.xjl.tl.common.config.MediaProperties;
import com.xjl.tl.support.MockAiServer;
import com.xjl.tl.support.SseTestClient.Event;
import com.xjl.tl.support.SseTestClient.FilePart;
import com.xjl.tl.support.SseTestClient.Session;
import com.xjl.tl.support.StreamingTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * image-translation「图片提交」「两步法图片翻译流程」「一体化图片翻译引擎」「图片翻译记录」/ tasks 6.3、6.4：
 * 校验（A0450 / C0170）、原图落盘、SSE 转发与 done 落库补 id、结果图落盘、错误时删除原图、记录检索 / 详情 /
 * 图片读取 / 编辑 / 收藏 / 删除与用户隔离。
 */
class ImageTranslationTest extends StreamingTestBase {

    private static final String BASE = "/api/image-translations";
    private static final Duration WAIT = Duration.ofSeconds(10);

    @Autowired
    private MediaProperties mediaProperties;

    private String token;
    private long userId;
    private long visionModel;

    @BeforeEach
    void user() throws Exception {
        String name = registerUser(uniqueName("im"), "Passw0rd!");
        token = accessToken(name, "Passw0rd!");
        userId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ?", Long.class, name);
        visionModel = insertModel("CHAT", "OPENAI_COMPATIBLE", true);
    }

    private long insertModel(String capability, String provider, boolean vision) {
        return jdbcTemplate.queryForObject("""
                INSERT INTO biz.model_config (name, provider, capability, supports_vision, base_url, model_name,
                  api_key_cipher, api_key_mask, enabled)
                VALUES (?, ?, ?, ?, 'https://x', 'm', 'v1:x', '****', true) RETURNING id""", Long.class,
                uniqueName("m"), provider, capability, vision);
    }

    private Map<String, Object> form(byte[] image, String targetLang, Object modelConfigId) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("image", new FilePart("menu.png", "image/png", image));
        m.put("targetLang", targetLang);
        if (modelConfigId != null) {
            m.put("modelConfigId", String.valueOf(modelConfigId));
        }
        return m;
    }

    private Path stored(String rel) {
        return Path.of(mediaProperties.storageDir()).toAbsolutePath().normalize().resolve(rel);
    }

    private long countImages() {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM biz.image_translation WHERE user_id = ?", Long.class, userId);
    }

    /** 提交一张菜单图（vision 引擎，目标 en），返回记录 id。 */
    private long translateMenu() throws Exception {
        try (Session s = sse().multipart(BASE, token, form(ImageInspectorTest.encode("png", 200, 100), "en", visionModel))) {
            List<Event> events = s.readAll(WAIT).stream().filter(e -> !e.isComment()).toList();
            Event done = events.getLast();
            assertThat(done.event()).as("events=%s", events).isEqualTo("done");
            return jsonMapper.readTree(done.data()).path("id").asLong();
        }
    }

    @Test
    void visionTranslationIsForwardedAndPersistedWithId() throws Exception {
        byte[] png = ImageInspectorTest.encode("png", 200, 100);
        Map<String, Object> f = form(png, "en", visionModel);
        f.put("glossaryIds", List.of());
        try (Session s = sse().multipart(BASE, token, f)) {
            assertThat(s.status()).isEqualTo(200);
            List<Event> events = s.readAll(WAIT).stream().filter(e -> !e.isComment()).toList();
            assertThat(events).extracting(Event::event).containsExactly("start", "node", "node", "blocks", "node", "node",
                    "node", "translation", "node", "done");
            JsonNode done = jsonMapper.readTree(events.getLast().data());
            long id = done.path("id").asLong();
            assertThat(id).isPositive();
            assertThat(done.path("blocks")).hasSize(2);

            Map<String, Object> row = jdbcTemplate.queryForMap("SELECT * FROM biz.image_translation WHERE id = ?", id);
            assertThat(row.get("user_id")).isEqualTo(userId);
            assertThat(row.get("engine")).isEqualTo("vision");
            assertThat(row.get("model_config_id")).isEqualTo(visionModel);
            assertThat(row.get("mime")).isEqualTo("image/png");
            assertThat(row.get("width")).isEqualTo(200);
            assertThat(row.get("height")).isEqualTo(100);
            assertThat(row.get("size_bytes")).isEqualTo(png.length);
            assertThat(row.get("source_lang")).isEqualTo("auto");
            assertThat(row.get("detected_lang")).isEqualTo("zh");
            assertThat(row.get("search_text")).isEqualTo("宫保鸡丁\nKung Pao Chicken\n麻婆豆腐\nMapo Doufu");
            assertThat(row.get("prompt_tokens")).isEqualTo(1500);
            assertThat(row.get("duration_ms")).isEqualTo(5400);
            String path = (String) row.get("image_path");
            assertThat(path).matches("images/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.png");
            assertThat(Files.readAllBytes(stored(path))).isEqualTo(png);
            assertThat(row.get("result_image_path")).isNull();
        }
        MockAiServer.Received up = mockAi().requests("/internal/image/translate").getLast();
        assertThat(up.body().path("userId").asLong()).isEqualTo(userId);
        assertThat(up.body().path("mime").asString()).isEqualTo("image/png");
        assertThat(up.body().path("engine").asString()).isEqualTo("vision");
        assertThat(up.body().path("sourceLang").asString()).isEqualTo("auto");
        assertThat(up.body().path("modelConfigId").asLong()).isEqualTo(visionModel);
        assertThat(up.body().path("requestId").asString()).startsWith("img-");
        assertThat(java.util.Base64.getDecoder().decode(up.body().path("imageBase64").asString())).isEqualTo(png);
    }

    @Test
    void qwenMtImageSavesResultImage() throws Exception {
        long cfg = insertModel("IMAGE_TRANSLATE", "DASHSCOPE", false);
        Map<String, Object> f = form(ImageInspectorTest.encode("jpg", 80, 60), "zh", null);
        f.put("engine", "qwen-mt-image");
        f.put("sourceLang", "en");
        long id;
        try (Session s = sse().multipart(BASE, token, f)) {
            List<Event> events = s.readAll(WAIT).stream().filter(e -> !e.isComment()).toList();
            JsonNode done = jsonMapper.readTree(events.getLast().data());
            assertThat(events.getLast().event()).isEqualTo("done");
            id = done.path("id").asLong();
        }
        assertThat(mockAi().requests("/internal/image/translate").getLast().body().path("modelConfigId").asLong())
                .as("未指定时取启用的 IMAGE_TRANSLATE 配置").isPositive();
        String result = jdbcTemplate.queryForObject("SELECT result_image_path FROM biz.image_translation WHERE id = ?",
                String.class, id);
        assertThat(result).endsWith(".png");
        MvcResult img = perform(bearer(get(BASE + "/" + id + "/result-image"), token));
        assertThat(img.getResponse().getContentType()).isEqualTo("image/png");
        assertThat(img.getResponse().getContentAsByteArray()).isEqualTo(MockAiServer.RESULT_PNG);
        JsonNode detail = body(perform(bearer(get(BASE + "/" + id), token))).path("data");
        assertThat(detail.path("hasResultImage").asBoolean()).isTrue();
        assertThat(detail.path("blockCount").asInt()).isZero();
        assertThat(detail.path("preview").isNull()).isTrue();
        assertThat(detail.path("mime").asString()).isEqualTo("image/jpeg");
        jdbcTemplate.update("UPDATE biz.model_config SET enabled = false WHERE id = ?", cfg);
    }

    @Test
    void invalidImagesAreRejectedWithA0450BeforeStreaming() throws Exception {
        long before = countImages();
        int calls = mockAi().requests("/internal/image/translate").size();
        // 12 MB
        try (Session s = sse().multipart(BASE, token, form(ImageInspectorTest.pngHeader(100, 100, 12 * 1024 * 1024), "en", visionModel))) {
            assertThat(s.status()).isEqualTo(400);
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0450");
        }
        List<byte[]> invalid = List.of(
                "GIF89a not supported".getBytes(),
                ImageInspectorTest.pngHeader(20, 100, 64),
                ImageInspectorTest.pngHeader(100, 9000, 64),
                new byte[0]);
        for (byte[] img : invalid) {
            try (Session s = sse().multipart(BASE, token, form(img, "en", visionModel))) {
                assertThat(s.status()).isEqualTo(400);
                assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0450");
            }
        }
        Map<String, Object> noImage = new LinkedHashMap<>(Map.of("targetLang", "en"));
        try (Session s = sse().multipart(BASE, token, noImage)) {
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0450");
        }
        assertThat(countImages()).isEqualTo(before);
        assertThat(mockAi().requests("/internal/image/translate")).hasSize(calls);
    }

    @Test
    void nonVisionModelAndOtherParametersAreRejected() throws Exception {
        byte[] png = ImageInspectorTest.encode("png", 64, 64);
        long textOnly = insertModel("CHAT", "OPENAI_COMPATIBLE", false);
        try (Session s = sse().multipart(BASE, token, form(png, "en", textOnly))) {
            assertThat(s.status()).isEqualTo(400);
            JsonNode b = s.jsonBody();
            assertThat(b.path("code").asString()).isEqualTo("C0170");
            assertThat(b.path("message").asString()).contains("不支持图片输入");
        }
        long tts = insertModel("TTS", "OPENAI_COMPATIBLE", false);
        try (Session s = sse().multipart(BASE, token, form(png, "en", tts))) {
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("C0170");
        }
        try (Session s = sse().multipart(BASE, token, form(png, "en", 999_999))) {
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("C0130");
        }
        Map<String, Object> qwenWithChat = form(png, "en", visionModel);
        qwenWithChat.put("engine", "qwen-mt-image");
        try (Session s = sse().multipart(BASE, token, qwenWithChat)) {
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
        Map<String, Object> badEngine = form(png, "en", visionModel);
        badEngine.put("engine", "paddle");
        try (Session s = sse().multipart(BASE, token, badEngine)) {
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
        try (Session s = sse().multipart(BASE, token, form(png, "xx", visionModel))) {
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0420");
        }
        Map<String, Object> noTarget = form(png, "en", visionModel);
        noTarget.remove("targetLang");
        try (Session s = sse().multipart(BASE, token, noTarget)) {
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
        Map<String, Object> same = form(png, "en", visionModel);
        same.put("sourceLang", "en");
        try (Session s = sse().multipart(BASE, token, same)) {
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0410");
        }
        Map<String, Object> foreignGlossary = form(png, "en", visionModel);
        foreignGlossary.put("glossaryIds", List.of("987654"));
        try (Session s = sse().multipart(BASE, token, foreignGlossary)) {
            assertThat(s.jsonBody().path("code").asString()).isEqualTo("A0404");
        }
    }

    @Test
    void qwenMtImageWithoutConfigIsUnavailable() throws Exception {
        List<Long> enabled = jdbcTemplate.queryForList(
                "SELECT id FROM biz.model_config WHERE capability = 'IMAGE_TRANSLATE' AND enabled AND NOT deleted", Long.class);
        jdbcTemplate.update("UPDATE biz.model_config SET enabled = false WHERE capability = 'IMAGE_TRANSLATE'");
        try {
            Map<String, Object> f = form(ImageInspectorTest.encode("png", 64, 64), "zh", null);
            f.put("engine", "qwen-mt-image");
            try (Session s = sse().multipart(BASE, token, f)) {
                assertThat(s.status()).isEqualTo(503);
                assertThat(s.jsonBody().path("code").asString()).isEqualTo("C0173");
            }
        } finally {
            for (Long id : enabled) {
                jdbcTemplate.update("UPDATE biz.model_config SET enabled = true WHERE id = ?", id);
            }
        }
    }

    private long storedFiles() throws Exception {
        Path dir = stored("images");
        if (!Files.exists(dir)) {
            return 0;
        }
        try (var files = Files.walk(dir)) {
            return files.filter(p -> Files.isRegularFile(p) && !p.getFileName().toString().endsWith(".tmp")).count();
        }
    }

    @Test
    void upstreamErrorOrTruncatedStreamDeletesStoredImage() throws Exception {
        long before = countImages();
        long filesBefore = storedFiles();
        for (String target : List.of("ko", "ja")) {
            try (Session s = sse().multipart(BASE, token, form(ImageInspectorTest.encode("png", 64, 64), target, visionModel))) {
                List<Event> events = s.readAll(WAIT).stream().filter(e -> !e.isComment()).toList();
                Event last = events.getLast();
                assertThat(last.event()).isEqualTo("error");
                assertThat(jsonMapper.readTree(last.data()).path("code").asString())
                        .isEqualTo("ko".equals(target) ? "C0171" : "C0110");
            }
        }
        assertThat(countImages()).isEqualTo(before);
        // 原图在流结束后被异步删除，不会残留
        await(() -> {
            try {
                return storedFiles() == filesBefore;
            } catch (Exception e) {
                return false;
            }
        });
    }

    @Test
    void recordsCanBeSearchedReadEditedFavoritedAndDeleted() throws Exception {
        long id = translateMenu();
        // 列表与关键词
        JsonNode page = body(perform(bearer(get(BASE).param("keyword", "宫保"), token))).path("data");
        assertThat(page.path("total").asLong()).isEqualTo(1);
        JsonNode item = page.path("records").get(0);
        assertThat(item.path("id").asLong()).isEqualTo(id);
        assertThat(item.path("preview").asString()).isEqualTo("宫保鸡丁 → Kung Pao Chicken");
        assertThat(item.path("blockCount").asInt()).isEqualTo(2);
        assertThat(item.path("hasResultImage").asBoolean()).isFalse();
        assertThat(body(perform(bearer(get(BASE).param("keyword", "kung pao"), token))).path("data").path("total").asLong())
                .isEqualTo(1);
        assertThat(body(perform(bearer(get(BASE).param("keyword", "不存在的菜"), token))).path("data").path("total").asLong())
                .isZero();
        assertThat(body(perform(bearer(get(BASE).param("targetLang", "ja"), token))).path("data").path("total").asLong())
                .isZero();
        assertThat(body(perform(bearer(get(BASE).param("from", "2999-01-01T00:00:00Z"), token))).path("data").path("total").asLong())
                .isZero();

        // 详情与原图
        JsonNode detail = body(perform(bearer(get(BASE + "/" + id), token))).path("data");
        assertThat(detail.path("termHits").get(0).path("followed").asBoolean()).isTrue();
        assertThat(detail.path("trace").get(0).path("node").asString()).isEqualTo("ocr");
        assertThat(detail.path("promptTokens").asInt()).isEqualTo(1500);
        assertThat(detail.path("latencyMs").asInt()).isEqualTo(5400);
        assertThat(detail.path("blocks").get(0).path("bbox")).hasSize(4);
        MvcResult img = perform(bearer(get(BASE + "/" + id + "/image"), token));
        assertThat(img.getResponse().getContentType()).isEqualTo("image/png");
        assertThat(img.getResponse().getHeader("Cache-Control")).contains("private");
        MvcResult noResult = perform(bearer(get(BASE + "/" + id + "/result-image"), token));
        assertThat(noResult.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(noResult).path("code").asString()).isEqualTo("A0404");

        // 编辑译文：同步检索文本，刷新后一致
        JsonNode edited = body(perform(bearer(jsonBody(patch(BASE + "/" + id + "/blocks"),
                Map.of("blocks", List.of(Map.of("id", 2, "translation", "Mapo Tofu")))), token))).path("data");
        assertThat(edited.path("blocks").get(1).path("translation").asString()).isEqualTo("Mapo Tofu");
        assertThat(edited.path("blocks").get(0).path("translation").asString()).isEqualTo("Kung Pao Chicken");
        assertThat(body(perform(bearer(get(BASE + "/" + id), token))).path("data").path("blocks").get(1)
                .path("translation").asString()).isEqualTo("Mapo Tofu");
        assertThat(body(perform(bearer(get(BASE).param("keyword", "Mapo Tofu"), token))).path("data").path("total").asLong())
                .isEqualTo(1);
        MvcResult unknownBlock = perform(bearer(jsonBody(patch(BASE + "/" + id + "/blocks"),
                Map.of("blocks", List.of(Map.of("id", 99, "translation", "x")))), token));
        assertThat(body(unknownBlock).path("code").asString()).isEqualTo("A0410");
        assertThat(body(perform(bearer(jsonBody(patch(BASE + "/" + id + "/blocks"), Map.of("blocks", List.of())), token)))
                .path("code").asString()).isEqualTo("A0410");

        // 收藏
        perform(bearer(jsonBody(put(BASE + "/" + id + "/favorite"), Map.of("favorite", true)), token));
        assertThat(body(perform(bearer(get(BASE).param("favorite", "true"), token))).path("data").path("total").asLong())
                .isEqualTo(1);

        // 删除：逻辑删除 + 异步删除文件
        String path = jdbcTemplate.queryForObject("SELECT image_path FROM biz.image_translation WHERE id = ?", String.class, id);
        assertThat(body(perform(bearer(delete(BASE + "/" + id), token))).path("code").asString()).isEqualTo("00000");
        assertThat(jdbcTemplate.queryForObject("SELECT deleted FROM biz.image_translation WHERE id = ?", Boolean.class, id))
                .isTrue();
        await(() -> !Files.exists(stored(path)));
        assertThat(perform(bearer(get(BASE + "/" + id), token)).getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void otherUsersRecordsAndImagesAreNotFound() throws Exception {
        long id = translateMenu();
        String other = registerUser(uniqueName("im2"), "Passw0rd!");
        String otherToken = accessToken(other, "Passw0rd!");
        for (String path : List.of("", "/image", "/result-image")) {
            MvcResult r = perform(bearer(get(BASE + "/" + id + path), otherToken));
            assertThat(r.getResponse().getStatus()).isEqualTo(404);
            assertThat(body(r).path("code").asString()).isEqualTo("A0404");
        }
        assertThat(body(perform(bearer(jsonBody(put(BASE + "/" + id + "/favorite"), Map.of("favorite", true)), otherToken)))
                .path("code").asString()).isEqualTo("A0404");
        assertThat(body(perform(bearer(delete(BASE + "/" + id), otherToken))).path("code").asString()).isEqualTo("A0404");
        assertThat(body(perform(bearer(jsonBody(patch(BASE + "/" + id + "/blocks"),
                Map.of("blocks", List.of(Map.of("id", 1, "translation", "x")))), otherToken))).path("code").asString())
                .isEqualTo("A0404");
        assertThat(body(perform(bearer(get(BASE), otherToken))).path("data").path("total").asLong()).isZero();
    }

    @Test
    void missingImageFileReturnsNotFound() throws Exception {
        long id = translateMenu();
        String path = jdbcTemplate.queryForObject("SELECT image_path FROM biz.image_translation WHERE id = ?", String.class, id);
        Files.delete(stored(path));
        MvcResult r = perform(bearer(get(BASE + "/" + id + "/image"), token));
        assertThat(r.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(r).path("message").asString()).contains("图片文件不存在");
    }
}
