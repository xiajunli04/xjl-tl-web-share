package com.xjl.tl.module.user.controller;

import com.xjl.tl.common.Result;
import com.xjl.tl.module.user.dto.UserDtos.ChangePasswordRequest;
import com.xjl.tl.module.user.dto.UserDtos.UpdateProfileRequest;
import com.xjl.tl.module.user.dto.UserDtos.UserInfo;
import com.xjl.tl.module.user.service.UserService;
import com.xjl.tl.security.CurrentUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "个人中心", description = "修改个人资料与密码")
@RestController
@RequestMapping("/api/users/me")
public class UserProfileController {

    private final UserService userService;

    public UserProfileController(UserService userService) {
        this.userService = userService;
    }

    @Operation(summary = "修改昵称、邮箱")
    @PutMapping
    public Result<UserInfo> updateProfile(@Valid @RequestBody UpdateProfileRequest req) {
        return Result.ok(userService.updateProfile(CurrentUser.get().id(), req));
    }

    @Operation(summary = "修改密码", description = "校验原密码，成功后全部令牌失效，需要重新登录")
    @PutMapping("/password")
    public Result<Void> changePassword(@Valid @RequestBody ChangePasswordRequest req) {
        userService.changePassword(CurrentUser.get().id(), req);
        return Result.ok();
    }
}
