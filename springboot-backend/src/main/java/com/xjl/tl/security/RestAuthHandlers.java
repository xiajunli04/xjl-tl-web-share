package com.xjl.tl.security;

import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.Result;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.MediaType;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.jwt.JwtValidationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * 鉴权失败时输出统一 Result JSON：
 * 过期 → A0230，缺失/签名错误/已吊销 → A0231，角色不足 → A0301。
 */
@Component
public class RestAuthHandlers {

    private final JsonMapper jsonMapper;

    public RestAuthHandlers(JsonMapper jsonMapper) {
        this.jsonMapper = jsonMapper;
    }

    public AuthenticationEntryPoint entryPoint() {
        return (request, response, ex) -> write(response, isExpired(ex)
                ? ErrorCode.ACCESS_TOKEN_EXPIRED : ErrorCode.ACCESS_TOKEN_INVALID);
    }

    public AccessDeniedHandler accessDeniedHandler() {
        return (request, response, ex) -> write(response, ErrorCode.ACCESS_DENIED);
    }

    static boolean isExpired(AuthenticationException ex) {
        Throwable t = ex;
        while (t != null) {
            if (t instanceof JwtValidationException jve) {
                return jve.getErrors().stream().anyMatch(e -> TokenValidators.ERROR_EXPIRED.equals(e.getErrorCode()));
            }
            t = t.getCause();
        }
        return false;
    }

    private void write(HttpServletResponse response, ErrorCode code) throws IOException {
        response.setStatus(code.getHttpStatus());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write(jsonMapper.writeValueAsString(Result.fail(code)));
    }
}
