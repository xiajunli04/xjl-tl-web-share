package com.xjl.tl.common;

import java.util.List;

/**
 * 参数校验失败时的字段错误项（A0410 的 data 元素）。
 */
public record FieldError(String field, String message) {

    /** 构造单字段的参数错误异常。 */
    public static BizException invalid(String field, String message) {
        return new BizException(ErrorCode.PARAM_INVALID, message, List.of(new FieldError(field, message)));
    }
}
