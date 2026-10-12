package com.xjl.tl.common;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.regex.Pattern;

/**
 * 链路追踪过滤器：沿用请求头 X-Trace-Id，否则生成新的；写入 MDC 与响应头。
 * 优先级最高，保证 Spring Security 返回的错误响应同样带 traceId。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TraceIdFilter extends OncePerRequestFilter {

    /** 仅接受安全字符，防止日志注入。 */
    private static final Pattern VALID = Pattern.compile("^[A-Za-z0-9_\\-]{1,64}$");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String traceId = request.getHeader(TraceIdHolder.HEADER);
        if (!StringUtils.hasText(traceId) || !VALID.matcher(traceId).matches()) {
            traceId = TraceIdHolder.generate();
        }
        TraceIdHolder.set(traceId);
        response.setHeader(TraceIdHolder.HEADER, traceId);
        try {
            chain.doFilter(request, response);
        } finally {
            TraceIdHolder.clear();
        }
    }
}
