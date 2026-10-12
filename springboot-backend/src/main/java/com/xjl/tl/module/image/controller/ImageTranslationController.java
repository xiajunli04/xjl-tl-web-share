package com.xjl.tl.module.image.controller;

import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.Result;
import com.xjl.tl.module.image.dto.ImageDtos.BlocksPatchRequest;
import com.xjl.tl.module.image.dto.ImageDtos.ImageQuery;
import com.xjl.tl.module.image.dto.ImageDtos.ImageTranslationDetail;
import com.xjl.tl.module.image.dto.ImageDtos.ImageTranslationItem;
import com.xjl.tl.module.image.service.ImageRecordService;
import com.xjl.tl.module.image.service.ImageRecordService.ImageBytes;
import com.xjl.tl.module.image.service.ImageTranslateService;
import com.xjl.tl.module.image.service.ImageTranslateService.Submission;
import com.xjl.tl.module.log.annotation.OperationLog;
import com.xjl.tl.module.translate.dto.TranslateDtos.FavoriteRequest;
import com.xjl.tl.security.CurrentUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import reactor.core.publisher.Flux;

import java.time.Duration;
import java.util.List;

@Tag(name = "图片翻译", description = "图片提交（SSE）与图片翻译记录：检索、详情、原图/结果图、编辑译文、收藏、删除；他人记录返回 A0404")
@RestController
@RequestMapping("/api/image-translations")
public class ImageTranslationController {

    public static final String MODULE = "图片翻译";

    private final ImageTranslateService translateService;
    private final ImageRecordService recordService;

    public ImageTranslationController(ImageTranslateService translateService, ImageRecordService recordService) {
        this.translateService = translateService;
        this.recordService = recordService;
    }

    @Operation(summary = "提交图片翻译（SSE）", description = """
            multipart：image（JPG/PNG/WEBP/BMP，≤10 MB，宽高 32–8192）、sourceLang（缺省 auto）、targetLang、\
            engine（vision 默认 / qwen-mt-image）、modelConfigId、glossaryIds（可重复字段）。以 text/event-stream 返回 \
            start、node、blocks、translation、done、error 事件（同 AI 服务），done 中补充记录 id；每 15 秒一次注释心跳。\
            图片不合法 A0450、所选或默认模型不支持图片 C0170、模型不可用 C0130、qwen-mt-image 无可用配置 C0173、\
            语言 A0420 / A0410、术语库 A0404、限流 429 + A0212 都在建立流之前返回普通 JSON。""",
            responses = @ApiResponse(responseCode = "200", description = "SSE 事件流",
                    content = @Content(mediaType = MediaType.TEXT_EVENT_STREAM_VALUE,
                            schema = @Schema(type = "string", example = "event: start\ndata: {\"requestId\":\"img-7f3a\"}\n\n"))))
    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE, produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> submit(
            @Parameter(description = "图片") @RequestPart(value = "image", required = false) MultipartFile image,
            @Parameter(description = "源语言，缺省 auto") @RequestParam(required = false) String sourceLang,
            @Parameter(description = "目标语言") @RequestParam(required = false) String targetLang,
            @Parameter(description = "引擎，缺省 vision") @RequestParam(required = false) String engine,
            @Parameter(description = "模型配置 id") @RequestParam(required = false) Long modelConfigId,
            @Parameter(description = "术语库 id（可重复）") @RequestParam(required = false) List<Long> glossaryIds,
            HttpServletResponse response) {
        Flux<ServerSentEvent<String>> events = translateService.submit(CurrentUser.get().id(), image,
                new Submission(sourceLang, targetLang, engine, modelConfigId, glossaryIds));
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
        return events;
    }

    @Operation(summary = "分页查询图片翻译记录", description = "按创建时间倒序；keyword 匹配 OCR 原文或译文（不区分大小写）；时间范围为 [from, to)")
    @GetMapping
    public Result<PageResult<ImageTranslationItem>> page(@ParameterObject ImageQuery query) {
        return Result.ok(recordService.page(CurrentUser.get().id(), query));
    }

    @Operation(summary = "图片翻译记录详情")
    @GetMapping("/{id}")
    public Result<ImageTranslationDetail> detail(@PathVariable Long id) {
        return Result.ok(recordService.detail(CurrentUser.get().id(), id));
    }

    @Operation(summary = "原图", description = "返回原图字节（Content-Type 为原 MIME）；浏览器用带 JWT 的 fetch 读取后转为 blob URL")
    @GetMapping("/{id}/image")
    public ResponseEntity<byte[]> image(@PathVariable Long id) {
        return bytes(recordService.image(CurrentUser.get().id(), id));
    }

    @Operation(summary = "结果图", description = "仅 qwen-mt-image 引擎有结果图，没有时返回 404 + A0404")
    @GetMapping("/{id}/result-image")
    public ResponseEntity<byte[]> resultImage(@PathVariable Long id) {
        return bytes(recordService.resultImage(CurrentUser.get().id(), id));
    }

    @Operation(summary = "修改文本块译文", description = "按块 id 替换译文并同步关键词检索文本，返回最新详情；块不存在返回 A0410")
    @OperationLog(module = MODULE, action = "编辑图片译文")
    @PatchMapping("/{id}/blocks")
    public Result<ImageTranslationDetail> patchBlocks(@PathVariable Long id, @Valid @RequestBody BlocksPatchRequest req) {
        return Result.ok(recordService.patchBlocks(CurrentUser.get().id(), id, req));
    }

    @Operation(summary = "收藏/取消收藏")
    @PutMapping("/{id}/favorite")
    public Result<Void> favorite(@PathVariable Long id, @Valid @RequestBody FavoriteRequest req) {
        recordService.setFavorite(CurrentUser.get().id(), id, req.favorite());
        return Result.ok();
    }

    @Operation(summary = "删除图片翻译记录（逻辑删除，异步删除图片文件）")
    @OperationLog(module = MODULE, action = "删除图片翻译记录")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        recordService.delete(CurrentUser.get().id(), id);
        return Result.ok();
    }

    private static ResponseEntity<byte[]> bytes(ImageBytes img) {
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(img.mime()))
                .cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePrivate())
                .body(img.bytes());
    }
}
