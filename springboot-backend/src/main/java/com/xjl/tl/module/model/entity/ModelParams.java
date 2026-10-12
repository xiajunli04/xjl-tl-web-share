package com.xjl.tl.module.model.entity;

import com.fasterxml.jackson.annotation.JsonInclude;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

import java.util.Map;

/**
 * 模型调用参数，存储为 jsonb：{"temperature":0.3,"maxTokens":1024,"timeoutSeconds":30,"maxRetries":2,"extra":{"voice":"Tina"}}。
 * extra 存放引擎相关的非敏感参数，如音色 voice、豆包 appId、推理强度 reasoningEffort。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@Schema(description = "模型调用参数")
public record ModelParams(
        @Schema(description = "温度 0-2") @DecimalMin(value = "0", message = "temperature 不能小于 0")
        @DecimalMax(value = "2", message = "temperature 不能大于 2") Double temperature,
        @Schema(description = "最大输出 token 数") @Min(value = 1, message = "maxTokens 至少为 1")
        @Max(value = 200000, message = "maxTokens 过大") Integer maxTokens,
        @Schema(description = "超时时间（秒）") @Min(value = 1, message = "timeoutSeconds 至少为 1")
        @Max(value = 600, message = "timeoutSeconds 不能超过 600") Integer timeoutSeconds,
        @Schema(description = "连接错误/429/5xx 自动重试次数，缺省为 2") @Min(value = 0, message = "maxRetries 不能小于 0")
        @Max(value = 5, message = "maxRetries 不能超过 5") Integer maxRetries,
        @Schema(description = "引擎相关的额外参数（非敏感），如 voice、appId、reasoningEffort")
        @Size(max = 20, message = "额外参数过多") Map<String, String> extra) {

    public static ModelParams empty() {
        return new ModelParams(null, null, null, null, null);
    }
}
