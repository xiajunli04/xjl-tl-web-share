package com.xjl.tl.module.speech.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

import java.util.List;

/**
 * 语音服务 DTO（字段契约见 docs/contracts/speech-image-api.md §0.2 / §1.1–1.3 / §2.1）。
 */
public final class SpeechDtos {

    private SpeechDtos() {
    }

    @Schema(description = "引擎信息（Python 探测与模型配置组装，Spring 原样返回）")
    public record EngineInfo(
            @Schema(description = "引擎 id", example = "cascade") String id,
            @Schema(description = "类型", allowableValues = {"asr", "tts", "interpret", "image", "chat"}) String type,
            @Schema(description = "名称", example = "平台级联") String name,
            @Schema(description = "厂商", example = "阿里百炼") String vendor,
            @Schema(description = "来源：builtin 内置 / config 模型配置", allowableValues = {"builtin", "config"}) String kind,
            @Schema(description = "是否可用") Boolean available,
            @Schema(description = "不可用原因（中文），可用时为 null") String reason,
            @Schema(description = "支持的语言") List<String> languages,
            @Schema(description = "所用模型配置 id（kind=config）") Long modelConfigId,
            @Schema(description = "同传引擎：是否厂商语音到语音") Boolean s2s,
            @Schema(description = "同传引擎：单条发言流最多目标语言数") Integer maxTargets,
            @Schema(description = "同传引擎：双向对话是否支持自动方向") Boolean autoConverse,
            @Schema(description = "额外语种约束说明") String constraint,
            @Schema(description = "AI 对话实时语音模型：提供方", example = "DASHSCOPE") String provider,
            @Schema(description = "AI 对话实时语音模型：是否经过真实联调（否则标注为实验）") Boolean tested) {

        /** 是否可用（null 视为不可用）。 */
        public boolean usable() {
            return Boolean.TRUE.equals(available);
        }

        /** 是否厂商语音到语音引擎（null 视为否）。 */
        public boolean speechToSpeech() {
            return Boolean.TRUE.equals(s2s);
        }
    }

    @Schema(description = "五类引擎列表")
    public record SpeechEngines(@Schema(description = "语音识别") List<EngineInfo> asr,
                                @Schema(description = "语音合成") List<EngineInfo> tts,
                                @Schema(description = "同声传译") List<EngineInfo> interpret,
                                @Schema(description = "图片翻译") List<EngineInfo> image,
                                @Schema(description = "AI 对话可用引擎（cascade 平台级联 / realtime-chat 实时语音模型）")
                                List<EngineInfo> chat) {

        /** 按 id 查找同传引擎，不存在返回 null。 */
        public EngineInfo interpretEngine(String id) {
            return find(interpret, id);
        }

        /** 按 id 查找 AI 对话引擎，不存在返回 null。 */
        public EngineInfo chatEngine(String id) {
            return find(chat, id);
        }

        private static EngineInfo find(List<EngineInfo> list, String id) {
            return list == null ? null : list.stream().filter(e -> id.equals(e.id())).findFirst().orElse(null);
        }
    }

    @Schema(description = "听写结果")
    public record TranscribeResult(@Schema(description = "识别文本") String text,
                                   @Schema(description = "识别语种", example = "zh") String lang,
                                   @Schema(description = "音频时长（毫秒）") Long durationMs,
                                   @Schema(description = "实际使用的引擎", example = "local-sensevoice") String engine) {
    }

    /** 转发给 Python /internal/speech/transcribe 的请求体（§1.2）。 */
    public record UpstreamTranscribeRequest(String audioBase64, String lang, String engine, Long modelConfigId) {
    }

    @Schema(description = "朗读请求")
    public record TtsRequest(
            @Schema(description = "文本，最长 2000 字符") @NotBlank(message = "文本不能为空") String text,
            @Schema(description = "语言代码", example = "en") @NotBlank(message = "语言不能为空") String lang,
            @Schema(description = "音色，缺省按语言取默认音色") String voice,
            @Schema(description = "性别（缺省 female）", allowableValues = {"female", "male"})
            @Pattern(regexp = "^(female|male)$", message = "性别只能是 female 或 male") String gender,
            @Schema(description = "引擎，缺省由 AI 服务选择", example = "edge-tts") String engine,
            @Schema(description = "语速倍率 0.5–2.0，缺省 1.0", example = "1.2")
            @DecimalMin(value = "0.5", message = "语速不能小于 0.5")
            @DecimalMax(value = "2.0", message = "语速不能大于 2.0") Double rate) {
    }

    /** 转发给 Python /internal/speech/tts 的请求体（§1.3）。 */
    public record UpstreamTtsRequest(String text, String lang, String voice, String gender, String engine,
                                     Long modelConfigId, Double rate) {
    }
}
