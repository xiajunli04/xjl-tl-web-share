package com.xjl.tl.common;

import org.slf4j.MDC;

import java.util.UUID;

/**
 * traceId 工具：统一存放在 MDC 中，日志与响应体共用。
 */
public final class TraceIdHolder {

    public static final String MDC_KEY = "traceId";
    public static final String HEADER = "X-Trace-Id";

    private TraceIdHolder() {
    }

    public static String get() {
        return MDC.get(MDC_KEY);
    }

    public static void set(String traceId) {
        MDC.put(MDC_KEY, traceId);
    }

    public static void clear() {
        MDC.remove(MDC_KEY);
    }

    public static String generate() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 16);
    }
}
