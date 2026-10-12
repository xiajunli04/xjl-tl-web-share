package com.xjl.tl.common.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

/**
 * 语音、同传与图片翻译配置（app.media，见 add-speech-and-image-translation design D2 / D9 / D10）。
 *
 * @param storageDir              原图、译图存储根目录
 * @param imageMaxBytes           图片大小上限
 * @param imageMinSide            图片宽高下限（像素）
 * @param imageMaxSide            图片宽高上限（像素）
 * @param transcribeMaxSeconds    听写音频时长上限
 * @param ttsMaxChars             朗读文本长度上限
 * @param insightsMaxChars        解读原文长度上限
 * @param wsTicketTtl             WebSocket 一次性票据有效期
 * @param maxStreams              全局并发发言流上限
 * @param roomMaxMembers          会议室人数上限
 * @param roomMaxLanguagesCascade 级联引擎会议室语言数上限
 * @param roomMaxLanguagesS2s     S2S 引擎会议室语言数上限
 * @param rejoinGrace             成员断线后可恢复身份的时长
 * @param idleEndAfter            全部连接断开后自动结束会话的时长
 * @param segmentFlushInterval    转写段批量写入间隔
 * @param segmentFlushBatch       转写段批量写入条数
 * @param segmentWaitTimeout      等待全部目标译文定稿的超时
 * @param interpretWsUrl          Python 同传 WebSocket 地址；为空时由 app.ai.base-url 推导为 ws://…/internal/interpret/stream
 */
@ConfigurationProperties(prefix = "app.media")
public record MediaProperties(
        String storageDir,
        long imageMaxBytes,
        int imageMinSide,
        int imageMaxSide,
        int transcribeMaxSeconds,
        int ttsMaxChars,
        int insightsMaxChars,
        Duration wsTicketTtl,
        int maxStreams,
        int roomMaxMembers,
        int roomMaxLanguagesCascade,
        int roomMaxLanguagesS2s,
        Duration rejoinGrace,
        Duration idleEndAfter,
        Duration segmentFlushInterval,
        int segmentFlushBatch,
        Duration segmentWaitTimeout,
        String interpretWsUrl) {
}
