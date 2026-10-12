package com.xjl.tl.module.glossary;

import com.xjl.tl.support.IntegrationTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * glossary 规格「术语管理」「CSV 导入与导出」/ tasks 4.5、4.6。
 */
class GlossaryTermTest extends IntegrationTestBase {

    private String token;
    private long glossaryId;

    @BeforeEach
    void setUp() throws Exception {
        token = accessToken(registerUser(uniqueName("gt"), "Passw0rd!"), "Passw0rd!");
        MvcResult r = perform(jsonBody(bearer(post(GlossaryTest.BASE), token), GlossaryTest.glossary("terms", null)));
        glossaryId = body(r).path("data").path("id").asLong();
    }

    private String terms() {
        return GlossaryTest.BASE + "/" + glossaryId + "/terms";
    }

    private MvcResult addTerm(String source, String target) throws Exception {
        return perform(jsonBody(bearer(post(terms()), token), Map.of("sourceTerm", source, "targetTerm", target)));
    }

    private MvcResult upload(MockMultipartHttpServletRequestBuilder b) throws Exception {
        return mockMvc.perform(b.header("Authorization", "Bearer " + token)).andReturn();
    }

    private int termCount() {
        return jdbcTemplate.queryForObject("SELECT term_count FROM biz.glossary WHERE id = ?", Integer.class, glossaryId);
    }

    // ---------------- 术语管理 ----------------

    @Test
    void duplicateSourceTermIgnoringCaseReturnsA0112() throws Exception {
        assertThat(body(addTerm("GPU", "图形处理器")).path("code").asString()).isEqualTo("00000");
        MvcResult dup = addTerm("gpu", "显卡");
        assertThat(dup.getResponse().getStatus()).isEqualTo(409);
        assertThat(body(dup).path("code").asString()).isEqualTo("A0112");
        assertThat(termCount()).isEqualTo(1);
    }

    @Test
    void termCountFollowsAddAndDelete() throws Exception {
        long first = body(addTerm("GPU", "图形处理器")).path("data").path("id").asLong();
        addTerm("CPU", "中央处理器");
        addTerm("machine learning", "机器学习");
        OffsetDateTime before = jdbcTemplate.queryForObject("SELECT updated_at FROM biz.glossary WHERE id = ?",
                OffsetDateTime.class, glossaryId);
        assertThat(termCount()).isEqualTo(3);
        assertThat(body(perform(bearer(delete(terms() + "/" + first), token))).path("code").asString()).isEqualTo("00000");
        assertThat(termCount()).isEqualTo(2);
        // 术语变更刷新术语库 updated_at（Python 按 id + updated_at 缓存）
        OffsetDateTime after = jdbcTemplate.queryForObject("SELECT updated_at FROM biz.glossary WHERE id = ?",
                OffsetDateTime.class, glossaryId);
        assertThat(after).isAfterOrEqualTo(before);
        JsonNode detail = body(perform(bearer(get(GlossaryTest.BASE + "/" + glossaryId), token))).path("data");
        assertThat(detail.path("termCount").asInt()).isEqualTo(2);
    }

    @Test
    void updateTermAndSearchByKeyword() throws Exception {
        long id = body(addTerm("Neural Network", "神经网络")).path("data").path("id").asLong();
        addTerm("GPU", "图形处理器");
        Map<String, Object> req = new HashMap<>();
        req.put("sourceTerm", "neural network");
        req.put("targetTerm", "神经网络模型");
        req.put("note", "AI");
        req.put("caseSensitive", true);
        JsonNode updated = body(perform(jsonBody(bearer(put(terms() + "/" + id), token), req))).path("data");
        assertThat(updated.path("sourceTerm").asString()).isEqualTo("neural network");
        assertThat(updated.path("caseSensitive").asBoolean()).isTrue();
        // 改成与另一条术语重复
        MvcResult dup = perform(jsonBody(bearer(put(terms() + "/" + id), token), Map.of("sourceTerm", "gpu", "targetTerm", "x")));
        assertThat(body(dup).path("code").asString()).isEqualTo("A0112");

        JsonNode page = body(perform(bearer(get(terms()).param("keyword", "神经"), token))).path("data");
        assertThat(page.path("total").asLong()).isEqualTo(1);
        assertThat(page.path("records").get(0).path("note").asString()).isEqualTo("AI");
    }

    @Test
    void termWritesAreOperationLogged() throws Exception {
        String trace = "term-log-" + System.nanoTime();
        perform(jsonBody(bearer(post(terms()), token), Map.of("sourceTerm", "API", "targetTerm", "接口"))
                .header("X-Trace-Id", trace));
        await(() -> jdbcTemplate.queryForObject("SELECT count(*) FROM biz.operation_log WHERE trace_id = ?",
                Integer.class, trace) == 1);
        assertThat(jdbcTemplate.queryForObject("SELECT action FROM biz.operation_log WHERE trace_id = ?", String.class, trace))
                .isEqualTo("新增术语");
    }

    // ---------------- CSV 导入导出 ----------------

    /** 10 行：2 行缺少目标术语、3 行与已有术语重复（大小写不同）、5 行新增。 */
    private static final String TEN_ROWS = """
            source,target,note
            GPU,图形处理器x,覆盖
            cpu,中央处理器x,
            "Machine Learning","机器学习x","含,逗号"
            transformer,,
            attention,注意力,
            embedding,嵌入,
            token,,缺目标
            tensor,张量,
            "quote ""q""\",引号,
            gradient,梯度,
            """;

    private void seedExisting() throws Exception {
        addTerm("gpu", "图形处理器");
        addTerm("CPU", "中央处理器");
        addTerm("machine learning", "机器学习");
    }

    private MockMultipartFile csv(String content, boolean bom) {
        byte[] body = content.getBytes(StandardCharsets.UTF_8);
        if (bom) {
            byte[] withBom = new byte[body.length + 3];
            withBom[0] = (byte) 0xEF;
            withBom[1] = (byte) 0xBB;
            withBom[2] = (byte) 0xBF;
            System.arraycopy(body, 0, withBom, 3, body.length);
            body = withBom;
        }
        return new MockMultipartFile("file", "terms.csv", "text/csv", body);
    }

    @Test
    void previewImportReportsCountsAndErrorLines() throws Exception {
        seedExisting();
        MvcResult r = upload(multipart(terms() + "/import/preview").file(csv(TEN_ROWS, true)));
        JsonNode d = body(r).path("data");
        assertThat(body(r).path("code").asString()).as(body(r).toString()).isEqualTo("00000");
        assertThat(d.path("total").asInt()).isEqualTo(10);
        assertThat(d.path("valid").asInt()).isEqualTo(8);
        assertThat(d.path("newCount").asInt()).isEqualTo(5);
        assertThat(d.path("updateCount").asInt()).isEqualTo(3);
        assertThat(d.path("errors").valueStream().map(e -> e.path("line").asInt()).toList()).containsExactly(5, 8);
        assertThat(d.path("errors").get(0).path("message").asString()).contains("目标术语");
        assertThat(d.path("sample").get(0).path("exists").asBoolean()).isTrue();
        assertThat(d.path("sample").get(2).path("note").asString()).isEqualTo("含,逗号");
        // 预览不写库
        assertThat(termCount()).isEqualTo(3);
    }

    @Test
    void overwriteStrategyImportsAndOverwrites() throws Exception {
        seedExisting();
        MvcResult r = upload(multipart(terms() + "/import").file(csv(TEN_ROWS, false)).param("strategy", "overwrite"));
        JsonNode d = body(r).path("data");
        assertThat(d.path("inserted").asInt()).isEqualTo(5);
        assertThat(d.path("updated").asInt()).isEqualTo(3);
        assertThat(d.path("skipped").asInt()).isZero();
        assertThat(d.path("failed").asInt()).isEqualTo(2);
        assertThat(termCount()).isEqualTo(8);
        assertThat(jdbcTemplate.queryForObject(
                "SELECT target_term FROM biz.glossary_term WHERE glossary_id = ? AND lower(source_term) = 'gpu'",
                String.class, glossaryId)).isEqualTo("图形处理器x");
        assertThat(jdbcTemplate.queryForObject(
                "SELECT source_term FROM biz.glossary_term WHERE glossary_id = ? AND target_term = '引号'",
                String.class, glossaryId)).isEqualTo("quote \"q\"");
    }

    @Test
    void skipStrategyKeepsExistingTerms() throws Exception {
        seedExisting();
        JsonNode d = body(upload(multipart(terms() + "/import").file(csv(TEN_ROWS, true)).param("strategy", "skip")))
                .path("data");
        assertThat(d.path("inserted").asInt()).isEqualTo(5);
        assertThat(d.path("updated").asInt()).isZero();
        assertThat(d.path("skipped").asInt()).isEqualTo(3);
        assertThat(d.path("failed").asInt()).isEqualTo(2);
        assertThat(jdbcTemplate.queryForObject(
                "SELECT target_term FROM biz.glossary_term WHERE glossary_id = ? AND lower(source_term) = 'gpu'",
                String.class, glossaryId)).isEqualTo("图形处理器");
    }

    @Test
    void invalidFilesAreRejectedWithA0421() throws Exception {
        // 缺少 source 表头
        MvcResult noHeader = upload(multipart(terms() + "/import/preview")
                .file(csv("src,target\nGPU,图形处理器\n", false)));
        assertThat(noHeader.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(noHeader).path("code").asString()).isEqualTo("A0421");
        // 非 UTF-8（GBK 编码的中文）
        byte[] gbk = "source,target\nGPU,图形处理器\n".getBytes(Charset.forName("GBK"));
        MvcResult notUtf8 = upload(multipart(terms() + "/import/preview")
                .file(new MockMultipartFile("file", "gbk.csv", "text/csv", gbk)));
        assertThat(body(notUtf8).path("code").asString()).isEqualTo("A0421");
        // 超过 5000 行
        StringBuilder big = new StringBuilder("source,target\n");
        for (int i = 0; i < 5001; i++) {
            big.append("t").append(i).append(",v\n");
        }
        MvcResult tooMany = upload(multipart(terms() + "/import").file(csv(big.toString(), false)));
        assertThat(body(tooMany).path("code").asString()).isEqualTo("A0421");
        assertThat(termCount()).isZero();
        // 非法策略
        MvcResult badStrategy = upload(multipart(terms() + "/import")
                .file(csv("source,target\na,b\n", false)).param("strategy", "merge"));
        assertThat(body(badStrategy).path("code").asString()).isEqualTo("A0410");
    }

    @Test
    void exportProducesReimportableCsv() throws Exception {
        addTerm("GPU", "图形处理器");
        perform(jsonBody(bearer(post(terms()), token), Map.of("sourceTerm", "machine learning", "targetTerm", "机器学习",
                "note", "含,逗号与\"引号\"")));
        addTerm("token", "词元");
        MvcResult r = perform(bearer(get(terms() + "/export"), token));
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        assertThat(r.getResponse().getContentType()).startsWith("text/csv");
        String disposition = r.getResponse().getHeader("Content-Disposition");
        assertThat(disposition).startsWith("attachment").contains("filename*=UTF-8''terms.csv");
        byte[] content = r.getResponse().getContentAsByteArray();
        String text = new String(content, StandardCharsets.UTF_8);
        assertThat(text).startsWith((char) 0xFEFF + "source,target,note\r\n");
        assertThat(text.lines().count()).isEqualTo(4);

        // 原样导入到另一个术语库
        MvcResult other = perform(jsonBody(bearer(post(GlossaryTest.BASE), token), GlossaryTest.glossary("副本", null)));
        long otherId = body(other).path("data").path("id").asLong();
        JsonNode result = body(upload(multipart(GlossaryTest.BASE + "/" + otherId + "/terms/import")
                .file(new MockMultipartFile("file", "x.csv", "text/csv", content)))).path("data");
        assertThat(result.path("inserted").asInt()).isEqualTo(3);
        assertThat(result.path("failed").asInt()).isZero();
        List<String> notes = jdbcTemplate.queryForList(
                "SELECT coalesce(note, '') FROM biz.glossary_term WHERE glossary_id = ? ORDER BY id", String.class, otherId);
        assertThat(notes).containsExactly("", "含,逗号与\"引号\"", "");

        // 中文文件名按 UTF-8 编码
        MvcResult cn = perform(bearer(get(GlossaryTest.BASE + "/" + otherId + "/terms/export"), token));
        assertThat(cn.getResponse().getHeader("Content-Disposition")).contains("filename*=UTF-8''%E5%89%AF%E6%9C%AC.csv");
    }
}
