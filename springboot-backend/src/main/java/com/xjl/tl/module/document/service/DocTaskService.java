package com.xjl.tl.module.document.service;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.TraceIdHolder;
import com.xjl.tl.infra.ai.AiServiceClient;
import com.xjl.tl.module.document.DocProperties;
import com.xjl.tl.module.document.DocStatus;
import com.xjl.tl.module.document.dto.DocDtos.ConfirmTermsRequest;
import com.xjl.tl.module.document.dto.DocDtos.CreateDocTaskRequest;
import com.xjl.tl.module.document.dto.DocDtos.DocOptions;
import com.xjl.tl.module.document.dto.DocDtos.DocSegmentVO;
import com.xjl.tl.module.document.dto.DocDtos.DocTaskQuery;
import com.xjl.tl.module.document.dto.DocDtos.DocTaskSummaryVO;
import com.xjl.tl.module.document.dto.DocDtos.DocTaskVO;
import com.xjl.tl.module.document.dto.DocDtos.DocTermVO;
import com.xjl.tl.module.document.dto.DocDtos.DocTraceVO;
import com.xjl.tl.module.document.dto.DocDtos.RetranslateResult;
import com.xjl.tl.module.document.dto.DocDtos.TaskPayload;
import com.xjl.tl.module.document.dto.DocDtos.TermDecision;
import com.xjl.tl.module.document.dto.DocDtos.TermPair;
import com.xjl.tl.module.document.dto.DocDtos.UpstreamRetranslateRequest;
import com.xjl.tl.module.document.dto.DocDtos.Usage;
import com.xjl.tl.module.document.repository.DocRepository;
import com.xjl.tl.module.document.repository.DocRepository.NewTask;
import com.xjl.tl.module.document.repository.DocTaskRow;
import com.xjl.tl.module.document.service.DocSseHub.Push;
import com.xjl.tl.module.glossary.service.GlossaryService;
import com.xjl.tl.module.memory.dto.TmDtos;
import com.xjl.tl.module.memory.dto.TmDtos.TmEntryInput;
import com.xjl.tl.module.memory.dto.TmDtos.TmWriteResult;
import com.xjl.tl.module.memory.service.TmService;
import com.xjl.tl.module.model.service.ModelConfigService;
import com.xjl.tl.module.translate.SupportedLanguage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.util.StringUtils;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import tools.jackson.databind.JsonNode;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 文档任务的用户操作（design D7 / D10 / D11 / D13）：创建、查询、取消、继续、删除、术语确认、事件订阅、
 * 段落后编辑（提交后异步写入翻译记忆）、单段重译、导出与一键写入翻译记忆。所有操作只允许访问自己的任务，否则返回 A0404。
 */
@Service
public class DocTaskService {

    public static final String UPSTREAM_RETRANSLATE_PATH = "/internal/doc/segment/retranslate";
    private static final Logger log = LoggerFactory.getLogger(DocTaskService.class);
    private static final String DEFAULT_TITLE = "未命名文档";
    /** 缺省分块策略：没有二级标题时退化为单组，效果等同 serial。 */
    private static final String DEFAULT_STRATEGY = "hybrid";
    private static final int TITLE_MAX = 200;
    private static final String BOM = String.valueOf((char) 0xFEFF);
    /** 执行端的受保护内容标记 ⟦n⟧（防御性去除：段落原文中通常不会出现）。 */
    private static final Pattern PROTECT_MARK = Pattern.compile("⟦\\s*\\d+\\s*⟧");

    private final DocRepository repo;
    private final DocProperties props;
    private final DocCommandPublisher publisher;
    private final DocSseHub hub;
    private final GlossaryService glossaryService;
    private final ModelConfigService modelConfigService;
    private final AiServiceClient aiServiceClient;
    private final TmService tmService;
    private final TransactionTemplate tx;

    public DocTaskService(DocRepository repo, DocProperties props, DocCommandPublisher publisher, DocSseHub hub,
                          GlossaryService glossaryService, ModelConfigService modelConfigService,
                          AiServiceClient aiServiceClient, TmService tmService, TransactionTemplate tx) {
        this.repo = repo;
        this.props = props;
        this.publisher = publisher;
        this.hub = hub;
        this.glossaryService = glossaryService;
        this.modelConfigService = modelConfigService;
        this.aiServiceClient = aiServiceClient;
        this.tmService = tmService;
        this.tx = tx;
    }

    // ---------------- 创建 ----------------

    /** JSON 方式创建：format 由请求声明（缺省 md）。 */
    public DocTaskVO createFromText(Long userId, CreateDocTaskRequest req) {
        String format = StringUtils.hasText(req.format()) ? req.format() : "md";
        String text = req.text() == null ? "" : stripBom(req.text());
        return create(userId, req, format, text, null);
    }

    /** multipart 方式创建：format 由扩展名判定，文本必须是 UTF-8（兼容 BOM），标题缺省取文件名。 */
    public DocTaskVO createFromFile(Long userId, String fileName, byte[] content, CreateDocTaskRequest settings) {
        String format = formatOf(fileName);
        if (format == null) {
            throw docInvalid("仅支持 .md、.markdown、.txt 文件");
        }
        String text = stripBom(decodeUtf8(content));
        return create(userId, settings, format, text, baseName(fileName));
    }

    private DocTaskVO create(Long userId, CreateDocTaskRequest req, String format, String text, String fileTitle) {
        if (!StringUtils.hasText(text)) {
            throw docInvalid("文档内容为空");
        }
        int charCount = text.codePointCount(0, text.length());
        if (charCount > props.maxTextLength()) {
            throw docInvalid("文档最长 " + props.maxTextLength() + " 字符，当前 " + charCount + " 字符");
        }
        String source = StringUtils.hasText(req.sourceLang()) ? req.sourceLang() : SupportedLanguage.AUTO;
        SupportedLanguage.requireSource("sourceLang", source);
        SupportedLanguage.require("targetLang", req.targetLang());
        if (source.equals(req.targetLang())) {
            throw FieldError.invalid("targetLang", "源语言与目标语言不能相同");
        }
        List<Long> glossaryIds = req.glossaryIds() == null ? List.of() : List.copyOf(new LinkedHashSet<>(req.glossaryIds()));
        if (glossaryIds.size() > props.maxGlossaries()) {
            throw FieldError.invalid("glossaryIds", "最多选择 " + props.maxGlossaries() + " 个术语库");
        }
        glossaryService.requireReadable(userId, glossaryIds);
        Long modelId = req.modelConfigId();
        if (modelId != null) {
            modelConfigService.requireEnabled(modelId);
        }
        // 评审模型在创建时解析并记录到任务上，继续执行时沿用（管理员之后切换评审模型不影响已有任务）
        Long reviewModelId = modelConfigService.resolveReviewModelId(req.reviewModelConfigId());
        String title = StringUtils.hasText(req.title()) ? req.title().trim()
                : fileTitle != null && !fileTitle.isBlank() ? fileTitle : defaultTitle(text, format);
        title = truncate(title, TITLE_MAX);
        NewTask task = new NewTask(userId, title, format, text, charCount, source, req.targetLang(),
                StringUtils.hasText(req.style()) ? req.style() : "faithful",
                StringUtils.hasText(req.domain()) ? req.domain().trim() : null, glossaryIds, modelId, reviewModelId,
                StringUtils.hasText(req.strategy()) ? req.strategy() : DEFAULT_STRATEGY,
                req.confirmTerms() == null || req.confirmTerms(),
                req.options() == null ? DocOptions.DEFAULTS : req.options().normalized());

        long id = tx.execute(status -> {
            repo.lockUser(userId);
            checkConcurrency(userId);
            return repo.insertTask(task);
        });
        dispatch(id, () -> publisher.start(id, traceId(), payload(repo.findTask(id).orElseThrow(), text)));
        return requireTask(userId, id).toVO();
    }

    // ---------------- 查询 ----------------

    public PageResult<DocTaskSummaryVO> page(Long userId, DocTaskQuery q) {
        DocRepository.Page page = repo.page(userId, q.getStatus(), q.getKeyword(), q.getPageNum(), q.getPageSize());
        return new PageResult<>(page.rows().stream().map(r -> DocTaskSummaryVO.of(r.toVO())).toList(), page.total(),
                q.getPageNum(), q.getPageSize());
    }

    public DocTaskVO detail(Long userId, Long id) {
        return requireTask(userId, id).toVO();
    }

    public List<DocSegmentVO> segments(Long userId, Long id) {
        requireTask(userId, id);
        return repo.segments(id);
    }

    public List<DocTermVO> terms(Long userId, Long id) {
        requireTask(userId, id);
        return repo.terms(id);
    }

    public List<DocTraceVO> traces(Long userId, Long id) {
        requireTask(userId, id);
        return repo.traces(id);
    }

    // ---------------- 取消 / 继续 / 删除 ----------------

    /** 运行中或待确认时允许：置为 CANCELLING 并写入 cancel 命令，执行端回报 cancelled 后变为 CANCELLED。 */
    public DocTaskVO cancel(Long userId, Long id) {
        DocTaskRow task = tx.execute(status -> {
            DocTaskRow t = lockOwned(userId, id);
            if (!DocStatus.CANCELLABLE.contains(t.status())) {
                throw stateInvalid(t, "只有运行中或待确认术语的任务可以取消");
            }
            repo.setStatus(id, DocStatus.CANCELLING, null);
            return t;
        });
        publisher.cancel(id);
        hub.publish(new Push(id, "phase", phaseData(DocStatus.CANCELLING, task.phase()), false));
        return requireTask(userId, id).toVO();
    }

    /** 仅 FAILED（可重试）或 CANCELLED 允许：回到 PENDING 并写入 retry 命令，从断点继续。 */
    public DocTaskVO retry(Long userId, Long id) {
        tx.executeWithoutResult(status -> {
            DocTaskRow t = lockOwned(userId, id);
            boolean allowed = DocStatus.CANCELLED.equals(t.status())
                    || (DocStatus.FAILED.equals(t.status()) && Boolean.TRUE.equals(t.retryable()));
            if (!allowed) {
                throw stateInvalid(t, "只有可重试的失败任务或已取消的任务可以继续");
            }
            repo.lockUser(userId);
            checkConcurrency(userId);
            repo.resetForRetry(id);
        });
        dispatch(id, () -> publisher.retry(id, traceId(), payload(repo.findTask(id).orElseThrow(), repo.sourceText(id))));
        return requireTask(userId, id).toVO();
    }

    /** 逻辑删除。总是写入带 purge 的 cancel 命令：运行中的任务先取消，执行端随即清理检查点、分块缓存与 eventSeq 计数。 */
    public void delete(Long userId, Long id) {
        tx.executeWithoutResult(status -> {
            lockOwned(userId, id);
            repo.softDelete(id);
        });
        try {
            publisher.cancelAndPurge(id);
        } catch (RuntimeException e) {
            log.warn("删除任务后写入 cancel 命令失败 taskId={}：{}", id, e.toString());
        }
        hub.closeAll(id);
    }

    // ---------------- 术语确认 ----------------

    /**
     * 仅 AWAITING_CONFIRM 允许。按请求更新 / 新增术语；未出现在请求中的待确认术语视为拒绝；
     * 以全部 CONFIRMED 术语作为任务术语表写入 resume 命令，任务进入 TRANSLATING。
     */
    public List<DocTermVO> confirmTerms(Long userId, Long id, ConfirmTermsRequest req) {
        List<TermPair> confirmed = tx.execute(status -> {
            DocTaskRow t = lockOwned(userId, id);
            if (!DocStatus.AWAITING_CONFIRM.equals(t.status())) {
                throw stateInvalid(t, "只有待确认术语的任务可以确认术语");
            }
            Map<Long, DocTermVO> byId = new HashMap<>();
            Map<String, DocTermVO> bySource = new HashMap<>();
            for (DocTermVO term : repo.terms(id)) {
                byId.put(term.id(), term);
                bySource.put(term.source().toLowerCase(Locale.ROOT), term);
            }
            Set<String> seen = new HashSet<>();
            Set<Long> touched = new HashSet<>();
            for (TermDecision d : req.terms()) {
                String source = d.source().trim();
                String target = d.target().trim();
                String key = source.toLowerCase(Locale.ROOT);
                if (!seen.add(key)) {
                    throw FieldError.invalid("terms", "源术语重复：" + source);
                }
                DocTermVO existing = d.id() != null ? byId.get(d.id()) : bySource.get(key);
                if (d.id() != null && existing == null) {
                    throw new BizException(ErrorCode.NOT_FOUND, "术语不存在：" + d.id());
                }
                DocTermVO clash = bySource.get(key);
                if (existing != null && clash != null && !clash.id().equals(existing.id())) {
                    throw FieldError.invalid("terms", "源术语与已有术语重复：" + source);
                }
                if (existing != null) {
                    repo.updateTerm(id, existing.id(), source, target, d.status());
                    touched.add(existing.id());
                } else {
                    repo.insertTerm(id, source, target, "user", d.status());
                }
            }
            repo.rejectPendingExcept(id, touched);
            repo.setStatus(id, DocStatus.TRANSLATING, "translating");
            return repo.terms(id).stream()
                    .filter(term -> "CONFIRMED".equals(term.status()))
                    .map(term -> new TermPair(term.source(), term.target()))
                    .toList();
        });
        publisher.resume(id, traceId(), confirmed);
        hub.publish(new Push(id, "phase", phaseData(DocStatus.TRANSLATING, "translating"), false));
        return repo.terms(id);
    }

    // ---------------- 事件订阅 ----------------

    /**
     * 建立 SSE：先登记订阅再读取快照，保证先发 snapshot、再发后续实时事件；终结状态发送 snapshot 后关闭。
     * 不设超时（timeout=0），断线由心跳发送失败发现。
     */
    public SseEmitter subscribe(Long userId, Long id) {
        requireTask(userId, id);
        SseEmitter emitter = new SseEmitter(0L);
        DocSseHub.Subscriber subscriber = hub.register(id, emitter);
        DocTaskRow snapshot = requireTask(userId, id);
        subscriber.start("snapshot", snapshot.toVO(), DocStatus.isTerminal(snapshot.status()));
        return emitter;
    }

    // ---------------- 后编辑 / 重译 / 导出 ----------------

    /**
     * 后编辑：保存译文并标记 edited。事务提交后异步把该段写入任务所属用户的翻译记忆
     * （来源 document，来源引用 "taskId:seq"），写入失败只记日志、不影响编辑结果。
     */
    public DocSegmentVO editSegment(Long userId, Long id, int seq, String target) {
        DocTaskRow task = requireTask(userId, id);
        DocSegmentVO segment = requireSegment(id, seq);
        if (!Boolean.TRUE.equals(segment.translatable())) {
            throw FieldError.invalid("seq", "不可翻译的段落不能编辑");
        }
        TmEntryInput entry = memoryEntry(task, segment, target);
        tx.executeWithoutResult(status -> {
            repo.editSegment(id, seq, target);
            if (entry != null) {
                TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                    @Override
                    public void afterCommit() {
                        tmService.writeAsync(task.userId(), List.of(entry));
                    }
                });
            }
        });
        return requireSegment(id, seq);
    }

    /**
     * 一键写入翻译记忆：仅 COMPLETED 任务（否则 A0431）；只写可翻译且已有译文的段落，每批最多 200 条，
     * 返回写入条数。模型不可用时返回 C0160。
     */
    public TmWriteResult writeMemory(Long userId, Long id) {
        DocTaskRow task = requireTask(userId, id);
        if (!DocStatus.COMPLETED.equals(task.status())) {
            throw stateInvalid(task, "只有已完成的任务可以写入翻译记忆");
        }
        List<TmEntryInput> entries = repo.segments(id).stream()
                .filter(s -> Boolean.TRUE.equals(s.translatable()))
                .map(s -> memoryEntry(task, s, s.target()))
                .filter(Objects::nonNull)
                .toList();
        return new TmWriteResult(tmService.write(task.userId(), entries));
    }

    /** 由 doc_task / doc_segment / doc_task_term 组装上下文，同步调用 Python 重译单段；不保存结果。 */
    public RetranslateResult retranslate(Long userId, Long id, int seq, String instruction) {
        DocTaskRow task = requireTask(userId, id);
        DocSegmentVO segment = requireSegment(id, seq);
        if (!Boolean.TRUE.equals(segment.translatable())) {
            throw FieldError.invalid("seq", "不可翻译的段落不能重译");
        }
        DocSegmentVO prev = repo.neighbor(id, seq, true).orElse(null);
        DocSegmentVO next = repo.neighbor(id, seq, false).orElse(null);
        // 重译接口的术语一律按"必须使用"处理，因此只带 CONFIRMED；AUTO（软约束）不传，避免把未经确认的译法强制到重译结果中
        List<TermPair> terms = repo.terms(id).stream()
                .filter(t -> "CONFIRMED".equals(t.status()))
                .map(t -> new TermPair(t.source(), t.target()))
                .toList();
        UpstreamRetranslateRequest upstream = new UpstreamRetranslateRequest(id, seq, segment.source(),
                prev == null ? null : prev.source(), prev == null ? null : prev.target(),
                next == null ? null : next.source(), task.summary(), terms, task.targetLang(), task.style(),
                task.domain(), task.modelConfigId(), StringUtils.hasText(instruction) ? instruction.trim() : null);
        JsonNode data = aiServiceClient.post(UPSTREAM_RETRANSLATE_PATH, upstream, JsonNode.class);
        if (data == null || !data.path("target").isString()) {
            throw new BizException(ErrorCode.DOC_TASK_FAILED, "AI 服务返回的重译结果缺少译文");
        }
        JsonNode usage = data.path("usage");
        return new RetranslateResult(data.path("target").asString(),
                new Usage(intOrNull(usage.path("promptTokens")), intOrNull(usage.path("completionTokens"))),
                intOrNull(data.path("latencyMs")));
    }

    /** 导出内容与文件名。 */
    public record Export(String fileName, String contentType, byte[] content) {
    }

    public Export export(Long userId, Long id, String format) {
        DocTaskRow task = requireTask(userId, id);
        String fmt = format == null ? "md" : format;
        if (!List.of("md", "bilingual", "txt").contains(fmt)) {
            throw FieldError.invalid("format", "导出格式只能是 md、bilingual 或 txt");
        }
        List<DocSegmentVO> segments = repo.segments(id);
        if (segments.isEmpty()) {
            throw stateInvalid(task, "文档尚未完成解析，暂无可导出的内容");
        }
        String name = task.title();
        return switch (fmt) {
            case "bilingual" -> new Export(name + ".bilingual.md", "text/markdown",
                    bytes(DocAssembler.bilingual(segments)));
            case "txt" -> new Export(name + "." + task.targetLang() + ".txt", "text/plain",
                    bytes(DocAssembler.translated(segments)));
            default -> new Export(name + "." + task.targetLang() + ".md", "text/markdown",
                    bytes(DocAssembler.translated(segments)));
        };
    }

    // ---------------- 内部 ----------------

    private void checkConcurrency(Long userId) {
        if (repo.countRunning(userId) >= props.maxRunningPerUser()) {
            throw new BizException(ErrorCode.TOO_MANY_DOC_TASKS,
                    "同时运行的文档任务最多 " + props.maxRunningPerUser() + " 个，请等待已有任务完成");
        }
    }

    /** 写入任务流；Redis 不可用时任务置为 FAILED（可重试）并返回 C0110。 */
    private void dispatch(long id, Runnable send) {
        try {
            send.run();
        } catch (RuntimeException e) {
            log.error("写入任务流失败 taskId={}", id, e);
            repo.markDispatchFailed(id, ErrorCode.AI_SERVICE_UNAVAILABLE.getCode(), "任务提交到执行队列失败，请稍后点击继续");
            throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE, "任务提交到执行队列失败，请稍后重试");
        }
    }

    /**
     * 段落对应的翻译记忆条目：原文为去除受保护标记后的纯文本（段落原文本身不含前缀等块级标记）；
     * 原文或译文为空、语种未知时返回 null。
     */
    private static TmEntryInput memoryEntry(DocTaskRow task, DocSegmentVO segment, String target) {
        String source = segment.source() == null ? "" : PROTECT_MARK.matcher(segment.source()).replaceAll("").trim();
        String sourceLang = SupportedLanguage.AUTO.equals(task.sourceLang()) ? task.detectedLang() : task.sourceLang();
        if (source.isEmpty() || !StringUtils.hasText(target) || !StringUtils.hasText(sourceLang)) {
            return null;
        }
        return new TmEntryInput(sourceLang, task.targetLang(), source, target.trim(), TmDtos.ORIGIN_DOCUMENT,
                task.id() + ":" + segment.seq());
    }

    private TaskPayload payload(DocTaskRow t, String text) {
        return new TaskPayload(t.userId(), t.title(), t.format(), text, t.sourceLang(), t.targetLang(), t.style(),
                t.domain(), t.glossaryIds(), t.modelConfigId(), t.reviewModelConfigId(), t.strategy(),
                t.confirmTerms(), t.options());
    }

    private DocTaskRow requireTask(Long userId, Long id) {
        DocTaskRow t = repo.findTask(id).orElse(null);
        if (t == null || !t.userId().equals(userId)) {
            throw new BizException(ErrorCode.NOT_FOUND, "文档任务不存在");
        }
        return t;
    }

    private DocTaskRow lockOwned(Long userId, Long id) {
        DocTaskRow t = repo.lockTask(id).orElse(null);
        if (t == null || !t.userId().equals(userId)) {
            throw new BizException(ErrorCode.NOT_FOUND, "文档任务不存在");
        }
        return t;
    }

    private DocSegmentVO requireSegment(Long id, int seq) {
        return repo.segment(id, seq).orElseThrow(() -> new BizException(ErrorCode.NOT_FOUND, "段落不存在"));
    }

    private static BizException stateInvalid(DocTaskRow t, String message) {
        return new BizException(ErrorCode.DOC_TASK_STATE_INVALID, message + "（当前状态：" + t.status() + "）");
    }

    private static BizException docInvalid(String message) {
        return new BizException(ErrorCode.DOC_INVALID, message);
    }

    private static Map<String, Object> phaseData(String status, String phase) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("status", status);
        m.put("phase", phase);
        return m;
    }

    private static String traceId() {
        String id = TraceIdHolder.get();
        return id != null ? id : TraceIdHolder.generate();
    }

    static String formatOf(String fileName) {
        if (fileName == null) {
            return null;
        }
        String lower = fileName.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
            return "md";
        }
        if (lower.endsWith(".txt")) {
            return "txt";
        }
        return null;
    }

    static String baseName(String fileName) {
        if (fileName == null) {
            return null;
        }
        String name = fileName.replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1);
        int dot = name.lastIndexOf('.');
        return (dot > 0 ? name.substring(0, dot) : name).trim();
    }

    /** 缺省标题：Markdown 取首个 ATX 标题，否则取首个非空行（最长 50 字符）。 */
    static String defaultTitle(String text, String format) {
        String firstLine = null;
        for (String line : text.split("\\r?\\n")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            if ("md".equals(format) && trimmed.matches("^#{1,6}\\s+.*")) {
                String heading = trimmed.replaceFirst("^#{1,6}\\s+", "").replaceFirst("\\s+#+\\s*$", "").trim();
                if (!heading.isEmpty()) {
                    return truncate(heading, 50);
                }
            }
            if (firstLine == null) {
                firstLine = trimmed;
            }
        }
        return firstLine == null ? DEFAULT_TITLE : truncate(firstLine, 50);
    }

    private static String decodeUtf8(byte[] content) {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(content))
                    .toString();
        } catch (CharacterCodingException e) {
            throw docInvalid("文件不是 UTF-8 编码");
        }
    }

    private static String stripBom(String text) {
        return text.startsWith(BOM) ? text.substring(1) : text;
    }

    private static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private static Integer intOrNull(JsonNode n) {
        return n != null && n.isNumber() ? n.asInt() : null;
    }

    private static String truncate(String s, int max) {
        if (s == null || s.length() <= max) {
            return s;
        }
        return s.substring(0, max);
    }
}
