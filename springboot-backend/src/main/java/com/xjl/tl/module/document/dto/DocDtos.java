package com.xjl.tl.module.document.dto;

import com.xjl.tl.common.PageQuery;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import tools.jackson.databind.JsonNode;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 文档任务 DTO（字段契约见 design D13，前端按此并行开发，字段一律 camelCase）。
 */
public final class DocDtos {

    public static final String FORMAT_REGEX = "^(md|txt)$";
    public static final String STYLE_REGEX = "^(faithful|fluent|creative)$";
    public static final String STRATEGY_REGEX = "^(serial|parallel|hybrid)$";
    public static final String TERM_STATUS_REGEX = "^(CONFIRMED|REJECTED)$";

    private DocDtos() {
    }

    // ---------------- 请求 ----------------

    @Schema(description = "实验选项（缺省 contextWindow、globalSummary、termExtraction、translationMemory 开启，review 关闭）")
    public record DocOptions(@Schema(description = "前块上下文（缺省 true）") Boolean contextWindow,
                             @Schema(description = "全文摘要（缺省 true）") Boolean globalSummary,
                             @Schema(description = "候选术语抽取（缺省 true）") Boolean termExtraction,
                             @Schema(description = "评审与修正（缺省 false，按需开启）") Boolean review,
                             @Schema(description = "翻译记忆（缺省 true）：按段检索任务所属用户的翻译记忆作为参考译法") Boolean translationMemory) {

        /** 推荐的缺省选项：上下文 + 摘要 + 术语抽取 + 翻译记忆，不评审（实验显示评审显著增加成本而无可测量的质量收益）。 */
        public static final DocOptions DEFAULTS = new DocOptions(true, true, true, false, true);

        /** 缺省字段按 DEFAULTS 补全：review 补为 false，其余补为 true。 */
        public DocOptions normalized() {
            return new DocOptions(contextWindow == null || contextWindow, globalSummary == null || globalSummary,
                    termExtraction == null || termExtraction, Boolean.TRUE.equals(review),
                    translationMemory == null || translationMemory);
        }
    }

    @Schema(description = "创建文档任务（JSON 方式；multipart 方式的 settings 也使用本结构，其中 text、format 被忽略）")
    public record CreateDocTaskRequest(
            @Schema(description = "标题，缺省取首个标题或首行（multipart 方式缺省取文件名）") @Size(max = 200, message = "标题最长 200 位") String title,
            @Schema(description = "原文，去除空白后不能为空，最长 50000 字符") String text,
            @Schema(description = "格式", allowableValues = {"md", "txt"}) @Pattern(regexp = FORMAT_REGEX, message = "格式只能是 md 或 txt") String format,
            @Schema(description = "源语言代码，auto 表示自动识别（缺省 auto）", example = "auto") String sourceLang,
            @Schema(description = "目标语言代码", example = "zh") @NotBlank(message = "目标语言不能为空") String targetLang,
            @Schema(description = "风格（缺省 faithful）", allowableValues = {"faithful", "fluent", "creative"})
            @Pattern(regexp = STYLE_REGEX, message = "风格只能是 faithful、fluent 或 creative") String style,
            @Schema(description = "领域，缺省由 Agent 判定") @Size(max = 32, message = "领域最长 32 位") String domain,
            @Schema(description = "术语库 id 列表（须为自己的或公共的术语库）") List<@NotNull(message = "术语库 id 不能为空") Long> glossaryIds,
            @Schema(description = "模型配置 id，缺省使用默认模型") Long modelConfigId,
            @Schema(description = "评审模型配置 id（须为启用状态，否则 C0130），缺省使用管理员设置的评审模型，仍没有则与译者相同；创建时解析并记录到任务上")
            Long reviewModelConfigId,
            @Schema(description = "分块策略（缺省 hybrid）", allowableValues = {"serial", "parallel", "hybrid"})
            @Pattern(regexp = STRATEGY_REGEX, message = "策略只能是 serial、parallel 或 hybrid") String strategy,
            @Schema(description = "是否人工确认术语（缺省 true）") Boolean confirmTerms,
            @Schema(description = "实验选项（缺省 contextWindow、globalSummary、termExtraction、translationMemory 开启，review 关闭）") @Valid DocOptions options) {
    }

    @Schema(description = "文档任务查询条件")
    public static class DocTaskQuery extends PageQuery {
        @Schema(description = "状态", allowableValues = {"PENDING", "PARSING", "ANALYZING", "AWAITING_CONFIRM",
                "TRANSLATING", "CONSISTENCY", "COMPLETED", "FAILED", "CANCELLING", "CANCELLED"})
        private String status;
        @Schema(description = "标题关键词（不区分大小写）")
        private String keyword;

        public String getStatus() {
            return status;
        }

        public void setStatus(String status) {
            this.status = status;
        }

        public String getKeyword() {
            return keyword;
        }

        public void setKeyword(String keyword) {
            this.keyword = keyword;
        }
    }

    @Schema(description = "术语确认")
    public record ConfirmTermsRequest(
            @Schema(description = "确认结果；未出现在列表中的待确认术语视为拒绝")
            @NotNull(message = "术语列表不能为空") List<@Valid @NotNull(message = "术语不能为空") TermDecision> terms) {
    }

    @Schema(description = "单条术语的确认结果")
    public record TermDecision(
            @Schema(description = "术语 id，为空表示用户新增的术语") Long id,
            @Schema(description = "源术语") @NotBlank(message = "源术语不能为空") @Size(max = 200, message = "源术语最长 200 位") String source,
            @Schema(description = "译法") @NotBlank(message = "译法不能为空") @Size(max = 200, message = "译法最长 200 位") String target,
            @Schema(description = "确认状态", allowableValues = {"CONFIRMED", "REJECTED"})
            @NotBlank(message = "状态不能为空") @Pattern(regexp = TERM_STATUS_REGEX, message = "状态只能是 CONFIRMED 或 REJECTED") String status) {
    }

    @Schema(description = "段落后编辑")
    public record EditSegmentRequest(
            @Schema(description = "新译文") @NotNull(message = "译文不能为空") @Size(max = 20000, message = "译文最长 20000 字符") String target) {
    }

    @Schema(description = "单段重译")
    public record RetranslateRequest(
            @Schema(description = "补充要求，如“更口语化”") @Size(max = 200, message = "补充要求最长 200 字符") String instruction) {
    }

    // ---------------- 响应 ----------------

    @Schema(description = "文档任务详情（不含原文）")
    public record DocTaskVO(
            @Schema(description = "id") Long id,
            @Schema(description = "标题") String title,
            @Schema(description = "格式", allowableValues = {"md", "txt"}) String format,
            @Schema(description = "原文字符数") Integer charCount,
            @Schema(description = "用户选择的源语言，可能为 auto") String sourceLang,
            @Schema(description = "识别出的语种") String detectedLang,
            @Schema(description = "目标语言") String targetLang,
            @Schema(description = "风格") String style,
            @Schema(description = "领域") String domain,
            @Schema(description = "文体") String genre,
            @Schema(description = "术语库 id 列表") List<Long> glossaryIds,
            @Schema(description = "模型配置 id") Long modelConfigId,
            @Schema(description = "评审模型配置 id（创建时解析的结果，null 表示与译者相同）") Long reviewModelConfigId,
            @Schema(description = "分块策略") String strategy,
            @Schema(description = "是否人工确认术语") Boolean confirmTerms,
            @Schema(description = "实验选项") DocOptions options,
            @Schema(description = "状态") String status,
            @Schema(description = "执行端上报的最近阶段") String phase,
            @Schema(description = "已完成分块数") Integer progressDone,
            @Schema(description = "分块总数") Integer progressTotal,
            @Schema(description = "全文摘要") String summary,
            @Schema(description = "一致性报告 {issues:[{term, variants:[{text, count}], chosen, fixedSegs, unresolvedSegs}]}") JsonNode consistencyReport,
            @Schema(description = "统计 {chunks, cachedChunks, refined, compliance:{ok,total}}") JsonNode stats,
            @Schema(description = "错误码") String errorCode,
            @Schema(description = "错误信息") String errorMessage,
            @Schema(description = "失败后是否可继续") Boolean retryable,
            @Schema(description = "输入 token") Integer promptTokens,
            @Schema(description = "输出 token") Integer completionTokens,
            @Schema(description = "耗时（毫秒）") Integer latencyMs,
            @Schema(description = "创建时间") OffsetDateTime createdAt,
            @Schema(description = "开始执行时间") OffsetDateTime startedAt,
            @Schema(description = "结束时间") OffsetDateTime finishedAt) {
    }

    @Schema(description = "文档任务列表项（DocTaskVO 去掉 summary、consistencyReport、stats）")
    public record DocTaskSummaryVO(
            @Schema(description = "id") Long id,
            @Schema(description = "标题") String title,
            @Schema(description = "格式") String format,
            @Schema(description = "原文字符数") Integer charCount,
            @Schema(description = "用户选择的源语言") String sourceLang,
            @Schema(description = "识别出的语种") String detectedLang,
            @Schema(description = "目标语言") String targetLang,
            @Schema(description = "风格") String style,
            @Schema(description = "领域") String domain,
            @Schema(description = "文体") String genre,
            @Schema(description = "术语库 id 列表") List<Long> glossaryIds,
            @Schema(description = "模型配置 id") Long modelConfigId,
            @Schema(description = "评审模型配置 id") Long reviewModelConfigId,
            @Schema(description = "分块策略") String strategy,
            @Schema(description = "是否人工确认术语") Boolean confirmTerms,
            @Schema(description = "实验选项") DocOptions options,
            @Schema(description = "状态") String status,
            @Schema(description = "最近阶段") String phase,
            @Schema(description = "已完成分块数") Integer progressDone,
            @Schema(description = "分块总数") Integer progressTotal,
            @Schema(description = "错误码") String errorCode,
            @Schema(description = "错误信息") String errorMessage,
            @Schema(description = "失败后是否可继续") Boolean retryable,
            @Schema(description = "输入 token") Integer promptTokens,
            @Schema(description = "输出 token") Integer completionTokens,
            @Schema(description = "耗时（毫秒）") Integer latencyMs,
            @Schema(description = "创建时间") OffsetDateTime createdAt,
            @Schema(description = "开始执行时间") OffsetDateTime startedAt,
            @Schema(description = "结束时间") OffsetDateTime finishedAt) {

        public static DocTaskSummaryVO of(DocTaskVO v) {
            return new DocTaskSummaryVO(v.id(), v.title(), v.format(), v.charCount(), v.sourceLang(), v.detectedLang(),
                    v.targetLang(), v.style(), v.domain(), v.genre(), v.glossaryIds(), v.modelConfigId(),
                    v.reviewModelConfigId(), v.strategy(), v.confirmTerms(), v.options(), v.status(), v.phase(),
                    v.progressDone(), v.progressTotal(), v.errorCode(), v.errorMessage(), v.retryable(),
                    v.promptTokens(), v.completionTokens(), v.latencyMs(), v.createdAt(), v.startedAt(),
                    v.finishedAt());
        }
    }

    @Schema(description = "文档段落")
    public record DocSegmentVO(
            @Schema(description = "段序号（从 0 开始）") Integer seq,
            @Schema(description = "块类型", allowableValues = {"heading", "paragraph", "list_item", "blockquote",
                    "table_row", "code", "html", "blank", "hr"}) String blockType,
            @Schema(description = "标题级别（仅 heading）") Integer level,
            @Schema(description = "前缀标记") String prefix,
            @Schema(description = "原文") String source,
            @Schema(description = "后缀（行尾与块间换行）") String suffix,
            @Schema(description = "是否可翻译") Boolean translatable,
            @Schema(description = "所属分块") Integer chunkIndex,
            @Schema(description = "译文（未翻译时为 null）") String target,
            @Schema(description = "状态", allowableValues = {"PENDING", "DONE"}) String status,
            @Schema(description = "评审分") Integer reviewScore,
            @Schema(description = "修正轮次") Integer reviewRounds,
            @Schema(description = "术语遵循 [{source, target, compliant}]") JsonNode compliance,
            @Schema(description = "是否已编辑") Boolean edited,
            @Schema(description = "翻译记忆命中 [{id, source, target, fuzzy, semantic, origin, originRef}]（0–1 条）") JsonNode tmHits) {
    }

    @Schema(description = "任务术语")
    public record DocTermVO(
            @Schema(description = "id") Long id,
            @Schema(description = "源术语") String source,
            @Schema(description = "译法") String target,
            @Schema(description = "来源", allowableValues = {"glossary", "extracted", "user"}) String origin,
            @Schema(description = "出现次数") Integer frequency,
            @Schema(description = "状态：PENDING 待确认 / CONFIRMED 已确认或术语库命中（强制使用）/ REJECTED 已拒绝 / "
                    + "AUTO 未开启确认时自动采用的抽取术语（仅供参考，不强制）",
                    allowableValues = {"PENDING", "CONFIRMED", "REJECTED", "AUTO"}) String status) {
    }

    @Schema(description = "执行轨迹")
    public record DocTraceVO(
            @Schema(description = "序号") Integer seq,
            @Schema(description = "节点") String node,
            @Schema(description = "分块") Integer chunkIndex,
            @Schema(description = "状态") String status,
            @Schema(description = "摘要") String summary,
            @Schema(description = "耗时（毫秒）") Integer latencyMs,
            @Schema(description = "输入 token") Integer promptTokens,
            @Schema(description = "输出 token") Integer completionTokens,
            @Schema(description = "记录时间") OffsetDateTime createdAt) {
    }

    @Schema(description = "token 用量")
    public record Usage(@Schema(description = "输入 token") Integer promptTokens,
                        @Schema(description = "输出 token") Integer completionTokens) {
    }

    @Schema(description = "单段重译结果（不自动保存，确认后再调用后编辑接口）")
    public record RetranslateResult(@Schema(description = "新译文") String target,
                                    @Schema(description = "用量") Usage usage,
                                    @Schema(description = "耗时（毫秒）") Integer latencyMs) {
    }

    /** 转发给 Python /internal/doc/segment/retranslate 的请求体（design D11）。 */
    public record UpstreamRetranslateRequest(Long taskId, Integer seq, String source, String prevSource,
                                             String prevTarget, String nextSource, String summary,
                                             List<TermPair> terms, String targetLang, String style, String domain,
                                             Long modelConfigId, String instruction) {
    }

    /** 术语对 {source, target}（resume 命令与重译请求共用）。 */
    public record TermPair(String source, String target) {
    }

    /** 任务流 start / retry 命令的 payload（design D2；reviewModelConfigId 为任务上记录的评审模型，可能为 null）。 */
    public record TaskPayload(Long userId, String title, String format, String text, String sourceLang,
                              String targetLang, String style, String domain, List<Long> glossaryIds,
                              Long modelConfigId, Long reviewModelConfigId, String strategy, Boolean confirmTerms,
                              DocOptions options) {
    }
}
