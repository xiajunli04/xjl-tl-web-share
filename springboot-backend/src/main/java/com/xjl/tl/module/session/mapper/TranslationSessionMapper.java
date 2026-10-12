package com.xjl.tl.module.session.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.xjl.tl.module.session.entity.TranslationSession;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;
import tools.jackson.databind.JsonNode;

/**
 * 会话表的定向更新（jsonb 列与计数器用显式 SQL，避免 updateById 忽略 null 字段）。
 */
public interface TranslationSessionMapper extends BaseMapper<TranslationSession> {

    String JSON = "typeHandler=com.xjl.tl.common.mybatis.JsonNodeTypeHandler";

    /** 写入等待回答的追问。 */
    @Update("UPDATE biz.translation_session SET pending = #{pending," + JSON + "}, updated_at = now() WHERE id = #{id}")
    int savePending(@Param("id") Long id, @Param("pending") JsonNode pending);

    /** 清空追问（无条件）。 */
    @Update("UPDATE biz.translation_session SET pending = NULL, updated_at = now() WHERE id = #{id} AND pending IS NOT NULL")
    int clearPending(@Param("id") Long id);

    /** 仅当 pending 的 threadId 一致时清空，返回是否清空。 */
    @Update("""
            UPDATE biz.translation_session SET pending = NULL, updated_at = now()
            WHERE id = #{id} AND pending ->> 'threadId' = #{threadId}""")
    int clearPendingIf(@Param("id") Long id, @Param("threadId") String threadId);

    /** 写回会话记忆（memory 事件）；memorized_until 只增不减。 */
    @Update("UPDATE biz.translation_session SET memory_summary = #{summary}, memory_entities = #{entities," + JSON + "},"
            + " memorized_until = GREATEST(memorized_until, #{memorizedUntil}), updated_at = now() WHERE id = #{id}")
    int applyMemory(@Param("id") Long id, @Param("summary") String summary, @Param("entities") JsonNode entities,
                    @Param("memorizedUntil") int memorizedUntil);

    /** 新一轮完成：轮次数 +1，标题为空时取缺省标题。 */
    @Update("""
            UPDATE biz.translation_session SET turn_count = turn_count + 1, title = COALESCE(title, #{title}),
              updated_at = now()
            WHERE id = #{id}""")
    int afterTurn(@Param("id") Long id, @Param("title") String title);

    /** 刷新更新时间（修订、切换采用版本）。 */
    @Update("UPDATE biz.translation_session SET updated_at = now() WHERE id = #{id}")
    int touch(@Param("id") Long id);
}
