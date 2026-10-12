package com.xjl.tl.common;

/**
 * 统一响应信封：{code, message, data, traceId}。
 */
public record Result<T>(String code, String message, T data, String traceId) {

    public static <T> Result<T> ok(T data) {
        return new Result<>(ErrorCode.SUCCESS.getCode(), ErrorCode.SUCCESS.getMessage(), data, TraceIdHolder.get());
    }

    public static <T> Result<T> ok() {
        return ok(null);
    }

    public static <T> Result<T> fail(ErrorCode errorCode) {
        return fail(errorCode.getCode(), errorCode.getMessage(), null);
    }

    public static <T> Result<T> fail(String code, String message, T data) {
        return new Result<>(code, message, data, TraceIdHolder.get());
    }

    /** 是否成功。 */
    public boolean success() {
        return ErrorCode.SUCCESS.getCode().equals(code);
    }
}
