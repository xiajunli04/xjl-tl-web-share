package com.xjl.tl.common;

import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * api-conventions：统一响应、全局异常处理、参数校验、分页、traceId。
 */
class ApiConventionsTest extends IntegrationTestBase {

    @Test
    void successResponseHasCodeDataAndTraceId() throws Exception {
        MvcResult r = perform(get("/test-support/ok"));
        JsonNode b = body(r);
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        assertThat(b.path("code").asString()).isEqualTo("00000");
        assertThat(b.path("data").asString()).isEqualTo("pong");
        assertThat(b.path("traceId").asString()).isNotBlank();
    }

    @Test
    void bizExceptionMapsCodeMessageAndHttpStatus() throws Exception {
        MvcResult r = perform(get("/test-support/biz"));
        JsonNode b = body(r);
        assertThat(r.getResponse().getStatus()).isEqualTo(409);
        assertThat(b.path("code").asString()).isEqualTo("A0111");
        assertThat(b.path("message").asString()).isEqualTo("用户名已存在");
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void unexpectedExceptionReturnsB0001WithoutStackTrace(CapturedOutput output) throws Exception {
        MvcResult r = perform(get("/test-support/npe").header("X-Trace-Id", "npe-trace-42"));
        String raw = r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        JsonNode b = body(r);
        assertThat(r.getResponse().getStatus()).isEqualTo(500);
        assertThat(b.path("code").asString()).isEqualTo("B0001");
        assertThat(b.path("message").asString()).isEqualTo("系统执行出错");
        assertThat(b.path("traceId").asString()).isNotBlank();
        assertThat(raw).doesNotContain("NullPointerException").doesNotContain("at com.xjl").doesNotContain("Exception");
        // 服务端日志中可按 traceId 查到完整堆栈
        assertThat(output.getOut()).contains("npe-trace-42").contains("NullPointerException")
                .contains("ConventionTestController.npe");
    }

    @Test
    void resourceNotFoundReturnsA0404() throws Exception {
        MvcResult r = perform(get("/test-support/missing"));
        assertThat(r.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(r).path("code").asString()).isEqualTo("A0404");
        // 不存在的路由同样返回 A0404
        MvcResult r2 = perform(get("/no-such-path"));
        assertThat(r2.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(r2).path("code").asString()).isEqualTo("A0404");
    }

    @Test
    void multipleInvalidFieldsAreAllReported() throws Exception {
        MvcResult r = perform(jsonBody(post("/test-support/form"), Map.of("name", "", "email", "bad")));
        JsonNode b = body(r);
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        assertThat(b.path("code").asString()).isEqualTo("A0410");
        List<String> fields = new ArrayList<>();
        b.path("data").forEach(e -> {
            fields.add(e.path("field").asString());
            assertThat(e.path("message").asString()).isNotBlank();
        });
        assertThat(fields).containsExactlyInAnyOrder("name", "email");
    }

    @Test
    void malformedBodyReturnsA0410() throws Exception {
        MvcResult r = perform(post("/test-support/form").contentType("application/json").content("{bad"));
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(r).path("code").asString()).isEqualTo("A0410");
    }

    @Test
    void traceIdGeneratedAndConsistentBetweenHeaderAndBody() throws Exception {
        MvcResult r = perform(get("/test-support/ok"));
        String header = r.getResponse().getHeader("X-Trace-Id");
        assertThat(header).isNotBlank();
        assertThat(body(r).path("traceId").asString()).isEqualTo(header);
    }

    @Test
    void incomingTraceIdIsReused() throws Exception {
        MvcResult r = perform(get("/test-support/ok").header("X-Trace-Id", "trace-from-client-01"));
        assertThat(r.getResponse().getHeader("X-Trace-Id")).isEqualTo("trace-from-client-01");
        assertThat(body(r).path("traceId").asString()).isEqualTo("trace-from-client-01");
    }

    @Test
    void securityErrorsAlsoCarryTraceId() throws Exception {
        MvcResult r = perform(get("/api/auth/me").header("X-Trace-Id", "sec-trace-1"));
        assertThat(r.getResponse().getStatus()).isEqualTo(401);
        assertThat(body(r).path("traceId").asString()).isEqualTo("sec-trace-1");
    }

    @Test
    void oversizedPageSizeIsCappedAt100() throws Exception {
        // 准备超过 100 条的数据（直接写库，避免 BCrypt 开销）
        jdbcTemplate.update("""
                INSERT INTO biz.sys_user (username, password_hash, nickname, status)
                SELECT 'bulk_' || g || '_' || floor(random()*1e9)::bigint, 'x', 'n', 'ENABLED' FROM generate_series(1, 105) g
                """);
        MvcResult r = perform(bearer(get("/api/admin/users").param("pageNum", "1").param("pageSize", "1000"), adminToken()));
        JsonNode data = body(r).path("data");
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        assertThat(data.path("pageSize").asInt()).isEqualTo(100);
        assertThat(data.path("pageNum").asInt()).isEqualTo(1);
        assertThat(data.path("records").size()).isEqualTo(100);
        assertThat(data.path("total").asLong()).isGreaterThan(100);
    }
}
