package com.xjl.tl.infra.ai;

import org.springframework.boot.health.contributor.Health;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * Python AI 服务健康探测：调用 /internal/health，不可达时为 DOWN。
 * 刻意不实现 actuator 的 HealthIndicator：AI 服务故障不应让 Spring 自身的存活/就绪探针失败，
 * 只在管理后台「系统状态」中汇总展示。
 */
@Component
public class AiServiceHealthChecker {

    private final AiServiceClient client;

    public AiServiceHealthChecker(AiServiceClient client) {
        this.client = client;
    }

    public Health health() {
        try {
            JsonNode data = client.health();
            String db = data.path("db").asString("UNKNOWN");
            return Health.up().withDetail("db", db).withDetail("version", data.path("version").asString("")).build();
        } catch (RuntimeException e) {
            return Health.down().withDetail("error", e.getMessage()).build();
        }
    }
}
