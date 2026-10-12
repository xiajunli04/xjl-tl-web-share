package com.xjl.tl.module.interpret.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import com.xjl.tl.common.mybatis.JsonNodeTypeHandler;
import tools.jackson.databind.JsonNode;

import java.time.OffsetDateTime;

/**
 * 同传会话（biz.interpret_session，DDL 见 V6__speech_image.sql / add-speech-and-image-translation D13）。
 * 会议室只记主持人一条。
 */
@TableName(value = "biz.interpret_session", autoResultMap = true)
public class InterpretSession {

    public static final String MODE_LISTEN = "LISTEN";
    public static final String MODE_CONVERSE = "CONVERSE";
    public static final String MODE_ROOM = "ROOM";
    public static final String MODE_CHAT = "CHAT";
    public static final String STATUS_ACTIVE = "ACTIVE";
    public static final String STATUS_ENDED = "ENDED";

    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String mode;
    private String engine;
    /** LISTEN: [目标]；CONVERSE: [A, B]；ROOM: [主持人语言]。 */
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode languages;
    private String roomCode;
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode options;
    private String status;
    private String title;
    private OffsetDateTime startedAt;
    private OffsetDateTime endedAt;
    private Integer durationMs;
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode stats;
    private Boolean favorite;
    @TableLogic
    private Boolean deleted;
    @TableField(fill = FieldFill.INSERT)
    private OffsetDateTime createdAt;

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

    public String getMode() {
        return mode;
    }

    public void setMode(String mode) {
        this.mode = mode;
    }

    public String getEngine() {
        return engine;
    }

    public void setEngine(String engine) {
        this.engine = engine;
    }

    public JsonNode getLanguages() {
        return languages;
    }

    public void setLanguages(JsonNode languages) {
        this.languages = languages;
    }

    public String getRoomCode() {
        return roomCode;
    }

    public void setRoomCode(String roomCode) {
        this.roomCode = roomCode;
    }

    public JsonNode getOptions() {
        return options;
    }

    public void setOptions(JsonNode options) {
        this.options = options;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public OffsetDateTime getStartedAt() {
        return startedAt;
    }

    public void setStartedAt(OffsetDateTime startedAt) {
        this.startedAt = startedAt;
    }

    public OffsetDateTime getEndedAt() {
        return endedAt;
    }

    public void setEndedAt(OffsetDateTime endedAt) {
        this.endedAt = endedAt;
    }

    public Integer getDurationMs() {
        return durationMs;
    }

    public void setDurationMs(Integer durationMs) {
        this.durationMs = durationMs;
    }

    public JsonNode getStats() {
        return stats;
    }

    public void setStats(JsonNode stats) {
        this.stats = stats;
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
