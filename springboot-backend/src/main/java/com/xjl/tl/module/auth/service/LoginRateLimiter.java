package com.xjl.tl.module.auth.service;

import com.xjl.tl.common.config.AppProperties;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.util.Locale;

/**
 * 登录失败限流：auth:login-fail:{username}，窗口期内失败达到阈值即锁定（见 design D3）。
 * 计数在首次失败时设置过期时间，窗口期满后自动解锁。
 */
@Component
public class LoginRateLimiter {

    static final String KEY = "auth:login-fail:";

    private final StringRedisTemplate redis;
    private final AppProperties.Security config;

    public LoginRateLimiter(StringRedisTemplate redis, AppProperties props) {
        this.redis = redis;
        this.config = props.security();
    }

    public boolean isLocked(String username) {
        String v = redis.opsForValue().get(key(username));
        return v != null && Long.parseLong(v) >= config.loginMaxFailures();
    }

    public void recordFailure(String username) {
        String key = key(username);
        Long count = redis.opsForValue().increment(key);
        if (count != null && count == 1L) {
            redis.expire(key, config.loginFailWindow());
        }
    }

    public void reset(String username) {
        redis.delete(key(username));
    }

    private static String key(String username) {
        return KEY + username.toLowerCase(Locale.ROOT);
    }
}
