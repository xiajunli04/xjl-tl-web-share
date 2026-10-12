package com.xjl.tl.module.glossary.controller;

import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.Result;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.GlossaryQuery;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.GlossaryRequest;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.GlossaryVO;
import com.xjl.tl.module.glossary.service.GlossaryService;
import com.xjl.tl.module.log.annotation.OperationLog;
import com.xjl.tl.security.CurrentUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "术语库", description = "个人/公共术语库管理：自己的库可编辑，公共库只有管理员可编辑；他人私有库返回 A0404")
@RestController
@RequestMapping("/api/glossaries")
public class GlossaryController {

    static final String MODULE = "术语库";

    private final GlossaryService service;

    public GlossaryController(GlossaryService service) {
        this.service = service;
    }

    @Operation(summary = "分页查询术语库", description = "返回自己的术语库和全部公共术语库，按更新时间倒序；editable 表示当前用户能否编辑")
    @GetMapping
    public Result<PageResult<GlossaryVO>> page(@ParameterObject GlossaryQuery query) {
        return Result.ok(service.page(CurrentUser.get(), query));
    }

    @Operation(summary = "查询术语库详情")
    @GetMapping("/{id}")
    public Result<GlossaryVO> get(@PathVariable Long id) {
        return Result.ok(service.get(CurrentUser.get(), id));
    }

    @Operation(summary = "新建术语库", description = "scope 缺省为 PRIVATE；普通用户设置 PUBLIC 返回 A0301；语种不在支持清单返回 A0420")
    @OperationLog(module = MODULE, action = "新建术语库")
    @PostMapping
    public Result<GlossaryVO> create(@Valid @RequestBody GlossaryRequest req) {
        return Result.ok(service.create(CurrentUser.get(), req));
    }

    @Operation(summary = "编辑术语库", description = "只能编辑自己的私有库；公共库只有管理员能改")
    @OperationLog(module = MODULE, action = "编辑术语库")
    @PutMapping("/{id}")
    public Result<GlossaryVO> update(@PathVariable Long id, @Valid @RequestBody GlossaryRequest req) {
        return Result.ok(service.update(CurrentUser.get(), id, req));
    }

    @Operation(summary = "删除术语库（逻辑删除）")
    @OperationLog(module = MODULE, action = "删除术语库")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        service.delete(CurrentUser.get(), id);
        return Result.ok();
    }
}
