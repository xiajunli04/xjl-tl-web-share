package com.xjl.tl.infra;

import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * add-session-context-and-memory 1.1：V5 迁移——翻译会话表、翻译记录新列、段落 tm_hits、
 * ai.translation_memory（HNSW / trgm 索引；tl_ai 可读写、tl_app 不能写）。
 */
class SessionMemorySchemaTest extends IntegrationTestBase {

    private static final String VECTOR = "'[" + "0.1,".repeat(383) + "0.1]'";

    @Test
    void sessionTableAndRecordColumnsExist() {
        List<String> sessionCols = jdbcTemplate.queryForList("""
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'biz' AND table_name = 'translation_session'""", String.class);
        assertThat(sessionCols).contains("id", "user_id", "title", "source_lang", "target_lang", "style", "domain",
                "glossary_ids", "model_config_id", "clarify_enabled", "memory_summary", "memory_entities",
                "memorized_until", "pending", "turn_count", "deleted", "created_at", "updated_at");
        List<String> recordCols = jdbcTemplate.queryForList("""
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'biz' AND table_name = 'translation_record'""", String.class);
        assertThat(recordCols).contains("session_id", "revision_of", "revise_instruction", "adopted", "clarification");
        assertThat(jdbcTemplate.queryForObject("""
                SELECT column_default FROM information_schema.columns
                WHERE table_schema = 'biz' AND table_name = 'translation_record' AND column_name = 'adopted'""",
                String.class)).isEqualTo("true");
        assertThat(jdbcTemplate.queryForObject("""
                SELECT count(*) FROM pg_indexes WHERE schemaname = 'biz' AND indexname = 'idx_translation_record_session'""",
                Integer.class)).isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject("""
                SELECT is_nullable || ':' || column_default FROM information_schema.columns
                WHERE table_schema = 'biz' AND table_name = 'doc_segment' AND column_name = 'tm_hits'""",
                String.class)).isEqualTo("NO:'[]'::jsonb");
    }

    @Test
    void translationMemoryHasVectorAndTrigramIndexes() {
        List<String> defs = jdbcTemplate.queryForList(
                "SELECT indexdef FROM pg_indexes WHERE schemaname = 'ai' AND tablename = 'translation_memory'", String.class);
        assertThat(defs).anySatisfy(d -> assertThat(d).contains("USING hnsw").contains("vector_cosine_ops"));
        assertThat(defs).anySatisfy(d -> assertThat(d).contains("USING gin").contains("gin_trgm_ops"));
        assertThat(defs).anySatisfy(d -> assertThat(d).contains("UNIQUE")
                .contains("(user_id, source_lang, target_lang, source_hash)"));
        assertThat(defs).anySatisfy(d -> assertThat(d).contains("idx_translation_memory_user_pair"));
    }

    @Test
    void tlAiCanReadAndWriteTranslationMemoryButTlAppCannotWrite() throws SQLException {
        try (Connection c = DriverManager.getConnection(withSchema(POSTGRES.getJdbcUrl()), "tl_ai", "tl_ai_pwd");
             Statement st = c.createStatement()) {
            st.executeUpdate("""
                    INSERT INTO ai.translation_memory (user_id, source_lang, target_lang, source_text, target_text,
                      source_norm, source_hash, embedding, origin, origin_ref)
                    VALUES (987654, 'en', 'zh', 'Restart the Pod.', '重启 Pod。', 'restart the pod.',
                      md5('restart the pod.'), %s, 'workbench', '1')""".formatted(VECTOR));
            // 唯一键冲突时覆盖译文
            st.executeUpdate("""
                    INSERT INTO ai.translation_memory (user_id, source_lang, target_lang, source_text, target_text,
                      source_norm, source_hash, embedding, origin, origin_ref)
                    VALUES (987654, 'en', 'zh', 'Restart the Pod.', '重启该 Pod。', 'restart the pod.',
                      md5('restart the pod.'), %s, 'document', '42:5')
                    ON CONFLICT (user_id, source_lang, target_lang, source_hash)
                    DO UPDATE SET target_text = EXCLUDED.target_text, updated_at = now()""".formatted(VECTOR));
            try (ResultSet rs = st.executeQuery("""
                    SELECT count(*), max(target_text), max(embedding <=> %s) FROM ai.translation_memory
                    WHERE user_id = 987654""".formatted(VECTOR))) {
                rs.next();
                assertThat(rs.getInt(1)).isEqualTo(1);
                assertThat(rs.getString(2)).isEqualTo("重启该 Pod。");
                assertThat(rs.getDouble(3)).isLessThan(1e-6);
            }
            try (ResultSet rs = st.executeQuery(
                    "SELECT similarity(source_norm, 'restart the pods') FROM ai.translation_memory WHERE user_id = 987654")) {
                rs.next();
                assertThat(rs.getDouble(1)).isGreaterThan(0.3);
            }
            assertThatThrownBy(() -> st.executeUpdate("""
                    INSERT INTO ai.translation_memory (user_id, source_lang, target_lang, source_text, target_text,
                      source_norm, source_hash, embedding, origin)
                    VALUES (1, 'en', 'zh', 'x', 'y', 'x', md5('x'), %s, 'other')""".formatted(VECTOR)))
                    .isInstanceOf(SQLException.class)
                    .hasMessageContaining("check constraint");
            assertThat(st.executeUpdate("DELETE FROM ai.translation_memory WHERE user_id = 987654")).isEqualTo(1);
        }
        // tl_app（建表者）已收回写权限
        assertThatThrownBy(() -> jdbcTemplate.update("""
                INSERT INTO ai.translation_memory (user_id, source_lang, target_lang, source_text, target_text,
                  source_norm, source_hash, embedding, origin)
                VALUES (1, 'en', 'zh', 'x', 'y', 'x', md5('x'), %s, 'workbench')""".formatted(VECTOR)))
                .rootCause().hasMessageContaining("permission denied");
        assertThatThrownBy(() -> jdbcTemplate.update("DELETE FROM ai.translation_memory"))
                .rootCause().hasMessageContaining("permission denied");
    }
}
