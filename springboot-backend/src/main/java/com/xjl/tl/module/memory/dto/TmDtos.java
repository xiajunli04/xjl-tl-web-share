package com.xjl.tl.module.memory.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.xjl.tl.common.PageQuery;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * 翻译记忆 DTO（字段契约见共享契约 D / F，与 Python /internal/tm/* 的 data 一致，Spring 原样透传）。
 */
public final class TmDtos {

    public static final String ORIGIN_WORKBENCH = "workbench";
    public static final String ORIGIN_DOCUMENT = "document";
    /** Python 单次写入上限。 */
    public static final int MAX_BATCH = 200;
    /** Python 接受的原文长度上限。 */
    public static final int MAX_SOURCE_LENGTH = 5000;

    private TmDtos() {
    }

    // ---------------- 请求 ----------------

    @Schema(description = "翻译记忆查询条件")
    public static class TmQuery extends PageQuery {
        @Schema(description = "关键词（匹配原文或译文）")
        private String keyword;
        @Schema(description = "源语言代码")
        private String sourceLang;
        @Schema(description = "目标语言代码")
        private String targetLang;

        public String getKeyword() {
            return keyword;
        }

        public void setKeyword(String keyword) {
            this.keyword = keyword;
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
    }

    @Schema(description = "检索相似译法")
    public record TmSearchRequest(
            @Schema(description = "原文，最长 5000 字符") @NotBlank(message = "原文不能为空")
            @Size(max = MAX_SOURCE_LENGTH, message = "原文最长 5000 字符") String text,
            @Schema(description = "源语言代码", example = "en") @NotBlank(message = "源语言不能为空") String sourceLang,
            @Schema(description = "目标语言代码", example = "zh") @NotBlank(message = "目标语言不能为空") String targetLang) {
    }

    // ---------------- 响应 ----------------

    @JsonIgnoreProperties(ignoreUnknown = true)
    @Schema(description = "翻译记忆条目")
    public record TmEntryVO(
            @Schema(description = "id") Long id,
            @Schema(description = "源语言") String sourceLang,
            @Schema(description = "目标语言") String targetLang,
            @Schema(description = "原文") String sourceText,
            @Schema(description = "译文") String targetText,
            @Schema(description = "来源", allowableValues = {ORIGIN_WORKBENCH, ORIGIN_DOCUMENT}) String origin,
            @Schema(description = "来源引用：翻译记录 id，或 \"taskId:seq\"") String originRef,
            @Schema(description = "命中次数") Integer hitCount,
            @Schema(description = "最近命中时间（ISO-8601）") String lastHitAt,
            @Schema(description = "创建时间（ISO-8601）") String createdAt,
            @Schema(description = "更新时间（ISO-8601）") String updatedAt) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    @Schema(description = "翻译记忆命中")
    public record TmHitVO(
            @Schema(description = "条目 id") Long id,
            @Schema(description = "记忆原文") String source,
            @Schema(description = "记忆译文") String target,
            @Schema(description = "字符级模糊匹配度 0–1，1 表示 100% 匹配") Double fuzzy,
            @Schema(description = "语义相似度 0–1") Double semantic,
            @Schema(description = "来源", allowableValues = {ORIGIN_WORKBENCH, ORIGIN_DOCUMENT}) String origin,
            @Schema(description = "来源引用") String originRef) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    @Schema(description = "相似译法检索结果")
    public record TmSearchResult(
            @Schema(description = "翻译记忆服务是否可用（模型不可用时为 false，hits 为空）") Boolean available,
            @Schema(description = "命中（最多 3 条）") List<TmHitVO> hits) {
    }

    @Schema(description = "从翻译记录存入记忆的可选参数")
    public record FromRecordRequest(
            @Schema(description = "改用的译文（工作台采用备选译法后传入；缺省为记录中的译文）")
            @Size(max = MAX_SOURCE_LENGTH, message = "译文最长 5000 字符") String targetText) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    @Schema(description = "写入翻译记忆的结果")
    public record TmWriteResult(@Schema(description = "写入（新增或更新）的条数") Integer written) {
    }

    // ---------------- Python 内部接口 ----------------

    /** 一条待写入的翻译记忆（POST /internal/tm/entries 的 entries 元素）。 */
    public record TmEntryInput(String sourceLang, String targetLang, String sourceText, String targetText,
                               String origin, String originRef) {
    }

    /** POST /internal/tm/entries 请求体（entries 不超过 200 条）。 */
    public record UpstreamWriteRequest(Long userId, List<TmEntryInput> entries) {
    }

    /** POST /internal/tm/search 请求体。 */
    public record UpstreamSearchRequest(Long userId, String text, String sourceLang, String targetLang, Integer limit) {
    }
}
