package com.xjl.tl.module.image.service;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;

import java.nio.charset.StandardCharsets;

/**
 * 图片格式与尺寸识别（add-speech-and-image-translation D10）：按文件头判断 JPG / PNG / WEBP / BMP，
 * 只解析头部读取宽高，不解码像素（8192×8192 的图片解码需要数百 MB 内存）。
 */
public final class ImageInspector {

    private ImageInspector() {
    }

    /**
     * 图片信息。
     *
     * @param mime   MIME 类型
     * @param ext    存储扩展名
     * @param width  宽（像素）
     * @param height 高（像素）
     */
    public record ImageInfo(String mime, String ext, int width, int height) {
    }

    /** 识别图片；格式不支持或头部损坏时抛出 A0450。 */
    public static ImageInfo inspect(byte[] b) {
        ImageInfo info;
        if (b.length >= 4 && (b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8 && (b[2] & 0xFF) == 0xFF) {
            info = jpeg(b);
        } else if (b.length >= 24 && (b[0] & 0xFF) == 0x89 && ascii(b, 1, 3).equals("PNG")) {
            info = new ImageInfo("image/png", "png", be32(b, 16), be32(b, 20));
        } else if (b.length >= 30 && ascii(b, 0, 4).equals("RIFF") && ascii(b, 8, 4).equals("WEBP")) {
            info = webp(b);
        } else if (b.length >= 26 && ascii(b, 0, 2).equals("BM")) {
            info = new ImageInfo("image/bmp", "bmp", le32(b, 18), Math.abs(le32(b, 22)));
        } else {
            throw new BizException(ErrorCode.IMAGE_INVALID, "仅支持 JPG、PNG、WEBP、BMP 格式的图片");
        }
        if (info == null || info.width() <= 0 || info.height() <= 0) {
            throw new BizException(ErrorCode.IMAGE_INVALID, "图片文件已损坏，无法读取尺寸");
        }
        return info;
    }

    /** JPEG：遍历标记段，读取 SOFn（C0–CF，除 C4/C8/CC）中的高与宽。 */
    private static ImageInfo jpeg(byte[] b) {
        int pos = 2;
        while (pos + 4 <= b.length) {
            if ((b[pos] & 0xFF) != 0xFF) {
                return null;
            }
            int marker = b[pos + 1] & 0xFF;
            if (marker == 0xFF) {
                // 填充字节
                pos++;
                continue;
            }
            if (marker == 0xD8 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
                pos += 2;
                continue;
            }
            int length = be16(b, pos + 2);
            boolean sof = marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
            if (sof && pos + 9 <= b.length) {
                return new ImageInfo("image/jpeg", "jpg", be16(b, pos + 7), be16(b, pos + 5));
            }
            if (length < 2) {
                return null;
            }
            pos += 2 + length;
        }
        return null;
    }

    /** WEBP：VP8（有损）、VP8L（无损）、VP8X（扩展）三种首块。 */
    private static ImageInfo webp(byte[] b) {
        String chunk = ascii(b, 12, 4);
        int w;
        int h;
        switch (chunk) {
            case "VP8 " -> {
                w = be16le(b, 26) & 0x3FFF;
                h = be16le(b, 28) & 0x3FFF;
            }
            case "VP8L" -> {
                int b1 = b[21] & 0xFF;
                int b2 = b[22] & 0xFF;
                int b3 = b[23] & 0xFF;
                int b4 = b[24] & 0xFF;
                w = 1 + (((b2 & 0x3F) << 8) | b1);
                h = 1 + (((b4 & 0x0F) << 10) | (b3 << 2) | ((b2 & 0xC0) >> 6));
            }
            case "VP8X" -> {
                w = 1 + le24(b, 24);
                h = 1 + le24(b, 27);
            }
            default -> {
                return null;
            }
        }
        return new ImageInfo("image/webp", "webp", w, h);
    }

    /** 按 MIME 推断扩展名（用于保存结果图），未知时为 jpg。 */
    public static String extOf(byte[] b) {
        try {
            return inspect(b).ext();
        } catch (BizException e) {
            return "jpg";
        }
    }

    private static String ascii(byte[] b, int off, int len) {
        return off + len <= b.length ? new String(b, off, len, StandardCharsets.US_ASCII) : "";
    }

    private static int be16(byte[] b, int off) {
        return (b[off] & 0xFF) << 8 | (b[off + 1] & 0xFF);
    }

    private static int be16le(byte[] b, int off) {
        return (b[off] & 0xFF) | (b[off + 1] & 0xFF) << 8;
    }

    private static int be32(byte[] b, int off) {
        return (b[off] & 0xFF) << 24 | (b[off + 1] & 0xFF) << 16 | (b[off + 2] & 0xFF) << 8 | (b[off + 3] & 0xFF);
    }

    private static int le24(byte[] b, int off) {
        return (b[off] & 0xFF) | (b[off + 1] & 0xFF) << 8 | (b[off + 2] & 0xFF) << 16;
    }

    private static int le32(byte[] b, int off) {
        return (b[off] & 0xFF) | (b[off + 1] & 0xFF) << 8 | (b[off + 2] & 0xFF) << 16 | (b[off + 3] & 0xFF) << 24;
    }
}
