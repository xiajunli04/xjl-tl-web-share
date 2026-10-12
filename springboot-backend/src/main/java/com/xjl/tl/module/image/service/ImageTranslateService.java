package com.xjl.tl.module.image.service;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.TraceIdHolder;
import com.xjl.tl.common.config.MediaProperties;
import com.xjl.tl.common.config.TranslateProperties;
import com.xjl.tl.infra.ai.AiStreamClient;
import com.xjl.tl.infra.ai.SseRelay;
import com.xjl.tl.infra.storage.MediaStorage;
import com.xjl.tl.module.glossary.service.GlossaryService;
import com.xjl.tl.module.image.dto.ImageDtos.UpstreamImageRequest;
import com.xjl.tl.module.image.entity.ImageTranslation;
import com.xjl.tl.module.image.mapper.ImageTranslationMapper;
import com.xjl.tl.module.image.service.ImageInspector.ImageInfo;
import com.xjl.tl.module.model.entity.ModelConfig;
import com.xjl.tl.module.model.service.ModelConfigService;
import com.xjl.tl.module.translate.SupportedLanguage;
import com.xjl.tl.module.translate.service.TranslateRateLimiter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.multipart.MultipartFile;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 图片翻译提交与转发（add-speech-and-image-translation D10，契约 §1.5 / §2.3）。
 * <ol>
 *   <li>建立流之前（请求线程）：图片非空、≤10 MB、JPG/PNG/WEBP/BMP、宽高 32–8192（否则 A0450）→ 语言 → 引擎与模型
 *       （vision 引擎所选或默认对话模型未标记支持图片 → C0170；qwen-mt-image 没有启用的配置 → C0173）→ 术语库权限 → 限流
 *       → 原图保存到 STORAGE_DIR/images/yyyy/MM/{uuid}.{ext}</li>
 *   <li>建立流之后：原样转发 Python 事件；done 时在 boundedElastic 线程落库（qwen-mt-image 的 resultImageBase64 落盘为结果图），
 *       在 done 中补上记录 id 后转发；流以 error、取消或异常结束且未落库时异步删除已保存的原图</li>
 * </ol>
 */
@Service
public class ImageTranslateService {

    public static final String UPSTREAM_PATH = "/internal/image/translate";
    public static final String ENGINE_VISION = "vision";
    public static final String ENGINE_QWEN_MT_IMAGE = "qwen-mt-image";
    public static final String STORAGE_CATEGORY = "images";
    static final String EVENT_DONE = "done";
    private static final Set<String> ENGINES = Set.of(ENGINE_VISION, ENGINE_QWEN_MT_IMAGE);
    private static final Logger log = LoggerFactory.getLogger(ImageTranslateService.class);

    private final MediaProperties props;
    private final TranslateProperties translateProps;
    private final AiStreamClient aiStreamClient;
    private final SseRelay relay;
    private final MediaStorage storage;
    private final ModelConfigService modelConfigService;
    private final GlossaryService glossaryService;
    private final TranslateRateLimiter rateLimiter;
    private final ImageTranslationMapper mapper;
    private final JsonMapper jsonMapper;

    public ImageTranslateService(MediaProperties props, TranslateProperties translateProps, AiStreamClient aiStreamClient,
                                 SseRelay relay, MediaStorage storage, ModelConfigService modelConfigService,
                                 GlossaryService glossaryService, TranslateRateLimiter rateLimiter,
                                 ImageTranslationMapper mapper, JsonMapper jsonMapper) {
        this.props = props;
        this.translateProps = translateProps;
        this.aiStreamClient = aiStreamClient;
        this.relay = relay;
        this.storage = storage;
        this.modelConfigService = modelConfigService;
        this.glossaryService = glossaryService;
        this.rateLimiter = rateLimiter;
        this.mapper = mapper;
        this.jsonMapper = jsonMapper;
    }

    /** 提交参数（multipart 表单字段）。 */
    public record Submission(String sourceLang, String targetLang, String engine, Long modelConfigId,
                             List<Long> glossaryIds) {
    }

    /** 一次提交的运行状态：phase 保证"落库"与"放弃时删除原图"只发生其一。 */
    private record Run(Long userId, ImageInfo info, int sizeBytes, String imagePath, String sourceLang,
                       String targetLang, String engine, Long modelConfigId, List<Long> glossaryIds,
                       AtomicReference<String> phase) {
    }

    private static final String STREAMING = "streaming";
    private static final String PERSISTING = "persisting";
    private static final String ABANDONED = "abandoned";

    public Flux<ServerSentEvent<String>> submit(Long userId, MultipartFile image, Submission form) {
        byte[] bytes = readImage(image);
        ImageInfo info = ImageInspector.inspect(bytes);
        int min = props.imageMinSide();
        int max = props.imageMaxSide();
        if (info.width() < min || info.height() < min || info.width() > max || info.height() > max) {
            throw new BizException(ErrorCode.IMAGE_INVALID, "图片宽高须在 " + min + "–" + max + " 像素之间");
        }
        String source = StringUtils.hasText(form.sourceLang()) ? form.sourceLang() : SupportedLanguage.AUTO;
        SupportedLanguage.requireSource("sourceLang", source);
        if (!StringUtils.hasText(form.targetLang())) {
            throw FieldError.invalid("targetLang", "目标语言不能为空");
        }
        SupportedLanguage.require("targetLang", form.targetLang());
        if (source.equals(form.targetLang())) {
            throw FieldError.invalid("targetLang", "源语言与目标语言不能相同");
        }
        String engine = StringUtils.hasText(form.engine()) ? form.engine() : ENGINE_VISION;
        if (!ENGINES.contains(engine)) {
            throw FieldError.invalid("engine", "引擎只能是 vision 或 qwen-mt-image");
        }
        List<Long> glossaryIds = form.glossaryIds() == null ? List.of() : List.copyOf(new LinkedHashSet<>(form.glossaryIds()));
        if (glossaryIds.size() > translateProps.maxGlossaries()) {
            throw FieldError.invalid("glossaryIds", "最多选择 " + translateProps.maxGlossaries() + " 个术语库");
        }
        glossaryService.requireReadable(userId, glossaryIds);
        Long modelId = resolveModel(engine, form.modelConfigId());
        rateLimiter.acquire("image", userId, translateProps.translateLimitPerMinute(), "图片翻译请求过于频繁，请稍后再试");

        String imagePath = storage.save(STORAGE_CATEGORY, info.ext(), bytes);
        String traceId = TraceIdHolder.get();
        Run run = new Run(userId, info, bytes.length, imagePath, source, form.targetLang(), engine, modelId, glossaryIds,
                new AtomicReference<>(STREAMING));
        UpstreamImageRequest upstream = new UpstreamImageRequest("img-" + UUID.randomUUID().toString().substring(0, 8),
                userId, Base64.getEncoder().encodeToString(bytes), info.mime(), source, form.targetLang(), engine,
                modelId, glossaryIds);
        SseRelay.Options options = new SseRelay.Options(Set.of(EVENT_DONE), translateProps.heartbeatInterval(),
                translateProps.timeout(), ErrorCode.TRANSLATE_TIMEOUT);
        return relay.relay(aiStreamClient.stream(UPSTREAM_PATH, upstream, traceId),
                e -> EVENT_DONE.equals(e.event())
                        ? SseRelay.blocking(traceId, () -> persist(run, e.data()))
                        : Mono.just(relay.forward(e, traceId)),
                options,
                succeeded -> {
                    if (run.phase().compareAndSet(STREAMING, ABANDONED)) {
                        storage.deleteAsync(run.imagePath());
                    }
                },
                traceId);
    }

    private byte[] readImage(MultipartFile image) {
        if (image == null || image.isEmpty()) {
            throw new BizException(ErrorCode.IMAGE_INVALID, "图片为空");
        }
        if (image.getSize() > props.imageMaxBytes()) {
            throw new BizException(ErrorCode.IMAGE_INVALID, "图片不能超过 " + props.imageMaxBytes() / 1024 / 1024 + " MB");
        }
        try {
            return image.getBytes();
        } catch (IOException e) {
            throw new BizException(ErrorCode.IMAGE_INVALID, "图片读取失败");
        }
    }

    /**
     * 解析模型：
     * vision —— 显式指定须为已启用配置（否则 C0130），缺省取默认对话模型（没有则 C0130）；须为支持图片输入的 CHAT 配置，否则 C0170。
     * qwen-mt-image —— 显式指定须为已启用的 IMAGE_TRANSLATE 配置；缺省取该能力的默认（或首个）启用配置，没有则 C0173。
     */
    private Long resolveModel(String engine, Long id) {
        if (ENGINE_VISION.equals(engine)) {
            Long modelId = id != null ? id : modelConfigService.defaultModelId();
            ModelConfig mc = modelConfigService.findEnabled(modelId);
            if (mc == null) {
                throw new BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE,
                        id != null ? ErrorCode.MODEL_CONFIG_UNAVAILABLE.getMessage() : "没有可用的默认对话模型");
            }
            if (!ModelConfig.CAP_CHAT.equals(mc.getCapability()) || !Boolean.TRUE.equals(mc.getSupportsVision())) {
                throw new BizException(ErrorCode.VISION_UNSUPPORTED,
                        "所选模型「" + mc.getName() + "」不支持图片输入，请选择标记为支持图片的对话模型");
            }
            return mc.getId();
        }
        if (id != null) {
            ModelConfig mc = modelConfigService.findEnabled(id);
            if (mc == null) {
                throw new BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE);
            }
            if (!ModelConfig.CAP_IMAGE_TRANSLATE.equals(mc.getCapability())) {
                throw FieldError.invalid("modelConfigId", "qwen-mt-image 引擎需要图片翻译（IMAGE_TRANSLATE）能力的模型配置");
            }
            return id;
        }
        List<ModelConfig> configs = modelConfigService.listEnabled(ModelConfig.CAP_IMAGE_TRANSLATE);
        if (configs.isEmpty()) {
            throw new BizException(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "图片翻译引擎不可用：没有启用的图片翻译（IMAGE_TRANSLATE）配置");
        }
        return configs.getFirst().getId();
    }

    /** done：落库（含结果图落盘），返回补上 id 的 done 事件。失败时删除本次保存的文件。 */
    private ServerSentEvent<String> persist(Run run, String data) {
        if (!run.phase().compareAndSet(STREAMING, PERSISTING)) {
            throw new BizException(ErrorCode.SYSTEM_ERROR, "图片翻译已取消");
        }
        String resultPath = null;
        try {
            JsonNode fin = relay.parse(data);
            if (!(fin instanceof ObjectNode done)) {
                throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE, "图片翻译结果格式不正确");
            }
            String b64 = done.path("resultImageBase64").asString(null);
            if (StringUtils.hasText(b64)) {
                byte[] result = Base64.getMimeDecoder().decode(b64);
                resultPath = storage.save(STORAGE_CATEGORY, ImageInspector.extOf(result), result);
            }
            ImageTranslation r = new ImageTranslation();
            r.setUserId(run.userId());
            r.setEngine(run.engine());
            JsonNode mid = done.path("modelConfigId");
            r.setModelConfigId(mid.isNumber() ? mid.asLong() : run.modelConfigId());
            r.setImagePath(run.imagePath());
            r.setResultImagePath(resultPath);
            r.setMime(run.info().mime());
            r.setWidth(run.info().width());
            r.setHeight(run.info().height());
            r.setSizeBytes(run.sizeBytes());
            r.setSourceLang(run.sourceLang());
            r.setDetectedLang(truncate(done.path("detectedLang").asString(null), 8));
            r.setTargetLang(run.targetLang());
            JsonNode blocks = arrayOrEmpty(done.get("blocks"));
            r.setBlocks(blocks);
            r.setSearchText(searchText(blocks));
            r.setGlossaryIds(run.glossaryIds().toArray(new Long[0]));
            r.setTermHits(arrayOrEmpty(done.get("termHits")));
            r.setTrace(arrayOrEmpty(done.get("trace")));
            r.setPromptTokens(intOrNull(done.path("usage").path("promptTokens")));
            r.setCompletionTokens(intOrNull(done.path("usage").path("completionTokens")));
            r.setDurationMs(intOrNull(done.path("latencyMs")));
            r.setFavorite(false);
            r.setDeleted(false);
            mapper.insert(r);
            ObjectNode out = done.deepCopy();
            out.put("id", r.getId());
            return ServerSentEvent.builder(jsonMapper.writeValueAsString(out)).event(EVENT_DONE).build();
        } catch (RuntimeException e) {
            log.warn("图片翻译落库失败，删除已保存的文件 {}：{}", run.imagePath(), e.toString());
            storage.deleteAsync(run.imagePath(), resultPath);
            throw e;
        }
    }

    /** 检索文本：每块的原文与译文按行拼接。 */
    static String searchText(JsonNode blocks) {
        StringBuilder sb = new StringBuilder();
        for (JsonNode b : blocks) {
            for (String field : new String[]{"text", "translation"}) {
                String v = b.path(field).asString("");
                if (!v.isEmpty()) {
                    if (!sb.isEmpty()) {
                        sb.append('\n');
                    }
                    sb.append(v);
                }
            }
        }
        return sb.toString();
    }

    private JsonNode arrayOrEmpty(JsonNode n) {
        return n != null && n.isArray() ? n : jsonMapper.createArrayNode();
    }

    private static Integer intOrNull(JsonNode n) {
        return n != null && n.isNumber() ? n.asInt() : null;
    }

    private static String truncate(String v, int max) {
        return v == null || v.length() <= max ? v : v.substring(0, max);
    }
}
