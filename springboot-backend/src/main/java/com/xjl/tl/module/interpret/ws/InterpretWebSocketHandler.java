package com.xjl.tl.module.interpret.ws;

import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.module.interpret.room.RoomRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 浏览器同传 WebSocket（/ws/interpret，add-speech-and-image-translation D1 / D7，契约 §2.6）：原生 WebSocketHandler，
 * 二进制帧为 PCM16LE 16 kHz 单声道音频，文本帧为 JSON 控制帧（ptt / flush / mute / end / ping）。
 * 只做转发与路由（交给 {@link RoomRegistry}），不做阻塞操作；发送经 ConcurrentWebSocketSessionDecorator 串行化。
 */
@Component
public class InterpretWebSocketHandler extends AbstractWebSocketHandler {

    /** 单帧上限：契约要求 ≤ 32 KB，这里留出余量。 */
    static final int MAX_MESSAGE_BYTES = 64 * 1024;
    static final int SEND_TIME_LIMIT_MS = 10_000;
    /** 发送缓冲上限（约 60 秒的 24 kHz PCM base64 音频），超出时丢弃最旧的消息。 */
    static final int SEND_BUFFER_LIMIT = 4 * 1024 * 1024;
    static final String PONG = "{\"type\":\"pong\"}";
    private static final Logger log = LoggerFactory.getLogger(InterpretWebSocketHandler.class);

    private final RoomRegistry registry;
    private final JsonMapper jsonMapper;
    /** 原始会话 id → 串行化发送的装饰器。 */
    private final Map<String, WebSocketSession> decorated = new ConcurrentHashMap<>();

    public InterpretWebSocketHandler(RoomRegistry registry, JsonMapper jsonMapper) {
        this.registry = registry;
        this.jsonMapper = jsonMapper;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        session.setBinaryMessageSizeLimit(MAX_MESSAGE_BYTES);
        session.setTextMessageSizeLimit(MAX_MESSAGE_BYTES);
        WebSocketSession ws = new ConcurrentWebSocketSessionDecorator(session, SEND_TIME_LIMIT_MS, SEND_BUFFER_LIMIT,
                ConcurrentWebSocketSessionDecorator.OverflowStrategy.DROP);
        decorated.put(session.getId(), ws);
        Map<String, Object> attrs = session.getAttributes();
        Long userId = (Long) attrs.get(InterpretHandshakeInterceptor.ATTR_USER_ID);
        Long sessionId = (Long) attrs.get(InterpretHandshakeInterceptor.ATTR_SESSION_ID);
        String participantId = (String) attrs.get(InterpretHandshakeInterceptor.ATTR_PARTICIPANT_ID);
        if (userId == null || sessionId == null || participantId == null
                || !registry.attach(ws, sessionId, participantId, userId)) {
            ObjectNode e = jsonMapper.createObjectNode();
            e.put("type", "error");
            e.put("code", ErrorCode.ROOM_NOT_FOUND.getCode());
            e.put("message", "同传会话不存在或已结束");
            e.put("fatal", true);
            ws.sendMessage(new TextMessage(jsonMapper.writeValueAsString(e)));
            ws.close(new CloseStatus(4404, "session not found"));
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        WebSocketSession ws = decorated.getOrDefault(session.getId(), session);
        JsonNode node;
        try {
            node = jsonMapper.readTree(message.getPayload());
        } catch (RuntimeException e) {
            node = null;
        }
        if (!(node instanceof ObjectNode msg)) {
            ObjectNode e = jsonMapper.createObjectNode();
            e.put("type", "error");
            e.put("code", ErrorCode.PARAM_INVALID.getCode());
            e.put("message", "控制帧必须是 JSON 对象");
            e.put("fatal", false);
            ws.sendMessage(new TextMessage(jsonMapper.writeValueAsString(e)));
            return;
        }
        if ("ping".equals(msg.path("type").asString(""))) {
            ws.sendMessage(new TextMessage(PONG));
            return;
        }
        registry.onControl(session.getId(), msg);
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        registry.onAudio(session.getId(), message.getPayload());
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.debug("同传 WebSocket 传输错误 ws={}：{}", session.getId(), exception.toString());
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        decorated.remove(session.getId());
        registry.detach(session.getId());
    }
}
