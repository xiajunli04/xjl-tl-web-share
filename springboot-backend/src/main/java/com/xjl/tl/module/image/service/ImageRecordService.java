package com.xjl.tl.module.image.service;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.mybatis.SqlUtils;
import com.xjl.tl.infra.storage.MediaStorage;
import com.xjl.tl.module.image.dto.ImageDtos.BlockEdit;
import com.xjl.tl.module.image.dto.ImageDtos.BlocksPatchRequest;
import com.xjl.tl.module.image.dto.ImageDtos.ImageQuery;
import com.xjl.tl.module.image.dto.ImageDtos.ImageTranslationDetail;
import com.xjl.tl.module.image.dto.ImageDtos.ImageTranslationItem;
import com.xjl.tl.module.image.entity.ImageTranslation;
import com.xjl.tl.module.image.mapper.ImageTranslationMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 图片翻译记录（image-translation「图片翻译记录」，translation-history「历史检索」）：分页检索（关键词匹配 search_text）、
 * 详情、原图 / 结果图读取、编辑块译文（同步维护 search_text）、收藏、逻辑删除（异步删除文件）。均按用户隔离，
 * 他人记录与不存在一样返回 A0404。
 */
@Service
public class ImageRecordService {

    private static final int PREVIEW_LENGTH = 100;

    private final ImageTranslationMapper mapper;
    private final MediaStorage storage;

    public ImageRecordService(ImageTranslationMapper mapper, MediaStorage storage) {
        this.mapper = mapper;
        this.storage = storage;
    }

    /** 图片字节与 MIME。 */
    public record ImageBytes(String mime, byte[] bytes) {
    }

    public PageResult<ImageTranslationItem> page(Long userId, ImageQuery q) {
        String kw = q.getKeyword();
        String pattern = StringUtils.hasText(kw) ? SqlUtils.containsPattern(kw) : null;
        QueryWrapper<ImageTranslation> w = new QueryWrapper<ImageTranslation>()
                .select("id", "engine", "source_lang", "detected_lang", "target_lang", "width", "height", "blocks",
                        "result_image_path", "favorite", "created_at")
                .eq("user_id", userId)
                .apply(pattern != null, "search_text ILIKE {0}", pattern)
                .eq(StringUtils.hasText(q.getTargetLang()), "target_lang", q.getTargetLang())
                .eq(q.getFavorite() != null, "favorite", q.getFavorite())
                .ge(q.getFrom() != null, "created_at", q.getFrom())
                .lt(q.getTo() != null, "created_at", q.getTo())
                .orderByDesc("created_at", "id");
        Page<ImageTranslation> page = mapper.selectPage(q.toPage(), w);
        return PageResult.of(page, ImageRecordService::toItem);
    }

    public ImageTranslationDetail detail(Long userId, Long id) {
        return toDetail(getOwned(userId, id));
    }

    /** 原图字节；文件丢失时返回 A0404。 */
    public ImageBytes image(Long userId, Long id) {
        ImageTranslation r = getOwned(userId, id);
        return new ImageBytes(r.getMime(), readOrNotFound(r.getImagePath()));
    }

    /** 结果图字节（仅 qwen-mt-image）；没有结果图返回 A0404。 */
    public ImageBytes resultImage(Long userId, Long id) {
        ImageTranslation r = getOwned(userId, id);
        if (r.getResultImagePath() == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "该记录没有结果图");
        }
        byte[] bytes = readOrNotFound(r.getResultImagePath());
        String ext = r.getResultImagePath().substring(r.getResultImagePath().lastIndexOf('.') + 1);
        String mime = switch (ext) {
            case "png" -> "image/png";
            case "webp" -> "image/webp";
            case "bmp" -> "image/bmp";
            default -> "image/jpeg";
        };
        return new ImageBytes(mime, bytes);
    }

    /** 修改块译文：块 id 须存在（否则 A0410），同步更新 search_text，返回最新详情。 */
    @Transactional
    public ImageTranslationDetail patchBlocks(Long userId, Long id, BlocksPatchRequest req) {
        ImageTranslation r = getOwned(userId, id);
        JsonNode blocks = r.getBlocks();
        Map<Integer, ObjectNode> byId = new HashMap<>();
        if (blocks instanceof ArrayNode arr) {
            for (JsonNode b : arr) {
                if (b instanceof ObjectNode o && o.path("id").isNumber()) {
                    byId.put(o.path("id").asInt(), o);
                }
            }
        }
        for (BlockEdit edit : req.blocks()) {
            ObjectNode block = byId.get(edit.id());
            if (block == null) {
                throw FieldError.invalid("blocks", "文本块不存在：" + edit.id());
            }
            block.put("translation", edit.translation());
        }
        ImageTranslation update = new ImageTranslation();
        update.setId(id);
        update.setBlocks(blocks);
        update.setSearchText(ImageTranslateService.searchText(blocks));
        mapper.updateById(update);
        return detail(userId, id);
    }

    @Transactional
    public void setFavorite(Long userId, Long id, boolean favorite) {
        getOwned(userId, id);
        mapper.update(null, new LambdaUpdateWrapper<ImageTranslation>()
                .eq(ImageTranslation::getId, id)
                .set(ImageTranslation::getFavorite, favorite));
    }

    /** 逻辑删除记录，提交后异步删除原图与结果图（失败只记日志）。 */
    @Transactional
    public void delete(Long userId, Long id) {
        ImageTranslation r = getOwned(userId, id);
        mapper.deleteById(id);
        storage.deleteAsync(r.getImagePath(), r.getResultImagePath());
    }

    /** 当前用户的记录：他人记录与不存在 / 已删除一样返回 A0404。 */
    public ImageTranslation getOwned(Long userId, Long id) {
        ImageTranslation r = mapper.selectById(id);
        if (r == null || !userId.equals(r.getUserId())) {
            throw new BizException(ErrorCode.NOT_FOUND, "图片翻译记录不存在");
        }
        return r;
    }

    private byte[] readOrNotFound(String rel) {
        byte[] bytes = storage.read(rel);
        if (bytes == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "图片文件不存在");
        }
        return bytes;
    }

    private static int blockCount(ImageTranslation r) {
        return r.getBlocks() != null && r.getBlocks().isArray() ? r.getBlocks().size() : 0;
    }

    /** 预览：首块「原文 → 译文」，截断到 100 字符；没有文本块时为 null。 */
    private static String preview(ImageTranslation r) {
        if (blockCount(r) == 0) {
            return null;
        }
        JsonNode first = r.getBlocks().get(0);
        String text = first.path("text").asString("");
        String translation = first.path("translation").asString("");
        String p = translation.isEmpty() ? text : text + " → " + translation;
        return p.length() <= PREVIEW_LENGTH ? p : p.substring(0, PREVIEW_LENGTH);
    }

    private static ImageTranslationItem toItem(ImageTranslation r) {
        return new ImageTranslationItem(r.getId(), r.getEngine(), r.getSourceLang(), r.getDetectedLang(),
                r.getTargetLang(), r.getWidth(), r.getHeight(), blockCount(r), preview(r), r.getResultImagePath() != null,
                r.getFavorite(), r.getCreatedAt());
    }

    private static ImageTranslationDetail toDetail(ImageTranslation r) {
        List<Long> glossaryIds = r.getGlossaryIds() == null ? List.of() : Arrays.asList(r.getGlossaryIds());
        return new ImageTranslationDetail(r.getId(), r.getEngine(), r.getSourceLang(), r.getDetectedLang(),
                r.getTargetLang(), r.getWidth(), r.getHeight(), blockCount(r), preview(r), r.getResultImagePath() != null,
                r.getFavorite(), r.getCreatedAt(), r.getModelConfigId(), r.getMime(), r.getSizeBytes(), r.getBlocks(),
                glossaryIds, r.getTermHits(), r.getTrace(), r.getPromptTokens(), r.getCompletionTokens(),
                r.getDurationMs());
    }
}
