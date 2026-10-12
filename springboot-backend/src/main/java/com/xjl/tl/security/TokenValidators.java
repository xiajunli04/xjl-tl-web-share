package com.xjl.tl.security;

import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;

import java.time.Instant;

/**
 * 自定义 JWT 校验器：区分"过期"与"无效/已吊销"，供 AuthenticationEntryPoint 映射 A0230 / A0231。
 */
public final class TokenValidators {

    /** 过期错误码，入口点据此返回 A0230。 */
    public static final String ERROR_EXPIRED = "token_expired";
    public static final String ERROR_REVOKED = "token_revoked";

    private TokenValidators() {
    }

    /** 过期校验（不允许时钟偏差，便于严格的 2 小时有效期）。 */
    public static OAuth2TokenValidator<Jwt> expiry() {
        return jwt -> {
            Instant exp = jwt.getExpiresAt();
            if (exp == null || !Instant.now().isBefore(exp)) {
                return OAuth2TokenValidatorResult.failure(new OAuth2Error(ERROR_EXPIRED, "访问令牌已过期", null));
            }
            return OAuth2TokenValidatorResult.success();
        };
    }

    /** 吊销校验：jti 黑名单与 revoked-before。 */
    public static OAuth2TokenValidator<Jwt> revocation(TokenRevocationService revocationService) {
        return jwt -> {
            if (revocationService.isBlacklisted(jwt.getId())) {
                return revoked();
            }
            Long userId;
            try {
                userId = Long.valueOf(jwt.getSubject());
            } catch (NumberFormatException e) {
                return revoked();
            }
            Long revokedBefore = revocationService.revokedBefore(userId);
            if (revokedBefore != null && issuedAtMillis(jwt) < revokedBefore) {
                return revoked();
            }
            return OAuth2TokenValidatorResult.success();
        };
    }

    private static long issuedAtMillis(Jwt jwt) {
        Object ms = jwt.getClaims().get(JwtService.CLAIM_IAT_MS);
        if (ms instanceof Number n) {
            return n.longValue();
        }
        Instant iat = jwt.getIssuedAt();
        return iat == null ? 0L : iat.toEpochMilli();
    }

    private static OAuth2TokenValidatorResult revoked() {
        return OAuth2TokenValidatorResult.failure(new OAuth2Error(ERROR_REVOKED, "访问令牌已吊销", null));
    }
}
