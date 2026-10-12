package com.xjl.tl.module.image;

import com.xjl.tl.common.BizException;
import com.xjl.tl.module.image.service.ImageInspector;
import com.xjl.tl.module.image.service.ImageInspector.ImageInfo;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 图片格式与尺寸识别：JPG / PNG / BMP 用 ImageIO 生成的真实文件，WEBP 三种首块手工构造。 */
class ImageInspectorTest {

    static byte[] encode(String format, int w, int h) throws IOException {
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(img, format, out);
        return out.toByteArray();
    }

    /** 只有文件头的 PNG（IHDR 中写入宽高），用于构造任意尺寸而不占内存。 */
    static byte[] pngHeader(int w, int h, int totalBytes) {
        ByteBuffer b = ByteBuffer.allocate(Math.max(33, totalBytes)).order(ByteOrder.BIG_ENDIAN);
        b.put(new byte[]{(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A});
        b.putInt(13).put("IHDR".getBytes(StandardCharsets.US_ASCII)).putInt(w).putInt(h);
        return b.array();
    }

    private static byte[] webp(String chunk, byte[] payload) {
        ByteBuffer b = ByteBuffer.allocate(20 + payload.length).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(12 + payload.length)
                .put("WEBP".getBytes(StandardCharsets.US_ASCII)).put(chunk.getBytes(StandardCharsets.US_ASCII))
                .putInt(payload.length).put(payload);
        return b.array();
    }

    @Test
    void readsDimensionsOfJpegPngBmp() throws IOException {
        ImageInfo jpg = ImageInspector.inspect(encode("jpg", 120, 45));
        assertThat(jpg).isEqualTo(new ImageInfo("image/jpeg", "jpg", 120, 45));
        assertThat(ImageInspector.inspect(encode("png", 64, 33))).isEqualTo(new ImageInfo("image/png", "png", 64, 33));
        assertThat(ImageInspector.inspect(encode("bmp", 40, 50))).isEqualTo(new ImageInfo("image/bmp", "bmp", 40, 50));
        assertThat(ImageInspector.inspect(pngHeader(9000, 100, 64)).width()).isEqualTo(9000);
    }

    @Test
    void readsDimensionsOfWebpVariants() {
        // VP8（有损）：帧头 3 字节 + 起始码 9d 01 2a + 14 位宽高
        byte[] vp8 = new byte[10];
        vp8[3] = (byte) 0x9d;
        vp8[4] = 0x01;
        vp8[5] = 0x2a;
        vp8[6] = (byte) (300 & 0xFF);
        vp8[7] = (byte) (300 >> 8);
        vp8[8] = (byte) (200 & 0xFF);
        vp8[9] = (byte) (200 >> 8);
        assertThat(ImageInspector.inspect(webp("VP8 ", vp8))).isEqualTo(new ImageInfo("image/webp", "webp", 300, 200));
        // VP8L（无损）：签名 0x2f + 14 位 (宽-1) + 14 位 (高-1)
        int w = 640 - 1;
        int h = 480 - 1;
        long bits = w | ((long) h << 14);
        byte[] vp8l = {0x2f, (byte) bits, (byte) (bits >> 8), (byte) (bits >> 16), (byte) (bits >> 24), 0, 0, 0, 0, 0};
        assertThat(ImageInspector.inspect(webp("VP8L", vp8l))).isEqualTo(new ImageInfo("image/webp", "webp", 640, 480));
        // VP8X（扩展）：4 字节标志 + 24 位 (宽-1) + 24 位 (高-1)
        byte[] vp8x = {0, 0, 0, 0, (byte) 0xFF, 0x03, 0, (byte) 0x7F, 0x02, 0};
        assertThat(ImageInspector.inspect(webp("VP8X", vp8x))).isEqualTo(new ImageInfo("image/webp", "webp", 1024, 640));
    }

    @Test
    void rejectsUnsupportedOrCorruptImages() {
        assertThatThrownBy(() -> ImageInspector.inspect("GIF89a-------------------------".getBytes(StandardCharsets.US_ASCII)))
                .isInstanceOf(BizException.class).extracting("code").isEqualTo("A0450");
        assertThatThrownBy(() -> ImageInspector.inspect(new byte[]{(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, 0x00, 1, 2}))
                .extracting("code").isEqualTo("A0450");
        assertThatThrownBy(() -> ImageInspector.inspect(pngHeader(0, 10, 40))).extracting("code").isEqualTo("A0450");
        assertThatThrownBy(() -> ImageInspector.inspect(webp("ALPH", new byte[12]))).extracting("code").isEqualTo("A0450");
        assertThat(ImageInspector.extOf(new byte[]{1, 2, 3})).isEqualTo("jpg");
    }
}
