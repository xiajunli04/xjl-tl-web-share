package com.xjl.tl.common;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 仅用于测试全局约定的接口（位于测试源码，不进入生产包）。
 */
@RestController
@RequestMapping("/test-support")
public class ConventionTestController {

    private static final Logger log = LoggerFactory.getLogger(ConventionTestController.class);

    public record Form(@NotBlank(message = "名称不能为空") String name, @Email(message = "邮箱格式不正确") String email) {
    }

    @GetMapping("/ok")
    public Result<String> ok() {
        log.info("handling ok");
        return Result.ok("pong");
    }

    @GetMapping("/biz")
    public Result<Void> biz() {
        throw new BizException(ErrorCode.USERNAME_EXISTS);
    }

    @GetMapping("/npe")
    public Result<Void> npe() {
        String s = null;
        s.length();
        return Result.ok();
    }

    @GetMapping("/missing")
    public Result<Void> missing() {
        throw new BizException(ErrorCode.NOT_FOUND);
    }

    @PostMapping("/form")
    public Result<Form> form(@Valid @RequestBody Form form) {
        return Result.ok(form);
    }
}
