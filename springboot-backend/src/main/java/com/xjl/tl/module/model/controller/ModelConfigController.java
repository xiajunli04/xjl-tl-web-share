package com.xjl.tl.module.model.controller;

import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.Result;
import com.xjl.tl.infra.ai.AiServiceClient;
import com.xjl.tl.infra.ai.ModelTestResult;
import com.xjl.tl.module.log.annotation.OperationLog;
import com.xjl.tl.module.model.dto.ModelConfigDtos.EnabledRequest;
import com.xjl.tl.module.model.dto.ModelConfigDtos.ModelConfigQuery;
import com.xjl.tl.module.model.dto.ModelConfigDtos.ModelConfigRequest;
import com.xjl.tl.module.model.dto.ModelConfigDtos.ModelConfigVO;
import com.xjl.tl.module.model.service.ModelConfigService;
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

@Tag(name = "模型配置", description = "LLM 模型配置管理（仅管理员）")
@RestController
@RequestMapping("/api/admin/model-configs")
public class ModelConfigController {

    private static final String MODULE = "模型配置";

    private final ModelConfigService service;
    private final AiServiceClient aiServiceClient;

    public ModelConfigController(ModelConfigService service, AiServiceClient aiServiceClient) {
        this.service = service;
        this.aiServiceClient = aiServiceClient;
    }

    @Operation(summary = "分页查询模型配置")
    @GetMapping
    public Result<PageResult<ModelConfigVO>> page(@ParameterObject ModelConfigQuery query) {
        return Result.ok(service.page(query));
    }

    @Operation(summary = "查询模型配置详情")
    @GetMapping("/{id}")
    public Result<ModelConfigVO> get(@PathVariable Long id) {
        return Result.ok(service.get(id));
    }

    @Operation(summary = "新增模型配置", description = "apiKey 加密存储，响应只返回掩码")
    @OperationLog(module = MODULE, action = "新增模型配置")
    @PostMapping
    public Result<ModelConfigVO> create(@Valid @RequestBody ModelConfigRequest req) {
        return Result.ok(service.create(req));
    }

    @Operation(summary = "编辑模型配置", description = "apiKey 为空或缺省表示保持原值")
    @OperationLog(module = MODULE, action = "编辑模型配置")
    @PutMapping("/{id}")
    public Result<ModelConfigVO> update(@PathVariable Long id, @Valid @RequestBody ModelConfigRequest req) {
        return Result.ok(service.update(id, req));
    }

    @Operation(summary = "删除模型配置（逻辑删除）", description = "删除默认 / 评审配置时同时取消对应标记")
    @OperationLog(module = MODULE, action = "删除模型配置")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        service.delete(id);
        return Result.ok();
    }

    @Operation(summary = "设为默认模型", description = "自动取消原默认配置")
    @OperationLog(module = MODULE, action = "设为默认模型")
    @PutMapping("/{id}/default")
    public Result<Void> setDefault(@PathVariable Long id) {
        service.setDefault(id);
        return Result.ok();
    }

    @Operation(summary = "设为评审模型", description = """
            自动取消原评审模型；不存在返回 A0404，已停用返回 C0130。可与默认模型为同一配置（等同于评审使用译者模型）。\
            未显式指定评审模型的翻译请求与文档任务使用该模型评审。""")
    @OperationLog(module = MODULE, action = "设为评审模型")
    @PutMapping("/{id}/review-default")
    public Result<Void> setReviewDefault(@PathVariable Long id) {
        service.setReviewDefault(id);
        return Result.ok();
    }

    @Operation(summary = "取消评审模型", description = "幂等：该配置不是评审模型时同样返回成功；不存在返回 A0404。取消后评审使用译者模型")
    @OperationLog(module = MODULE, action = "取消评审模型")
    @DeleteMapping("/{id}/review-default")
    public Result<Void> clearReviewDefault(@PathVariable Long id) {
        service.clearReviewDefault(id);
        return Result.ok();
    }

    @Operation(summary = "启用/停用模型配置", description = "停用默认 / 评审配置时同时取消对应标记")
    @OperationLog(module = MODULE, action = "启停模型配置")
    @PutMapping("/{id}/enabled")
    public Result<Void> setEnabled(@PathVariable Long id, @Valid @RequestBody EnabledRequest req) {
        service.setEnabled(id, req.enabled());
        return Result.ok();
    }

    @Operation(summary = "模型连通性测试", description = "经 Python AI 服务真实调用一次 LLM；连通失败以 ok=false 正常返回")
    @OperationLog(module = MODULE, action = "测试模型连通性")
    @PostMapping("/{id}/test")
    public Result<ModelTestResult> test(@PathVariable Long id) {
        service.get(id); // 不存在时返回 A0404
        return Result.ok(aiServiceClient.testModel(id));
    }
}
