package com.xjl.tl.module.insight.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * 解读 DTO（备选译法 / 关键表达 / 追问，见 add-speech-and-image-translation D11，契约 §1.6 / §1.7 / §2.2）。
 */
public final class InsightDtos {

    private InsightDtos() {
    }

    @Schema(description = "解读请求")
    public record InsightRequest(
            @Schema(description = "原文，最长 2000 字符") @NotBlank(message = "原文不能为空") String source,
            @Schema(description = "当前译文") @NotBlank(message = "译文不能为空") String translation,
            @Schema(description = "源语言代码（允许 auto）", example = "en") @NotBlank(message = "源语言不能为空") String sourceLang,
            @Schema(description = "目标语言代码", example = "zh") @NotBlank(message = "目标语言不能为空") String targetLang,
            @Schema(description = "关联的翻译记录 id（可选，须为自己的记录）") Long recordId) {
    }

    @Schema(description = "备选译法")
    public record Alternative(@Schema(description = "译文") String text,
                              @Schema(description = "语体", allowableValues = {"正式", "中性", "口语", "书面", "文学"}) String register,
                              @Schema(description = "适用场景说明（中文）") String note) {
    }

    @Schema(description = "关键表达")
    public record Expression(@Schema(description = "原文片段") String source,
                             @Schema(description = "译文片段") String target,
                             @Schema(description = "含义") String meaning,
                             @Schema(description = "说明") String note) {
    }

    @Schema(description = "解读结果")
    public record InsightResult(@Schema(description = "2–3 个备选译法") List<Alternative> alternatives,
                                @Schema(description = "至多 5 个关键表达") List<Expression> expressions,
                                @Schema(description = "一句话总结") String summary) {
    }

    @Schema(description = "一轮问答")
    public record QaTurn(@Schema(description = "问题") String q, @Schema(description = "回答") String a) {
    }

    @Schema(description = "追问请求")
    public record AskRequest(
            @Schema(description = "原文，最长 2000 字符") @NotBlank(message = "原文不能为空") String source,
            @Schema(description = "当前译文") @NotBlank(message = "译文不能为空") String translation,
            @Schema(description = "源语言代码（允许 auto）") @NotBlank(message = "源语言不能为空") String sourceLang,
            @Schema(description = "目标语言代码") @NotBlank(message = "目标语言不能为空") String targetLang,
            @Schema(description = "问题，最长 500 字符") @NotBlank(message = "问题不能为空")
            @Size(max = 500, message = "问题最长 500 字符") String question,
            @Schema(description = "此前的问答（最多取最近 6 轮）") List<@Valid QaTurn> history) {
    }

    /** 转发给 Python /internal/insights 的请求体（§1.6）。 */
    public record UpstreamInsightRequest(String source, String translation, String sourceLang, String targetLang,
                                         Long modelConfigId) {
    }

    /** 转发给 Python /internal/insights/ask 的请求体（§1.7）。 */
    public record UpstreamAskRequest(String source, String translation, String sourceLang, String targetLang,
                                     Long modelConfigId, String question, List<QaTurn> history) {
    }
}
