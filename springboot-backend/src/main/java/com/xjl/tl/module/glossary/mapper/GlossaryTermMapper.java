package com.xjl.tl.module.glossary.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.xjl.tl.module.glossary.entity.GlossaryTerm;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

import java.util.List;

public interface GlossaryTermMapper extends BaseMapper<GlossaryTerm> {

    /** 批量插入（调用方控制每批条数，避免超过 PostgreSQL 的参数上限）。 */
    @Insert("""
            <script>
            INSERT INTO biz.glossary_term (glossary_id, source_term, target_term, note, case_sensitive)
            VALUES
            <foreach collection="terms" item="t" separator=",">
              (#{glossaryId}, #{t.sourceTerm}, #{t.targetTerm}, #{t.note}, #{t.caseSensitive})
            </foreach>
            </script>
            """)
    int insertBatch(@Param("glossaryId") Long glossaryId, @Param("terms") List<GlossaryTerm> terms);

    /** 导入覆盖：更新目标术语与备注。 */
    @Update("""
            UPDATE biz.glossary_term SET target_term = #{targetTerm}, note = #{note}, updated_at = now()
            WHERE id = #{id}
            """)
    int overwrite(@Param("id") Long id, @Param("targetTerm") String targetTerm, @Param("note") String note);
}
