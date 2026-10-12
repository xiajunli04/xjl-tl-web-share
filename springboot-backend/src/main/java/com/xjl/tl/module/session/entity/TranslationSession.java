package com.xjl.tl.module.session.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import com.xjl.tl.common.mybatis.JsonNodeTypeHandler;
import com.xjl.tl.common.mybatis.LongArrayTypeHandler;
import tools.jackson.databind.JsonNode;

import java.time.OffsetDateTime;

/**
 * 翻译会话（biz.translation_session，见 design D1）：会话级默认参数、会话记忆与等待回答的追问。
 */
@TableName(value = "biz.translation_session", autoResultMap = true)
public class TranslationSession {

    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String title;
    private String sourceLang;
    private String targetLang;
    private String style;
    private String domain;
    @TableField(typeHandler = LongArrayTypeHandler.class)
    private Long[] glossaryIds;
    private Long modelConfigId;
    private Boolean clarifyEnabled;
    private String memorySummary;
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode memoryEntities;
    private Integer memorizedUntil;
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode pending;
    private Integer turnCount;
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

    public Long getUserId() {
        return userId;
    }

    public void setUserId(Long userId) {
        this.userId = userId;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getSourceLang() {
        return sourceLang;
    }

    public void setSourceLang(String sourceLang) {
        this.sourceLang = sourceLang;
    }

    public String getTargetLang() {
        return targetLang;
    }

    public void setTargetLang(String targetLang) {
        this.targetLang = targetLang;
    }

    public String getStyle() {
        return style;
    }

    public void setStyle(String style) {
        this.style = style;
    }

    public String getDomain() {
        return domain;
    }

    public void setDomain(String domain) {
        this.domain = domain;
    }

    public Long[] getGlossaryIds() {
        return glossaryIds;
    }

    public void setGlossaryIds(Long[] glossaryIds) {
        this.glossaryIds = glossaryIds;
    }

    public Long getModelConfigId() {
        return modelConfigId;
    }

    public void setModelConfigId(Long modelConfigId) {
        this.modelConfigId = modelConfigId;
    }

    public Boolean getClarifyEnabled() {
        return clarifyEnabled;
    }

    public void setClarifyEnabled(Boolean clarifyEnabled) {
        this.clarifyEnabled = clarifyEnabled;
    }

    public String getMemorySummary() {
        return memorySummary;
    }

    public void setMemorySummary(String memorySummary) {
        this.memorySummary = memorySummary;
    }

    public JsonNode getMemoryEntities() {
        return memoryEntities;
    }

    public void setMemoryEntities(JsonNode memoryEntities) {
        this.memoryEntities = memoryEntities;
    }

    public Integer getMemorizedUntil() {
        return memorizedUntil;
    }

    public void setMemorizedUntil(Integer memorizedUntil) {
        this.memorizedUntil = memorizedUntil;
    }

    public JsonNode getPending() {
        return pending;
    }

    public void setPending(JsonNode pending) {
        this.pending = pending;
    }

    public Integer getTurnCount() {
        return turnCount;
    }

    public void setTurnCount(Integer turnCount) {
        this.turnCount = turnCount;
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
