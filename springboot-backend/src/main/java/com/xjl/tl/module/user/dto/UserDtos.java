package com.xjl.tl.module.user.dto;

import com.xjl.tl.common.PageQuery;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 用户模块 DTO（字段契约见 design D13）。
 */
public final class UserDtos {

    /** 用户名：4–32 位字母、数字或下划线。 */
    public static final String USERNAME_REGEX = "^[A-Za-z0-9_]{4,32}$";
    public static final String USERNAME_MSG = "用户名须为 4-32 位字母、数字或下划线";
    /** 密码：8–64 位，同时包含字母和数字。 */
    public static final String PASSWORD_REGEX = "^(?=.*[A-Za-z])(?=.*\\d).{8,64}$";
    public static final String PASSWORD_MSG = "密码须为 8-64 位且同时包含字母和数字";
    public static final String STATUS_REGEX = "^(ENABLED|DISABLED)$";
    public static final String ROLE_REGEX = "^(ADMIN|USER)$";

    private UserDtos() {
    }

    @Schema(description = "用户信息")
    public record UserInfo(
            @Schema(description = "用户 id") Long id,
            @Schema(description = "用户名") String username,
            @Schema(description = "昵称") String nickname,
            @Schema(description = "邮箱") String email,
            @Schema(description = "状态", allowableValues = {"ENABLED", "DISABLED"}) String status,
            @Schema(description = "角色列表") List<String> roles,
            @Schema(description = "最近登录时间") OffsetDateTime lastLoginAt,
            @Schema(description = "创建时间") OffsetDateTime createdAt) {
    }

    @Schema(description = "管理员创建用户")
    public record CreateUserRequest(
            @Schema(description = "用户名") @NotBlank(message = "用户名不能为空") @Pattern(regexp = USERNAME_REGEX, message = USERNAME_MSG) String username,
            @Schema(description = "密码") @NotNull(message = "密码不能为空") @Pattern(regexp = PASSWORD_REGEX, message = PASSWORD_MSG) String password,
            @Schema(description = "昵称") @Size(max = 64, message = "昵称最长 64 位") String nickname,
            @Schema(description = "邮箱") @Email(message = "邮箱格式不正确") @Size(max = 128, message = "邮箱最长 128 位") String email,
            @Schema(description = "角色") @NotEmpty(message = "至少分配一个角色") List<@Pattern(regexp = ROLE_REGEX, message = "角色只能是 ADMIN 或 USER") String> roles) {
    }

    @Schema(description = "修改用户状态")
    public record UpdateStatusRequest(
            @Schema(description = "状态", allowableValues = {"ENABLED", "DISABLED"})
            @NotNull(message = "状态不能为空") @Pattern(regexp = STATUS_REGEX, message = "状态只能是 ENABLED 或 DISABLED") String status) {
    }

    @Schema(description = "分配角色")
    public record UpdateRolesRequest(
            @Schema(description = "角色") @NotEmpty(message = "至少分配一个角色")
            List<@NotNull @Pattern(regexp = ROLE_REGEX, message = "角色只能是 ADMIN 或 USER") String> roles) {
    }

    @Schema(description = "重置密码")
    public record ResetPasswordRequest(
            @Schema(description = "新密码") @NotNull(message = "密码不能为空") @Pattern(regexp = PASSWORD_REGEX, message = PASSWORD_MSG) String password) {
    }

    @Schema(description = "修改个人资料")
    public record UpdateProfileRequest(
            @Schema(description = "昵称") @Size(max = 64, message = "昵称最长 64 位") String nickname,
            @Schema(description = "邮箱") @Email(message = "邮箱格式不正确") @Size(max = 128, message = "邮箱最长 128 位") String email) {
    }

    @Schema(description = "修改密码")
    public record ChangePasswordRequest(
            @Schema(description = "原密码") @NotBlank(message = "原密码不能为空") String oldPassword,
            @Schema(description = "新密码") @NotNull(message = "新密码不能为空") @Pattern(regexp = PASSWORD_REGEX, message = PASSWORD_MSG) String newPassword) {
    }

    /** 用户分页查询条件。 */
    @Schema(description = "用户查询条件")
    public static class UserQuery extends PageQuery {
        @Schema(description = "用户名（模糊匹配）")
        private String username;
        @Schema(description = "状态", allowableValues = {"ENABLED", "DISABLED"})
        private String status;
        @Schema(description = "角色", allowableValues = {"ADMIN", "USER"})
        private String role;

        public String getUsername() {
            return username;
        }

        public void setUsername(String username) {
            this.username = username;
        }

        public String getStatus() {
            return status;
        }

        public void setStatus(String status) {
            this.status = status;
        }

        public String getRole() {
            return role;
        }

        public void setRole(String role) {
            this.role = role;
        }
    }
}
