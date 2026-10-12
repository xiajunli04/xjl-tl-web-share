package com.xjl.tl.module.user;

import com.xjl.tl.module.user.service.AdminBootstrapRunner;
import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * user-management：初始管理员、管理员用户管理、个人资料与密码修改。
 */
class UserManagementTest extends IntegrationTestBase {

    private static final String PWD = "Passw0rd1";

    @Autowired
    private AdminBootstrapRunner bootstrapRunner;

    // ---------------- 初始管理员 ----------------

    @Test
    void adminBootstrapCreatesOnlyOnce() throws Exception {
        // 应用启动时已创建一次；再次执行不会重复创建
        assertThat(bootstrapRunner.bootstrap()).isFalse();
        assertThat(bootstrapRunner.bootstrap()).isFalse();
        Integer admins = jdbcTemplate.queryForObject("""
                SELECT count(*) FROM biz.sys_user u JOIN biz.sys_user_role ur ON ur.user_id = u.id
                JOIN biz.sys_role r ON r.id = ur.role_id WHERE r.code = 'ADMIN' AND u.username = ?""",
                Integer.class, ADMIN_USERNAME);
        assertThat(admins).isEqualTo(1);
        JsonNode me = login(ADMIN_USERNAME, ADMIN_PASSWORD).path("user");
        assertThat(me.path("roles").toString()).contains("ADMIN");
    }

    // ---------------- 管理员用户管理 ----------------

    @Test
    void pageQueryFiltersByUsernameExcludesDeletedAndSortsByCreatedDesc() throws Exception {
        String admin = adminToken();
        String tag = "li" + System.nanoTime() % 100000;
        String u1 = registerUser(tag + "_a1", PWD);
        String u2 = registerUser(tag + "_a2", PWD);
        String u3 = registerUser(tag + "_a3", PWD);
        registerUser(uniqueName("other"), PWD);
        jdbcTemplate.update("UPDATE biz.sys_user SET deleted = true WHERE username = ?", u3);

        MvcResult r = perform(bearer(get("/api/admin/users").param("pageNum", "1").param("pageSize", "10")
                .param("username", tag), admin));
        JsonNode data = body(r).get("data");
        assertThat(data.path("total").asLong()).isEqualTo(2);
        List<String> names = new ArrayList<>();
        data.path("records").forEach(n -> names.add(n.path("username").asString()));
        assertThat(names).containsExactly(u2, u1);
        assertThat(data.path("records").get(0).path("roles").get(0).asString()).isEqualTo("USER");
    }

    @Test
    void pageQueryFiltersByStatusAndRole() throws Exception {
        String admin = adminToken();
        String tag = "flt" + System.nanoTime() % 100000;
        String u1 = registerUser(tag + "_x", PWD);
        String u2 = registerUser(tag + "_y", PWD);
        jdbcTemplate.update("UPDATE biz.sys_user SET status = 'DISABLED' WHERE username = ?", u1);
        MvcResult byStatus = perform(bearer(get("/api/admin/users").param("username", tag).param("status", "DISABLED"), admin));
        assertThat(body(byStatus).path("data").path("total").asLong()).isEqualTo(1);
        assertThat(body(byStatus).path("data").path("records").get(0).path("username").asString()).isEqualTo(u1);

        long id2 = userId(u2);
        perform(jsonBody(bearer(put("/api/admin/users/" + id2 + "/roles"), admin), Map.of("roles", List.of("ADMIN", "USER"))));
        MvcResult byRole = perform(bearer(get("/api/admin/users").param("username", tag).param("role", "ADMIN"), admin));
        assertThat(body(byRole).path("data").path("total").asLong()).isEqualTo(1);
        assertThat(body(byRole).path("data").path("records").get(0).path("username").asString()).isEqualTo(u2);
    }

    @Test
    void adminCreatesUserWithRoles() throws Exception {
        String name = uniqueName("created");
        MvcResult r = perform(jsonBody(bearer(post("/api/admin/users"), adminToken()),
                Map.of("username", name, "password", PWD, "nickname", "新人", "roles", List.of("USER"))));
        JsonNode data = body(r).get("data");
        assertThat(data.path("username").asString()).isEqualTo(name);
        assertThat(data.path("roles").get(0).asString()).isEqualTo("USER");
        login(name, PWD);
        MvcResult dup = perform(jsonBody(bearer(post("/api/admin/users"), adminToken()),
                Map.of("username", name, "password", PWD, "roles", List.of("USER"))));
        assertThat(body(dup).path("code").asString()).isEqualTo("A0111");
    }

    @Test
    void disableUserForcesLogoutAndBlocksLogin() throws Exception {
        String name = registerUser(uniqueName("victim"), PWD);
        JsonNode session = login(name, PWD);
        String userToken = session.path("accessToken").asString();
        long id = session.path("user").path("id").asLong();

        MvcResult r = perform(jsonBody(bearer(put("/api/admin/users/" + id + "/status"), adminToken()),
                Map.of("status", "DISABLED")));
        assertThat(body(r).path("code").asString()).isEqualTo("00000");
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM biz.sys_user WHERE id = ?", String.class, id))
                .isEqualTo("DISABLED");
        assertThat(body(perform(bearer(get("/api/auth/me"), userToken))).path("code").asString()).isEqualTo("A0231");
        MvcResult refresh = postJson("/api/auth/refresh", Map.of("refreshToken", session.path("refreshToken").asString()), null);
        assertThat(body(refresh).path("code").asString()).isEqualTo("A0232");
        MvcResult relogin = postJson("/api/auth/login", Map.of("username", name, "password", PWD), null);
        assertThat(body(relogin).path("code").asString()).isEqualTo("A0202");
    }

    @Test
    void adminCannotDisableDeleteOrDemoteSelf() throws Exception {
        String token = adminToken();
        long selfId = userId(ADMIN_USERNAME);
        MvcResult disable = perform(jsonBody(bearer(put("/api/admin/users/" + selfId + "/status"), token),
                Map.of("status", "DISABLED")));
        MvcResult del = perform(bearer(delete("/api/admin/users/" + selfId), token));
        MvcResult demote = perform(jsonBody(bearer(put("/api/admin/users/" + selfId + "/roles"), token),
                Map.of("roles", List.of("USER"))));
        for (MvcResult r : List.of(disable, del, demote)) {
            assertThat(r.getResponse().getStatus()).isEqualTo(400);
            assertThat(body(r).path("code").asString()).isEqualTo("A0410");
        }
        // 未做任何修改，令牌仍有效
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM biz.sys_user WHERE id = ?", String.class, selfId))
                .isEqualTo("ENABLED");
        assertThat(perform(bearer(get("/api/auth/me"), token)).getResponse().getStatus()).isEqualTo(200);
        MvcResult me = perform(bearer(get("/api/auth/me"), token));
        assertThat(body(me).path("data").path("roles").toString()).contains("ADMIN");
    }

    @Test
    void resetPasswordStoresBcryptAndForcesLogout() throws Exception {
        String name = registerUser(uniqueName("rst"), PWD);
        JsonNode session = login(name, PWD);
        long id = session.path("user").path("id").asLong();
        MvcResult r = perform(jsonBody(bearer(put("/api/admin/users/" + id + "/password"), adminToken()),
                Map.of("password", "NewPassw0rd")));
        assertThat(body(r).path("code").asString()).isEqualTo("00000");
        String hash = jdbcTemplate.queryForObject("SELECT password_hash FROM biz.sys_user WHERE id = ?", String.class, id);
        assertThat(hash).startsWith("$2a$");
        assertThat(body(perform(bearer(get("/api/auth/me"), session.path("accessToken").asString()))).path("code").asString())
                .isEqualTo("A0231");
        login(name, "NewPassw0rd");
    }

    @Test
    void changeRolesForcesLogout() throws Exception {
        String name = registerUser(uniqueName("role"), PWD);
        JsonNode session = login(name, PWD);
        long id = session.path("user").path("id").asLong();
        perform(jsonBody(bearer(put("/api/admin/users/" + id + "/roles"), adminToken()), Map.of("roles", List.of("ADMIN"))));
        assertThat(body(perform(bearer(get("/api/auth/me"), session.path("accessToken").asString()))).path("code").asString())
                .isEqualTo("A0231");
        assertThat(login(name, PWD).path("user").path("roles").toString()).contains("ADMIN");
    }

    @Test
    void logicalDeleteAllowsUsernameReuse() throws Exception {
        String name = registerUser(uniqueName("alice"), PWD);
        long id = userId(name);
        MvcResult del = perform(bearer(delete("/api/admin/users/" + id), adminToken()));
        assertThat(body(del).path("code").asString()).isEqualTo("00000");
        registerUser(name, PWD);
        Integer total = jdbcTemplate.queryForObject("SELECT count(*) FROM biz.sys_user WHERE username = ?", Integer.class, name);
        Boolean oldDeleted = jdbcTemplate.queryForObject("SELECT deleted FROM biz.sys_user WHERE id = ?", Boolean.class, id);
        assertThat(total).isEqualTo(2);
        assertThat(oldDeleted).isTrue();
        // 删除的用户对管理员接口不可见
        MvcResult again = perform(bearer(delete("/api/admin/users/" + id), adminToken()));
        assertThat(again.getResponse().getStatus()).isEqualTo(404);
        assertThat(body(again).path("code").asString()).isEqualTo("A0404");
    }

    @Test
    void adminWriteOperationsAreLogged() throws Exception {
        String name = registerUser(uniqueName("logged"), PWD);
        long id = userId(name);
        perform(jsonBody(bearer(put("/api/admin/users/" + id + "/password"), adminToken()).header("X-Trace-Id", "op-trace-1"),
                Map.of("password", "Secr3tPass")));
        await(() -> count("SELECT count(*) FROM biz.operation_log WHERE trace_id = 'op-trace-1'") == 1);
        Map<String, Object> row = jdbcTemplate.queryForMap("SELECT * FROM biz.operation_log WHERE trace_id = 'op-trace-1'");
        assertThat(row.get("module")).isEqualTo("用户管理");
        assertThat(row.get("action")).isEqualTo("重置密码");
        assertThat(row.get("username")).isEqualTo(ADMIN_USERNAME);
        assertThat(row.get("method")).isEqualTo("PUT");
        assertThat(row.get("path")).isEqualTo("/api/admin/users/" + id + "/password");
        assertThat(row.get("result_code")).isEqualTo("00000");
        assertThat((String) row.get("params")).doesNotContain("Secr3tPass").contains("******");
        assertThat(row.get("duration_ms")).isNotNull();
    }

    // ---------------- 个人资料与密码 ----------------

    @Test
    void updateProfile() throws Exception {
        String name = registerUser(uniqueName("prof"), PWD);
        String token = accessToken(name, PWD);
        MvcResult r = perform(jsonBody(bearer(put("/api/users/me"), token), Map.of("nickname", "新昵称", "email", "a@b.com")));
        JsonNode data = body(r).get("data");
        assertThat(data.path("nickname").asString()).isEqualTo("新昵称");
        assertThat(data.path("email").asString()).isEqualTo("a@b.com");
        MvcResult bad = perform(jsonBody(bearer(put("/api/users/me"), token), Map.of("email", "not-email")));
        assertThat(body(bad).path("code").asString()).isEqualTo("A0410");
    }

    @Test
    void changePasswordSuccessRevokesAllTokens() throws Exception {
        String name = registerUser(uniqueName("chg"), PWD);
        JsonNode session = login(name, PWD);
        String token = session.path("accessToken").asString();
        MvcResult r = perform(jsonBody(bearer(put("/api/users/me/password"), token),
                Map.of("oldPassword", PWD, "newPassword", "Changed123")));
        assertThat(body(r).path("code").asString()).isEqualTo("00000");
        assertThat(body(perform(bearer(get("/api/auth/me"), token))).path("code").asString()).isEqualTo("A0231");
        MvcResult refresh = postJson("/api/auth/refresh", Map.of("refreshToken", session.path("refreshToken").asString()), null);
        assertThat(body(refresh).path("code").asString()).isEqualTo("A0232");
        login(name, "Changed123");
    }

    @Test
    void changePasswordWithWrongOldPasswordReturnsA0240() throws Exception {
        String name = registerUser(uniqueName("chgx"), PWD);
        String token = accessToken(name, PWD);
        String before = jdbcTemplate.queryForObject("SELECT password_hash FROM biz.sys_user WHERE username = ?", String.class, name);
        MvcResult r = perform(jsonBody(bearer(put("/api/users/me/password"), token),
                Map.of("oldPassword", "Wrong1234", "newPassword", "Changed123")));
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(r).path("code").asString()).isEqualTo("A0240");
        String after = jdbcTemplate.queryForObject("SELECT password_hash FROM biz.sys_user WHERE username = ?", String.class, name);
        assertThat(after).isEqualTo(before);
        assertThat(perform(bearer(get("/api/auth/me"), token)).getResponse().getStatus()).isEqualTo(200);
    }

    private long userId(String username) {
        Long id = jdbcTemplate.queryForObject("SELECT id FROM biz.sys_user WHERE username = ? AND deleted = false",
                Long.class, username);
        return id == null ? -1 : id;
    }

    private int count(String sql) {
        Integer n = jdbcTemplate.queryForObject(sql, Integer.class);
        return n == null ? 0 : n;
    }
}
