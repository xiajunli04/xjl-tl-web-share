package com.xjl.tl.module.document;

import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * tasks 5.1：V3 迁移（四张 biz 表、ai.doc_chunk_result、索引）、tl_ai 权限范围与新增错误码；V4 评审模型与 AUTO 术语状态。
 */
class DocSchemaTest extends IntegrationTestBase {

    @Test
    void v3CreatesTablesAndIndexes() {
        List<String> biz = jdbcTemplate.queryForList(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'biz'", String.class);
        assertThat(biz).contains("doc_task", "doc_segment", "doc_task_term", "doc_task_trace");
        List<String> ai = jdbcTemplate.queryForList(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'ai'", String.class);
        assertThat(ai).contains("doc_chunk_result");
        assertThat(jdbcTemplate.queryForList(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'biz' AND indexname = 'uk_doc_task_term_source'",
                String.class)).singleElement().satisfies(d -> assertThat(d).contains("UNIQUE").contains("lower("));
        assertThat(jdbcTemplate.queryForList(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'biz' AND tablename = 'doc_segment'", String.class))
                .anySatisfy(d -> assertThat(d).contains("UNIQUE").contains("task_id, seq"));
        assertThat(jdbcTemplate.queryForList(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'ai' AND tablename = 'doc_chunk_result'", String.class))
                .anySatisfy(d -> assertThat(d).contains("task_id, chunk_index"));
    }

    @Test
    void v4AddsReviewModelColumnsIndexAndAutoTermStatus() throws SQLException {
        assertThat(jdbcTemplate.queryForList(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'biz' AND indexname = 'uk_model_config_review_default'",
                String.class)).singleElement().satisfies(d -> assertThat(d).contains("UNIQUE")
                .contains("(is_review_default)").contains("WHERE").contains("NOT deleted"));
        assertThat(jdbcTemplate.queryForObject("""
                SELECT is_nullable || ':' || data_type || ':' || column_default FROM information_schema.columns
                WHERE table_schema = 'biz' AND table_name = 'model_config' AND column_name = 'is_review_default'""",
                String.class)).isEqualTo("NO:boolean:false");
        assertThat(jdbcTemplate.queryForObject("""
                SELECT is_nullable || ':' || data_type FROM information_schema.columns
                WHERE table_schema = 'biz' AND table_name = 'doc_task' AND column_name = 'review_model_config_id'""",
                String.class)).isEqualTo("YES:bigint");

        // 部分唯一索引：未删除的评审模型最多一个
        long a = insertModelConfig("v4-a", true);
        long b = insertModelConfig("v4-b", true);
        jdbcTemplate.update("UPDATE biz.model_config SET is_review_default = true WHERE id = ?", a);
        assertThatThrownBy(() -> jdbcTemplate.update("UPDATE biz.model_config SET is_review_default = true WHERE id = ?", b))
                .hasMessageContaining("uk_model_config_review_default");

        // doc_task_term.status 接受 AUTO，仍拒绝未知值
        long userId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user ORDER BY id LIMIT 1", Long.class);
        long taskId = jdbcTemplate.queryForObject("""
                INSERT INTO biz.doc_task (user_id, title, format, source_text, char_count, source_lang, target_lang, style,
                  strategy, status, deleted)
                VALUES (?, 'v4', 'md', 'x', 1, 'en', 'zh', 'faithful', 'hybrid', 'COMPLETED', true) RETURNING id""",
                Long.class, userId);
        jdbcTemplate.update("""
                INSERT INTO biz.doc_task_term (task_id, source_term, target_term, origin, status)
                VALUES (?, 'Pod', 'Pod', 'extracted', 'AUTO')""", taskId);
        assertThatThrownBy(() -> jdbcTemplate.update("""
                INSERT INTO biz.doc_task_term (task_id, source_term, target_term, origin, status)
                VALUES (?, 'Node', '节点', 'extracted', 'MAYBE')""", taskId))
                .hasMessageContaining("doc_task_term_status_check");

        // Python（tl_ai）可以读取评审标记
        try (Connection c = DriverManager.getConnection(withSchema(POSTGRES.getJdbcUrl()), "tl_ai", "tl_ai_pwd");
             Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT count(*) FROM biz.model_config WHERE is_review_default")) {
            rs.next();
            assertThat(rs.getInt(1)).isEqualTo(1);
        }
    }

    @Test
    void tlAiCanReadWriteChunkCacheButNotDocTables() throws SQLException {
        try (Connection c = DriverManager.getConnection(withSchema(POSTGRES.getJdbcUrl()), "tl_ai", "tl_ai_pwd");
             Statement st = c.createStatement()) {
            st.executeUpdate("INSERT INTO ai.doc_chunk_result (task_id, chunk_index, result, usage) "
                    + "VALUES (999001, 0, '{\"segments\":[]}', '{\"promptTokens\":1}')");
            st.executeUpdate("UPDATE ai.doc_chunk_result SET usage = '{}' WHERE task_id = 999001");
            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM ai.doc_chunk_result WHERE task_id = 999001")) {
                rs.next();
                assertThat(rs.getInt(1)).isEqualTo(1);
            }
            st.executeUpdate("DELETE FROM ai.doc_chunk_result WHERE task_id = 999001");
            for (String table : List.of("doc_task", "doc_segment", "doc_task_term", "doc_task_trace")) {
                assertThatThrownBy(() -> st.executeQuery("SELECT * FROM biz." + table))
                        .isInstanceOf(SQLException.class).hasMessageContaining("permission denied");
            }
        }
    }

    @Test
    void documentErrorCodesMapToDesignHttpStatus() {
        assertThat(ErrorCode.TOO_MANY_DOC_TASKS.getCode()).isEqualTo("A0213");
        assertThat(ErrorCode.TOO_MANY_DOC_TASKS.getHttpStatus()).isEqualTo(429);
        assertThat(ErrorCode.DOC_INVALID.getCode()).isEqualTo("A0430");
        assertThat(ErrorCode.DOC_INVALID.getHttpStatus()).isEqualTo(400);
        assertThat(ErrorCode.DOC_TASK_STATE_INVALID.getCode()).isEqualTo("A0431");
        assertThat(ErrorCode.DOC_TASK_STATE_INVALID.getHttpStatus()).isEqualTo(409);
        assertThat(ErrorCode.DOC_TASK_FAILED.getCode()).isEqualTo("C0150");
        assertThat(ErrorCode.DOC_TASK_FAILED.getHttpStatus()).isEqualTo(502);
    }

    @Test
    void documentEndpointsAppearInApiDocs() throws Exception {
        String doc = perform(get("/v3/api-docs")).getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(doc).contains("/api/doc-tasks", "/api/doc-tasks/{id}", "/api/doc-tasks/{id}/segments",
                "/api/doc-tasks/{id}/events", "/api/doc-tasks/{id}/terms", "/api/doc-tasks/{id}/terms/confirm",
                "/api/doc-tasks/{id}/cancel", "/api/doc-tasks/{id}/retry", "/api/doc-tasks/{id}/segments/{seq}",
                "/api/doc-tasks/{id}/segments/{seq}/retranslate", "/api/doc-tasks/{id}/export", "文档翻译",
                "订阅任务进度（SSE）");
    }
}
