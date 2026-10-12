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
 * tasks 4.1：V2 迁移（四张表、pg_trgm 索引）与 tl_ai 读权限范围（ai-service-foundation「数据库最小权限」）。
 */
class TranslationSchemaTest extends IntegrationTestBase {

    @Test
    void v2CreatesTablesIndexesAndExtension() {
        List<String> tables = jdbcTemplate.queryForList(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'biz'", String.class);
        assertThat(tables).contains("glossary", "glossary_term", "translation_record", "agent_trace");
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM pg_extension WHERE extname = 'pg_trgm'", Integer.class))
                .isEqualTo(1);
        List<String> indexes = jdbcTemplate.queryForList(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'biz' AND tablename = 'translation_record'", String.class);
        assertThat(indexes).anySatisfy(d -> assertThat(d).contains("gin").contains("source_text").contains("gin_trgm_ops"));
        assertThat(indexes).anySatisfy(d -> assertThat(d).contains("user_id").contains("created_at DESC"));
        assertThat(jdbcTemplate.queryForList(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'biz' AND indexname = 'uk_glossary_term_source'", String.class))
                .singleElement().satisfies(d -> assertThat(d).contains("UNIQUE").contains("lower("));
    }

    @Test
    void tlAiCanReadGlossaryTablesOnly() throws SQLException {
        try (Connection c = DriverManager.getConnection(withSchema(POSTGRES.getJdbcUrl()), "tl_ai", "tl_ai_pwd");
             Statement st = c.createStatement()) {
            st.executeQuery("SELECT * FROM biz.glossary").close();
            st.executeQuery("SELECT * FROM biz.glossary_term").close();
            assertThatThrownBy(() -> st.executeUpdate(
                    "INSERT INTO biz.glossary_term (glossary_id, source_term, target_term) VALUES (1, 'a', 'b')"))
                    .isInstanceOf(SQLException.class).hasMessageContaining("permission denied");
            assertThatThrownBy(() -> st.executeUpdate("UPDATE biz.glossary SET name = 'x'"))
                    .isInstanceOf(SQLException.class).hasMessageContaining("permission denied");
            assertThatThrownBy(() -> st.executeQuery("SELECT * FROM biz.translation_record"))
                    .isInstanceOf(SQLException.class).hasMessageContaining("permission denied");
            assertThatThrownBy(() -> st.executeQuery("SELECT * FROM biz.agent_trace"))
                    .isInstanceOf(SQLException.class).hasMessageContaining("permission denied");
            assertThatThrownBy(() -> st.executeQuery("SELECT * FROM biz.sys_user"))
                    .isInstanceOf(SQLException.class).hasMessageContaining("permission denied");
        }
    }

    @Test
    void newEndpointsAppearInApiDocs() throws Exception {
        var r = perform(get("/v3/api-docs"));
        String doc = r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        assertThat(doc).contains("/api/translate/languages", "/api/translate/detect", "/api/translate/stream",
                "/api/model-configs/options", "/api/glossaries", "/api/glossaries/{id}/terms",
                "/api/glossaries/{id}/terms/import/preview", "/api/glossaries/{id}/terms/import",
                "/api/glossaries/{id}/terms/export", "/api/translations", "/api/translations/{id}/favorite",
                "text/event-stream", "流式翻译（SSE）", "术语库");
    }
}
