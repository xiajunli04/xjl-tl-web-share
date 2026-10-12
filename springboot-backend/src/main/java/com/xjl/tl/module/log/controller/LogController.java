package com.xjl.tl.module.log.controller;

import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.Result;
import com.xjl.tl.module.log.dto.LogDtos.LoginLogQuery;
import com.xjl.tl.module.log.dto.LogDtos.LoginLogVO;
import com.xjl.tl.module.log.dto.LogDtos.OperationLogQuery;
import com.xjl.tl.module.log.dto.LogDtos.OperationLogVO;
import com.xjl.tl.module.log.service.LogService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "日志管理", description = "登录日志、操作日志查询（仅管理员）")
@RestController
@RequestMapping("/api/admin/logs")
public class LogController {

    private final LogService logService;

    public LogController(LogService logService) {
        this.logService = logService;
    }

    @Operation(summary = "登录日志分页", description = "按用户名、是否成功、时间范围过滤，按时间倒序")
    @GetMapping("/login")
    public Result<PageResult<LoginLogVO>> loginLogs(@ParameterObject LoginLogQuery query) {
        return Result.ok(logService.pageLoginLogs(query));
    }

    @Operation(summary = "操作日志分页", description = "按用户名、模块、时间范围过滤，按时间倒序")
    @GetMapping("/operation")
    public Result<PageResult<OperationLogVO>> operationLogs(@ParameterObject OperationLogQuery query) {
        return Result.ok(logService.pageOperationLogs(query));
    }
}
