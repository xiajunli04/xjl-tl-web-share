package com.xjl.tl.module.user.controller;

import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.Result;
import com.xjl.tl.module.log.annotation.OperationLog;
import com.xjl.tl.module.user.dto.UserDtos.CreateUserRequest;
import com.xjl.tl.module.user.dto.UserDtos.ResetPasswordRequest;
import com.xjl.tl.module.user.dto.UserDtos.UpdateRolesRequest;
import com.xjl.tl.module.user.dto.UserDtos.UpdateStatusRequest;
import com.xjl.tl.module.user.dto.UserDtos.UserInfo;
import com.xjl.tl.module.user.dto.UserDtos.UserQuery;
import com.xjl.tl.module.user.service.UserService;
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

@Tag(name = "用户管理", description = "管理员管理用户")
@RestController
@RequestMapping("/api/admin/users")
public class UserAdminController {

    private static final String MODULE = "用户管理";

    private final UserService userService;

    public UserAdminController(UserService userService) {
        this.userService = userService;
    }

    @Operation(summary = "分页查询用户", description = "按用户名模糊、状态、角色过滤，按创建时间倒序")
    @GetMapping
    public Result<PageResult<UserInfo>> page(@ParameterObject UserQuery query) {
        return Result.ok(userService.page(query));
    }

    @Operation(summary = "创建用户")
    @OperationLog(module = MODULE, action = "创建用户")
    @PostMapping
    public Result<UserInfo> create(@Valid @RequestBody CreateUserRequest req) {
        return Result.ok(userService.adminCreate(req));
    }

    @Operation(summary = "启用/禁用用户", description = "禁用后该用户被强制下线；不能禁用自己")
    @OperationLog(module = MODULE, action = "修改用户状态")
    @PutMapping("/{id}/status")
    public Result<Void> updateStatus(@PathVariable Long id, @Valid @RequestBody UpdateStatusRequest req) {
        userService.updateStatus(CurrentUser.get().id(), id, req.status());
        return Result.ok();
    }

    @Operation(summary = "分配角色", description = "修改后该用户被强制下线；不能移除自己的 ADMIN 角色")
    @OperationLog(module = MODULE, action = "分配角色")
    @PutMapping("/{id}/roles")
    public Result<Void> updateRoles(@PathVariable Long id, @Valid @RequestBody UpdateRolesRequest req) {
        userService.updateRoles(CurrentUser.get().id(), id, req.roles());
        return Result.ok();
    }

    @Operation(summary = "重置密码", description = "重置后该用户被强制下线")
    @OperationLog(module = MODULE, action = "重置密码")
    @PutMapping("/{id}/password")
    public Result<Void> resetPassword(@PathVariable Long id, @Valid @RequestBody ResetPasswordRequest req) {
        userService.resetPassword(id, req.password());
        return Result.ok();
    }

    @Operation(summary = "删除用户（逻辑删除）", description = "不能删除自己")
    @OperationLog(module = MODULE, action = "删除用户")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        userService.delete(CurrentUser.get().id(), id);
        return Result.ok();
    }
}
