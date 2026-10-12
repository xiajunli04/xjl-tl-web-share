package com.xjl.tl.support;

import com.xjl.tl.common.ErrorCode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * 集成测试基类：共享 PostgreSQL(pgvector) 与 Redis 容器（只使用本地已有镜像）。
 * 应用以 tl_app 身份连库并执行 Flyway，与真实环境一致。
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
public abstract class IntegrationTestBase {

    public static final String ADMIN_USERNAME = "admin";
    public static final String ADMIN_PASSWORD = "Admin123456";

    protected static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
            DockerImageName.parse("pgvector/pgvector:pg17").asCompatibleSubstituteFor("postgres"))
            .withDatabaseName("xjl_tl")
            .withUsername("postgres")
            .withPassword("postgres")
            .withInitScript("db/init-test.sql");

    @SuppressWarnings("resource")
    protected static final GenericContainer<?> REDIS = new GenericContainer<>(DockerImageName.parse("redis:7-alpine"))
            .withExposedPorts(6379);

    private static final AtomicInteger SEQ = new AtomicInteger();

    static {
        POSTGRES.start();
        REDIS.start();
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", () -> withSchema(POSTGRES.getJdbcUrl()));
        r.add("spring.datasource.username", () -> "tl_app");
        r.add("spring.datasource.password", () -> "tl_app_pwd");
        r.add("spring.data.redis.host", REDIS::getHost);
        r.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
        r.add("app.admin.username", () -> ADMIN_USERNAME);
        r.add("app.admin.password", () -> ADMIN_PASSWORD);
    }

    protected static String withSchema(String jdbcUrl) {
        return jdbcUrl + (jdbcUrl.contains("?") ? "&" : "?") + "currentSchema=biz,public";
    }

    @Autowired
    protected MockMvc mockMvc;
    @Autowired
    protected JsonMapper jsonMapper;
    @Autowired
    protected JdbcTemplate jdbcTemplate;
    @Autowired
    protected StringRedisTemplate redis;

    @BeforeEach
    void flushRedis() {
        redis.execute((org.springframework.data.redis.core.RedisCallback<Object>) c -> {
            c.serverCommands().flushDb();
            return null;
        });
    }

    /** 评审模型是全局状态（影响文档任务与短文本的评审模型解析）：每个用例结束后清除，避免用例之间互相影响。 */
    @AfterEach
    void clearReviewModel() {
        jdbcTemplate.update("UPDATE biz.model_config SET is_review_default = false WHERE is_review_default");
    }

    /** 插入一个模型配置（不经过接口，密钥为占位密文），返回 id。 */
    protected long insertModelConfig(String name, boolean enabled) {
        return jdbcTemplate.queryForObject("""
                INSERT INTO biz.model_config (name, provider, base_url, model_name, api_key_cipher, api_key_mask, enabled)
                VALUES (?, 'OPENAI_COMPATIBLE', 'https://x', 'm', 'v1:x', '****', ?) RETURNING id""", Long.class,
                name, enabled);
    }

    /** 生成唯一用户名（4-32 位字母数字下划线）。 */
    protected static String uniqueName(String prefix) {
        return prefix + "_" + System.nanoTime() % 1_000_000 + SEQ.incrementAndGet();
    }

    protected String json(Object o) {
        return jsonMapper.writeValueAsString(o);
    }

    protected JsonNode body(MvcResult r) throws Exception {
        return jsonMapper.readTree(r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8));
    }

    protected MvcResult perform(MockHttpServletRequestBuilder req) throws Exception {
        return mockMvc.perform(req).andReturn();
    }

    protected MvcResult postJson(String url, Object payload, String token) throws Exception {
        MockHttpServletRequestBuilder b = post(url).contentType(MediaType.APPLICATION_JSON).content(json(payload));
        if (token != null) {
            b.header("Authorization", "Bearer " + token);
        }
        return perform(b);
    }

    protected MockHttpServletRequestBuilder bearer(MockHttpServletRequestBuilder b, String token) {
        return b.header("Authorization", "Bearer " + token);
    }

    protected MockHttpServletRequestBuilder jsonBody(MockHttpServletRequestBuilder b, Object payload) {
        return b.contentType(MediaType.APPLICATION_JSON).content(json(payload));
    }

    /** 注册一个普通用户并返回用户名。 */
    protected String registerUser(String username, String password) throws Exception {
        MvcResult r = postJson("/api/auth/register", Map.of("username", username, "password", password), null);
        if (r.getResponse().getStatus() != 200) {
            throw new IllegalStateException("注册失败：" + r.getResponse().getContentAsString());
        }
        return username;
    }

    /** 登录并返回 data 节点。 */
    protected JsonNode login(String username, String password) throws Exception {
        MvcResult r = postJson("/api/auth/login", Map.of("username", username, "password", password), null);
        JsonNode b = body(r);
        if (!ErrorCode.SUCCESS.getCode().equals(b.path("code").asString())) {
            throw new IllegalStateException("登录失败：" + b);
        }
        return b.get("data");
    }

    protected String accessToken(String username, String password) throws Exception {
        return login(username, password).get("accessToken").asString();
    }

    protected String adminToken() throws Exception {
        return accessToken(ADMIN_USERNAME, ADMIN_PASSWORD);
    }

    /** 等待异步结果（日志异步写库）。 */
    protected static void await(BooleanSupplier condition) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("等待超时");
    }
}
