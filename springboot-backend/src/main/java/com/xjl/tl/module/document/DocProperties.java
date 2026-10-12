package com.xjl.tl.module.document;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;

/**
 * 文档翻译配置（app.doc.*，见 design D1 / D2 / D7 / D10）。
 *
 * @param maxTextLength      原文最大字符数（按 Unicode 码点）
 * @param maxRunningPerUser  每个用户同时处于 PENDING / 运行中状态的任务上限（AWAITING_CONFIRM 不计入）
 * @param maxGlossaries      单个任务最多选择的术语库数
 * @param heartbeatInterval  浏览器 SSE 心跳间隔
 * @param staleTimeout       运行中任务超过该时长没有任何事件即标记为 FAILED（可重试）
 * @param staleCheckIntervalMs 失联检测的执行间隔（毫秒）
 * @param consumerEnabled    是否启动事件流消费者
 * @param tasksStream        任务流（Spring → Python）
 * @param eventsStream       事件流（Python → Spring）
 * @param workerGroup        任务流消费组（Python）
 * @param springGroup        事件流消费组（Spring）
 * @param consumerName       本实例在消费组中的名称；为空时取主机名
 * @param claimMinIdle       认领其他消费者 pending 消息的最小闲置时长
 * @param claimIntervalMs    周期性认领 pending 消息的间隔（毫秒）
 * @param pollTimeout        XREADGROUP 阻塞时长
 * @param batchSize          每次读取的最大消息数
 */
@ConfigurationProperties(prefix = "app.doc")
public record DocProperties(@DefaultValue("50000") int maxTextLength,
                            @DefaultValue("2") int maxRunningPerUser,
                            @DefaultValue("10") int maxGlossaries,
                            @DefaultValue("15s") Duration heartbeatInterval,
                            @DefaultValue("30m") Duration staleTimeout,
                            @DefaultValue("60000") long staleCheckIntervalMs,
                            @DefaultValue("true") boolean consumerEnabled,
                            @DefaultValue("tl:doc-tasks") String tasksStream,
                            @DefaultValue("tl:doc-events") String eventsStream,
                            @DefaultValue("ai-worker") String workerGroup,
                            @DefaultValue("spring") String springGroup,
                            String consumerName,
                            @DefaultValue("60s") Duration claimMinIdle,
                            @DefaultValue("30000") long claimIntervalMs,
                            @DefaultValue("2s") Duration pollTimeout,
                            @DefaultValue("20") int batchSize) {
}
