package com.xjl.tl.module.interpret.ws;

import com.xjl.tl.common.config.AppProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * 注册同传 WebSocket 端点 /ws/interpret（add-speech-and-image-translation D1 / D2）。
 * 鉴权与 Origin 校验在 {@link InterpretHandshakeInterceptor} 中完成；Spring 自带的同源检查使用相同的允许来源。
 */
@Configuration
@EnableWebSocket
public class InterpretWebSocketConfig implements WebSocketConfigurer {

    public static final String PATH = "/ws/interpret";

    private final InterpretWebSocketHandler handler;
    private final InterpretHandshakeInterceptor interceptor;
    private final AppProperties props;

    public InterpretWebSocketConfig(InterpretWebSocketHandler handler, InterpretHandshakeInterceptor interceptor,
                                    AppProperties props) {
        this.handler = handler;
        this.interceptor = interceptor;
        this.props = props;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, PATH)
                .addInterceptors(interceptor)
                .setAllowedOriginPatterns(props.cors().allowedOrigins().toArray(String[]::new));
    }
}
