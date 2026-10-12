package com.xjl.tl.module.auth.service;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.RequestUtils;
import com.xjl.tl.module.auth.dto.AuthDtos.LoginRequest;
import com.xjl.tl.module.auth.dto.AuthDtos.RegisterRequest;
import com.xjl.tl.module.auth.dto.AuthDtos.TokenResponse;
import com.xjl.tl.module.log.entity.LoginLog;
import com.xjl.tl.module.log.service.LogService;
import com.xjl.tl.module.user.dto.UserDtos.UserInfo;
import com.xjl.tl.module.user.entity.SysUser;
import com.xjl.tl.module.user.service.UserService;
import com.xjl.tl.security.CurrentUser;
import com.xjl.tl.security.JwtService;
import com.xjl.tl.security.TokenRevocationService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;

/**
 * 认证服务：注册、登录、刷新、退出（见 design D3）。
 */
@Service
public class AuthService {

    /** 用于在用户不存在时也执行一次 BCrypt 比较，避免通过响应时间枚举用户。 */
    private final String dummyHash;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final UserService userService;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final TokenRevocationService revocationService;
    private final LoginRateLimiter rateLimiter;
    private final LogService logService;

    public AuthService(UserService userService, PasswordEncoder passwordEncoder, JwtService jwtService,
                       TokenRevocationService revocationService, LoginRateLimiter rateLimiter, LogService logService) {
        this.userService = userService;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.revocationService = revocationService;
        this.rateLimiter = rateLimiter;
        this.logService = logService;
        this.dummyHash = passwordEncoder.encode("dummy-password-for-timing");
    }

    public UserInfo register(RegisterRequest req) {
        SysUser user = userService.create(req.username(), req.password(), req.nickname(), req.email(),
                List.of(UserService.ROLE_USER));
        return userService.toInfo(user);
    }

    public TokenResponse login(LoginRequest req, HttpServletRequest request) {
        String username = req.username().trim();
        // 已锁定时直接拒绝，不校验密码
        if (rateLimiter.isLocked(username)) {
            saveLoginLog(null, username, false, "登录失败次数过多", request);
            throw new BizException(ErrorCode.LOGIN_LOCKED);
        }
        SysUser user = userService.findByUsername(username);
        boolean matched = passwordEncoder.matches(req.password(), user == null ? dummyHash : user.getPasswordHash());
        if (user == null || !matched) {
            rateLimiter.recordFailure(username);
            saveLoginLog(user == null ? null : user.getId(), username, false, "用户名或密码错误", request);
            throw new BizException(ErrorCode.BAD_CREDENTIALS);
        }
        if (!SysUser.ENABLED.equals(user.getStatus())) {
            saveLoginLog(user.getId(), username, false, "账号已禁用", request);
            throw new BizException(ErrorCode.ACCOUNT_DISABLED);
        }
        rateLimiter.reset(username);
        userService.markLogin(user);
        saveLoginLog(user.getId(), username, true, null, request);
        return issueTokens(user);
    }

    public TokenResponse refresh(String refreshToken) {
        Long userId = revocationService.consumeRefreshToken(refreshToken);
        if (userId == null) {
            throw new BizException(ErrorCode.REFRESH_TOKEN_INVALID);
        }
        SysUser user;
        try {
            user = userService.getRequired(userId);
        } catch (BizException e) {
            throw new BizException(ErrorCode.REFRESH_TOKEN_INVALID);
        }
        if (!SysUser.ENABLED.equals(user.getStatus())) {
            throw new BizException(ErrorCode.REFRESH_TOKEN_INVALID);
        }
        return issueTokens(user);
    }

    public void logout(CurrentUser current, String refreshToken) {
        revocationService.revokeAccess(current.jti(), current.expiresAt());
        if (StringUtils.hasText(refreshToken)) {
            revocationService.deleteRefreshToken(refreshToken, current.id());
        }
    }

    private TokenResponse issueTokens(SysUser user) {
        UserInfo info = userService.toInfo(user);
        JwtService.IssuedToken access = jwtService.issue(user.getId(), user.getUsername(), info.roles());
        String refreshToken = newRefreshToken();
        revocationService.saveRefreshToken(refreshToken, user.getId());
        return new TokenResponse(access.token(), refreshToken, access.expiresIn(), info);
    }

    private static String newRefreshToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private void saveLoginLog(Long userId, String username, boolean success, String reason, HttpServletRequest request) {
        LoginLog entry = new LoginLog();
        entry.setUserId(userId);
        entry.setUsername(RequestUtils.truncate(username, 64));
        entry.setIp(RequestUtils.clientIp(request));
        entry.setUserAgent(RequestUtils.truncate(request.getHeader("User-Agent"), 512));
        entry.setSuccess(success);
        entry.setFailReason(reason);
        logService.saveLoginLog(entry);
    }
}
