package com.xjl.tl.common;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.util.StringUtils;

/**
 * 请求相关工具。
 */
public final class RequestUtils {

    private RequestUtils() {
    }

    /** 客户端 IP：优先取 X-Forwarded-For 的第一个地址。 */
    public static String clientIp(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        if (StringUtils.hasText(xff)) {
            return truncate(xff.split(",")[0].trim(), 64);
        }
        return truncate(request.getRemoteAddr(), 64);
    }

    public static String truncate(String s, int max) {
        if (s == null || s.length() <= max) {
            return s;
        }
        return s.substring(0, max);
    }
}
