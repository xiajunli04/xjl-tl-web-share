package com.xjl.tl.module.session.service;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.config.TranslateProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 会话级 Redis 锁（design Risks「pending 追问与并发请求冲突」）：同一会话同一时间只允许一个进行中的
 * 翻译、修订或追问恢复。SET NX + 过期时间（翻译总超时 + 1 分钟，进程异常退出也能自动释放）；
 * 释放时比对令牌，避免误删过期后被他人重新获取的锁。冲突返回 409 + A0214。
 */
@Component
public class SessionLock {

    static final String KEY = "lock:session:";
    private static final Logger log = LoggerFactory.getLogger(SessionLock.class);
    private static final RedisScript<Long> RELEASE = new DefaultRedisScript<>(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            Long.class);

    private final StringRedisTemplate redis;
    private final Duration ttl;

    public SessionLock(StringRedisTemplate redis, TranslateProperties props) {
        this.redis = redis;
        this.ttl = props.timeout().plusMinutes(1);
    }

    /** 获取会话锁，已被占用时抛出 A0214。 */
    public Handle acquire(long sessionId) {
        String key = KEY + sessionId;
        String token = UUID.randomUUID().toString();
        Boolean ok = redis.opsForValue().setIfAbsent(key, token, ttl);
        if (!Boolean.TRUE.equals(ok)) {
            throw new BizException(ErrorCode.SESSION_BUSY);
        }
        return new Handle(key, token);
    }

    /** 已获取的锁；release 幂等，失败只记日志（锁会自动过期）。 */
    public final class Handle {
        private final String key;
        private final String token;
        private final AtomicBoolean released = new AtomicBoolean();

        private Handle(String key, String token) {
            this.key = key;
            this.token = token;
        }

        public void release() {
            if (!released.compareAndSet(false, true)) {
                return;
            }
            try {
                redis.execute(RELEASE, List.of(key), token);
            } catch (RuntimeException e) {
                log.warn("释放会话锁失败 key={}：{}", key, e.toString());
            }
        }
    }
}
