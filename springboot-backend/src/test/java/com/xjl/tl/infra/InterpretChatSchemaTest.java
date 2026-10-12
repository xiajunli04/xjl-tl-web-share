package com.xjl.tl.infra;

import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * add-ai-avatar-and-landing 1.3：V7 迁移——interpret_session.mode 允许 CHAT，其他非法值仍被拒绝。
 */
class InterpretChatSchemaTest extends IntegrationTestBase {

    @Test
    void modeAcceptsChatAndRejectsUnknown() {
        Long userId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user ORDER BY id LIMIT 1", Long.class);
        Long id = jdbcTemplate.queryForObject("""
                INSERT INTO biz.interpret_session (user_id, mode, engine, languages, status)
                VALUES (?, 'CHAT', 'cascade', '["zh","en"]'::jsonb, 'ENDED') RETURNING id""", Long.class, userId);
        assertThat(jdbcTemplate.queryForObject("SELECT mode FROM biz.interpret_session WHERE id = ?", String.class, id))
                .isEqualTo("CHAT");
        assertThatThrownBy(() -> jdbcTemplate.update("""
                INSERT INTO biz.interpret_session (user_id, mode, engine, status)
                VALUES (?, 'KARAOKE', 'cascade', 'ENDED')""", userId))
                .rootCause().hasMessageContaining("check constraint");
        jdbcTemplate.update("DELETE FROM biz.interpret_session WHERE id = ?", id);
    }
}
