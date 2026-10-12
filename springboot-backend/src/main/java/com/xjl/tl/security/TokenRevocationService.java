package com.xjl.tl.security;

import com.xjl.tl.common.config.AppProperties;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.Set;

/**
 * 令牌吊销与刷新令牌存储（Redis，见 design D3）。
 * <ul>
 *   <li>auth:blacklist:{jti}：退出登录后的访问令牌黑名单，TTL 为剩余有效期</li>
 *   <li>auth:revoked-before:{userId}：强制下线时间戳（毫秒），早于该时间签发的令牌失效</li>
 *   <li>auth:refresh:{token} → userId；auth:user-refresh:{userId} 为该用户的刷新令牌集合</li>
 * </ul>
 */
@Service
public class TokenRevocationService {

    static final String BLACKLIST = "auth:blacklist:";
    static final String REVOKED_BEFORE = "auth:revoked-before:";
    static final String REFRESH = "auth:refresh:";
    static final String USER_REFRESH = "auth:user-refresh:";

    private final StringRedisTemplate redis;
    private final AppProperties props;

    public TokenRevocationService(StringRedisTemplate redis, AppProperties props) {
        this.redis = redis;
        this.props = props;
    }

    /** 吊销单个访问令牌（退出登录）。 */
    public void revokeAccess(String jti, Instant expiresAt) {
        if (jti == null || expiresAt == null) {
            return;
        }
        Duration ttl = Duration.between(Instant.now(), expiresAt);
        if (!ttl.isNegative() && !ttl.isZero()) {
            redis.opsForValue().set(BLACKLIST + jti, "1", ttl);
        }
    }

    /** 强制下线：使该用户此前签发的全部访问令牌与刷新令牌失效。 */
    public void revokeAllForUser(Long userId) {
        // 保留时长覆盖访问令牌最长有效期即可
        redis.opsForValue().set(REVOKED_BEFORE + userId, String.valueOf(Instant.now().toEpochMilli()),
                props.security().accessTokenTtl().plusMinutes(1));
        String setKey = USER_REFRESH + userId;
        Set<String> tokens = redis.opsForSet().members(setKey);
        if (tokens != null && !tokens.isEmpty()) {
            redis.delete(tokens.stream().map(t -> REFRESH + t).toList());
        }
        redis.delete(setKey);
    }

    public boolean isBlacklisted(String jti) {
        return jti != null && Boolean.TRUE.equals(redis.hasKey(BLACKLIST + jti));
    }

    /** @return 强制下线时间戳（毫秒），没有则返回 null */
    public Long revokedBefore(Long userId) {
        String v = redis.opsForValue().get(REVOKED_BEFORE + userId);
        return v == null ? null : Long.valueOf(v);
    }

    // ---------------- 刷新令牌 ----------------

    public void saveRefreshToken(String token, Long userId) {
        Duration ttl = props.security().refreshTokenTtl();
        redis.opsForValue().set(REFRESH + token, String.valueOf(userId), ttl);
        String setKey = USER_REFRESH + userId;
        redis.opsForSet().add(setKey, token);
        redis.expire(setKey, ttl);
    }

    /** 原子地取出并删除刷新令牌（轮换），无效时返回 null。 */
    public Long consumeRefreshToken(String token) {
        String userId = redis.opsForValue().getAndDelete(REFRESH + token);
        if (userId == null) {
            return null;
        }
        Long id = Long.valueOf(userId);
        redis.opsForSet().remove(USER_REFRESH + id, token);
        return id;
    }

    /** 删除指定用户的某个刷新令牌（退出登录）。 */
    public void deleteRefreshToken(String token, Long userId) {
        String owner = redis.opsForValue().get(REFRESH + token);
        if (owner != null && owner.equals(String.valueOf(userId))) {
            redis.delete(REFRESH + token);
            redis.opsForSet().remove(USER_REFRESH + userId, token);
        }
    }
}
