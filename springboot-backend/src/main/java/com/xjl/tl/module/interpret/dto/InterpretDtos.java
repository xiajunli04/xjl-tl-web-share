package com.xjl.tl.module.interpret.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.xjl.tl.common.PageQuery;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.format.annotation.DateTimeFormat;
import tools.jackson.databind.JsonNode;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/**
 * 同传会话 DTO（字段契约见 docs/contracts/speech-image-api.md §2.4）。
 */
public final class InterpretDtos {

    public static final String MODE_REGEX = "^(LISTEN|CONVERSE|ROOM|CHAT)$";
    /** AI 对话场景（add-ai-avatar-and-landing D6） */
    public static final String CHAT_SCENARIO_REGEX = "^(free|travel|restaurant|business|interview)$";
    /** 响应速度档位（improve-speech-playback-latency D6） */
    public static final String LATENCY_MODE_REGEX = "^(balanced|fast)$";
    public static final String WS_URL = "/ws/interpret";

    private InterpretDtos() {
    }

    @Schema(description = "创建同传会话")
    public record InterpretCreateRequest(
            @Schema(description = "模式", allowableValues = {"LISTEN", "CONVERSE", "ROOM", "CHAT"})
            @NotBlank(message = "模式不能为空") @Pattern(regexp = MODE_REGEX, message = "模式只能是 LISTEN、CONVERSE、ROOM 或 CHAT") String mode,
            @Schema(description = "引擎（缺省 cascade；CHAT 可选 cascade 或 realtime-chat 实时语音模型）", example = "cascade") String engine,
            @Schema(description = "LISTEN: [目标]；CONVERSE: [A, B]；ROOM: [我的语言]；CHAT: [我的语言, 对话语言]")
            @NotEmpty(message = "语言不能为空") List<@NotBlank(message = "语言不能为空") String> languages,
            @Schema(description = "LISTEN 的源语种提示（缺省自动识别）") List<String> sourceHints,
            @Schema(description = "CONVERSE 路由（缺省：级联 auto，S2S 引擎 ptt）", allowableValues = {"auto", "ptt"})
            @Pattern(regexp = "^(auto|ptt)$", message = "路由只能是 auto 或 ptt") String converseRouting,
            @Schema(description = "术语库 id") List<@NotNull(message = "术语库 id 不能为空") Long> glossaryIds,
            @Schema(description = "领域提示") @Size(max = 100, message = "领域提示最长 100 字符") String domainHint,
            @Schema(description = "是否语音播报（缺省 true）") Boolean tts,
            @Schema(description = "耳机模式（缺省 false，前端据此关闭半双工）") Boolean headphone,
            @Schema(description = "音色性别（缺省 female）", allowableValues = {"female", "male"})
            @Pattern(regexp = "^(female|male)$", message = "性别只能是 female 或 male") String gender,
            @Schema(description = "各语言音色 {lang: voice}") Map<String, String> voices,
            @Schema(description = "级联识别引擎（缺省由 AI 服务选择）") String asrEngine,
            @Schema(description = "级联合成引擎（缺省由 AI 服务选择）") String ttsEngine,
            @Schema(description = "模型配置 id：级联翻译所用对话模型或 S2S 所用实时同传配置") Long modelConfigId,
            @Schema(description = "显示名（会议室中显示）") @Size(max = 64, message = "显示名最长 64 字符") String displayName,
            @Schema(description = "标题（缺省按模式生成）") @Size(max = 200, message = "标题最长 200 字符") String title,
            @Schema(description = "AI 对话场景（仅 CHAT，缺省 free）", allowableValues = {"free", "travel", "restaurant", "business", "interview"})
            @Pattern(regexp = CHAT_SCENARIO_REGEX, message = "场景只能是 free、travel、restaurant、business 或 interview") String chatScenario,
            @Schema(description = "响应速度（缺省 balanced；仅对平台级联生效，fast 断句更快）", allowableValues = {"balanced", "fast"})
            @Pattern(regexp = LATENCY_MODE_REGEX, message = "响应速度只能是 balanced 或 fast") String latencyMode) {
    }

    @Schema(description = "加入会议室")
    public record JoinRequest(
            @Schema(description = "显示名（缺省为用户名）") @Size(max = 64, message = "显示名最长 64 字符") String displayName,
            @Schema(description = "我的语言", example = "en") @NotBlank(message = "语言不能为空") String lang,
            @Schema(description = "断线 30 秒内重新加入时携带原 participantId 以恢复身份") String participantId,
            @Schema(description = "是否接收语音播报（缺省 true）") Boolean tts) {
    }

    @Schema(description = "连接信息（创建、加入、重取票据的返回值）")
    public record InterpretJoinVO(
            @Schema(description = "会话 id") Long sessionId,
            @Schema(description = "参与者 id", example = "p1") String participantId,
            @Schema(description = "一次性 WebSocket 票据（60 秒内有效）") String wsTicket,
            @Schema(description = "房间码（仅会议室）", example = "K7M2QX") String roomCode,
            @Schema(description = "模式") String mode,
            @Schema(description = "引擎") String engine,
            @Schema(description = "语言（会议室为本人语言）") List<String> languages,
            @Schema(description = "是否主持人 / 创建者") @JsonProperty("isHost") boolean isHost,
            @Schema(description = "WebSocket 路径", example = WS_URL) String wsUrl) {
    }

    @Schema(description = "同传会话")
    public record InterpretSessionVO(
            @Schema(description = "会话 id") Long id,
            @Schema(description = "模式") String mode,
            @Schema(description = "引擎") String engine,
            @Schema(description = "语言") JsonNode languages,
            @Schema(description = "房间码") String roomCode,
            @Schema(description = "状态", allowableValues = {"ACTIVE", "ENDED"}) String status,
            @Schema(description = "标题") String title,
            @Schema(description = "开始时间") OffsetDateTime startedAt,
            @Schema(description = "结束时间") OffsetDateTime endedAt,
            @Schema(description = "时长（毫秒）") Integer durationMs,
            @Schema(description = "统计 {utterances, avgE2eMs, p50E2eMs, participants, languages}") JsonNode stats,
            @Schema(description = "是否收藏") Boolean favorite,
            @Schema(description = "会话选项") JsonNode options) {
    }

    @Schema(description = "转写段")
    public record InterpretSegmentVO(
            @Schema(description = "序号") Integer seq,
            @Schema(description = "发言人参与者 id") String speakerParticipant,
            @Schema(description = "发言人显示名") String speakerName,
            @Schema(description = "源语种") String sourceLang,
            @Schema(description = "原文") String sourceText,
            @Schema(description = "各语种译文 {lang: text}") JsonNode translations,
            @Schema(description = "指标 {asrMs, mtFirstMs, mtMs, ttsFirstMs, e2eMs}") JsonNode metrics,
            @Schema(description = "开始偏移（毫秒，相对会话开始）") Integer startedMs,
            @Schema(description = "结束偏移（毫秒）") Integer endedMs) {
    }

    @Schema(description = "同传会话查询条件")
    public static class InterpretQuery extends PageQuery {
        @Schema(description = "关键词（匹配标题或转写内容，不区分大小写）")
        private String keyword;
        @Schema(description = "模式", allowableValues = {"LISTEN", "CONVERSE", "ROOM"})
        private String mode;
        @Schema(description = "是否只看收藏")
        private Boolean favorite;
        @Schema(description = "开始时间（ISO-8601，含）", example = "2026-10-01T00:00:00+08:00")
        @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
        private OffsetDateTime from;
        @Schema(description = "结束时间（ISO-8601，不含）", example = "2026-10-02T00:00:00+08:00")
        @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
        private OffsetDateTime to;

        public String getKeyword() {
            return keyword;
        }

        public void setKeyword(String keyword) {
            this.keyword = keyword;
        }

        public String getMode() {
            return mode;
        }

        public void setMode(String mode) {
            this.mode = mode;
        }

        public Boolean getFavorite() {
            return favorite;
        }

        public void setFavorite(Boolean favorite) {
            this.favorite = favorite;
        }

        public OffsetDateTime getFrom() {
            return from;
        }

        public void setFrom(OffsetDateTime from) {
            this.from = from;
        }

        public OffsetDateTime getTo() {
            return to;
        }

        public void setTo(OffsetDateTime to) {
            this.to = to;
        }
    }
}
