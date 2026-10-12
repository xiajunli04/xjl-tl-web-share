package com.xjl.tl.module.translate.controller;

import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.Result;
import com.xjl.tl.module.translate.dto.TranslateDtos.FavoriteRequest;
import com.xjl.tl.module.translate.dto.TranslateDtos.TranslationDetailVO;
import com.xjl.tl.module.translate.dto.TranslateDtos.TranslationQuery;
import com.xjl.tl.module.translate.dto.TranslateDtos.TranslationSummaryVO;
import com.xjl.tl.module.translate.service.TranslationRecordService;
import com.xjl.tl.security.CurrentUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "翻译历史", description = "当前用户的翻译记录：检索、详情与 Agent 轨迹、收藏、删除；他人记录返回 A0404")
@RestController
@RequestMapping("/api/translations")
public class TranslationHistoryController {

    private final TranslationRecordService service;

    public TranslationHistoryController(TranslationRecordService service) {
        this.service = service;
    }

    @Operation(summary = "分页查询翻译历史", description = "按创建时间倒序；keyword 匹配原文或译文（不区分大小写）；时间范围为 [startTime, endTime)")
    @GetMapping
    public Result<PageResult<TranslationSummaryVO>> page(@ParameterObject TranslationQuery query) {
        return Result.ok(service.page(CurrentUser.get().id(), query));
    }

    @Operation(summary = "翻译记录详情", description = "含按 seq 排序的 Agent 轨迹")
    @GetMapping("/{id}")
    public Result<TranslationDetailVO> detail(@PathVariable Long id) {
        return Result.ok(service.detail(CurrentUser.get().id(), id));
    }

    @Operation(summary = "收藏/取消收藏")
    @PutMapping("/{id}/favorite")
    public Result<Void> favorite(@PathVariable Long id, @Valid @RequestBody FavoriteRequest req) {
        service.setFavorite(CurrentUser.get().id(), id, req.favorite());
        return Result.ok();
    }

    @Operation(summary = "删除翻译记录（逻辑删除）")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        service.delete(CurrentUser.get().id(), id);
        return Result.ok();
    }
}
