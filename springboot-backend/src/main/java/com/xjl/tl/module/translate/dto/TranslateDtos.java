package com.xjl.tl.module.translate.dto;

import com.xjl.tl.common.PageQuery;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.format.annotation.DateTimeFormat;
import tools.jackson.databind.JsonNode;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 翻译、语种识别与历史记录 DTO（字段契约见 design D7）。
 */
public final class TranslateDtos {

    public static final String MODE_REGEX = "^(auto|fast|standard)$";
    public static final String STYLE_REGEX = "^(faithful|fluent|creative)$";

    private TranslateDtos() {
    }

    // ---------------- 语种 ----------------

    @Schema(description = "支持的语种")
    public record LanguageVO(@Schema(description = "语种代码", example = "ja") String code,
                             @Schema(description = "中文名", example = "日语") String name,
                             @Schema(description = "本族语名称", example = "日本語") String nativeName) {
    }

    @Schema(description = "语种识别请求")
    public record DetectRequest(@Schema(description = "待识别文本") @NotBlank(message = "文本不能为空") String text) {
    }

    @Schema(description = "语种识别结果（与 Python /internal/lang/detect 的 data 一致）")
    public record DetectResult(@Schema(description = "最可能的语种代码") String lang,
                               @Schema(description = "置信度 0-1") Double confidence,
                               @Schema(description = "识别方法", allowableValues = {"lingua", "llm"}) String method,
                               @Schema(description = "候选（最多 3 个）") List<Candidate> candidates) {

        public record Candidate(@Schema(description = "语种代码") String lang,
                                @Schema(description = "置信度") Double confidence) {
        }
    }

    // ---------------- 翻译 ----------------

    @Schema(description = "翻译请求（带 sessionId 时，未显式给出的参数取会话的默认参数）")
    public record TranslateRequest(
            @Schema(description = "原文，最长 5000 字符") @NotBlank(message = "原文不能为空") String text,
            @Schema(description = "源语言代码，auto 表示自动识别（缺省 auto，会话内缺省取会话设置）", example = "auto") String sourceLang,
            @Schema(description = "目标语言代码（非会话请求必填，会话内缺省取会话设置）", example = "zh") String targetLang,
            @Schema(description = "模式（缺省 auto）", allowableValues = {"auto", "fast", "standard"})
            @Pattern(regexp = MODE_REGEX, message = "模式只能是 auto、fast 或 standard") String mode,
            @Schema(description = "风格（缺省 faithful）", allowableValues = {"faithful", "fluent", "creative"})
            @Pattern(regexp = STYLE_REGEX, message = "风格只能是 faithful、fluent 或 creative") String style,
            @Schema(description = "领域，缺省由 Agent 判定") @Size(max = 32, message = "领域最长 32 位") String domain,
            @Schema(description = "术语库 id 列表（须为自己的或公共的术语库）") List<@NotNull(message = "术语库 id 不能为空") Long> glossaryIds,
            @Schema(description = "模型配置 id，缺省使用默认模型") Long modelConfigId,
            @Schema(description = "评审模型配置 id（须为启用状态，否则 C0130），缺省使用管理员设置的评审模型，仍没有则评审使用译者模型")
            Long reviewModelConfigId,
            @Schema(description = "会话 id（须为自己的会话，否则 A0404）：使用会话默认参数并注入会话上下文；会话有待回答的追问时视为放弃该追问")
            Long sessionId) {
    }

    /**
     * 转发给 Python /internal/translate/stream 的请求体：TranslateRequest + userId（已补全缺省值）。
     * reviewModelConfigId 为解析后的评审模型（null 表示评审使用译者模型）；
     * session / revise 仅会话请求与修订时非 null（契约 A）。
     */
    public record UpstreamTranslateRequest(String text, String sourceLang, String targetLang, String mode, String style,
                                           String domain, List<Long> glossaryIds, Long modelConfigId,
                                           Long reviewModelConfigId, Long userId, SessionPayload session,
                                           RevisePayload revise) {

        public UpstreamTranslateRequest withSession(SessionPayload s, RevisePayload r) {
            return new UpstreamTranslateRequest(text, sourceLang, targetLang, mode, style, domain, glossaryIds,
                    modelConfigId, reviewModelConfigId, userId, s, r);
        }
    }

    /**
     * 会话载荷（契约 A）：recentTurns 为最近 6 轮已采用版本（seq 升序，每轮原文截断到 500 字符，总量超过 4000 字符时
     * 从最早轮次丢弃）；toMemorize 为待压缩的已采用轮次（不足 3 轮时为空）；turnSeq 为本轮轮次号（修订轮为被修订轮的 seq）。
     */
    public record SessionPayload(Long sessionId, Boolean clarifyEnabled, List<SessionTurnPayload> recentTurns,
                                 String summary, JsonNode entities, List<MemorizeTurnPayload> toMemorize,
                                 Integer memorizedUntil, Integer turnSeq) {
    }

    /** 会话上下文中的一轮：采用版本的原文、译文与修订要求。 */
    public record SessionTurnPayload(Integer seq, String source, String target, String instruction) {
    }

    /** 待压缩进会话摘要的一轮。 */
    public record MemorizeTurnPayload(Integer seq, String source, String target) {
    }

    /** 修订载荷（契约 A，仅 mode=revise）。 */
    public record RevisePayload(Long recordId, String baseSource, String baseTarget, String instruction) {
    }

    /** 转发给 Python /internal/translate/resume 的请求体（契约 B）。 */
    public record UpstreamResumeRequest(String threadId, String answer, Long userId) {
    }

    // ---------------- 历史 ----------------

    @Schema(description = "翻译历史查询条件")
    public static class TranslationQuery extends PageQuery {
        @Schema(description = "关键词（匹配原文或译文，不区分大小写）")
        private String keyword;
        @Schema(description = "源语言代码（自动识别的记录按识别结果匹配）")
        private String sourceLang;
        @Schema(description = "目标语言代码")
        private String targetLang;
        @Schema(description = "是否只看收藏")
        private Boolean favorite;
        @Schema(description = "开始时间（ISO-8601，含）", example = "2026-10-01T00:00:00+08:00")
        @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
        private OffsetDateTime startTime;
        @Schema(description = "结束时间（ISO-8601，不含）", example = "2026-10-02T00:00:00+08:00")
        @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
        private OffsetDateTime endTime;

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

        public Boolean getFavorite() {
            return favorite;
        }

        public void setFavorite(Boolean favorite) {
            this.favorite = favorite;
        }

        public OffsetDateTime getStartTime() {
            return startTime;
        }

        public void setStartTime(OffsetDateTime startTime) {
            this.startTime = startTime;
        }

        public OffsetDateTime getEndTime() {
            return endTime;
        }

        public void setEndTime(OffsetDateTime endTime) {
            this.endTime = endTime;
        }
    }

    @Schema(description = "翻译历史列表项")
    public record TranslationSummaryVO(
            @Schema(description = "记录 id") Long id,
            @Schema(description = "原文预览（前 100 字符）") String sourcePreview,
            @Schema(description = "译文预览（前 100 字符）") String targetPreview,
            @Schema(description = "源语言（自动识别时为识别结果）") String sourceLang,
            @Schema(description = "目标语言") String targetLang,
            @Schema(description = "实际路径", allowableValues = {"fast", "standard", "revise"}) String path,
            @Schema(description = "评审分（快速路径为空）") Integer reviewScore,
            @Schema(description = "是否收藏") Boolean favorite,
            @Schema(description = "总耗时（毫秒）") Integer latencyMs,
            @Schema(description = "创建时间") OffsetDateTime createdAt,
            @Schema(description = "所属会话 id（非会话记录为 null）") Long sessionId,
            @Schema(description = "修订来源记录 id") Long revisionOf,
            @Schema(description = "修订要求") String reviseInstruction,
            @Schema(description = "追问问答 {question, options, span, answer}") JsonNode clarification,
            @Schema(description = "是否为所在轮次的采用版本") Boolean adopted) {
    }

    @Schema(description = "Agent 节点轨迹")
    public record TraceVO(
            @Schema(description = "执行顺序，从 1 开始") Integer seq,
            @Schema(description = "节点名", example = "translate") String node,
            @Schema(description = "状态", allowableValues = {"completed", "skipped", "started", "interrupted"}) String status,
            @Schema(description = "中文摘要") String summary,
            @Schema(description = "详情：该节点相关的事件内容（detect / terms / plan / review / output）") JsonNode detail,
            @Schema(description = "耗时（毫秒）") Integer latencyMs,
            @Schema(description = "输入 token") Integer promptTokens,
            @Schema(description = "输出 token") Integer completionTokens) {
    }

    @Schema(description = "翻译记录详情")
    public record TranslationDetailVO(
            @Schema(description = "记录 id") Long id,
            @Schema(description = "原文") String sourceText,
            @Schema(description = "译文") String targetText,
            @Schema(description = "用户选择的源语言（可能为 auto）") String sourceLang,
            @Schema(description = "识别出的语种") String detectedLang,
            @Schema(description = "目标语言") String targetLang,
            @Schema(description = "模式") String mode,
            @Schema(description = "实际路径") String path,
            @Schema(description = "风格") String style,
            @Schema(description = "领域") String domain,
            @Schema(description = "所用术语库 id") List<Long> glossaryIds,
            @Schema(description = "所用模型配置 id") Long modelConfigId,
            @Schema(description = "最终评审分") Integer reviewScore,
            @Schema(description = "修正轮次") Integer reviewRounds,
            @Schema(description = "术语遵循情况 [{source, target, compliant}]") JsonNode compliance,
            @Schema(description = "术语命中 [{source, target, glossaryId}]") JsonNode termHits,
            @Schema(description = "输入 token") Integer promptTokens,
            @Schema(description = "输出 token") Integer completionTokens,
            @Schema(description = "总耗时（毫秒）") Integer latencyMs,
            @Schema(description = "是否收藏") Boolean favorite,
            @Schema(description = "创建时间") OffsetDateTime createdAt,
            @Schema(description = "按 seq 排序的 Agent 轨迹") List<TraceVO> traces,
            @Schema(description = "所属会话 id（非会话记录为 null）") Long sessionId,
            @Schema(description = "修订来源记录 id") Long revisionOf,
            @Schema(description = "修订要求") String reviseInstruction,
            @Schema(description = "追问问答 {question, options, span, answer}") JsonNode clarification,
            @Schema(description = "是否为所在轮次的采用版本") Boolean adopted) {
    }

    @Schema(description = "收藏/取消收藏")
    public record FavoriteRequest(@Schema(description = "是否收藏") @NotNull(message = "favorite 不能为空") Boolean favorite) {
    }
}
