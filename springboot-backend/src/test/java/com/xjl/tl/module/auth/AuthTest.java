package com.xjl.tl.module.auth;

import com.nimbusds.jose.jwk.source.ImmutableSecret;
import com.xjl.tl.security.JwtService;
import com.xjl.tl.security.TokenRevocationService;
import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * user-auth：注册、登录、限流、刷新、令牌校验、退出与强制下线、当前用户。
 */
class AuthTest extends IntegrationTestBase {

    private static final String PWD = "Passw0rd1";

    @Autowired
    private JwtEncoder jwtEncoder;
    @Autowired
    private TokenRevocationService revocationService;

    // ---------------- 注册 ----------------

    @Test
    void registerSuccessReturnsUserInfoWithUserRole() throws Exception {
        String name = uniqueName("reg");
        MvcResult r = postJson("/api/auth/register", Map.of("username", name, "password", PWD, "nickname", "小李"), null);
        JsonNode b = body(r);
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        assertThat(b.path("code").asString()).isEqualTo("00000");
        JsonNode data = b.get("data");
        assertThat(data.path("username").asString()).isEqualTo(name);
        assertThat(data.path("nickname").asString()).isEqualTo("小李");
        assertThat(data.path("status").asString()).isEqualTo("ENABLED");
        assertThat(data.path("roles").get(0).asString()).isEqualTo("USER");
        assertThat(data.path("roles").size()).isEqualTo(1);
        assertThat(data.has("passwordHash")).isFalse();
        assertThat(r.getResponse().getContentAsString()).doesNotContain("$2a$");
        String hash = jdbcTemplate.queryForObject("SELECT password_hash FROM biz.sys_user WHERE username = ?", String.class, name);
        assertThat(hash).startsWith("$2a$").isNotEqualTo(PWD);
    }

    @Test
    void registerDuplicateUsernameReturns409() throws Exception {
        String name = registerUser(uniqueName("dup"), PWD);
        MvcResult r = postJson("/api/auth/register", Map.of("username", name, "password", PWD), null);
        assertThat(r.getResponse().getStatus()).isEqualTo(409);
        assertThat(body(r).path("code").asString()).isEqualTo("A0111");
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM biz.sys_user WHERE username = ?", Integer.class, name))
                .isEqualTo(1);
    }

    @Test
    void registerWeakPasswordReturnsA0410WithPasswordField() throws Exception {
        for (String weak : List.of("short1a", "allletters", "12345678")) {
            String name = uniqueName("weak");
            MvcResult r = postJson("/api/auth/register", Map.of("username", name, "password", weak), null);
            JsonNode b = body(r);
            assertThat(r.getResponse().getStatus()).isEqualTo(400);
            assertThat(b.path("code").asString()).isEqualTo("A0410");
            assertThat(b.path("data").get(0).path("field").asString()).isEqualTo("password");
            assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM biz.sys_user WHERE username = ?", Integer.class, name))
                    .isZero();
        }
    }

    // ---------------- 登录 ----------------

    @Test
    void loginSuccessIssuesTokensAndWritesLog() throws Exception {
        String name = registerUser(uniqueName("login"), PWD);
        JsonNode data = login(name, PWD);
        assertThat(data.path("accessToken").asString()).isNotBlank();
        assertThat(data.path("refreshToken").asString()).isNotBlank();
        assertThat(data.path("expiresIn").asLong()).isEqualTo(7200);
        assertThat(data.path("user").path("username").asString()).isEqualTo(name);
        assertThat(data.path("user").path("roles").get(0).asString()).isEqualTo("USER");
        assertThat(data.path("user").path("lastLoginAt").isNull()).isFalse();
        await(() -> countLoginLogs(name, true) == 1);
    }

    @Test
    void wrongPasswordAndUnknownUserReturnSameA0201() throws Exception {
        String name = registerUser(uniqueName("cred"), PWD);
        String unknown = uniqueName("nobody");
        MvcResult wrongPwd = postJson("/api/auth/login", Map.of("username", name, "password", "Wrong1234"), null);
        MvcResult noUser = postJson("/api/auth/login", Map.of("username", unknown, "password", PWD), null);
        for (MvcResult r : List.of(wrongPwd, noUser)) {
            assertThat(r.getResponse().getStatus()).isEqualTo(401);
            assertThat(body(r).path("code").asString()).isEqualTo("A0201");
        }
        assertThat(body(wrongPwd).path("message").asString()).isEqualTo(body(noUser).path("message").asString());
        await(() -> countLoginLogs(name, false) == 1 && countLoginLogs(unknown, false) == 1);
    }

    @Test
    void disabledAccountReturnsA0202WithoutTokens() throws Exception {
        String name = registerUser(uniqueName("dis"), PWD);
        jdbcTemplate.update("UPDATE biz.sys_user SET status = 'DISABLED' WHERE username = ?", name);
        MvcResult r = postJson("/api/auth/login", Map.of("username", name, "password", PWD), null);
        assertThat(r.getResponse().getStatus()).isEqualTo(403);
        JsonNode b = body(r);
        assertThat(b.path("code").asString()).isEqualTo("A0202");
        assertThat(b.get("data").isNull()).isTrue();
    }

    // ---------------- 限流 ----------------

    @Test
    void fiveFailuresLockEvenWithCorrectPassword() throws Exception {
        String name = registerUser(uniqueName("lock"), PWD);
        for (int i = 0; i < 5; i++) {
            MvcResult r = postJson("/api/auth/login", Map.of("username", name, "password", "Wrong1234"), null);
            assertThat(body(r).path("code").asString()).isEqualTo("A0201");
        }
        MvcResult r = postJson("/api/auth/login", Map.of("username", name, "password", PWD), null);
        assertThat(r.getResponse().getStatus()).isEqualTo(429);
        assertThat(body(r).path("code").asString()).isEqualTo("A0211");
        Long ttl = redis.getExpire("auth:login-fail:" + name.toLowerCase());
        assertThat(ttl).isPositive().isLessThanOrEqualTo(15 * 60);
    }

    @Test
    void successfulLoginResetsFailureCounter() throws Exception {
        String name = registerUser(uniqueName("reset"), PWD);
        for (int i = 0; i < 4; i++) {
            postJson("/api/auth/login", Map.of("username", name, "password", "Wrong1234"), null);
        }
        login(name, PWD);
        assertThat(redis.hasKey("auth:login-fail:" + name.toLowerCase())).isFalse();
        // 计数清零后再错 4 次仍不会被锁
        for (int i = 0; i < 4; i++) {
            postJson("/api/auth/login", Map.of("username", name, "password", "Wrong1234"), null);
        }
        login(name, PWD);
    }

    // ---------------- 刷新 ----------------

    @Test
    void refreshRotatesTokens() throws Exception {
        String name = registerUser(uniqueName("ref"), PWD);
        JsonNode first = login(name, PWD);
        String oldRefresh = first.path("refreshToken").asString();
        MvcResult r = postJson("/api/auth/refresh", Map.of("refreshToken", oldRefresh), null);
        JsonNode data = body(r).get("data");
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        assertThat(data.path("refreshToken").asString()).isNotBlank().isNotEqualTo(oldRefresh);
        assertThat(data.path("accessToken").asString()).isNotBlank();
        assertThat(redis.hasKey("auth:refresh:" + oldRefresh)).isFalse();
        // 新访问令牌可用
        MvcResult me = perform(bearer(get("/api/auth/me"), data.path("accessToken").asString()));
        assertThat(me.getResponse().getStatus()).isEqualTo(200);
    }

    @Test
    void reusedOrUnknownRefreshTokenReturnsA0232() throws Exception {
        String name = registerUser(uniqueName("reuse"), PWD);
        String refresh = login(name, PWD).path("refreshToken").asString();
        postJson("/api/auth/refresh", Map.of("refreshToken", refresh), null);
        MvcResult reused = postJson("/api/auth/refresh", Map.of("refreshToken", refresh), null);
        assertThat(reused.getResponse().getStatus()).isEqualTo(401);
        assertThat(body(reused).path("code").asString()).isEqualTo("A0232");
        MvcResult unknown = postJson("/api/auth/refresh", Map.of("refreshToken", "not-a-token"), null);
        assertThat(body(unknown).path("code").asString()).isEqualTo("A0232");
    }

    // ---------------- 访问令牌校验 ----------------

    @Test
    void expiredTokenReturnsA0230() throws Exception {
        Instant past = Instant.now().minusSeconds(3 * 3600);
        JwtClaimsSet claims = JwtClaimsSet.builder().subject("1").claim(JwtService.CLAIM_USERNAME, "admin")
                .claim(JwtService.CLAIM_ROLES, List.of("ADMIN")).id(UUID.randomUUID().toString())
                .issuedAt(past).expiresAt(past.plusSeconds(7200)).build();
        String token = jwtEncoder.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims))
                .getTokenValue();
        MvcResult r = perform(bearer(get("/api/auth/me"), token));
        assertThat(r.getResponse().getStatus()).isEqualTo(401);
        assertThat(body(r).path("code").asString()).isEqualTo("A0230");
    }

    @Test
    void wrongSignatureReturnsA0231() throws Exception {
        NimbusJwtEncoder other = new NimbusJwtEncoder(new ImmutableSecret<>(new SecretKeySpec(
                "another-secret-another-secret-another-secret".getBytes(StandardCharsets.UTF_8), "HmacSHA256")));
        Instant now = Instant.now();
        JwtClaimsSet claims = JwtClaimsSet.builder().subject("1").claim(JwtService.CLAIM_ROLES, List.of("ADMIN"))
                .id(UUID.randomUUID().toString()).issuedAt(now).expiresAt(now.plusSeconds(600)).build();
        String token = other.encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims))
                .getTokenValue();
        MvcResult r = perform(bearer(get("/api/auth/me"), token));
        assertThat(r.getResponse().getStatus()).isEqualTo(401);
        assertThat(body(r).path("code").asString()).isEqualTo("A0231");
        MvcResult garbage = perform(bearer(get("/api/auth/me"), "not.a.jwt"));
        assertThat(body(garbage).path("code").asString()).isEqualTo("A0231");
    }

    @Test
    void missingTokenReturnsA0231() throws Exception {
        MvcResult r = perform(get("/api/auth/me"));
        assertThat(r.getResponse().getStatus()).isEqualTo(401);
        assertThat(body(r).path("code").asString()).isEqualTo("A0231");
    }

    @Test
    void userRoleAccessingAdminApiReturnsA0301() throws Exception {
        String name = registerUser(uniqueName("plain"), PWD);
        String token = accessToken(name, PWD);
        for (String url : List.of("/api/admin/users", "/api/admin/model-configs", "/api/admin/logs/login")) {
            MvcResult r = perform(bearer(get(url), token));
            assertThat(r.getResponse().getStatus()).isEqualTo(403);
            assertThat(body(r).path("code").asString()).isEqualTo("A0301");
        }
    }

    // ---------------- 退出与吊销 ----------------

    @Test
    void logoutRevokesAccessAndRefreshToken() throws Exception {
        String name = registerUser(uniqueName("out"), PWD);
        JsonNode data = login(name, PWD);
        String access = data.path("accessToken").asString();
        String refresh = data.path("refreshToken").asString();
        MvcResult out = postJson("/api/auth/logout", Map.of("refreshToken", refresh), access);
        assertThat(body(out).path("code").asString()).isEqualTo("00000");
        MvcResult me = perform(bearer(get("/api/auth/me"), access));
        assertThat(me.getResponse().getStatus()).isEqualTo(401);
        assertThat(body(me).path("code").asString()).isEqualTo("A0231");
        assertThat(redis.hasKey("auth:refresh:" + refresh)).isFalse();
        MvcResult reuse = postJson("/api/auth/refresh", Map.of("refreshToken", refresh), null);
        assertThat(body(reuse).path("code").asString()).isEqualTo("A0232");
    }

    @Test
    void revokeAllForUserInvalidatesOldTokens() throws Exception {
        String name = registerUser(uniqueName("revoke"), PWD);
        JsonNode data = login(name, PWD);
        long userId = data.path("user").path("id").asLong();
        revocationService.revokeAllForUser(userId);
        MvcResult me = perform(bearer(get("/api/auth/me"), data.path("accessToken").asString()));
        assertThat(body(me).path("code").asString()).isEqualTo("A0231");
        MvcResult refresh = postJson("/api/auth/refresh", Map.of("refreshToken", data.path("refreshToken").asString()), null);
        assertThat(body(refresh).path("code").asString()).isEqualTo("A0232");
        // 吊销之后新签发的令牌不受影响
        String fresh = accessToken(name, PWD);
        assertThat(perform(bearer(get("/api/auth/me"), fresh)).getResponse().getStatus()).isEqualTo(200);
    }

    // ---------------- 当前用户 ----------------

    @Test
    void meReturnsCurrentUserWithoutPasswordHash() throws Exception {
        String name = registerUser(uniqueName("me"), PWD);
        MvcResult r = perform(bearer(get("/api/auth/me"), accessToken(name, PWD)));
        JsonNode data = body(r).get("data");
        assertThat(data.path("username").asString()).isEqualTo(name);
        assertThat(data.path("roles").get(0).asString()).isEqualTo("USER");
        assertThat(data.has("id")).isTrue();
        assertThat(data.has("email")).isTrue();
        assertThat(data.has("lastLoginAt")).isTrue();
        assertThat(data.has("passwordHash")).isFalse();
        assertThat(r.getResponse().getContentAsString()).doesNotContain("$2a$");
    }

    private int countLoginLogs(String username, boolean success) {
        Integer n = jdbcTemplate.queryForObject("SELECT count(*) FROM biz.login_log WHERE username = ? AND success = ?",
                Integer.class, username, success);
        return n == null ? 0 : n;
    }
}
