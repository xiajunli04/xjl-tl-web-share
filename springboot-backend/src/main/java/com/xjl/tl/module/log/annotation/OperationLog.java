package com.xjl.tl.module.log.annotation;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 标注需要记录操作日志的管理员写操作（见 design D11）。
 */
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
@Documented
public @interface OperationLog {

    /** 模块，如"用户管理"。 */
    String module();

    /** 动作，如"禁用用户"。 */
    String action();
}
