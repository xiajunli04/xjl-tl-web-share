package com.xjl.tl.module.memory.controller;

import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.Result;
import com.xjl.tl.module.log.annotation.OperationLog;
import com.xjl.tl.module.memory.dto.TmDtos.FromRecordRequest;
import com.xjl.tl.module.memory.dto.TmDtos.TmEntryVO;
import com.xjl.tl.module.memory.dto.TmDtos.TmQuery;
import com.xjl.tl.module.memory.dto.TmDtos.TmSearchRequest;
import com.xjl.tl.module.memory.dto.TmDtos.TmSearchResult;
import com.xjl.tl.module.memory.dto.TmDtos.TmWriteResult;
import com.xjl.tl.module.memory.service.TmService;
import com.xjl.tl.security.CurrentUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "翻译记忆", description = "当前用户的翻译记忆：列表、删除、从翻译记录写入、相似译法检索；转发到 AI 服务，模型不可用时返回 503 + C0160")
@RestController
@RequestMapping("/api/tm")
public class TmController {

    public static final String MODULE = "翻译记忆";

    private final TmService service;

    public TmController(TmService service) {
        this.service = service;
    }

    @Operation(summary = "分页查询翻译记忆", description = "可按语言对筛选、按原文或译文关键词检索；AI 服务不可用返回 C0110")
    @GetMapping
    public Result<PageResult<TmEntryVO>> page(@ParameterObject TmQuery query) {
        return Result.ok(service.page(CurrentUser.get().id(), query));
    }

    @Operation(summary = "删除翻译记忆", description = "不存在或不属于当前用户返回 A0404")
    @OperationLog(module = MODULE, action = "删除翻译记忆")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        service.delete(CurrentUser.get().id(), id);
        return Result.ok();
    }

    @Operation(summary = "把翻译记录存入记忆", description = """
            记录须属于当前用户（否则 A0404）；源语言取识别结果（用户指定源语言时取所选语言），来源为 workbench，\
            来源引用为记录 id。同一语言对下规范化后相同的原文以最新译文覆盖。模型不可用返回 503 + C0160。""")
    @OperationLog(module = MODULE, action = "存入翻译记忆")
    @PostMapping("/from-record/{recordId}")
    public Result<TmWriteResult> fromRecord(@PathVariable Long recordId,
                                            @Valid @RequestBody(required = false) FromRecordRequest req) {
        String override = req == null ? null : req.targetText();
        return Result.ok(service.fromRecord(CurrentUser.get().id(), recordId, override));
    }

    @Operation(summary = "检索相似译法", description = "返回最多 3 条命中（fuzzy / semantic 为 0–1）；模型不可用时 available=false、hits 为空")
    @PostMapping("/search")
    public Result<TmSearchResult> search(@Valid @RequestBody TmSearchRequest req) {
        return Result.ok(service.search(CurrentUser.get().id(), req));
    }
}
