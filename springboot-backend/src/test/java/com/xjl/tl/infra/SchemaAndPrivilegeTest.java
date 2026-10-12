package com.xjl.tl.infra;

import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 2.5 / 2.7：Flyway 迁移、预置角色、tl_ai 最小权限、健康检查。
 */
class SchemaAndPrivilegeTest extends IntegrationTestBase {

    @Test
    void flywayCreatesSchemasTablesAndRoles() {
        List<String> schemas = jdbcTemplate.queryForList(
                "SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('biz','ai')", String.class);
        assertThat(schemas).containsExactlyInAnyOrder("biz", "ai");
        List<String> tables = jdbcTemplate.queryForList(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'biz'", String.class);
        assertThat(tables).contains("sys_user", "sys_role", "sys_user_role", "model_config", "login_log", "operation_log");
        assertThat(jdbcTemplate.queryForList("SELECT code FROM biz.sys_role ORDER BY id", String.class))
                .containsExactly("ADMIN", "USER");
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM pg_extension WHERE extname = 'vector'", Integer.class))
                .isEqualTo(1);
    }

    @Test
    void tlAiCanSelectButNotUpdateModelConfig() throws SQLException {
        try (Connection c = DriverManager.getConnection(withSchema(POSTGRES.getJdbcUrl()), "tl_ai", "tl_ai_pwd");
             Statement st = c.createStatement()) {
            st.executeQuery("SELECT id, api_key_cipher FROM biz.model_config").close();
            assertThatThrownBy(() -> st.executeUpdate("UPDATE biz.model_config SET name = 'x'"))
                    .isInstanceOf(SQLException.class)
                    .hasMessageContaining("permission denied");
            assertThatThrownBy(() -> st.executeQuery("SELECT * FROM biz.sys_user"))
                    .isInstanceOf(SQLException.class)
                    .hasMessageContaining("permission denied");
            // ai schema 拥有完整权限
            st.execute("CREATE TABLE ai.it_probe (id int)");
            st.execute("INSERT INTO ai.it_probe VALUES (1)");
            st.execute("DROP TABLE ai.it_probe");
        }
    }

    @Test
    void tlAiHasDefaultPrivilegesOnTablesCreatedByTlApp() throws SQLException {
        jdbcTemplate.execute("CREATE TABLE IF NOT EXISTS ai.app_created (id int)");
        try (Connection c = DriverManager.getConnection(withSchema(POSTGRES.getJdbcUrl()), "tl_ai", "tl_ai_pwd");
             Statement st = c.createStatement()) {
            st.execute("INSERT INTO ai.app_created VALUES (1)");
        } finally {
            jdbcTemplate.execute("DROP TABLE ai.app_created");
        }
    }

    @Test
    void actuatorHealthIsUp() throws Exception {
        var r = perform(get("/actuator/health"));
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        assertThat(body(r).path("status").asString()).isEqualTo("UP");
    }

    @Test
    void swaggerAndApiDocsAvailable() throws Exception {
        var r = perform(get("/v3/api-docs"));
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        String doc = r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        assertThat(doc).contains("/api/auth/login", "/api/admin/users", "/api/admin/model-configs", "bearerAuth");
        assertThat(perform(get("/swagger-ui/index.html")).getResponse().getStatus()).isEqualTo(200);
    }
}
