package com.xjl.tl.module.interpret.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.xjl.tl.common.mybatis.JsonNodeTypeHandler;
import tools.jackson.databind.JsonNode;

import java.time.OffsetDateTime;

/**
 * 同传转写段（biz.interpret_segment）：一句话的原文与各语种译文。只由 SegmentWriter 批量写入，这里用于查询。
 */
@TableName(value = "biz.interpret_segment", autoResultMap = true)
public class InterpretSegment {

    @TableId(type = IdType.AUTO)
    private Long id;
    private Long sessionId;
    private Integer seq;
    private String speakerParticipant;
    private String speakerName;
    private Long speakerUserId;
    private String sourceLang;
    private String sourceText;
    /** {"en":"...","ja":"..."}。 */
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode translations;
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode metrics;
    private Integer startedMs;
    private Integer endedMs;
    private OffsetDateTime createdAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getSessionId() {
        return sessionId;
    }

    public void setSessionId(Long sessionId) {
        this.sessionId = sessionId;
    }

    public Integer getSeq() {
        return seq;
    }

    public void setSeq(Integer seq) {
        this.seq = seq;
    }

    public String getSpeakerParticipant() {
        return speakerParticipant;
    }

    public void setSpeakerParticipant(String speakerParticipant) {
        this.speakerParticipant = speakerParticipant;
    }

    public String getSpeakerName() {
        return speakerName;
    }

    public void setSpeakerName(String speakerName) {
        this.speakerName = speakerName;
    }

    public Long getSpeakerUserId() {
        return speakerUserId;
    }

    public void setSpeakerUserId(Long speakerUserId) {
        this.speakerUserId = speakerUserId;
    }

    public String getSourceLang() {
        return sourceLang;
    }

    public void setSourceLang(String sourceLang) {
        this.sourceLang = sourceLang;
    }

    public String getSourceText() {
        return sourceText;
    }

    public void setSourceText(String sourceText) {
        this.sourceText = sourceText;
    }

    public JsonNode getTranslations() {
        return translations;
    }

    public void setTranslations(JsonNode translations) {
        this.translations = translations;
    }

    public JsonNode getMetrics() {
        return metrics;
    }

    public void setMetrics(JsonNode metrics) {
        this.metrics = metrics;
    }

    public Integer getStartedMs() {
        return startedMs;
    }

    public void setStartedMs(Integer startedMs) {
        this.startedMs = startedMs;
    }

    public Integer getEndedMs() {
        return endedMs;
    }

    public void setEndedMs(Integer endedMs) {
        this.endedMs = endedMs;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(OffsetDateTime createdAt) {
        this.createdAt = createdAt;
    }
}
