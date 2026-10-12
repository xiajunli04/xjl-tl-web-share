package com.xjl.tl.module.translate.service;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;

/**
 * 按用户的 Redis 固定窗口限流（见 design D8）：rate:{kind}:{userId}:{epochMinute}。
 * 计数在窗口内首次请求时设置过期时间；超限抛出 A0212（HTTP 429）。
 */
@Component
public class TranslateRateLimiter {

    public static final String TRANSLATE = "translate";
    public static final String DETECT = "detect";
    static final String KEY = "rate:";
    private static final Duration KEY_TTL = Duration.ofSeconds(120);

    private final StringRedisTemplate redis;
    private final Clock clock;

    public TranslateRateLimiter(StringRedisTemplate redis) {
        this.redis = redis;
        this.clock = Clock.systemUTC();
    }

    /** 计数 +1，超过 limitPerMinute 时抛出 A0212。 */
    public void acquire(String kind, Long userId, int limitPerMinute, String message) {
        long epochMinute = clock.millis() / 60_000L;
        String key = KEY + kind + ":" + userId + ":" + epochMinute;
        Long count = redis.opsForValue().increment(key);
        if (count != null && count == 1L) {
            redis.expire(key, KEY_TTL);
        }
        if (count != null && count > limitPerMinute) {
            throw new BizException(ErrorCode.TOO_MANY_REQUESTS, message);
        }
    }
}
