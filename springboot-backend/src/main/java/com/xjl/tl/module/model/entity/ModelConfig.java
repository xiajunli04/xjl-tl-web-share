package com.xjl.tl.module.model.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.FieldStrategy;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;

import java.time.OffsetDateTime;

/**
 * 模型配置（biz.model_config，DDL 见 design D13；能力类型与新提供方见 add-speech-and-image-translation D12）。
 */
@TableName(value = "biz.model_config", autoResultMap = true)
public class ModelConfig {

    public static final String OPENAI_COMPATIBLE = "OPENAI_COMPATIBLE";
    public static final String ANTHROPIC = "ANTHROPIC";
    public static final String DASHSCOPE = "DASHSCOPE";
    public static final String VOLCENGINE = "VOLCENGINE";
    public static final String GOOGLE = "GOOGLE";

    public static final String CAP_CHAT = "CHAT";
    public static final String CAP_ASR = "ASR";
    public static final String CAP_TTS = "TTS";
    public static final String CAP_REALTIME_TRANSLATE = "REALTIME_TRANSLATE";
    /** 实时语音对话（AI 对话的端到端语音模型，improve-speech-playback-latency D7）。 */
    public static final String CAP_REALTIME_CHAT = "REALTIME_CHAT";
    public static final String CAP_IMAGE_TRANSLATE = "IMAGE_TRANSLATE";

    @TableId(type = IdType.AUTO)
    private Long id;
    private String name;
    private String provider;
    private String capability;
    private Boolean supportsVision;
    private String baseUrl;
    private String modelName;
    private String apiKeyCipher;
    private String apiKeyMask;
    @TableField(typeHandler = ModelParamsTypeHandler.class)
    private ModelParams params;
    private Boolean isDefault;
    private Boolean isReviewDefault;
    private Boolean enabled;
    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private String remark;
    @TableLogic
    private Boolean deleted;
    @TableField(fill = FieldFill.INSERT)
    private OffsetDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private OffsetDateTime updatedAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getProvider() {
        return provider;
    }

    public void setProvider(String provider) {
        this.provider = provider;
    }

    public String getCapability() {
        return capability;
    }

    public void setCapability(String capability) {
        this.capability = capability;
    }

    public Boolean getSupportsVision() {
        return supportsVision;
    }

    public void setSupportsVision(Boolean supportsVision) {
        this.supportsVision = supportsVision;
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public String getModelName() {
        return modelName;
    }

    public void setModelName(String modelName) {
        this.modelName = modelName;
    }

    public String getApiKeyCipher() {
        return apiKeyCipher;
    }

    public void setApiKeyCipher(String apiKeyCipher) {
        this.apiKeyCipher = apiKeyCipher;
    }

    public String getApiKeyMask() {
        return apiKeyMask;
    }

    public void setApiKeyMask(String apiKeyMask) {
        this.apiKeyMask = apiKeyMask;
    }

    public ModelParams getParams() {
        return params;
    }

    public void setParams(ModelParams params) {
        this.params = params;
    }

    public Boolean getIsDefault() {
        return isDefault;
    }

    public void setIsDefault(Boolean isDefault) {
        this.isDefault = isDefault;
    }

    public Boolean getIsReviewDefault() {
        return isReviewDefault;
    }

    public void setIsReviewDefault(Boolean isReviewDefault) {
        this.isReviewDefault = isReviewDefault;
    }

    public Boolean getEnabled() {
        return enabled;
    }

    public void setEnabled(Boolean enabled) {
        this.enabled = enabled;
    }

    public String getRemark() {
        return remark;
    }

    public void setRemark(String remark) {
        this.remark = remark;
    }

    public Boolean getDeleted() {
        return deleted;
    }

    public void setDeleted(Boolean deleted) {
        this.deleted = deleted;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(OffsetDateTime updatedAt) {
        this.updatedAt = updatedAt;
    }
}
