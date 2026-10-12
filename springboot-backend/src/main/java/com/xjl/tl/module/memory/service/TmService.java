package com.xjl.tl.module.memory.service;

import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.TraceIdHolder;
import com.xjl.tl.infra.ai.AiServiceClient;
import com.xjl.tl.module.memory.dto.TmDtos;
import com.xjl.tl.module.memory.dto.TmDtos.TmEntryInput;
import com.xjl.tl.module.memory.dto.TmDtos.TmEntryVO;
import com.xjl.tl.module.memory.dto.TmDtos.TmQuery;
import com.xjl.tl.module.memory.dto.TmDtos.TmSearchRequest;
import com.xjl.tl.module.memory.dto.TmDtos.TmSearchResult;
import com.xjl.tl.module.memory.dto.TmDtos.TmWriteResult;
import com.xjl.tl.module.memory.dto.TmDtos.UpstreamSearchRequest;
import com.xjl.tl.module.memory.dto.TmDtos.UpstreamWriteRequest;
import com.xjl.tl.module.translate.SupportedLanguage;
import com.xjl.tl.module.translate.entity.TranslationRecord;
import com.xjl.tl.module.translate.service.TranslationRecordService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 翻译记忆（design D5）：Spring 只做鉴权与转发，存储、embedding 与检索都在 Python（ai.translation_memory）。
 * <ul>
 *   <li>所有内部请求都带当前用户 id，Python 按 user_id 隔离</li>
 *   <li>写入单次最多 200 条，超出部分分批；原文为空或超过 5000 字符、译文为空的条目不发送</li>
 *   <li>Python 模型不可用时返回 C0160（HTTP 503），由 AiServiceClient 原样透传</li>
 *   <li>异步写入（文档段落后编辑）失败只记日志</li>
 * </ul>
 */
@Service
public class TmService {

    public static final String UPSTREAM_ENTRIES_PATH = "/internal/tm/entries";
    public static final String UPSTREAM_ENTRY_PATH = "/internal/tm/entries/{id}";
    public static final String UPSTREAM_SEARCH_PATH = "/internal/tm/search";
    /** 工作台"相似译法"返回的命中条数。 */
    static final int SEARCH_LIMIT = 3;

    private static final Logger log = LoggerFactory.getLogger(TmService.class);

    private final AiServiceClient aiServiceClient;
    private final TranslationRecordService recordService;
    private final JsonMapper jsonMapper;
    /** 异步写入使用虚拟线程：调用是 IO 密集的同步 HTTP。 */
    private final ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();

    public TmService(AiServiceClient aiServiceClient, TranslationRecordService recordService, JsonMapper jsonMapper) {
        this.aiServiceClient = aiServiceClient;
        this.recordService = recordService;
        this.jsonMapper = jsonMapper;
    }

    @PreDestroy
    void shutdown() {
        executor.shutdown();
    }

    // ---------------- 查询 / 删除 / 检索 ----------------

    public PageResult<TmEntryVO> page(Long userId, TmQuery q) {
        Map<String, Object> query = new LinkedHashMap<>();
        query.put("userId", userId);
        query.put("pageNum", q.getPageNum());
        query.put("pageSize", q.getPageSize());
        query.put("keyword", trimOrNull(q.getKeyword()));
        query.put("sourceLang", trimOrNull(q.getSourceLang()));
        query.put("targetLang", trimOrNull(q.getTargetLang()));
        JsonNode data = aiServiceClient.get(UPSTREAM_ENTRIES_PATH, Map.of(), query, JsonNode.class);
        List<TmEntryVO> records = new ArrayList<>();
        if (data != null) {
            for (JsonNode r : data.path("records")) {
                records.add(jsonMapper.treeToValue(r, TmEntryVO.class));
            }
        }
        return new PageResult<>(records,
                data == null ? 0 : data.path("total").asLong(0),
                data == null ? q.getPageNum() : data.path("pageNum").asLong(q.getPageNum()),
                data == null ? q.getPageSize() : data.path("pageSize").asLong(q.getPageSize()));
    }

    /** 不存在或不属于当前用户时 Python 返回 A0404，原样透传。 */
    public void delete(Long userId, Long id) {
        aiServiceClient.delete(UPSTREAM_ENTRY_PATH, Map.of("id", id), Map.of("userId", userId), JsonNode.class);
    }

    public TmSearchResult search(Long userId, TmSearchRequest req) {
        SupportedLanguage.require("sourceLang", req.sourceLang());
        SupportedLanguage.require("targetLang", req.targetLang());
        TmSearchResult result = aiServiceClient.post(UPSTREAM_SEARCH_PATH,
                new UpstreamSearchRequest(userId, req.text(), req.sourceLang(), req.targetLang(), SEARCH_LIMIT),
                TmSearchResult.class);
        if (result == null) {
            return new TmSearchResult(false, List.of());
        }
        return new TmSearchResult(Boolean.TRUE.equals(result.available()),
                result.hits() == null ? List.of() : result.hits());
    }

    // ---------------- 写入 ----------------

    /**
     * 工作台「存入记忆」：记录须属于当前用户（否则 A0404）。源语言取识别结果，用户指定源语言时取 source_lang。
     */
    public TmWriteResult fromRecord(Long userId, Long recordId) {
        return fromRecord(userId, recordId, null);
    }

    /**
     * 把翻译记录存入记忆；targetText 非空时改用该译文（工作台「解读」中采用了备选译法，见 add-speech-and-image-translation D11）。
     */
    public TmWriteResult fromRecord(Long userId, Long recordId, String targetText) {
        TranslationRecord r = recordService.getOwned(userId, recordId);
        String sourceLang = StringUtils.hasText(r.getDetectedLang()) ? r.getDetectedLang() : r.getSourceLang();
        if (!StringUtils.hasText(sourceLang) || SupportedLanguage.AUTO.equals(sourceLang)) {
            throw FieldError.invalid("recordId", "无法确定该记录的原文语种");
        }
        if (r.getSourceText().length() > TmDtos.MAX_SOURCE_LENGTH) {
            throw FieldError.invalid("recordId", "原文超过 " + TmDtos.MAX_SOURCE_LENGTH + " 字符，不能存入翻译记忆");
        }
        String target = StringUtils.hasText(targetText) ? targetText.trim() : r.getTargetText();
        int written = write(userId, List.of(new TmEntryInput(sourceLang, r.getTargetLang(), r.getSourceText(),
                target, TmDtos.ORIGIN_WORKBENCH, String.valueOf(r.getId()))));
        return new TmWriteResult(written);
    }

    /**
     * 同步批量写入，返回 Python 报告的写入条数之和。无效条目（原文为空或超长、译文为空）被跳过。
     */
    public int write(Long userId, List<TmEntryInput> entries) {
        List<TmEntryInput> valid = entries.stream().filter(TmService::isValid).toList();
        int written = 0;
        for (int from = 0; from < valid.size(); from += TmDtos.MAX_BATCH) {
            List<TmEntryInput> batch = valid.subList(from, Math.min(from + TmDtos.MAX_BATCH, valid.size()));
            TmWriteResult result = aiServiceClient.post(UPSTREAM_ENTRIES_PATH, new UpstreamWriteRequest(userId, batch),
                    TmWriteResult.class);
            written += result == null || result.written() == null ? 0 : result.written();
        }
        return written;
    }

    /** 异步写入（不阻塞调用方）；失败（含 C0160）只记日志。traceId 沿用调用方的。 */
    public void writeAsync(Long userId, List<TmEntryInput> entries) {
        String traceId = TraceIdHolder.get();
        executor.execute(() -> {
            if (traceId != null) {
                TraceIdHolder.set(traceId);
            }
            try {
                int written = write(userId, entries);
                log.info("异步写入翻译记忆完成 userId={} written={}", userId, written);
            } catch (RuntimeException e) {
                log.warn("异步写入翻译记忆失败 userId={}：{}", userId, e.getMessage());
            } finally {
                TraceIdHolder.clear();
            }
        });
    }

    private static boolean isValid(TmEntryInput e) {
        return StringUtils.hasText(e.sourceText()) && e.sourceText().length() <= TmDtos.MAX_SOURCE_LENGTH
                && StringUtils.hasText(e.targetText()) && StringUtils.hasText(e.sourceLang())
                && !SupportedLanguage.AUTO.equals(e.sourceLang()) && StringUtils.hasText(e.targetLang());
    }

    private static String trimOrNull(String s) {
        return StringUtils.hasText(s) ? s.trim() : null;
    }
}
