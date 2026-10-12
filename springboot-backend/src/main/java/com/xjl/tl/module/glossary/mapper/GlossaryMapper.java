package com.xjl.tl.module.glossary.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.xjl.tl.module.glossary.entity.Glossary;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

public interface GlossaryMapper extends BaseMapper<Glossary> {

    /**
     * 按实际术语数刷新 term_count，同时刷新 updated_at（Python 按 id + updated_at 缓存术语库）。
     */
    @Update("""
            UPDATE biz.glossary
            SET term_count = (SELECT count(*) FROM biz.glossary_term t WHERE t.glossary_id = #{id}),
                updated_at = now()
            WHERE id = #{id}
            """)
    int refreshTermCount(@Param("id") Long id);
}
