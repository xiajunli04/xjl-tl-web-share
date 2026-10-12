package com.xjl.tl.module.image.entity;

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
 * 图片翻译记录（biz.image_translation，DDL 见 V6__speech_image.sql / add-speech-and-image-translation D13）。
 */
@TableName(value = "biz.image_translation", autoResultMap = true)
public class ImageTranslation {

    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String engine;
    private Long modelConfigId;
    /** 原图相对 STORAGE_DIR 的路径。 */
    private String imagePath;
    /** 结果图相对路径（仅 qwen-mt-image）。 */
    private String resultImagePath;
    private String mime;
    private Integer width;
    private Integer height;
    private Integer sizeBytes;
    private String sourceLang;
    private String detectedLang;
    private String targetLang;
    /** [{id, text, translation, bbox:[x0,y0,x1,y1], lang?}]。 */
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode blocks;
    /** 全部块原文与译文拼接，供关键词检索。 */
    private String searchText;
    @TableField(typeHandler = LongArrayTypeHandler.class)
    private Long[] glossaryIds;
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode termHits;
    @TableField(typeHandler = JsonNodeTypeHandler.class)
    private JsonNode trace;
    private Integer promptTokens;
    private Integer completionTokens;
    private Integer durationMs;
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

    public String getEngine() {
        return engine;
    }

    public void setEngine(String engine) {
        this.engine = engine;
    }

    public Long getModelConfigId() {
        return modelConfigId;
    }

    public void setModelConfigId(Long modelConfigId) {
        this.modelConfigId = modelConfigId;
    }

    public String getImagePath() {
        return imagePath;
    }

    public void setImagePath(String imagePath) {
        this.imagePath = imagePath;
    }

    public String getResultImagePath() {
        return resultImagePath;
    }

    public void setResultImagePath(String resultImagePath) {
        this.resultImagePath = resultImagePath;
    }

    public String getMime() {
        return mime;
    }

    public void setMime(String mime) {
        this.mime = mime;
    }

    public Integer getWidth() {
        return width;
    }

    public void setWidth(Integer width) {
        this.width = width;
    }

    public Integer getHeight() {
        return height;
    }

    public void setHeight(Integer height) {
        this.height = height;
    }

    public Integer getSizeBytes() {
        return sizeBytes;
    }

    public void setSizeBytes(Integer sizeBytes) {
        this.sizeBytes = sizeBytes;
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

    public JsonNode getBlocks() {
        return blocks;
    }

    public void setBlocks(JsonNode blocks) {
        this.blocks = blocks;
    }

    public String getSearchText() {
        return searchText;
    }

    public void setSearchText(String searchText) {
        this.searchText = searchText;
    }

    public Long[] getGlossaryIds() {
        return glossaryIds;
    }

    public void setGlossaryIds(Long[] glossaryIds) {
        this.glossaryIds = glossaryIds;
    }

    public JsonNode getTermHits() {
        return termHits;
    }

    public void setTermHits(JsonNode termHits) {
        this.termHits = termHits;
    }

    public JsonNode getTrace() {
        return trace;
    }

    public void setTrace(JsonNode trace) {
        this.trace = trace;
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

    public Integer getDurationMs() {
        return durationMs;
    }

    public void setDurationMs(Integer durationMs) {
        this.durationMs = durationMs;
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
