package com.xjl.tl.module.interpret.ws;

import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.Result;
import com.xjl.tl.common.config.AppProperties;
import com.xjl.tl.module.interpret.service.WsTicketService;
import com.xjl.tl.module.interpret.service.WsTicketService.Ticket;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * 同传 WebSocket 握手拦截器（add-speech-and-image-translation D2，契约 §2.6）：
 * <ol>
 *   <li>携带 Origin 时必须在 WEB_ORIGIN（app.cors.allowed-origins）内，否则 403 + A0301；
 *       不带 Origin 时只校验票据：浏览器发起 WebSocket 一定带 Origin，缺失的只会是前端同源代理（web/src/proxy.ts
 *       把同源请求转成服务端调用并去掉 Origin，局域网访问即走这条路）或非浏览器客户端，后者本可伪造任意 Origin，
 *       校验对其没有意义。鉴权依赖一次性票据（需 Bearer 令牌经 REST 换取，不依赖 Cookie），与 REST 的 CORS 行为一致</li>
 *   <li>?ticket= 一次性票据（Redis GETDEL）有效，否则 401 + A0453；票据内容写入 WS 属性</li>
 * </ol>
 * 先校验 Origin，来源不合法的请求不会消耗票据。
 */
@Component
public class InterpretHandshakeInterceptor implements HandshakeInterceptor {

    public static final String ATTR_USER_ID = "interpret.userId";
    public static final String ATTR_SESSION_ID = "interpret.sessionId";
    public static final String ATTR_PARTICIPANT_ID = "interpret.participantId";
    private static final Logger log = LoggerFactory.getLogger(InterpretHandshakeInterceptor.class);

    private final WsTicketService ticketService;
    private final List<String> allowedOrigins;
    private final JsonMapper jsonMapper;

    public InterpretHandshakeInterceptor(WsTicketService ticketService, AppProperties props, JsonMapper jsonMapper) {
        this.ticketService = ticketService;
        this.allowedOrigins = props.cors() == null ? List.of() : props.cors().allowedOrigins().stream()
                .map(InterpretHandshakeInterceptor::normalize).toList();
        this.jsonMapper = jsonMapper;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler,
                                   Map<String, Object> attributes) throws IOException {
        String origin = request.getHeaders().getOrigin();
        if (!originAllowed(origin)) {
            log.info("同传握手被拒绝：Origin 不允许 {}", origin);
            reject(response, HttpStatus.FORBIDDEN, ErrorCode.ACCESS_DENIED, "连接来源不被允许");
            return false;
        }
        String raw = UriComponentsBuilder.fromUri(request.getURI()).build().getQueryParams().getFirst("ticket");
        Ticket ticket = ticketService.consume(raw == null ? null : URLDecoder.decode(raw, StandardCharsets.UTF_8));
        if (ticket == null) {
            log.info("同传握手被拒绝：票据无效或已使用");
            reject(response, HttpStatus.UNAUTHORIZED, ErrorCode.WS_TICKET_INVALID, ErrorCode.WS_TICKET_INVALID.getMessage());
            return false;
        }
        attributes.put(ATTR_USER_ID, ticket.userId());
        attributes.put(ATTR_SESSION_ID, ticket.sessionId());
        attributes.put(ATTR_PARTICIPANT_ID, ticket.participantId());
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler,
                               Exception exception) {
        // 无需处理
    }

    private boolean originAllowed(String origin) {
        if (origin == null || origin.isBlank()) {
            return true;  // 同源代理或非浏览器客户端：只校验票据（见类注释）
        }
        String o = normalize(origin);
        return allowedOrigins.contains("*") || allowedOrigins.contains(o);
    }

    private static String normalize(String origin) {
        String o = origin.trim();
        return o.endsWith("/") ? o.substring(0, o.length() - 1) : o;
    }

    private void reject(ServerHttpResponse response, HttpStatus status, ErrorCode code, String message) throws IOException {
        response.setStatusCode(status);
        response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        response.getBody().write(jsonMapper.writeValueAsBytes(Result.fail(code.getCode(), message, null)));
    }
}
