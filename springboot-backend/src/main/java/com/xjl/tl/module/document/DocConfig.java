package com.xjl.tl.module.document;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * 文档翻译模块配置：绑定 app.doc.*，启用定时任务（失联检测、周期性认领 pending 事件）。
 */
@Configuration
@EnableScheduling
@EnableConfigurationProperties(DocProperties.class)
public class DocConfig {
}
