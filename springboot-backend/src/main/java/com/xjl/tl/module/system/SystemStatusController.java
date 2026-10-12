package com.xjl.tl.module.system;

import com.xjl.tl.common.Result;
import com.xjl.tl.infra.ai.AiServiceHealthChecker;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.Status;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

@Tag(name = "系统状态", description = "Spring / PostgreSQL / Redis / AI 服务健康状态（仅管理员）")
@RestController
@RequestMapping("/api/admin/system")
public class SystemStatusController {

    private final JdbcTemplate jdbcTemplate;
    private final StringRedisTemplate redisTemplate;
    private final AiServiceHealthChecker aiServiceHealth;

    public SystemStatusController(JdbcTemplate jdbcTemplate, StringRedisTemplate redisTemplate,
                                  AiServiceHealthChecker aiServiceHealth) {
        this.jdbcTemplate = jdbcTemplate;
        this.redisTemplate = redisTemplate;
        this.aiServiceHealth = aiServiceHealth;
    }

    @Operation(summary = "查询系统各组件健康状态")
    @GetMapping("/status")
    public Result<SystemStatus> status() {
        List<StatusItem> items = new ArrayList<>();
        items.add(new StatusItem("spring", "UP", null));
        items.add(probe("postgres", () -> jdbcTemplate.queryForObject("select 1", Integer.class)));
        items.add(probe("redis", () -> redisTemplate.execute((org.springframework.data.redis.core.RedisCallback<String>) c -> c.ping())));
        Health ai = aiServiceHealth.health();
        items.add(new StatusItem("ai-service", Status.UP.equals(ai.getStatus()) ? "UP" : "DOWN",
                String.valueOf(ai.getDetails())));
        return Result.ok(new SystemStatus(items));
    }

    private static StatusItem probe(String name, Supplier<?> check) {
        try {
            check.get();
            return new StatusItem(name, "UP", null);
        } catch (RuntimeException e) {
            return new StatusItem(name, "DOWN", e.getClass().getSimpleName());
        }
    }

    public record SystemStatus(List<StatusItem> items) {
    }

    public record StatusItem(String name, String status, String detail) {
    }
}
