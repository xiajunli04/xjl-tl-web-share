package com.xjl.tl.common;

/**
 * 业务异常：携带错误码、提示文案与 HTTP 状态码。
 * 支持透传 AI 服务返回的未知错误码（见 design D9）。
 */
public class BizException extends RuntimeException {

    private final String code;
    private final int httpStatus;
    private final transient Object data;

    public BizException(ErrorCode errorCode) {
        this(errorCode, errorCode.getMessage());
    }

    public BizException(ErrorCode errorCode, String message) {
        this(errorCode.getCode(), message, errorCode.getHttpStatus(), null);
    }

    public BizException(ErrorCode errorCode, String message, Object data) {
        this(errorCode.getCode(), message, errorCode.getHttpStatus(), data);
    }

    public BizException(String code, String message, int httpStatus, Object data) {
        super(message);
        this.code = code;
        this.httpStatus = httpStatus;
        this.data = data;
    }

    public String getCode() {
        return code;
    }

    public int getHttpStatus() {
        return httpStatus;
    }

    public Object getData() {
        return data;
    }
}
