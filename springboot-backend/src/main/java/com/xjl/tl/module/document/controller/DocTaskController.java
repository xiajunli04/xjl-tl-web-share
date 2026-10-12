package com.xjl.tl.module.document.controller;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.Result;
import com.xjl.tl.module.document.dto.DocDtos.ConfirmTermsRequest;
import com.xjl.tl.module.document.dto.DocDtos.CreateDocTaskRequest;
import com.xjl.tl.module.document.dto.DocDtos.DocSegmentVO;
import com.xjl.tl.module.document.dto.DocDtos.DocTaskQuery;
import com.xjl.tl.module.document.dto.DocDtos.DocTaskSummaryVO;
import com.xjl.tl.module.document.dto.DocDtos.DocTaskVO;
import com.xjl.tl.module.document.dto.DocDtos.DocTermVO;
import com.xjl.tl.module.document.dto.DocDtos.DocTraceVO;
import com.xjl.tl.module.document.dto.DocDtos.EditSegmentRequest;
import com.xjl.tl.module.document.dto.DocDtos.RetranslateRequest;
import com.xjl.tl.module.document.dto.DocDtos.RetranslateResult;
import com.xjl.tl.module.document.service.DocTaskService;
import com.xjl.tl.module.log.annotation.OperationLog;
import com.xjl.tl.module.memory.dto.TmDtos.TmWriteResult;
import com.xjl.tl.security.CurrentUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.ConstraintViolation;
import jakarta.validation.Valid;
import jakarta.validation.Validator;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

@Tag(name = "文档翻译", description = "文档翻译任务：创建、查询、进度订阅（SSE）、取消/继续/删除、术语确认、段落后编辑与重译、导出；他人任务返回 A0404")
@RestController
@RequestMapping("/api/doc-tasks")
public class DocTaskController {

    public static final String MODULE = "文档翻译";

    private final DocTaskService service;
    private final JsonMapper jsonMapper;
    private final Validator validator;

    public DocTaskController(DocTaskService service, JsonMapper jsonMapper, Validator validator) {
        this.service = service;
        this.jsonMapper = jsonMapper;
        this.validator = validator;
    }

    // ---------------- 创建 ----------------

    @Operation(summary = "创建文档任务（JSON）", description = """
            粘贴文本创建任务，format 为 md 或 txt（缺省 md）。文本去除空白后不能为空且不超过 50000 字符，否则返回 A0430；\
            语种不支持返回 A0420；选择了不可访问的术语库返回 A0404；指定的模型或评审模型已停用返回 C0130；\
            同一用户运行中（含排队）的任务已达 2 个时返回 429 + A0213。\
            缺省参数：strategy=hybrid、confirmTerms=true，options 中 contextWindow / globalSummary / termExtraction / translationMemory 开启、review 关闭；\
            评审模型缺省使用管理员设置的评审模型（仍没有则与译者相同），解析结果记录在任务的 reviewModelConfigId 上。\
            创建成功后状态为 PENDING，并向任务流写入 start 命令。""")
    @OperationLog(module = MODULE, action = "创建文档任务")
    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public Result<DocTaskVO> create(@Valid @RequestBody CreateDocTaskRequest req) {
        return Result.ok(service.createFromText(CurrentUser.get().id(), req));
    }

    @Operation(summary = "创建文档任务（上传文件）", description = """
            multipart：file 为 .md / .markdown / .txt 文件（UTF-8，可带 BOM），settings 为除 text、format 外各参数的 JSON 字符串。\
            格式由扩展名判定，不支持的格式、非 UTF-8、空文档或超过 50000 字符返回 A0430；标题缺省取文件名。\
            其余参数、缺省值与错误码同 JSON 方式（含 reviewModelConfigId）。""")
    @OperationLog(module = MODULE, action = "创建文档任务")
    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<DocTaskVO> upload(
            @Parameter(description = "文档文件") @RequestPart("file") MultipartFile file,
            @Parameter(description = "翻译设置 JSON，如 {\"targetLang\":\"zh\",\"strategy\":\"hybrid\",\"confirmTerms\":true,\"reviewModelConfigId\":3}")
            @RequestPart("settings") String settings) {
        CreateDocTaskRequest req = parseSettings(settings);
        byte[] content;
        try {
            content = file.getBytes();
        } catch (IOException e) {
            throw new BizException(ErrorCode.DOC_INVALID, "读取上传文件失败");
        }
        return Result.ok(service.createFromFile(CurrentUser.get().id(), file.getOriginalFilename(), content, req));
    }

    // ---------------- 查询 ----------------

    @Operation(summary = "分页查询文档任务", description = "按创建时间倒序；可按状态与标题关键词筛选")
    @GetMapping
    public Result<PageResult<DocTaskSummaryVO>> page(@ParameterObject DocTaskQuery query) {
        return Result.ok(service.page(CurrentUser.get().id(), query));
    }

    @Operation(summary = "文档任务详情", description = "参数、状态、阶段、进度、摘要、一致性报告、统计与用量（不含原文）")
    @GetMapping("/{id}")
    public Result<DocTaskVO> detail(@PathVariable Long id) {
        return Result.ok(service.detail(CurrentUser.get().id(), id));
    }

    @Operation(summary = "全部段落", description = "按 seq 顺序返回全部段落（prefix + 译文/原文 + suffix 可拼回全文）")
    @GetMapping("/{id}/segments")
    public Result<List<DocSegmentVO>> segments(@PathVariable Long id) {
        return Result.ok(service.segments(CurrentUser.get().id(), id));
    }

    @Operation(summary = "任务术语", description = """
            候选与已确认的术语，按出现次数倒序。status：PENDING 待确认、CONFIRMED 已确认或术语库命中（强制使用）、\
            REJECTED 已拒绝、AUTO 未开启确认时自动采用的抽取术语（仅供参考，不强制）。""")
    @GetMapping("/{id}/terms")
    public Result<List<DocTermVO>> terms(@PathVariable Long id) {
        return Result.ok(service.terms(CurrentUser.get().id(), id));
    }

    @Operation(summary = "执行轨迹", description = "执行端上报的节点轨迹（trace 事件），按接收顺序返回")
    @GetMapping("/{id}/traces")
    public Result<List<DocTraceVO>> traces(@PathVariable Long id) {
        return Result.ok(service.traces(CurrentUser.get().id(), id));
    }

    @Operation(summary = "订阅任务进度（SSE）", description = """
            以 text/event-stream 推送事件，data 均为单行 JSON：首先发送 snapshot（DocTaskVO），随后推送 phase、parsed、analysis、\
            awaiting_confirm、chunk_done、consistency、completed、failed、cancelled；每 15 秒发送注释心跳 ":ping"。\
            任务处于终结状态（COMPLETED / FAILED / CANCELLED）时发送 snapshot 后关闭连接；收到终结事件后同样关闭。""",
            responses = @ApiResponse(responseCode = "200", description = "SSE 事件流",
                    content = @Content(mediaType = MediaType.TEXT_EVENT_STREAM_VALUE,
                            schema = @Schema(type = "string", example = "event:snapshot\ndata:{\"id\":1,\"status\":\"TRANSLATING\"}\n\n"))))
    @GetMapping(value = "/{id}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable Long id, HttpServletResponse response) {
        SseEmitter emitter = service.subscribe(CurrentUser.get().id(), id);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
        return emitter;
    }

    // ---------------- 操作 ----------------

    @Operation(summary = "确认术语", description = """
            仅 AWAITING_CONFIRM 状态允许（否则 409 + A0431）。terms 中 id 为空表示用户新增的术语；未出现在列表中的待确认术语视为拒绝。\
            确认后以全部 CONFIRMED 术语作为任务术语表写入 resume 命令，任务进入 TRANSLATING，返回最新术语列表。""")
    @OperationLog(module = MODULE, action = "确认任务术语")
    @PostMapping("/{id}/terms/confirm")
    public Result<List<DocTermVO>> confirmTerms(@PathVariable Long id, @Valid @RequestBody ConfirmTermsRequest req) {
        return Result.ok(service.confirmTerms(CurrentUser.get().id(), id, req));
    }

    @Operation(summary = "取消任务", description = "运行中或待确认术语时允许（否则 409 + A0431）：任务变为 CANCELLING，执行端停止后变为 CANCELLED")
    @OperationLog(module = MODULE, action = "取消文档任务")
    @PostMapping("/{id}/cancel")
    public Result<DocTaskVO> cancel(@PathVariable Long id) {
        return Result.ok(service.cancel(CurrentUser.get().id(), id));
    }

    @Operation(summary = "继续任务", description = """
            仅 FAILED（retryable=true）或 CANCELLED 允许（否则 409 + A0431），同样受并发限制（429 + A0213）。\
            任务回到 PENDING 并写入 retry 命令，从断点恢复，已完成的分块不再调用 LLM。""")
    @OperationLog(module = MODULE, action = "继续文档任务")
    @PostMapping("/{id}/retry")
    public Result<DocTaskVO> retry(@PathVariable Long id) {
        return Result.ok(service.retry(CurrentUser.get().id(), id));
    }

    @Operation(summary = "删除任务（逻辑删除）", description = "运行中的任务先取消；执行端随后清理该任务的检查点与分块缓存")
    @OperationLog(module = MODULE, action = "删除文档任务")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        service.delete(CurrentUser.get().id(), id);
        return Result.ok();
    }

    @Operation(summary = "段落后编辑", description = """
            修改可翻译段落的译文并标记为已编辑（已编辑的段落不会被执行端覆盖）；不可翻译段落返回 A0410。\
            保存成功后异步把该段写入翻译记忆，写入失败不影响本接口结果。""")
    @OperationLog(module = MODULE, action = "编辑段落译文")
    @PutMapping("/{id}/segments/{seq}")
    public Result<DocSegmentVO> editSegment(@PathVariable Long id, @PathVariable Integer seq,
                                            @Valid @RequestBody EditSegmentRequest req) {
        return Result.ok(service.editSegment(CurrentUser.get().id(), id, seq, req.target()));
    }

    @Operation(summary = "写入翻译记忆", description = """
            把已完成任务（否则 409 + A0431）中所有可翻译且已有译文的段落写入任务所属用户的翻译记忆\
            （来源 document，来源引用 "taskId:seq"），每批最多 200 条，返回写入条数；模型不可用返回 503 + C0160。\
            段落后编辑保存后也会自动异步写入该段。""")
    @OperationLog(module = MODULE, action = "写入翻译记忆")
    @PostMapping("/{id}/memory")
    public Result<TmWriteResult> writeMemory(@PathVariable Long id) {
        return Result.ok(service.writeMemory(CurrentUser.get().id(), id));
    }

    @Operation(summary = "单段重译", description = """
            结合前后段、全文摘要与任务术语表同步调用 AI 服务重译该段，可附加一句要求；返回新译文与用量，不自动保存\
            （用户确认后再调用段落后编辑接口）。AI 服务不可用返回 C0110。""")
    @PostMapping("/{id}/segments/{seq}/retranslate")
    public Result<RetranslateResult> retranslate(@PathVariable Long id, @PathVariable Integer seq,
                                                 @Valid @RequestBody(required = false) RetranslateRequest req) {
        return Result.ok(service.retranslate(CurrentUser.get().id(), id, seq, req == null ? null : req.instruction()));
    }

    @Operation(summary = "导出", description = """
            format=md 译文 Markdown（prefix + 译文 + suffix 拼接，没有译文的段落使用原文，保持原文结构）；\
            format=bilingual 双语对照 Markdown（原文段与译文段交替，不可翻译段只输出一次）；format=txt 纯文本（拼接规则同 md）。\
            文件名按 RFC 5987 以 UTF-8 编码。""",
            responses = @ApiResponse(responseCode = "200", description = "导出文件",
                    content = @Content(mediaType = "text/markdown")))
    @GetMapping("/{id}/export")
    public ResponseEntity<byte[]> export(
            @PathVariable Long id,
            @Parameter(description = "导出格式（缺省 md）", schema = @Schema(allowableValues = {"md", "bilingual", "txt"}))
            @RequestParam(value = "format", required = false, defaultValue = "md") String format) {
        DocTaskService.Export export = service.export(CurrentUser.get().id(), id, format);
        ContentDisposition disposition = ContentDisposition.attachment()
                .filename(safeFileName(export.fileName()), StandardCharsets.UTF_8)
                .build();
        return ResponseEntity.ok()
                .contentType(new MediaType(MediaType.parseMediaType(export.contentType()), StandardCharsets.UTF_8))
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
                .body(export.content());
    }

    // ---------------- 内部 ----------------

    private CreateDocTaskRequest parseSettings(String settings) {
        CreateDocTaskRequest req;
        try {
            req = jsonMapper.readValue(settings == null || settings.isBlank() ? "{}" : settings,
                    CreateDocTaskRequest.class);
        } catch (RuntimeException e) {
            throw FieldError.invalid("settings", "settings 不是合法的 JSON");
        }
        Set<ConstraintViolation<CreateDocTaskRequest>> violations = validator.validate(req);
        if (!violations.isEmpty()) {
            List<FieldError> errors = violations.stream()
                    .map(v -> new FieldError(v.getPropertyPath().toString(), v.getMessage()))
                    .sorted(Comparator.comparing(FieldError::field))
                    .toList();
            throw new BizException(ErrorCode.PARAM_INVALID, ErrorCode.PARAM_INVALID.getMessage(), errors);
        }
        return req;
    }

    /** 去掉文件名中的路径与非法字符。 */
    static String safeFileName(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").trim();
        return cleaned.isEmpty() ? "document" : cleaned;
    }
}
