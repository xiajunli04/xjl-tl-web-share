package com.xjl.tl.common;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.xjl.tl.module.log.aspect.SensitiveMasker;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 2.2：Result 序列化格式、错误码映射、分页参数上限；操作日志脱敏规则。
 */
class CommonUnitTest {

    private final JsonMapper mapper = JsonMapper.builder().build();

    @AfterEach
    void clear() {
        TraceIdHolder.clear();
    }

    @Test
    void successResultSerializesEnvelope() {
        TraceIdHolder.set("abc123");
        JsonNode node = mapper.valueToTree(Result.ok(List.of(1, 2)));
        assertThat(node.path("code").asString()).isEqualTo("00000");
        assertThat(node.path("message").asString()).isEqualTo("成功");
        assertThat(node.path("data").size()).isEqualTo(2);
        assertThat(node.path("traceId").asString()).isEqualTo("abc123");
        assertThat(node.has("success")).as("不应序列化辅助方法").isFalse();
        assertThat(Set.of("code", "message", "data", "traceId")).isEqualTo(propertyNames(node));
    }

    @Test
    void failResultKeepsNullData() {
        JsonNode node = mapper.valueToTree(Result.fail(ErrorCode.BAD_CREDENTIALS));
        assertThat(node.path("code").asString()).isEqualTo("A0201");
        assertThat(node.has("data")).isTrue();
        assertThat(node.get("data").isNull()).isTrue();
    }

    @Test
    void errorCodesFollowDesignTable() {
        assertThat(Arrays.stream(ErrorCode.values()).map(ErrorCode::getCode).collect(Collectors.toSet()))
                .containsExactlyInAnyOrder("00000", "A0111", "A0201", "A0202", "A0211", "A0230", "A0231", "A0232",
                        "A0240", "A0301", "A0404", "A0410", "B0001", "B0100", "C0110", "C0120", "C0121", "C0122",
                        "C0123", "C0130",
                        // add-text-translation-agent 新增
                        "A0112", "A0212", "A0420", "A0421", "C0140", "C0141",
                        // add-document-translation-agent 新增
                        "A0213", "A0430", "A0431", "C0150",
                        // add-session-context-and-memory 新增
                        "A0214", "A0440", "C0160",
                        // add-speech-and-image-translation 新增
                        "A0450", "A0451", "A0452", "A0453", "A0454", "C0170", "C0171", "C0172", "C0173", "C0174");
        assertThat(ErrorCode.ROOM_FULL.getHttpStatus()).isEqualTo(409);
        assertThat(ErrorCode.ROOM_NOT_FOUND.getHttpStatus()).isEqualTo(404);
        assertThat(ErrorCode.WS_TICKET_INVALID.getHttpStatus()).isEqualTo(401);
        assertThat(ErrorCode.SPEECH_ENGINE_UNAVAILABLE.getHttpStatus()).isEqualTo(503);
        assertThat(ErrorCode.SESSION_BUSY.getHttpStatus()).isEqualTo(409);
        assertThat(ErrorCode.CLARIFY_EXPIRED.getHttpStatus()).isEqualTo(409);
        assertThat(ErrorCode.TM_UNAVAILABLE.getHttpStatus()).isEqualTo(503);
        assertThat(ErrorCode.USERNAME_EXISTS.getHttpStatus()).isEqualTo(409);
        assertThat(ErrorCode.LOGIN_LOCKED.getHttpStatus()).isEqualTo(429);
        assertThat(ErrorCode.ACCESS_DENIED.getHttpStatus()).isEqualTo(403);
        assertThat(ErrorCode.AI_SERVICE_UNAVAILABLE.getHttpStatus()).isEqualTo(503);
        assertThat(ErrorCode.LLM_TIMEOUT.getHttpStatus()).isEqualTo(504);
        assertThat(ErrorCode.MODEL_CONFIG_UNAVAILABLE.getHttpStatus()).isEqualTo(400);
        assertThat(ErrorCode.fromCode("C0121")).isEqualTo(ErrorCode.LLM_AUTH_FAILED);
        assertThat(ErrorCode.fromCode("X9999")).isNull();
    }

    @Test
    void translationErrorCodesMapToDesignHttpStatus() {
        assertThat(ErrorCode.TERM_EXISTS.getCode()).isEqualTo("A0112");
        assertThat(ErrorCode.TERM_EXISTS.getHttpStatus()).isEqualTo(409);
        assertThat(ErrorCode.TOO_MANY_REQUESTS.getCode()).isEqualTo("A0212");
        assertThat(ErrorCode.TOO_MANY_REQUESTS.getHttpStatus()).isEqualTo(429);
        assertThat(ErrorCode.LANGUAGE_UNSUPPORTED.getCode()).isEqualTo("A0420");
        assertThat(ErrorCode.LANGUAGE_UNSUPPORTED.getHttpStatus()).isEqualTo(400);
        assertThat(ErrorCode.IMPORT_FILE_INVALID.getCode()).isEqualTo("A0421");
        assertThat(ErrorCode.IMPORT_FILE_INVALID.getHttpStatus()).isEqualTo(400);
        assertThat(ErrorCode.AGENT_FAILED.getCode()).isEqualTo("C0140");
        assertThat(ErrorCode.AGENT_FAILED.getHttpStatus()).isEqualTo(502);
        assertThat(ErrorCode.TRANSLATE_TIMEOUT.getCode()).isEqualTo("C0141");
        assertThat(ErrorCode.TRANSLATE_TIMEOUT.getHttpStatus()).isEqualTo(504);
        assertThat(ErrorCode.fromCode("C0141")).isEqualTo(ErrorCode.TRANSLATE_TIMEOUT);
    }

    @Test
    void pageQueryDefaultsAndCap() {
        PageQuery q = new PageQuery();
        assertThat(q.getPageNum()).isEqualTo(1);
        assertThat(q.getPageSize()).isEqualTo(10);
        q.setPageSize(1000);
        q.setPageNum(0);
        assertThat(q.getPageSize()).isEqualTo(100);
        assertThat(q.getPageNum()).isEqualTo(1);
    }

    @Test
    void pageResultSerializesFields() {
        Page<String> page = new Page<>(2, 100);
        page.setTotal(250);
        page.setRecords(List.of("a"));
        JsonNode node = mapper.valueToTree(PageResult.of(page, (String s) -> s.toUpperCase()));
        assertThat(propertyNames(node)).isEqualTo(Set.of("records", "total", "pageNum", "pageSize"));
        assertThat(node.path("total").asLong()).isEqualTo(250);
        assertThat(node.path("pageNum").asLong()).isEqualTo(2);
        assertThat(node.path("pageSize").asLong()).isEqualTo(100);
        assertThat(node.path("records").get(0).asString()).isEqualTo("A");
    }

    @Test
    void sensitiveFieldsAreMaskedRecursively() {
        JsonNode node = mapper.readTree("""
                {"req":{"name":"n","apiKey":"sk-123","password":"p","params":{"maxTokens":10},
                 "list":[{"refreshToken":"r","oldPassword":"o"}]}}""");
        SensitiveMasker.mask(node);
        JsonNode req = node.get("req");
        assertThat(req.get("apiKey").asString()).isEqualTo(SensitiveMasker.MASK);
        assertThat(req.get("password").asString()).isEqualTo(SensitiveMasker.MASK);
        assertThat(req.get("name").asString()).isEqualTo("n");
        assertThat(req.get("params").get("maxTokens").asInt()).isEqualTo(10);
        assertThat(req.get("list").get(0).get("refreshToken").asString()).isEqualTo(SensitiveMasker.MASK);
        assertThat(req.get("list").get(0).get("oldPassword").asString()).isEqualTo(SensitiveMasker.MASK);
    }

    private static Set<String> propertyNames(JsonNode node) {
        return Set.copyOf(node.propertyNames());
    }
}
