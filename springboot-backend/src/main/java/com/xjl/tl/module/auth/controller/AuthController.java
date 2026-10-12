package com.xjl.tl.module.auth.controller;

import com.xjl.tl.common.Result;
import com.xjl.tl.module.auth.dto.AuthDtos.LoginRequest;
import com.xjl.tl.module.auth.dto.AuthDtos.LogoutRequest;
import com.xjl.tl.module.auth.dto.AuthDtos.RefreshRequest;
import com.xjl.tl.module.auth.dto.AuthDtos.RegisterRequest;
import com.xjl.tl.module.auth.dto.AuthDtos.TokenResponse;
import com.xjl.tl.module.auth.service.AuthService;
import com.xjl.tl.module.user.dto.UserDtos.UserInfo;
import com.xjl.tl.module.user.service.UserService;
import com.xjl.tl.security.CurrentUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirements;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "认证", description = "注册、登录、刷新令牌、退出、当前用户")
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService authService;
    private final UserService userService;

    public AuthController(AuthService authService, UserService userService) {
        this.authService = authService;
        this.userService = userService;
    }

    @Operation(summary = "注册", description = "默认分配 USER 角色；用户名冲突返回 A0111")
    @SecurityRequirements
    @PostMapping("/register")
    public Result<UserInfo> register(@Valid @RequestBody RegisterRequest req) {
        return Result.ok(authService.register(req));
    }

    @Operation(summary = "登录", description = "返回访问令牌与刷新令牌；15 分钟内失败 5 次将被锁定（A0211）")
    @SecurityRequirements
    @PostMapping("/login")
    public Result<TokenResponse> login(@Valid @RequestBody LoginRequest req, HttpServletRequest request) {
        return Result.ok(authService.login(req, request));
    }

    @Operation(summary = "刷新令牌", description = "用刷新令牌换取新的一对令牌，旧刷新令牌立即失效")
    @SecurityRequirements
    @PostMapping("/refresh")
    public Result<TokenResponse> refresh(@Valid @RequestBody RefreshRequest req) {
        return Result.ok(authService.refresh(req.refreshToken()));
    }

    @Operation(summary = "退出登录", description = "吊销当前访问令牌及（可选）刷新令牌")
    @PostMapping("/logout")
    public Result<Void> logout(@RequestBody(required = false) LogoutRequest req) {
        authService.logout(CurrentUser.get(), req == null ? null : req.refreshToken());
        return Result.ok();
    }

    @Operation(summary = "当前用户信息")
    @GetMapping("/me")
    public Result<UserInfo> me() {
        return Result.ok(userService.getInfo(CurrentUser.get().id()));
    }
}
