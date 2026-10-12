package com.xjl.tl.module.glossary.controller;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.Result;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.ImportPreviewVO;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.ImportResultVO;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.TermQuery;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.TermRequest;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.TermVO;
import com.xjl.tl.module.glossary.service.GlossaryTermService;
import com.xjl.tl.module.log.annotation.OperationLog;
import com.xjl.tl.security.CurrentUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
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

import java.io.IOException;
import java.nio.charset.StandardCharsets;

@Tag(name = "术语", description = "术语增删改查与 CSV 导入导出（CSV 列：source,target,note，UTF-8，可带 BOM）")
@RestController
@RequestMapping("/api/glossaries/{id}/terms")
public class GlossaryTermController {

    private static final String MODULE = GlossaryController.MODULE;
    private static final MediaType TEXT_CSV = new MediaType("text", "csv", StandardCharsets.UTF_8);

    private final GlossaryTermService service;

    public GlossaryTermController(GlossaryTermService service) {
        this.service = service;
    }

    @Operation(summary = "分页查询术语", description = "按创建时间倒序；keyword 匹配源术语或目标术语（不区分大小写）")
    @GetMapping
    public Result<PageResult<TermVO>> page(@PathVariable Long id, @ParameterObject TermQuery query) {
        return Result.ok(service.page(CurrentUser.get(), id, query));
    }

    @Operation(summary = "新增术语", description = "源术语在同一术语库内不区分大小写唯一，重复返回 A0112")
    @OperationLog(module = MODULE, action = "新增术语")
    @PostMapping
    public Result<TermVO> create(@PathVariable Long id, @Valid @RequestBody TermRequest req) {
        return Result.ok(service.create(CurrentUser.get(), id, req));
    }

    @Operation(summary = "编辑术语", description = "caseSensitive 缺省表示保持原值")
    @OperationLog(module = MODULE, action = "编辑术语")
    @PutMapping("/{termId}")
    public Result<TermVO> update(@PathVariable Long id, @PathVariable Long termId, @Valid @RequestBody TermRequest req) {
        return Result.ok(service.update(CurrentUser.get(), id, termId, req));
    }

    @Operation(summary = "删除术语（物理删除）")
    @OperationLog(module = MODULE, action = "删除术语")
    @DeleteMapping("/{termId}")
    public Result<Void> delete(@PathVariable Long id, @PathVariable Long termId) {
        service.delete(CurrentUser.get(), id, termId);
        return Result.ok();
    }

    @Operation(summary = "预览导入", description = "返回总数、有效数、新增数、将覆盖数、逐行错误与样例；最多 5000 行，表头或编码非法返回 A0421")
    @PostMapping(value = "/import/preview", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<ImportPreviewVO> preview(@PathVariable Long id,
                                           @Parameter(description = "CSV 文件") @RequestPart("file") MultipartFile file) {
        return Result.ok(service.preview(CurrentUser.get(), id, bytes(file)));
    }

    @Operation(summary = "确认导入", description = "strategy=skip 跳过已存在的术语，overwrite 覆盖已存在术语的目标术语与备注")
    @OperationLog(module = MODULE, action = "导入术语")
    @PostMapping(value = "/import", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<ImportResultVO> importTerms(
            @PathVariable Long id,
            @Parameter(description = "CSV 文件") @RequestPart("file") MultipartFile file,
            @Parameter(description = "冲突策略", schema = @Schema(allowableValues = {"skip", "overwrite"}))
            @RequestParam(value = "strategy", required = false, defaultValue = "skip") String strategy) {
        return Result.ok(service.importTerms(CurrentUser.get(), id, bytes(file), strategy));
    }

    @Operation(summary = "导出术语 CSV", description = "UTF-8（带 BOM）CSV，可原样重新导入；文件名按 RFC 5987 以 UTF-8 编码",
            responses = @ApiResponse(responseCode = "200", description = "CSV 文件",
                    content = @Content(mediaType = "text/csv")))
    @GetMapping("/export")
    public ResponseEntity<byte[]> export(@PathVariable Long id) {
        GlossaryTermService.Export export = service.export(CurrentUser.get(), id);
        ContentDisposition disposition = ContentDisposition.attachment()
                .filename(safeFileName(export.name()) + ".csv", StandardCharsets.UTF_8)
                .build();
        return ResponseEntity.ok()
                .contentType(TEXT_CSV)
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
                .body(export.content());
    }

    private static byte[] bytes(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new BizException(ErrorCode.IMPORT_FILE_INVALID, ErrorCode.IMPORT_FILE_INVALID.getMessage() + "：文件为空");
        }
        try {
            return file.getBytes();
        } catch (IOException e) {
            throw new BizException(ErrorCode.IMPORT_FILE_INVALID, ErrorCode.IMPORT_FILE_INVALID.getMessage() + "：读取文件失败");
        }
    }

    /** 去掉文件名中的路径与非法字符。 */
    static String safeFileName(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").trim();
        return cleaned.isEmpty() ? "glossary" : cleaned;
    }
}
