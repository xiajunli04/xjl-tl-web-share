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
 * add-speech-and-image-translation 1.2：V6 迁移——模型配置能力类型与按能力唯一的默认模型、
 * 同传会话/转写段、图片翻译记录（tl_ai 可读 model_config 新列，无权访问新业务表）。
 */
class SpeechImageSchemaTest extends IntegrationTestBase {

    @Test
    void modelConfigHasCapabilityColumnsAndPerCapabilityDefaultIndex() {
        assertThat(jdbcTemplate.queryForObject("""
                SELECT column_default FROM information_schema.columns
                WHERE table_schema = 'biz' AND table_name = 'model_config' AND column_name = 'capability'""",
                String.class)).isEqualTo("'CHAT'::character varying");
        assertThat(jdbcTemplate.queryForObject("""
                SELECT indexdef FROM pg_indexes WHERE schemaname = 'biz' AND indexname = 'uk_model_config_default'""",
                String.class)).contains("(capability)").contains("is_default");
        assertThatThrownBy(() -> jdbcTemplate.update("""
                INSERT INTO biz.model_config (name, provider, base_url, model_name, api_key_cipher, api_key_mask, capability)
                VALUES ('x', 'OPENAI_COMPATIBLE', 'https://x', 'm', 'v1:x', '****', 'VIDEO')"""))
                .rootCause().hasMessageContaining("check constraint");
    }

    @Test
    void newTablesExist() {
        assertThat(columns("interpret_session")).contains("user_id", "mode", "engine", "languages", "room_code",
                "options", "status", "title", "started_at", "ended_at", "duration_ms", "stats", "favorite", "deleted");
        assertThat(columns("interpret_segment")).contains("session_id", "seq", "speaker_participant", "speaker_name",
                "source_lang", "source_text", "translations", "metrics", "started_ms", "ended_ms");
        assertThat(columns("image_translation")).contains("user_id", "engine", "image_path", "result_image_path",
                "width", "height", "source_lang", "target_lang", "blocks", "search_text", "glossary_ids", "term_hits",
                "trace", "favorite", "deleted");
        List<String> idx = jdbcTemplate.queryForList(
                "SELECT indexname FROM pg_indexes WHERE schemaname = 'biz' AND tablename = 'interpret_session'", String.class);
        assertThat(idx).contains("uk_interpret_session_active", "uk_interpret_session_room");
    }

    @Test
    void tlAiReadsCapabilityButCannotTouchNewTables() throws SQLException {
        try (Connection c = DriverManager.getConnection(withSchema(POSTGRES.getJdbcUrl()), "tl_ai", "tl_ai_pwd");
             Statement st = c.createStatement()) {
            try (ResultSet rs = st.executeQuery("SELECT count(*) FROM biz.model_config WHERE capability = 'CHAT'")) {
                assertThat(rs.next()).isTrue();
            }
            assertThatThrownBy(() -> st.executeQuery("SELECT 1 FROM biz.interpret_session"))
                    .hasMessageContaining("permission denied");
            assertThatThrownBy(() -> st.executeQuery("SELECT 1 FROM biz.image_translation"))
                    .hasMessageContaining("permission denied");
        }
    }

    private List<String> columns(String table) {
        return jdbcTemplate.queryForList("""
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'biz' AND table_name = ?""", String.class, table);
    }
}
