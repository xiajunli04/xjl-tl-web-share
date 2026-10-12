package com.xjl.tl.common.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;

/**
 * 文本翻译相关配置（app.translate.*，见 design D5 / D8）。
 *
 * @param maxTextLength            原文最大字符数
 * @param translateLimitPerMinute  每个用户每分钟最多发起的翻译次数
 * @param detectLimitPerMinute     每个用户每分钟最多发起的语种识别次数
 * @param heartbeatInterval        SSE 心跳间隔
 * @param timeout                  单次翻译总时长上限
 * @param maxGlossaries            单次翻译最多选择的术语库数
 */
@ConfigurationProperties(prefix = "app.translate")
public record TranslateProperties(@DefaultValue("5000") int maxTextLength,
                                  @DefaultValue("20") int translateLimitPerMinute,
                                  @DefaultValue("120") int detectLimitPerMinute,
                                  @DefaultValue("15s") Duration heartbeatInterval,
                                  @DefaultValue("180s") Duration timeout,
                                  @DefaultValue("10") int maxGlossaries) {
}
