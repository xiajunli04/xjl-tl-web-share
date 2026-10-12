package com.xjl.tl.infra.ai;

import io.swagger.v3.oas.annotations.media.Schema;

/**
 * 模型连通性测试结果（与 Python /internal/llm/test 的 data 完全一致，Spring 原样透传）。
 */
@Schema(description = "模型连通性测试结果")
public record ModelTestResult(
        @Schema(description = "是否连通") Boolean ok,
        @Schema(description = "实际模型名") String model,
        @Schema(description = "耗时（毫秒）") Long latencyMs,
        @Schema(description = "回复片段") String reply,
        @Schema(description = "token 用量") Usage usage,
        @Schema(description = "失败时的错误码") String errorCode,
        @Schema(description = "失败时的提示") String errorMessage) {

    public record Usage(Integer promptTokens, Integer completionTokens) {
    }
}
