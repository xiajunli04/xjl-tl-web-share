package com.xjl.tl.module.session.dto;

import com.xjl.tl.common.PageQuery;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import tools.jackson.databind.JsonNode;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 翻译会话 DTO（字段契约见共享契约 F，一律 camelCase）。
 */
public final class SessionDtos {

    public static final String STYLE_REGEX = "^(faithful|fluent|creative)$";

    private SessionDtos() {
    }

    // ---------------- 请求 ----------------

    @Schema(description = "创建 / 修改会话（修改时全部字段可选，未给出的字段保持不变）")
    public record SessionRequest(
            @Schema(description = "标题，缺省取首轮原文前 20 个字符") @Size(max = 100, message = "标题最长 100 位") String title,
            @Schema(description = "默认源语言代码，auto 表示自动识别（创建时缺省 auto）", example = "auto") String sourceLang,
            @Schema(description = "默认目标语言代码（创建时必填）", example = "zh") String targetLang,
            @Schema(description = "默认风格（缺省 faithful）", allowableValues = {"faithful", "fluent", "creative"})
            @Pattern(regexp = STYLE_REGEX, message = "风格只能是 faithful、fluent 或 creative") String style,
            @Schema(description = "默认领域") @Size(max = 32, message = "领域最长 32 位") String domain,
            @Schema(description = "默认术语库 id 列表（须为自己的或公共的术语库）") List<@NotNull(message = "术语库 id 不能为空") Long> glossaryIds,
            @Schema(description = "默认模型配置 id（须为启用状态）") Long modelConfigId,
            @Schema(description = "是否允许歧义追问（缺省 true）") Boolean clarifyEnabled) {
    }

    @Schema(description = "会话查询条件")
    public static class SessionQuery extends PageQuery {
        @Schema(description = "标题关键词（不区分大小写）")
        private String keyword;

        public String getKeyword() {
            return keyword;
        }

        public void setKeyword(String keyword) {
            this.keyword = keyword;
        }
    }

    @Schema(description = "修订请求")
    public record ReviseRequest(
            @Schema(description = "被修订的记录 id（须属于该会话）") @NotNull(message = "记录 id 不能为空") Long recordId,
            @Schema(description = "修订要求，1–500 字符", example = "更口语一些") @NotBlank(message = "修订要求不能为空")
            @Size(max = 500, message = "修订要求最长 500 字符") String instruction) {
    }

    @Schema(description = "回答追问")
    public record ClarifyRequest(
            @Schema(description = "追问的 threadId（须与会话中等待回答的追问一致）", example = "turn:req-001")
            @NotBlank(message = "threadId 不能为空") String threadId,
            @Schema(description = "回答：选项之一或 1–200 字符的自由文本", example = "银行") @NotBlank(message = "回答不能为空")
            @Size(max = 200, message = "回答最长 200 字符") String answer) {
    }

    // ---------------- 响应 ----------------

    @Schema(description = "会话列表项")
    public record SessionSummaryVO(
            @Schema(description = "会话 id") Long id,
            @Schema(description = "标题（尚无翻译且未命名时为 null）") String title,
            @Schema(description = "默认源语言") String sourceLang,
            @Schema(description = "默认目标语言") String targetLang,
            @Schema(description = "轮次数") Integer turnCount,
            @Schema(description = "是否有等待回答的追问") Boolean hasPending,
            @Schema(description = "更新时间") OffsetDateTime updatedAt,
            @Schema(description = "创建时间") OffsetDateTime createdAt) {
    }

    @Schema(description = "会话（列表项 + 默认参数）")
    public record SessionVO(
            @Schema(description = "会话 id") Long id,
            @Schema(description = "标题") String title,
            @Schema(description = "默认源语言") String sourceLang,
            @Schema(description = "默认目标语言") String targetLang,
            @Schema(description = "轮次数") Integer turnCount,
            @Schema(description = "是否有等待回答的追问") Boolean hasPending,
            @Schema(description = "更新时间") OffsetDateTime updatedAt,
            @Schema(description = "创建时间") OffsetDateTime createdAt,
            @Schema(description = "默认风格") String style,
            @Schema(description = "默认领域") String domain,
            @Schema(description = "默认术语库 id 列表") List<Long> glossaryIds,
            @Schema(description = "默认模型配置 id") Long modelConfigId,
            @Schema(description = "是否允许歧义追问") Boolean clarifyEnabled) {
    }

    @Schema(description = "会话实体（人名、称谓、产品名等及其已用译法）")
    public record EntityVO(@Schema(description = "原文") String source,
                           @Schema(description = "已用译法") String target,
                           @Schema(description = "说明") String note) {
    }

    @Schema(description = "等待回答的追问")
    public record PendingVO(
            @Schema(description = "threadId") String threadId,
            @Schema(description = "问题") String question,
            @Schema(description = "选项（2–4 个）") List<String> options,
            @Schema(description = "歧义片段") String span,
            @Schema(description = "理由") String reason,
            @Schema(description = "触发追问的原文") String source) {
    }

    @Schema(description = "一轮中的一个版本")
    public record RecordBrief(
            @Schema(description = "记录 id") Long id,
            @Schema(description = "原文") String sourceText,
            @Schema(description = "译文") String targetText,
            @Schema(description = "模式", allowableValues = {"auto", "fast", "standard", "revise"}) String mode,
            @Schema(description = "实际路径", allowableValues = {"fast", "standard", "revise"}) String path,
            @Schema(description = "修订要求") String reviseInstruction,
            @Schema(description = "追问问答 {question, options, span, answer}") JsonNode clarification,
            @Schema(description = "修订来源记录 id（v1 为 null）") Long revisionOf,
            @Schema(description = "是否为采用版本") Boolean adopted,
            @Schema(description = "评审分") Integer reviewScore,
            @Schema(description = "创建时间") OffsetDateTime createdAt) {
    }

    @Schema(description = "一轮翻译：版本链（按创建时间升序，v1 为原始翻译）与当前采用版本")
    public record TurnVO(@Schema(description = "轮次号，从 1 开始") Integer seq,
                         @Schema(description = "版本链") List<RecordBrief> versions,
                         @Schema(description = "采用版本的记录 id") Long adoptedRecordId) {
    }

    @Schema(description = "会话详情")
    public record SessionDetailVO(
            @Schema(description = "会话 id") Long id,
            @Schema(description = "标题") String title,
            @Schema(description = "默认源语言") String sourceLang,
            @Schema(description = "默认目标语言") String targetLang,
            @Schema(description = "轮次数") Integer turnCount,
            @Schema(description = "是否有等待回答的追问") Boolean hasPending,
            @Schema(description = "更新时间") OffsetDateTime updatedAt,
            @Schema(description = "创建时间") OffsetDateTime createdAt,
            @Schema(description = "默认风格") String style,
            @Schema(description = "默认领域") String domain,
            @Schema(description = "默认术语库 id 列表") List<Long> glossaryIds,
            @Schema(description = "默认模型配置 id") Long modelConfigId,
            @Schema(description = "是否允许歧义追问") Boolean clarifyEnabled,
            @Schema(description = "早期轮次摘要") String memorySummary,
            @Schema(description = "会话实体表") List<EntityVO> memoryEntities,
            @Schema(description = "已压缩到第几轮") Integer memorizedUntil,
            @Schema(description = "等待回答的追问（没有时为 null）") PendingVO pending,
            @Schema(description = "按轮次号升序的轮次") List<TurnVO> turns) {
    }
}
