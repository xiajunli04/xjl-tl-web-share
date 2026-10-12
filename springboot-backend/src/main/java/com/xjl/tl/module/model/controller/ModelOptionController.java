package com.xjl.tl.module.model.controller;

import com.xjl.tl.common.Result;
import com.xjl.tl.module.model.dto.ModelConfigDtos.ModelOptionVO;
import com.xjl.tl.module.model.service.ModelConfigService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@Tag(name = "模型选项", description = "任意已登录用户可查询的可用模型列表")
@RestController
@RequestMapping("/api/model-configs")
public class ModelOptionController {

    private final ModelConfigService service;

    public ModelOptionController(ModelConfigService service) {
        this.service = service;
    }

    @Operation(summary = "可用模型选项", description = "只返回已启用的配置 {id, name, capability, provider, isDefault, isReviewDefault, supportsVision}，"
            + "可按能力（缺省 CHAT）与是否支持图片输入筛选，默认模型排在第一位；不含接口地址与密钥信息")
    @GetMapping("/options")
    public Result<List<ModelOptionVO>> options(
            @Parameter(description = "能力类型，缺省 CHAT") @RequestParam(required = false) String capability,
            @Parameter(description = "只返回支持图片输入的配置") @RequestParam(defaultValue = "false") boolean vision) {
        return Result.ok(service.options(capability, vision));
    }
}
