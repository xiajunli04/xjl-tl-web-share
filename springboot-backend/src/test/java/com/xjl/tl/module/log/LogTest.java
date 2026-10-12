package com.xjl.tl.module.log;

import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * api-conventions「操作日志」：记录并脱敏、按时间范围与用户名查询；登录日志查询。
 */
class LogTest extends IntegrationTestBase {

    @Test
    void createModelConfigIsLoggedWithMaskedApiKey() throws Exception {
        String admin = adminToken();
        String traceId = "mc-log-" + System.nanoTime();
        perform(jsonBody(bearer(post("/api/admin/model-configs"), admin).header("X-Trace-Id", traceId), Map.of(
                "name", "LogCheck", "provider", "OPENAI_COMPATIBLE", "baseUrl", "https://api.deepseek.com/v1",
                "modelName", "deepseek-chat", "apiKey", "sk-plain-text-key-7777")));
        await(() -> jdbcTemplate.queryForObject("SELECT count(*) FROM biz.operation_log WHERE trace_id = ?",
                Integer.class, traceId) == 1);
        Map<String, Object> row = jdbcTemplate.queryForMap("SELECT * FROM biz.operation_log WHERE trace_id = ?", traceId);
        String params = (String) row.get("params");
        assertThat(params).doesNotContain("sk-plain-text-key-7777").contains("\"apiKey\":\"******\"").contains("LogCheck");
        assertThat(row.get("module")).isEqualTo("模型配置");
        assertThat(row.get("action")).isEqualTo("新增模型配置");
        assertThat(row.get("result_code")).isEqualTo("00000");

        // 通过查询接口同样只能看到脱敏值
        MvcResult r = perform(bearer(get("/api/admin/logs/operation").param("module", "模型配置")
                .param("username", ADMIN_USERNAME), admin));
        String raw = r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        assertThat(raw).contains(traceId).doesNotContain("sk-plain-text-key-7777");
    }

    @Test
    void failedOperationRecordsErrorCode() throws Exception {
        String admin = adminToken();
        String traceId = "fail-log-" + System.nanoTime();
        perform(bearer(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                .delete("/api/admin/model-configs/999999"), admin).header("X-Trace-Id", traceId));
        await(() -> jdbcTemplate.queryForObject("SELECT count(*) FROM biz.operation_log WHERE trace_id = ?",
                Integer.class, traceId) == 1);
        assertThat(jdbcTemplate.queryForObject("SELECT result_code FROM biz.operation_log WHERE trace_id = ?",
                String.class, traceId)).isEqualTo("A0404");
    }

    @Test
    void operationLogTimeRangeAndUsernameFilter() throws Exception {
        String user = "oplog_" + System.nanoTime() % 1000000;
        jdbcTemplate.update("""
                INSERT INTO biz.operation_log (username, module, action, created_at) VALUES
                (?, 'M', 'old',    '2026-01-01T10:00:00+08:00'),
                (?, 'M', 'in1',    '2026-02-01T10:00:00+08:00'),
                (?, 'M', 'in2',    '2026-02-15T10:00:00+08:00'),
                (?, 'M', 'future', '2026-03-01T10:00:00+08:00'),
                ('someone_else', 'M', 'in3', '2026-02-10T10:00:00+08:00')
                """, user, user, user, user);
        MvcResult r = perform(bearer(get("/api/admin/logs/operation")
                .param("username", user)
                .param("startTime", "2026-01-15T00:00:00+08:00")
                .param("endTime", "2026-02-20T00:00:00+08:00"), adminToken()));
        JsonNode data = body(r).get("data");
        assertThat(data.path("total").asLong()).isEqualTo(2);
        assertThat(data.path("records").get(0).path("action").asString()).isEqualTo("in2");
        assertThat(data.path("records").get(1).path("action").asString()).isEqualTo("in1");
        OffsetDateTime createdAt = OffsetDateTime.parse(data.path("records").get(0).path("createdAt").asString());
        assertThat(createdAt.toInstant()).isEqualTo(OffsetDateTime.of(2026, 2, 15, 2, 0, 0, 0, ZoneOffset.UTC).toInstant());
    }

    @Test
    void loginLogQuery() throws Exception {
        String name = registerUser(uniqueName("ll"), "Passw0rd1");
        postJson("/api/auth/login", Map.of("username", name, "password", "Wrong1234"), null);
        login(name, "Passw0rd1");
        await(() -> jdbcTemplate.queryForObject("SELECT count(*) FROM biz.login_log WHERE username = ?",
                Integer.class, name) == 2);
        String admin = adminToken();
        MvcResult all = perform(bearer(get("/api/admin/logs/login").param("username", name), admin));
        JsonNode data = body(all).get("data");
        assertThat(data.path("total").asLong()).isEqualTo(2);
        assertThat(data.path("records").get(0).path("success").asBoolean()).isTrue();
        assertThat(data.path("records").get(1).path("failReason").asString()).isNotBlank();
        MvcResult failed = perform(bearer(get("/api/admin/logs/login").param("username", name).param("success", "false"), admin));
        assertThat(body(failed).path("data").path("total").asLong()).isEqualTo(1);
        MvcResult future = perform(bearer(get("/api/admin/logs/login").param("username", name)
                .param("startTime", OffsetDateTime.now().plusDays(1).toString()), admin));
        assertThat(body(future).path("data").path("total").asLong()).isZero();
    }
}
