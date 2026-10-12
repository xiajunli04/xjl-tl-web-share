package com.xjl.tl;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableAsync;

/**
 * 译桥（LinguaBridge）业务后端启动类。
 */
@EnableAsync
@SpringBootApplication
public class TlApplication {

    public static void main(String[] args) {
        SpringApplication.run(TlApplication.class, args);
    }
}
