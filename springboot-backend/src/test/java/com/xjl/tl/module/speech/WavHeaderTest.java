package com.xjl.tl.module.speech;

import com.xjl.tl.common.BizException;
import com.xjl.tl.module.speech.service.WavHeader;
import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** WAV 头解析：时长计算、额外分块、扩展格式、截断与非法输入。 */
class WavHeaderTest {

    @Test
    void computesDurationFromByteRate() {
        WavHeader h = WavHeader.parse(SpeechApiTest.wav(16000, 1, 2500));
        assertThat(h.sampleRate()).isEqualTo(16000);
        assertThat(h.channels()).isEqualTo(1);
        assertThat(h.durationMs()).isEqualTo(2500);
        assertThat(WavHeader.parse(SpeechApiTest.wav(48000, 2, 1000)).durationMs()).isEqualTo(1000);
    }

    @Test
    void skipsUnknownChunksAndAcceptsExtensibleFormat() {
        int dataBytes = 32000;
        ByteBuffer b = ByteBuffer.allocate(12 + 8 + 3 + 1 + 8 + 16 + 8 + dataBytes).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(0).put("WAVE".getBytes(StandardCharsets.US_ASCII));
        // 奇数长度的 LIST 分块（按 RIFF 规则补齐 1 字节）
        b.put("LIST".getBytes(StandardCharsets.US_ASCII)).putInt(3).put(new byte[]{1, 2, 3}).put((byte) 0);
        b.put("fmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 0xFFFE).putShort((short) 1)
                .putInt(16000).putInt(32000).putShort((short) 2).putShort((short) 16);
        // 流式写入时 data 长度为占位值：按实际长度截断
        b.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(-1);
        WavHeader h = WavHeader.parse(b.array());
        assertThat(h.audioFormat()).isEqualTo(0xFFFE);
        assertThat(h.durationMs()).isEqualTo(1000);
    }

    @Test
    void rejectsNonPcmMissingChunksAndGarbage() {
        byte[] wav = SpeechApiTest.wav(16000, 1, 100);
        wav[20] = 3; // IEEE float
        assertThatThrownBy(() -> WavHeader.parse(wav)).isInstanceOf(BizException.class)
                .hasMessageContaining("PCM").extracting("code").isEqualTo("A0454");
        byte[] noData = java.util.Arrays.copyOf(SpeechApiTest.wav(16000, 1, 0), 36);
        assertThatThrownBy(() -> WavHeader.parse(noData)).extracting("code").isEqualTo("A0454");
        assertThatThrownBy(() -> WavHeader.parse(null)).extracting("code").isEqualTo("A0454");
        assertThatThrownBy(() -> WavHeader.parse("RIFF....AVI ".getBytes(StandardCharsets.US_ASCII)))
                .extracting("code").isEqualTo("A0454");
    }
}
