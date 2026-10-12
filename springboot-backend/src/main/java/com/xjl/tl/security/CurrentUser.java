package com.xjl.tl.security;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;

import java.time.Instant;
import java.util.List;

/**
 * 当前登录用户（从访问令牌中解析）。
 */
public record CurrentUser(Long id, String username, List<String> roles, String jti, Instant expiresAt) {

    /** 获取当前用户，未登录时抛出 A0231。 */
    public static CurrentUser get() {
        CurrentUser user = getOrNull();
        if (user == null) {
            throw new BizException(ErrorCode.ACCESS_TOKEN_INVALID);
        }
        return user;
    }

    /** 获取当前用户，未登录返回 null。 */
    public static CurrentUser getOrNull() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof Jwt jwt)) {
            return null;
        }
        List<String> roles = jwt.getClaimAsStringList(JwtService.CLAIM_ROLES);
        return new CurrentUser(Long.valueOf(jwt.getSubject()), jwt.getClaimAsString(JwtService.CLAIM_USERNAME),
                roles == null ? List.of() : roles, jwt.getId(), jwt.getExpiresAt());
    }
}
