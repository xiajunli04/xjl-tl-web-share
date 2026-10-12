package com.xjl.tl.module.model.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.xjl.tl.module.model.entity.ModelConfig;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

public interface ModelConfigMapper extends BaseMapper<ModelConfig> {

    /** 取消某能力当前的默认配置（同时刷新 updated_at，供 Python 侧缓存失效）。 */
    @Update("UPDATE biz.model_config SET is_default = false, updated_at = now() "
            + "WHERE is_default = true AND deleted = false AND capability = #{capability}")
    int clearDefault(@Param("capability") String capability);

    /** 取消当前评审模型标记（同上刷新 updated_at）。 */
    @Update("UPDATE biz.model_config SET is_review_default = false, updated_at = now() WHERE is_review_default = true AND deleted = false")
    int clearReviewDefault();
}
