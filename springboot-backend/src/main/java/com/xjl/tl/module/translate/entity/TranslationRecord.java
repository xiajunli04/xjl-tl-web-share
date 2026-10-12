package com.xjl.tl.module.translate.entity;

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
 * 翻译记录（biz.translation_record，DDL 见 design D6）。
 */
@TableName(value = "biz.translation_record", autoResultMap = true)
public class TranslationRecord {

    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String sourceText;
    private String targetText;
    private String sourceLang;
    private String detectedLang;
    private String targetLang;
    private String path;
    private String mode;
    private String style;
    private String domain;
    @TableField(typeHandler = LongArrayTypeHandler.class)
    private Long[] glossaryIds;
    private Long modelConfigId;
    private Integer reviewScore;
    private Integer reviewRounds;
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode compliance;
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode termHits;
    private Integer promptTokens;
    private Integer completionTokens;
    private Integer latencyMs;
    private Boolean favorite;
    /** 所属会话（非会话翻译为 null）。 */
    private Long sessionId;
    /** 修订来源记录 id（一轮的原始翻译为 null）。 */
    private Long revisionOf;
    private String reviseInstruction;
    /** 是否为所在分支的采用版本（非会话记录恒为 true）。 */
    private Boolean adopted;
    /** 追问问答 {question, options, span, answer}。 */
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode clarification;
    @TableLogic
    private Boolean deleted;
    @TableField(fill = FieldFill.INSERT)
    private OffsetDateTime createdAt;

    public Long getSessionId() {
        return sessionId;
    }

    public void setSessionId(Long sessionId) {
        this.sessionId = sessionId;
    }

    public Long getRevisionOf() {
        return revisionOf;
    }

    public void setRevisionOf(Long revisionOf) {
        this.revisionOf = revisionOf;
    }

    public String getReviseInstruction() {
        return reviseInstruction;
    }

    public void setReviseInstruction(String reviseInstruction) {
        this.reviseInstruction = reviseInstruction;
    }

    public Boolean getAdopted() {
        return adopted;
    }

    public void setAdopted(Boolean adopted) {
        this.adopted = adopted;
    }

    public JsonNode getClarification() {
        return clarification;
    }

    public void setClarification(JsonNode clarification) {
        this.clarification = clarification;
    }

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

    public String getSourceText() {
        return sourceText;
    }

    public void setSourceText(String sourceText) {
        this.sourceText = sourceText;
    }

    public String getTargetText() {
        return targetText;
    }

    public void setTargetText(String targetText) {
        this.targetText = targetText;
    }

    public String getSourceLang() {
        return sourceLang;
    }

    public void setSourceLang(String sourceLang) {
        this.sourceLang = sourceLang;
    }

    public String getDetectedLang() {
        return detectedLang;
    }

    public void setDetectedLang(String detectedLang) {
        this.detectedLang = detectedLang;
    }

    public String getTargetLang() {
        return targetLang;
    }

    public void setTargetLang(String targetLang) {
        this.targetLang = targetLang;
    }

    public String getPath() {
        return path;
    }

    public void setPath(String path) {
        this.path = path;
    }

    public String getMode() {
        return mode;
    }

    public void setMode(String mode) {
        this.mode = mode;
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

    public Integer getReviewScore() {
        return reviewScore;
    }

    public void setReviewScore(Integer reviewScore) {
        this.reviewScore = reviewScore;
    }

    public Integer getReviewRounds() {
        return reviewRounds;
    }

    public void setReviewRounds(Integer reviewRounds) {
        this.reviewRounds = reviewRounds;
    }

    public JsonNode getCompliance() {
        return compliance;
    }

    public void setCompliance(JsonNode compliance) {
        this.compliance = compliance;
    }

    public JsonNode getTermHits() {
        return termHits;
    }

    public void setTermHits(JsonNode termHits) {
        this.termHits = termHits;
    }

    public Integer getPromptTokens() {
        return promptTokens;
    }

    public void setPromptTokens(Integer promptTokens) {
        this.promptTokens = promptTokens;
    }

    public Integer getCompletionTokens() {
        return completionTokens;
    }

    public void setCompletionTokens(Integer completionTokens) {
        this.completionTokens = completionTokens;
    }

    public Integer getLatencyMs() {
        return latencyMs;
    }

    public void setLatencyMs(Integer latencyMs) {
        this.latencyMs = latencyMs;
    }

    public Boolean getFavorite() {
        return favorite;
    }

    public void setFavorite(Boolean favorite) {
        this.favorite = favorite;
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
}
