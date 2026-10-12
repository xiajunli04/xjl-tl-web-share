package com.xjl.tl.module.speech.service;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;

import java.nio.charset.StandardCharsets;

/**
 * WAV 头解析：只读取 RIFF 分块（fmt / data）计算时长，不解码音频（听写时长校验，见 speech-services「听写接口」）。
 *
 * @param audioFormat 1 = PCM，0xFFFE = WAVE_FORMAT_EXTENSIBLE
 * @param channels    声道数
 * @param sampleRate  采样率
 * @param byteRate    每秒字节数
 * @param dataBytes   音频数据字节数（按实际文件长度截断，兼容流式写入时 data 长度为占位值的情况）
 */
public record WavHeader(int audioFormat, int channels, int sampleRate, long byteRate, long dataBytes) {

    private static final int PCM = 1;
    private static final int EXTENSIBLE = 0xFFFE;

    /** 时长（毫秒）。 */
    public long durationMs() {
        return dataBytes * 1000L / byteRate;
    }

    /** 解析 WAV；不是 RIFF/WAVE、缺少 fmt 或 data 分块、非 PCM 编码、没有音频数据时抛出 A0454。 */
    public static WavHeader parse(byte[] b) {
        if (b == null || b.length < 12 || !"RIFF".equals(ascii(b, 0)) || !"WAVE".equals(ascii(b, 8))) {
            throw invalid("不是有效的 WAV 文件");
        }
        int pos = 12;
        Integer format = null;
        int channels = 0;
        int sampleRate = 0;
        long byteRate = 0;
        Long data = null;
        while (pos + 8 <= b.length) {
            String id = ascii(b, pos);
            long size = le32(b, pos + 4);
            int body = pos + 8;
            if ("fmt ".equals(id) && body + 16 <= b.length) {
                format = le16(b, body);
                channels = le16(b, body + 2);
                sampleRate = (int) le32(b, body + 4);
                byteRate = le32(b, body + 8);
            } else if ("data".equals(id)) {
                data = Math.min(size, b.length - (long) body);
                break;
            }
            long next = body + size + (size & 1);
            if (next > Integer.MAX_VALUE) {
                break;
            }
            pos = (int) next;
        }
        if (format == null || data == null || byteRate <= 0) {
            throw invalid("WAV 文件缺少格式或数据分块");
        }
        if (format != PCM && format != EXTENSIBLE) {
            throw invalid("仅支持 PCM 编码的 WAV 音频");
        }
        if (data <= 0) {
            throw invalid("音频为空");
        }
        return new WavHeader(format, channels, sampleRate, byteRate, data);
    }

    private static BizException invalid(String message) {
        return new BizException(ErrorCode.AUDIO_INVALID, message);
    }

    private static String ascii(byte[] b, int off) {
        return off + 4 <= b.length ? new String(b, off, 4, StandardCharsets.US_ASCII) : "";
    }

    private static int le16(byte[] b, int off) {
        return (b[off] & 0xFF) | (b[off + 1] & 0xFF) << 8;
    }

    private static long le32(byte[] b, int off) {
        return (b[off] & 0xFFL) | (b[off + 1] & 0xFFL) << 8 | (b[off + 2] & 0xFFL) << 16 | (b[off + 3] & 0xFFL) << 24;
    }
}
