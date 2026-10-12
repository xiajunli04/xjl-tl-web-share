package com.xjl.tl.module.interpret;

import com.xjl.tl.module.interpret.service.SegmentWriter;
import com.xjl.tl.module.interpret.service.SegmentWriter.Speaker;
import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.json.JsonMapper;

import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 联调发现：级联链路的译文定稿要等首段译音合成出来，可能晚于合并等待超时；
 * 超时写入后迟到的译文与指标必须回填到已写入的行，不能丢弃。
 */
class SegmentWriterLateEventTest extends IntegrationTestBase {

    @Autowired
    private SegmentWriter writer;
    @Autowired
    private JsonMapper jsonMapper;

    @Test
    void lateTranslationAndMetricsAreBackfilledAfterTimeout() throws Exception {
        long userId = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user ORDER BY id LIMIT 1", Long.class);
        long sessionId = jdbcTemplate.queryForObject("""
                INSERT INTO biz.interpret_session (user_id, mode, engine, languages) VALUES (?, 'LISTEN', 'cascade', '["en"]')
                RETURNING id""", Long.class, userId);
        Speaker speaker = new Speaker("p1", "主持人", userId);

        writer.transcript(sessionId, "p1:1", speaker, "zh", "大家好", 0, 800, Set.of("en"));
        // 测试环境 segment-wait-timeout = 2 s：超时后按已有内容（只有原文）写入
        await(() -> count(sessionId) == 1);
        assertThat(jdbcTemplate.queryForObject(
                "SELECT translations::text FROM biz.interpret_segment WHERE session_id = ?", String.class, sessionId))
                .isEqualTo("{}");

        writer.translation(sessionId, "p1:1", speaker, "en", "Hello everyone.");
        writer.metrics(sessionId, "p1:1", speaker, jsonMapper.readTree("{\"e2eMs\":6200}"));
        await(() -> "Hello everyone.".equals(jdbcTemplate.queryForObject(
                "SELECT translations->>'en' FROM biz.interpret_segment WHERE session_id = ?", String.class, sessionId)));
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "SELECT seq, metrics->>'e2eMs' AS e2e FROM biz.interpret_segment WHERE session_id = ?", sessionId);
        assertThat(row.get("seq")).isEqualTo(1);
        await(() -> "6200".equals(jdbcTemplate.queryForObject(
                "SELECT metrics->>'e2eMs' FROM biz.interpret_segment WHERE session_id = ?", String.class, sessionId)));
        assertThat(count(sessionId)).as("回填不新增行").isEqualTo(1);
    }

    private int count(long sessionId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM biz.interpret_segment WHERE session_id = ?",
                Integer.class, sessionId);
    }
}
