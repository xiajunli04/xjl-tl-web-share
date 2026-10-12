package com.xjl.tl.module.model.dto;

import com.xjl.tl.common.PageQuery;
import com.xjl.tl.module.model.entity.ModelParams;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.OffsetDateTime;

/**
 * 模型配置 DTO（字段契约见 design D13）。
 */
public final class ModelConfigDtos {

    public static final String PROVIDER_REGEX = "^(OPENAI_COMPATIBLE|ANTHROPIC|DASHSCOPE|VOLCENGINE|GOOGLE)$";
    public static final String CAPABILITY_REGEX = "^(CHAT|ASR|TTS|REALTIME_TRANSLATE|REALTIME_CHAT|IMAGE_TRANSLATE)$";

    private ModelConfigDtos() {
    }

    @Schema(description = "模型配置")
    public record ModelConfigVO(
            @Schema(description = "id") Long id,
            @Schema(description = "显示名") String name,
            @Schema(description = "能力类型", allowableValues = {"CHAT", "ASR", "TTS", "REALTIME_TRANSLATE", "REALTIME_CHAT", "IMAGE_TRANSLATE"}) String capability,
            @Schema(description = "提供方", allowableValues = {"OPENAI_COMPATIBLE", "ANTHROPIC", "DASHSCOPE", "VOLCENGINE", "GOOGLE"}) String provider,
            @Schema(description = "接口地址") String baseUrl,
            @Schema(description = "模型名") String modelName,
            @Schema(description = "API Key 掩码") String apiKeyMask,
            @Schema(description = "是否支持图片输入") Boolean supportsVision,
            @Schema(description = "调用参数") ModelParams params,
            @Schema(description = "是否默认模型") Boolean isDefault,
            @Schema(description = "是否评审模型") Boolean isReviewDefault,
            @Schema(description = "是否启用") Boolean enabled,
            @Schema(description = "备注") String remark,
            @Schema(description = "创建时间") OffsetDateTime createdAt,
            @Schema(description = "更新时间") OffsetDateTime updatedAt) {
    }

    @Schema(description = "新增/编辑模型配置；编辑时 apiKey 为空或缺省表示保持原值")
    public record ModelConfigRequest(
            @Schema(description = "显示名") @NotBlank(message = "名称不能为空") @Size(max = 64, message = "名称最长 64 位") String name,
            @Schema(description = "能力类型，缺省为 CHAT", allowableValues = {"CHAT", "ASR", "TTS", "REALTIME_TRANSLATE", "REALTIME_CHAT", "IMAGE_TRANSLATE"})
            @Pattern(regexp = CAPABILITY_REGEX, message = "能力类型不合法") String capability,
            @Schema(description = "提供方", allowableValues = {"OPENAI_COMPATIBLE", "ANTHROPIC", "DASHSCOPE", "VOLCENGINE", "GOOGLE"})
            @NotNull(message = "提供方不能为空") @Pattern(regexp = PROVIDER_REGEX, message = "提供方不合法") String provider,
            @Schema(description = "接口地址（实时同传可用 wss://）", example = "https://api.deepseek.com/v1") @NotBlank(message = "接口地址不能为空")
            @Size(max = 255, message = "接口地址最长 255 位") @Pattern(regexp = "^(https?|wss?)://.+", message = "接口地址须以 http(s):// 或 ws(s):// 开头") String baseUrl,
            @Schema(description = "模型名", example = "deepseek-chat") @NotBlank(message = "模型名不能为空") @Size(max = 128, message = "模型名最长 128 位") String modelName,
            @Schema(description = "API Key（新增必填）") @Size(max = 512, message = "API Key 过长") String apiKey,
            @Schema(description = "调用参数") @Valid ModelParams params,
            @Schema(description = "备注") @Size(max = 255, message = "备注最长 255 位") String remark,
            @Schema(description = "是否启用，默认 true") Boolean enabled,
            @Schema(description = "是否支持图片输入（仅 CHAT），默认 false") Boolean supportsVision) {
    }

    @Schema(description = "可用模型选项（不含任何连接信息与密钥字段）")
    public record ModelOptionVO(
            @Schema(description = "id") Long id,
            @Schema(description = "显示名") String name,
            @Schema(description = "能力类型") String capability,
            @Schema(description = "提供方") String provider,
            @Schema(description = "是否默认模型") Boolean isDefault,
            @Schema(description = "是否评审模型") Boolean isReviewDefault,
            @Schema(description = "是否支持图片输入") Boolean supportsVision) {
    }

    @Schema(description = "启用/停用")
    public record EnabledRequest(@Schema(description = "是否启用") @NotNull(message = "enabled 不能为空") Boolean enabled) {
    }

    @Schema(description = "模型配置查询条件")
    public static class ModelConfigQuery extends PageQuery {
        @Schema(description = "关键字（匹配名称或模型名）")
        private String keyword;

        public String getKeyword() {
            return keyword;
        }

        public void setKeyword(String keyword) {
            this.keyword = keyword;
        }
    }
}
