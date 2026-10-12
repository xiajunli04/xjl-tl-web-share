package com.xjl.tl.module.image.dto;

import com.xjl.tl.common.PageQuery;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.format.annotation.DateTimeFormat;
import tools.jackson.databind.JsonNode;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 图片翻译 DTO（字段契约见 docs/contracts/speech-image-api.md §1.5 / §2.3）。
 */
public final class ImageDtos {

    private ImageDtos() {
    }

    /** 转发给 Python /internal/image/translate 的请求体（§1.5）。 */
    public record UpstreamImageRequest(String requestId, Long userId, String imageBase64, String mime, String sourceLang,
                                       String targetLang, String engine, Long modelConfigId, List<Long> glossaryIds) {
    }

    @Schema(description = "图片翻译记录列表项")
    public record ImageTranslationItem(
            @Schema(description = "记录 id") Long id,
            @Schema(description = "引擎", allowableValues = {"vision", "qwen-mt-image"}) String engine,
            @Schema(description = "源语言（可能为 auto）") String sourceLang,
            @Schema(description = "识别出的源语言") String detectedLang,
            @Schema(description = "目标语言") String targetLang,
            @Schema(description = "原图宽") Integer width,
            @Schema(description = "原图高") Integer height,
            @Schema(description = "文本块数") Integer blockCount,
            @Schema(description = "预览：首块「原文 → 译文」", example = "宫保鸡丁 → Kung Pao Chicken") String preview,
            @Schema(description = "是否有结果图（qwen-mt-image）") Boolean hasResultImage,
            @Schema(description = "是否收藏") Boolean favorite,
            @Schema(description = "创建时间") OffsetDateTime createdAt) {
    }

    @Schema(description = "图片翻译记录详情（列表项字段 + 以下字段）")
    public record ImageTranslationDetail(
            @Schema(description = "记录 id") Long id,
            @Schema(description = "引擎") String engine,
            @Schema(description = "源语言（可能为 auto）") String sourceLang,
            @Schema(description = "识别出的源语言") String detectedLang,
            @Schema(description = "目标语言") String targetLang,
            @Schema(description = "原图宽") Integer width,
            @Schema(description = "原图高") Integer height,
            @Schema(description = "文本块数") Integer blockCount,
            @Schema(description = "预览") String preview,
            @Schema(description = "是否有结果图") Boolean hasResultImage,
            @Schema(description = "是否收藏") Boolean favorite,
            @Schema(description = "创建时间") OffsetDateTime createdAt,
            @Schema(description = "模型配置 id") Long modelConfigId,
            @Schema(description = "原图 MIME", example = "image/jpeg") String mime,
            @Schema(description = "原图字节数") Integer sizeBytes,
            @Schema(description = "文本块 [{id, text, translation, bbox:[x0,y0,x1,y1]}]，bbox 为原图归一化坐标") JsonNode blocks,
            @Schema(description = "术语库 id") List<Long> glossaryIds,
            @Schema(description = "术语命中 [{source, target, followed, blockIds}]") JsonNode termHits,
            @Schema(description = "步骤轨迹 [{node, status, summary, latencyMs}]") JsonNode trace,
            @Schema(description = "输入 token") Integer promptTokens,
            @Schema(description = "输出 token") Integer completionTokens,
            @Schema(description = "耗时（毫秒）") Integer latencyMs) {
    }

    @Schema(description = "一个文本块的译文修改")
    public record BlockEdit(@Schema(description = "块 id") @NotNull(message = "块 id 不能为空") Integer id,
                            @Schema(description = "新译文，最长 2000 字符") @NotNull(message = "译文不能为空")
                            @Size(max = 2000, message = "译文最长 2000 字符") String translation) {
    }

    @Schema(description = "修改文本块译文")
    public record BlocksPatchRequest(@Schema(description = "要修改的块") @NotEmpty(message = "blocks 不能为空")
                                     List<@Valid @NotNull(message = "块不能为空") BlockEdit> blocks) {
    }

    @Schema(description = "图片翻译记录查询条件")
    public static class ImageQuery extends PageQuery {
        @Schema(description = "关键词（匹配 OCR 原文或译文，不区分大小写）")
        private String keyword;
        @Schema(description = "目标语言代码")
        private String targetLang;
        @Schema(description = "是否只看收藏")
        private Boolean favorite;
        @Schema(description = "开始时间（ISO-8601，含）", example = "2026-10-01T00:00:00+08:00")
        @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
        private OffsetDateTime from;
        @Schema(description = "结束时间（ISO-8601，不含）", example = "2026-10-02T00:00:00+08:00")
        @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
        private OffsetDateTime to;

        public String getKeyword() {
            return keyword;
        }

        public void setKeyword(String keyword) {
            this.keyword = keyword;
        }

        public String getTargetLang() {
            return targetLang;
        }

        public void setTargetLang(String targetLang) {
            this.targetLang = targetLang;
        }

        public Boolean getFavorite() {
            return favorite;
        }

        public void setFavorite(Boolean favorite) {
            this.favorite = favorite;
        }

        public OffsetDateTime getFrom() {
            return from;
        }

        public void setFrom(OffsetDateTime from) {
            this.from = from;
        }

        public OffsetDateTime getTo() {
            return to;
        }

        public void setTo(OffsetDateTime to) {
            this.to = to;
        }
    }
}
