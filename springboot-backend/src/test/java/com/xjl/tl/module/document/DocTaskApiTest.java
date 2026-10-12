package com.xjl.tl.module.document;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * tasks 5.2–5.4：创建（JSON / multipart、校验、并发限制、start 命令）、列表与详情、取消 / 继续 / 删除、术语确认；
 * 缺省参数（hybrid / 人工确认 / 不评审）与评审模型的解析和记录（improve-agent-from-experiments 2.3）。
 */
class DocTaskApiTest extends DocTaskTestBase {

    private static final String GPU_DOC = "# GPU Basics\n\nA GPU accelerates training.\n\n## Usage\n\nUse the GPU for each epoch.\n";

    private int taskCount() {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM biz.doc_task WHERE user_id = ?", Integer.class, userId);
    }

    private MvcResult upload(String fileName, byte[] content, String settings) throws Exception {
        return mockMvc.perform(multipart("/api/doc-tasks")
                .file(new MockMultipartFile("file", fileName, "application/octet-stream", content))
                .file(new MockMultipartFile("settings", "", MediaType.APPLICATION_JSON_VALUE,
                        settings.getBytes(StandardCharsets.UTF_8)))
                .header("Authorization", "Bearer " + token)).andReturn();
    }

    private MvcResult action(long id, String action) throws Exception {
        return perform(bearer(post("/api/doc-tasks/" + id + "/" + action), token));
    }

    private static void assertError(MvcResult r, int status, String code) throws Exception {
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8))
                .isEqualTo(status);
        assertThat(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).contains("\"code\":\"" + code + "\"");
    }

    // ---------------- 创建 ----------------

    @Test
    void createFromJsonReturnsPendingAndWritesStartCommandInContractFormat() throws Exception {
        MvcResult r = createRaw(createBody(GPU_DOC), token);
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        JsonNode task = body(r).path("data");
        long id = task.path("id").asLong();
        assertThat(task.path("status").asString()).isEqualTo("PENDING");
        assertThat(task.path("title").asString()).isEqualTo("GPU Basics");
        assertThat(task.path("format").asString()).isEqualTo("md");
        assertThat(task.path("charCount").asInt()).isEqualTo(GPU_DOC.length());
        assertThat(task.path("progressDone").asInt()).isZero();
        // 未传 options：review 缺省关闭，其余三项缺省开启
        assertThat(task.path("options").path("review").asBoolean()).isFalse();
        assertThat(task.path("options").path("contextWindow").asBoolean()).isTrue();
        assertThat(task.has("sourceText")).isFalse();
        assertThat(task.has("text")).isFalse();
        // D13：DocTaskVO 的字段全部存在（值可为 null）
        assertThat(task.propertyNames()).contains("id", "title", "format", "charCount", "sourceLang", "detectedLang",
                "targetLang", "style", "domain", "genre", "glossaryIds", "modelConfigId", "reviewModelConfigId",
                "strategy", "confirmTerms",
                "options", "status", "phase", "progressDone", "progressTotal", "summary", "consistencyReport", "stats",
                "errorCode", "errorMessage", "retryable", "promptTokens", "completionTokens", "latencyMs", "createdAt",
                "startedAt", "finishedAt");

        List<Map<String, String>> cmds = commandsFor(id);
        assertThat(cmds).hasSize(1);
        Map<String, String> start = cmds.getFirst();
        assertThat(start).containsEntry("cmd", "start").containsEntry("taskId", String.valueOf(id));
        assertThat(start.get("traceId")).isNotBlank();
        String raw = start.get("payload");
        assertThat(raw).doesNotContain("\n");
        JsonNode payload = jsonMapper.readTree(raw);
        assertThat(payload.path("userId").asLong()).isEqualTo(userId);
        assertThat(payload.path("title").asString()).isEqualTo("GPU Basics");
        assertThat(payload.path("format").asString()).isEqualTo("md");
        assertThat(payload.path("text").asString()).isEqualTo(GPU_DOC);
        assertThat(payload.path("sourceLang").asString()).isEqualTo("auto");
        assertThat(payload.path("targetLang").asString()).isEqualTo("zh");
        assertThat(payload.path("style").asString()).isEqualTo("faithful");
        assertThat(payload.has("domain")).isTrue();
        assertThat(payload.path("glossaryIds").isArray()).isTrue();
        assertThat(payload.has("reviewModelConfigId")).isTrue();
        assertThat(payload.path("reviewModelConfigId").isNull()).isTrue();
        assertThat(payload.path("strategy").asString()).isEqualTo("serial");
        assertThat(payload.path("confirmTerms").asBoolean()).isTrue();
        assertThat(payload.path("options").propertyNames())
                .containsExactlyInAnyOrder("contextWindow", "globalSummary", "termExtraction", "review",
                        "translationMemory");
        // 翻译记忆缺省开启：任务与 start 命令一致
        assertThat(task.path("options").path("translationMemory").asBoolean()).isTrue();
        assertThat(payload.path("options").path("translationMemory").asBoolean()).isTrue();
    }

    @Test
    void uploadMarkdownFileUsesFileNameAsTitle() throws Exception {
        StringBuilder sb = new StringBuilder(String.valueOf((char) 0xFEFF)).append("# Guide\n\n");
        while (sb.length() < 8001) {
            sb.append("Pods run containers. ");
        }
        String text = sb.substring(0, 8001);
        MvcResult r = upload("guide.md", text.getBytes(StandardCharsets.UTF_8),
                "{\"targetLang\":\"zh\",\"strategy\":\"serial\",\"options\":{\"review\":false}}");
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString()).isEqualTo(200);
        JsonNode task = body(r).path("data");
        assertThat(task.path("status").asString()).isEqualTo("PENDING");
        assertThat(task.path("title").asString()).isEqualTo("guide");
        assertThat(task.path("format").asString()).isEqualTo("md");
        // BOM 被去除
        assertThat(task.path("charCount").asInt()).isEqualTo(8000);
        assertThat(task.path("options").path("review").asBoolean()).isFalse();
        assertThat(task.path("options").path("contextWindow").asBoolean()).isTrue();
        long id = task.path("id").asLong();
        assertThat(commandsFor(id)).singleElement().satisfies(c -> {
            assertThat(c.get("cmd")).isEqualTo("start");
            assertThat(jsonMapper.readTree(c.get("payload")).path("text").asString()).startsWith("# Guide");
        });

        MvcResult txt = upload("notes.TXT", "第一段\n\n第二段".getBytes(StandardCharsets.UTF_8), "{\"targetLang\":\"en\"}");
        assertThat(body(txt).path("data").path("format").asString()).isEqualTo("txt");
        assertThat(body(txt).path("data").path("title").asString()).isEqualTo("notes");
    }

    @Test
    void defaultParametersAreHybridConfirmTermsAndNoReview() throws Exception {
        MvcResult r = createRaw(Map.of("text", GPU_DOC, "targetLang", "zh"), token);
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8))
                .isEqualTo(200);
        JsonNode task = body(r).path("data");
        assertThat(task.path("strategy").asString()).isEqualTo("hybrid");
        assertThat(task.path("confirmTerms").asBoolean()).isTrue();
        assertThat(task.path("options").path("contextWindow").asBoolean()).isTrue();
        assertThat(task.path("options").path("globalSummary").asBoolean()).isTrue();
        assertThat(task.path("options").path("termExtraction").asBoolean()).isTrue();
        assertThat(task.path("options").path("review").asBoolean()).isFalse();
        // 没有评审模型时为 null（与译者相同）
        assertThat(task.path("reviewModelConfigId").isNull()).isTrue();
        long id = task.path("id").asLong();
        JsonNode payload = jsonMapper.readTree(commandsFor(id).getFirst().get("payload"));
        assertThat(payload.path("strategy").asString()).isEqualTo("hybrid");
        assertThat(payload.path("confirmTerms").asBoolean()).isTrue();
        assertThat(payload.path("options").path("review").asBoolean()).isFalse();
        assertThat(payload.path("options").path("termExtraction").asBoolean()).isTrue();
        assertThat(payload.path("reviewModelConfigId").isNull()).isTrue();

        // 部分 options：未给出的字段按缺省补全
        Map<String, Object> partial = createBody(GPU_DOC);
        partial.put("options", Map.of("contextWindow", false));
        JsonNode options = body(createRaw(partial, token)).path("data").path("options");
        assertThat(options.path("contextWindow").asBoolean()).isFalse();
        assertThat(options.path("globalSummary").asBoolean()).isTrue();
        assertThat(options.path("review").asBoolean()).isFalse();
        // 显式关闭确认（第三个任务前把前两个置为完成，避免触发并发限制）
        jdbcTemplate.update("UPDATE biz.doc_task SET status = 'COMPLETED' WHERE user_id = ?", userId);
        Map<String, Object> noConfirm = createBody(GPU_DOC);
        noConfirm.put("confirmTerms", false);
        assertThat(body(createRaw(noConfirm, token)).path("data").path("confirmTerms").asBoolean()).isFalse();
    }

    @Test
    void reviewModelIsResolvedAtCreationAndRecordedOnTask() throws Exception {
        long reviewer = insertModelConfig("reviewer", true);
        long explicit = insertModelConfig("explicit-reviewer", true);
        String admin = adminToken();
        assertThat(perform(bearer(put("/api/admin/model-configs/" + reviewer + "/review-default"), admin))
                .getResponse().getStatus()).isEqualTo(200);

        // 未指定：使用管理员设置的评审模型
        Map<String, Object> body = createBody(GPU_DOC);
        body.put("options", Map.of("review", true));
        JsonNode task = body(createRaw(body, token)).path("data");
        long id = task.path("id").asLong();
        assertThat(task.path("reviewModelConfigId").asLong()).isEqualTo(reviewer);
        assertThat(task.path("options").path("review").asBoolean()).isTrue();
        assertThat(detail(id).path("reviewModelConfigId").asLong()).isEqualTo(reviewer);
        assertThat(jdbcTemplate.queryForObject("SELECT review_model_config_id FROM biz.doc_task WHERE id = ?",
                Long.class, id)).isEqualTo(reviewer);
        assertThat(jsonMapper.readTree(commandsFor(id).getFirst().get("payload")).path("reviewModelConfigId").asLong())
                .isEqualTo(reviewer);
        // 列表项同样返回
        JsonNode first = body(perform(bearer(get("/api/doc-tasks"), token))).path("data").path("records").get(0);
        assertThat(first.path("reviewModelConfigId").asLong()).isEqualTo(reviewer);

        // 显式指定优先
        body.put("reviewModelConfigId", explicit);
        long explicitTask = body(createRaw(body, token)).path("data").path("id").asLong();
        assertThat(detail(explicitTask).path("reviewModelConfigId").asLong()).isEqualTo(explicit);
        assertThat(jsonMapper.readTree(commandsFor(explicitTask).getFirst().get("payload"))
                .path("reviewModelConfigId").asLong()).isEqualTo(explicit);

        // multipart 的 settings 使用同一结构
        jdbcTemplate.update("UPDATE biz.doc_task SET status = 'COMPLETED' WHERE user_id = ?", userId);
        MvcResult up = upload("guide.md", GPU_DOC.getBytes(StandardCharsets.UTF_8),
                json(Map.of("targetLang", "zh", "reviewModelConfigId", explicit)));
        assertThat(up.getResponse().getStatus()).as(up.getResponse().getContentAsString()).isEqualTo(200);
        assertThat(body(up).path("data").path("reviewModelConfigId").asLong()).isEqualTo(explicit);
        assertThat(body(up).path("data").path("strategy").asString()).isEqualTo("hybrid");
    }

    @Test
    void retryKeepsReviewModelRecordedOnTask() throws Exception {
        long reviewer = insertModelConfig("retry-reviewer", true);
        long newer = insertModelConfig("retry-newer", true);
        String admin = adminToken();
        perform(bearer(put("/api/admin/model-configs/" + reviewer + "/review-default"), admin));
        long id = createTask(GPU_DOC);
        // 管理员之后切换评审模型：已创建的任务继续执行时仍使用创建时记录的值
        perform(bearer(put("/api/admin/model-configs/" + newer + "/review-default"), admin));
        jdbcTemplate.update("UPDATE biz.doc_task SET status = 'FAILED', retryable = true WHERE id = ?", id);
        assertThat(action(id, "retry").getResponse().getStatus()).isEqualTo(200);
        Map<String, String> retry = commandsFor(id).getLast();
        assertThat(retry.get("cmd")).isEqualTo("retry");
        assertThat(jsonMapper.readTree(retry.get("payload")).path("reviewModelConfigId").asLong()).isEqualTo(reviewer);
        assertThat(detail(id).path("reviewModelConfigId").asLong()).isEqualTo(reviewer);
    }

    @Test
    void disabledExplicitReviewModelIsRejectedWithC0130() throws Exception {
        long disabled = insertModelConfig("reviewer-off", false);
        int before = taskCount();
        Map<String, Object> body = createBody(GPU_DOC);
        body.put("reviewModelConfigId", disabled);
        assertError(createRaw(body, token), 400, "C0130");
        body.put("reviewModelConfigId", 987654321L);
        assertError(createRaw(body, token), 400, "C0130");
        assertError(upload("guide.md", GPU_DOC.getBytes(StandardCharsets.UTF_8),
                json(Map.of("targetLang", "zh", "reviewModelConfigId", disabled))), 400, "C0130");
        assertThat(taskCount()).isEqualTo(before);
        assertThat(commands()).isNullOrEmpty();
    }

    @Test
    void tooLargeEmptyOrUnsupportedDocumentsAreRejectedWithA0430() throws Exception {
        int before = taskCount();
        assertError(createRaw(createBody("a".repeat(60000)), token), 400, "A0430");
        assertError(createRaw(createBody("   \n\t "), token), 400, "A0430");
        assertError(upload("report.docx", "hello".getBytes(StandardCharsets.UTF_8), "{\"targetLang\":\"zh\"}"), 400, "A0430");
        assertError(upload("bad.md", new byte[]{(byte) 0xC3, (byte) 0x28, 0x41}, "{\"targetLang\":\"zh\"}"), 400, "A0430");
        assertError(upload("empty.txt", new byte[0], "{\"targetLang\":\"zh\"}"), 400, "A0430");
        assertThat(taskCount()).isEqualTo(before);
        // 50000 字符（含多字节字符，按码点计）可以创建
        assertThat(createRaw(createBody("文".repeat(50000)), token).getResponse().getStatus()).isEqualTo(200);
    }

    @Test
    void invalidParametersAreRejected() throws Exception {
        Map<String, Object> body = createBody(GPU_DOC);
        body.put("targetLang", "xx");
        assertError(createRaw(body, token), 400, "A0420");
        body = createBody(GPU_DOC);
        body.put("strategy", "random");
        assertError(createRaw(body, token), 400, "A0410");
        body = createBody(GPU_DOC);
        body.put("format", "docx");
        assertError(createRaw(body, token), 400, "A0410");
        assertError(upload("a.md", "x".getBytes(StandardCharsets.UTF_8), "{not json"), 400, "A0410");
        assertError(upload("a.md", "x".getBytes(StandardCharsets.UTF_8), "{\"strategy\":\"serial\"}"), 400, "A0410");
    }

    @Test
    void othersPrivateGlossaryReturnsA0404() throws Exception {
        String other = registerUser(uniqueName("doco"), "Passw0rd!");
        String otherToken = accessToken(other, "Passw0rd!");
        JsonNode g = body(postJson("/api/glossaries",
                Map.of("name", "私有库", "sourceLang", "en", "targetLang", "zh"), otherToken)).path("data");
        Map<String, Object> body = createBody(GPU_DOC);
        body.put("glossaryIds", List.of(g.path("id").asLong()));
        int before = taskCount();
        assertError(createRaw(body, token), 404, "A0404");
        assertThat(taskCount()).isEqualTo(before);
        // 自己的术语库可以使用，并写入 payload
        JsonNode mine = body(postJson("/api/glossaries",
                Map.of("name", "我的库", "sourceLang", "en", "targetLang", "zh"), token)).path("data");
        body.put("glossaryIds", List.of(mine.path("id").asLong()));
        long id = body(createRaw(body, token)).path("data").path("id").asLong();
        assertThat(jsonMapper.readTree(commandsFor(id).getFirst().get("payload")).path("glossaryIds").get(0).asLong())
                .isEqualTo(mine.path("id").asLong());
    }

    @Test
    void thirdRunningTaskIsRejectedWithA0213ButAwaitingConfirmDoesNotCount() throws Exception {
        long first = createTask(GPU_DOC);
        long second = createTask(GPU_DOC);
        setStatus(second, "TRANSLATING");
        MvcResult third = createRaw(createBody(GPU_DOC), token);
        assertError(third, 429, "A0213");
        assertThat(taskCount()).isEqualTo(2);

        setStatus(first, "AWAITING_CONFIRM");
        assertThat(createRaw(createBody(GPU_DOC), token).getResponse().getStatus()).isEqualTo(200);
        // 其他用户不受影响
        String other = registerUser(uniqueName("doco"), "Passw0rd!");
        assertThat(createRaw(createBody(GPU_DOC), accessToken(other, "Passw0rd!")).getResponse().getStatus())
                .isEqualTo(200);
    }

    // ---------------- 列表与详情 ----------------

    @Test
    void listFiltersByStatusAndKeywordAndIsolatesUsers() throws Exception {
        Map<String, Object> body = createBody(GPU_DOC);
        body.put("title", "Kubernetes 指南");
        long k8s = body(createRaw(body, token)).path("data").path("id").asLong();
        setStatus(k8s, "COMPLETED");
        long gpu = createTask(GPU_DOC);

        JsonNode page = body(perform(bearer(get("/api/doc-tasks?pageNum=1&pageSize=10"), token))).path("data");
        assertThat(page.path("total").asLong()).isEqualTo(2);
        assertThat(page.path("records").get(0).path("id").asLong()).isEqualTo(gpu);
        assertThat(page.path("records").get(0).has("summary")).isFalse();
        assertThat(page.path("records").get(0).has("consistencyReport")).isFalse();
        assertThat(page.path("records").get(0).has("stats")).isFalse();
        assertThat(page.path("records").get(0).has("progressTotal")).isTrue();

        JsonNode byStatus = body(perform(bearer(get("/api/doc-tasks?status=COMPLETED"), token))).path("data");
        assertThat(byStatus.path("total").asLong()).isEqualTo(1);
        assertThat(byStatus.path("records").get(0).path("id").asLong()).isEqualTo(k8s);
        JsonNode byKeyword = body(perform(bearer(get("/api/doc-tasks?keyword=kubernetes"), token))).path("data");
        assertThat(byKeyword.path("total").asLong()).isEqualTo(1);

        String other = registerUser(uniqueName("doco"), "Passw0rd!");
        String otherToken = accessToken(other, "Passw0rd!");
        assertThat(body(perform(bearer(get("/api/doc-tasks"), otherToken))).path("data").path("total").asLong()).isZero();
        assertError(perform(bearer(get("/api/doc-tasks/" + gpu), otherToken)), 404, "A0404");
        assertError(perform(bearer(get("/api/doc-tasks/" + gpu + "/segments"), otherToken)), 404, "A0404");
        assertError(perform(bearer(get("/api/doc-tasks/" + gpu + "/terms"), otherToken)), 404, "A0404");
        assertError(perform(bearer(post("/api/doc-tasks/" + gpu + "/cancel"), otherToken)), 404, "A0404");
        assertError(perform(bearer(delete("/api/doc-tasks/" + gpu), otherToken)), 404, "A0404");
        assertError(perform(bearer(get("/api/doc-tasks/99999999"), token)), 404, "A0404");
    }

    // ---------------- 取消 / 继续 / 删除 ----------------

    @Test
    void cancelTranslatingTaskGoesThroughCancellingToCancelled() throws Exception {
        long id = createTask(GPU_DOC);
        setStatus(id, "TRANSLATING");
        MvcResult r = action(id, "cancel");
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        assertThat(body(r).path("data").path("status").asString()).isEqualTo("CANCELLING");
        assertThat(commandsFor(id)).extracting(c -> c.get("cmd")).containsExactly("start", "cancel");
        assertThat(commandsFor(id).get(1)).containsOnlyKeys("cmd", "taskId");

        // 取消进行中再次取消：状态不允许
        assertError(action(id, "cancel"), 409, "A0431");
        // 在途的 phase 事件不会把状态改回运行中
        emit(event(id, 1, "phase", "{\"phase\":\"translating\"}"));
        awaitSeq(id, 1);
        assertThat(detail(id).path("status").asString()).isEqualTo("CANCELLING");
        emit(event(id, 2, "cancelled", "{}"));
        awaitSeq(id, 2);
        JsonNode t = detail(id);
        assertThat(t.path("status").asString()).isEqualTo("CANCELLED");
        assertThat(t.path("finishedAt").isNull()).isFalse();
    }

    @Test
    void stateNotAllowingOperationReturnsA0431() throws Exception {
        long id = createTask(GPU_DOC);
        setStatus(id, "COMPLETED");
        assertError(action(id, "retry"), 409, "A0431");
        assertError(action(id, "cancel"), 409, "A0431");
        assertError(perform(bearer(jsonBody(post("/api/doc-tasks/" + id + "/terms/confirm"),
                Map.of("terms", List.of())), token)), 409, "A0431");
        jdbcTemplate.update("UPDATE biz.doc_task SET status = 'FAILED', retryable = false WHERE id = ?", id);
        assertError(action(id, "retry"), 409, "A0431");
        setStatus(id, "PENDING");
        assertError(action(id, "retry"), 409, "A0431");
        assertThat(commandsFor(id)).extracting(c -> c.get("cmd")).containsExactly("start");
    }

    @Test
    void retryFailedOrCancelledTaskWritesRetryCommandWithPayload() throws Exception {
        long id = createTask(GPU_DOC);
        jdbcTemplate.update("""
                UPDATE biz.doc_task SET status = 'FAILED', retryable = true, error_code = 'C0122',
                  error_message = 'LLM 调用超时', finished_at = now(), last_event_seq = 9 WHERE id = ?""", id);
        MvcResult r = action(id, "retry");
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        JsonNode t = body(r).path("data");
        assertThat(t.path("status").asString()).isEqualTo("PENDING");
        assertThat(t.path("errorCode").isNull()).isTrue();
        assertThat(t.path("finishedAt").isNull()).isTrue();
        Map<String, String> retry = commandsFor(id).getLast();
        assertThat(retry.get("cmd")).isEqualTo("retry");
        assertThat(retry.get("traceId")).isNotBlank();
        assertThat(jsonMapper.readTree(retry.get("payload")).path("text").asString()).isEqualTo(GPU_DOC);
        // eventSeq 在 retry 后继续递增，不回退
        assertThat(lastEventSeq(id)).isEqualTo(9);

        setStatus(id, "CANCELLED");
        assertThat(action(id, "retry").getResponse().getStatus()).isEqualTo(200);
    }

    @Test
    void retryIsAlsoSubjectToConcurrencyLimit() throws Exception {
        long failed = createTask(GPU_DOC);
        jdbcTemplate.update("UPDATE biz.doc_task SET status = 'FAILED', retryable = true WHERE id = ?", failed);
        createTask(GPU_DOC);
        createTask(GPU_DOC);
        assertError(action(failed, "retry"), 429, "A0213");
        assertThat(detail(failed).path("status").asString()).isEqualTo("FAILED");
    }

    @Test
    void deleteIsLogicalAndAlwaysSendsCancelForPurge() throws Exception {
        long running = createTask(GPU_DOC);
        setStatus(running, "TRANSLATING");
        assertThat(perform(bearer(delete("/api/doc-tasks/" + running), token)).getResponse().getStatus()).isEqualTo(200);
        assertThat(jdbcTemplate.queryForObject("SELECT deleted FROM biz.doc_task WHERE id = ?", Boolean.class, running))
                .isTrue();
        assertThat(commandsFor(running)).extracting(c -> c.get("cmd")).containsExactly("start", "cancel");
        assertThat(commandsFor(running).get(1)).containsEntry("purge", "true");
        assertError(perform(bearer(get("/api/doc-tasks/" + running), token)), 404, "A0404");
        assertThat(body(perform(bearer(get("/api/doc-tasks"), token))).path("data").path("total").asLong()).isZero();

        long completed = createTask(GPU_DOC);
        setStatus(completed, "COMPLETED");
        perform(bearer(delete("/api/doc-tasks/" + completed), token));
        assertThat(commandsFor(completed)).extracting(c -> c.get("cmd")).containsExactly("start", "cancel");
        assertThat(commandsFor(completed).get(1)).containsEntry("purge", "true");
        // 删除后的事件被确认并忽略
        emit(event(completed, 1, "phase", "{\"phase\":\"parsing\"}"));
        awaitUntil(() -> pendingCount() == 0 && redis.opsForStream().size(EVENTS) == 1, "事件被确认");
        Thread.sleep(300);
        assertThat(lastEventSeq(completed)).isZero();
    }

    // ---------------- 术语确认 ----------------

    @Test
    void confirmTermsSavesDecisionsAndWritesResumeCommand() throws Exception {
        long id = createTask(GPU_DOC);
        // 样例 2.1 的前 9 条事件：到 awaiting_confirm 为止
        List<tools.jackson.databind.node.ObjectNode> sample = com.xjl.tl.support.DocStreamSample.section("2.1");
        sample.subList(0, 9).forEach(m -> emit(m, id));
        awaitSeq(id, 9);
        assertThat(detail(id).path("status").asString()).isEqualTo("AWAITING_CONFIRM");
        JsonNode terms = body(perform(bearer(get("/api/doc-tasks/" + id + "/terms"), token))).path("data");
        assertThat(terms).hasSize(3);
        Map<String, Long> ids = new java.util.HashMap<>();
        terms.forEach(t -> {
            ids.put(t.path("source").asString(), t.path("id").asLong());
            assertThat(t.path("status").asString()).isEqualTo("PENDING");
        });
        assertThat(terms.get(0).path("source").asString()).isEqualTo("GPU");
        assertThat(terms.get(0).path("origin").asString()).isEqualTo("glossary");
        assertThat(terms.get(0).path("frequency").asInt()).isEqualTo(3);

        List<Map<String, Object>> decisions = new ArrayList<>();
        decisions.add(Map.of("id", ids.get("GPU"), "source", "GPU", "target", "图形处理器", "status", "CONFIRMED"));
        decisions.add(Map.of("id", ids.get("epoch"), "source", "epoch", "target", "训练轮次", "status", "CONFIRMED"));
        decisions.add(Map.of("source", "Pod", "target", "容器组", "status", "CONFIRMED"));
        // training 未出现在列表中：视为拒绝
        MvcResult r = perform(bearer(jsonBody(post("/api/doc-tasks/" + id + "/terms/confirm"),
                Map.of("terms", decisions)), token));
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(200);
        JsonNode after = body(r).path("data");
        assertThat(after).hasSize(4);
        Map<String, JsonNode> bySource = new java.util.HashMap<>();
        after.forEach(t -> bySource.put(t.path("source").asString(), t));
        assertThat(bySource.get("epoch").path("target").asString()).isEqualTo("训练轮次");
        assertThat(bySource.get("epoch").path("status").asString()).isEqualTo("CONFIRMED");
        assertThat(bySource.get("training").path("status").asString()).isEqualTo("REJECTED");
        assertThat(bySource.get("Pod").path("origin").asString()).isEqualTo("user");

        Map<String, String> resume = commandsFor(id).getLast();
        assertThat(resume.get("cmd")).isEqualTo("resume");
        assertThat(resume.get("traceId")).isNotBlank();
        assertThat(resume.get("data")).doesNotContain("\n");
        JsonNode data = jsonMapper.readTree(resume.get("data"));
        List<String> pairs = new ArrayList<>();
        data.path("terms").forEach(t -> pairs.add(t.path("source").asString() + "=" + t.path("target").asString()));
        assertThat(pairs).containsExactlyInAnyOrder("GPU=图形处理器", "epoch=训练轮次", "Pod=容器组");
        assertThat(detail(id).path("status").asString()).isEqualTo("TRANSLATING");

        // 已确认后不能再次确认
        assertError(perform(bearer(jsonBody(post("/api/doc-tasks/" + id + "/terms/confirm"),
                Map.of("terms", decisions)), token)), 409, "A0431");
    }

    @Test
    void confirmTermsValidatesInput() throws Exception {
        long id = createTask(GPU_DOC);
        setStatus(id, "AWAITING_CONFIRM");
        assertError(perform(bearer(jsonBody(post("/api/doc-tasks/" + id + "/terms/confirm"),
                Map.of("terms", List.of(Map.of("source", "", "target", "x", "status", "CONFIRMED")))), token)), 400, "A0410");
        assertError(perform(bearer(jsonBody(post("/api/doc-tasks/" + id + "/terms/confirm"),
                Map.of("terms", List.of(Map.of("source", "a", "target", "x", "status", "MAYBE")))), token)), 400, "A0410");
        assertError(perform(bearer(jsonBody(post("/api/doc-tasks/" + id + "/terms/confirm"),
                Map.of("terms", List.of(Map.of("source", "a", "target", "x", "status", "CONFIRMED"),
                        Map.of("source", "A", "target", "y", "status", "CONFIRMED")))), token)), 400, "A0410");
        assertError(perform(bearer(jsonBody(post("/api/doc-tasks/" + id + "/terms/confirm"),
                Map.of("terms", List.of(Map.of("id", 987654321, "source", "a", "target", "x", "status", "CONFIRMED")))),
                token)), 404, "A0404");
        assertThat(detail(id).path("status").asString()).isEqualTo("AWAITING_CONFIRM");
    }

    @Test
    void writeOperationsAreRecordedInOperationLog() throws Exception {
        long id = createTask(GPU_DOC);
        setStatus(id, "TRANSLATING");
        action(id, "cancel");
        await(() -> jdbcTemplate.queryForObject(
                "SELECT count(*) FROM biz.operation_log WHERE module = '文档翻译' AND user_id = ?", Integer.class, userId) >= 2);
        List<String> actions = jdbcTemplate.queryForList(
                "SELECT action FROM biz.operation_log WHERE module = '文档翻译' AND user_id = ?", String.class, userId);
        assertThat(actions).contains("创建文档任务", "取消文档任务");
    }
}
