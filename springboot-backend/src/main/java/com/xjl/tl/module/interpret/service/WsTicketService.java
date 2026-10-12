package com.xjl.tl.module.interpret.service;

import com.xjl.tl.common.config.MediaProperties;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

import java.security.SecureRandom;
import java.util.Base64;

/**
 * WebSocket 一次性票据（add-speech-and-image-translation D2）：32 字节随机串（base64url），
 * Redis 键 ws:ticket:{t} → {userId, sessionId, participantId}，TTL 为 app.media.ws-ticket-ttl；
 * 握手时 GETDEL 读取并作废，重复使用或过期均视为无效。
 */
@Service
public class WsTicketService {

    static final String KEY = "ws:ticket:";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final StringRedisTemplate redis;
    private final MediaProperties props;
    private final JsonMapper jsonMapper;

    public WsTicketService(StringRedisTemplate redis, MediaProperties props, JsonMapper jsonMapper) {
        this.redis = redis;
        this.props = props;
        this.jsonMapper = jsonMapper;
    }

    /** 票据内容。 */
    public record Ticket(Long userId, Long sessionId, String participantId) {
    }

    /** 签发票据。 */
    public String issue(Long userId, Long sessionId, String participantId) {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        redis.opsForValue().set(KEY + token, jsonMapper.writeValueAsString(new Ticket(userId, sessionId, participantId)),
                props.wsTicketTtl());
        return token;
    }

    /** 读取并作废票据；不存在、已使用、已过期或格式错误时返回 null。 */
    public Ticket consume(String token) {
        if (token == null || token.isBlank() || token.length() > 128) {
            return null;
        }
        String json = redis.opsForValue().getAndDelete(KEY + token);
        if (json == null) {
            return null;
        }
        try {
            Ticket t = jsonMapper.readValue(json, Ticket.class);
            return t.userId() == null || t.sessionId() == null || t.participantId() == null ? null : t;
        } catch (RuntimeException e) {
            return null;
        }
    }
}
