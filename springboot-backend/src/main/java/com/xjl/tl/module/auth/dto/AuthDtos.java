package com.xjl.tl.module.auth.dto;

import com.xjl.tl.module.user.dto.UserDtos;
import com.xjl.tl.module.user.dto.UserDtos.UserInfo;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * 认证模块 DTO（字段契约见 design D13）。
 */
public final class AuthDtos {

    private AuthDtos() {
    }

    @Schema(description = "注册请求")
    public record RegisterRequest(
            @Schema(description = "用户名，4-32 位字母、数字或下划线") @NotBlank(message = "用户名不能为空")
            @Pattern(regexp = UserDtos.USERNAME_REGEX, message = UserDtos.USERNAME_MSG) String username,
            @Schema(description = "密码，8-64 位且包含字母和数字") @NotNull(message = "密码不能为空")
            @Pattern(regexp = UserDtos.PASSWORD_REGEX, message = UserDtos.PASSWORD_MSG) String password,
            @Schema(description = "昵称") @Size(max = 64, message = "昵称最长 64 位") String nickname,
            @Schema(description = "邮箱") @Email(message = "邮箱格式不正确") @Size(max = 128, message = "邮箱最长 128 位") String email) {
    }

    @Schema(description = "登录请求")
    public record LoginRequest(
            @Schema(description = "用户名") @NotBlank(message = "用户名不能为空") @Size(max = 64, message = "用户名过长") String username,
            @Schema(description = "密码") @NotBlank(message = "密码不能为空") @Size(max = 128, message = "密码过长") String password) {
    }

    @Schema(description = "刷新令牌请求")
    public record RefreshRequest(
            @Schema(description = "刷新令牌") @NotBlank(message = "刷新令牌不能为空") String refreshToken) {
    }

    @Schema(description = "退出登录请求")
    public record LogoutRequest(@Schema(description = "刷新令牌（可选）") String refreshToken) {
    }

    @Schema(description = "令牌响应")
    public record TokenResponse(
            @Schema(description = "访问令牌（JWT）") String accessToken,
            @Schema(description = "刷新令牌") String refreshToken,
            @Schema(description = "访问令牌有效期（秒）") long expiresIn,
            @Schema(description = "当前用户") UserInfo user) {
    }
}
