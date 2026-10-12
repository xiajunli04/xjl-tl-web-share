package com.xjl.tl.module.document;

import com.xjl.tl.infra.ai.AiServiceClient;
import com.xjl.tl.module.document.service.DocTaskService;
import com.xjl.tl.support.DocStreamSample;
import com.xjl.tl.support.MockAiServer;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * tasks 6.4：导出（md / bilingual / txt，按 prefix + 译文 + suffix 拼接）、段落后编辑、单段重译（MockAiServer 模拟上游）。
 */
class DocExportTest extends DocTaskTestBase {

    private static final Path FIXTURE = Path.of("..", "docs", "contracts", "fixtures", "k8s-guide.md");
    private static final String GPU_DOC = "# GPU Basics\n\nA GPU accelerates training.\n\n## Usage\n\nUse the GPU for each epoch.\n";

    private MockHttpServletResponse export(long id, String format) throws Exception {
        return perform(bearer(get("/api/doc-tasks/" + id + "/export?format=" + format), token)).getResponse();
    }

    // ---------------- 夹具解析（模拟 Python 的切分：保证 prefix + source + suffix 逐字节拼回原文） ----------------

    private static final Pattern HEADING = Pattern.compile("^(#{1,6} )(.*)$");
    private static final Pattern LIST = Pattern.compile("^(\\s*(?:[-*]|\\d+\\.)\\s+)(.*)$");
    private static final Pattern TABLE_SEPARATOR = Pattern.compile("^\\|[\\s\\-:|]+\\|$");

    /** 按行切分并保留行尾（\n 或 \r\n）。 */
    private static List<String> linesWithEol(String text) {
        List<String> out = new ArrayList<>();
        int start = 0;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == '\n') {
                out.add(text.substring(start, i + 1));
                start = i + 1;
            }
        }
        if (start < text.length()) {
            out.add(text.substring(start));
        }
        return out;
    }

    private static String body(String line) {
        return line.endsWith("\r\n") ? line.substring(0, line.length() - 2)
                : line.endsWith("\n") ? line.substring(0, line.length() - 1) : line;
    }

    /** 测试用切分：fenced 代码块、空行、HTML、表头分隔行不可翻译；二级标题开始新块。 */
    private ArrayNode splitFixture(String text, List<List<Integer>> chunks) {
        ArrayNode segs = jsonMapper.createArrayNode();
        List<String> lines = linesWithEol(text);
        int seq = 0;
        int chunk = 0;
        chunks.add(new ArrayList<>());
        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            String b = body(line);
            String eol = line.substring(b.length());
            ObjectNode s = jsonMapper.createObjectNode();
            if (b.startsWith("```")) {
                StringBuilder block = new StringBuilder(line);
                while (++i < lines.size()) {
                    block.append(lines.get(i));
                    if (body(lines.get(i)).startsWith("```")) {
                        break;
                    }
                }
                fill(s, "code", "", block.toString(), "", false);
            } else if (b.isBlank()) {
                fill(s, "blank", "", b, eol, false);
            } else if (HEADING.matcher(b).matches()) {
                Matcher m = HEADING.matcher(b);
                m.matches();
                if (m.group(1).equals("## ") && seq > 0) {
                    chunk++;
                    chunks.add(new ArrayList<>());
                }
                fill(s, "heading", m.group(1), m.group(2), eol, true);
                s.put("level", m.group(1).trim().length());
            } else if (LIST.matcher(b).matches()) {
                Matcher m = LIST.matcher(b);
                m.matches();
                fill(s, "list_item", m.group(1), m.group(2), eol, true);
            } else if (b.startsWith("> ")) {
                fill(s, "blockquote", "> ", b.substring(2), eol, true);
            } else if (b.startsWith("|")) {
                if (TABLE_SEPARATOR.matcher(b).matches()) {
                    fill(s, "table_row", "", b, eol, false);
                } else {
                    fill(s, "table_row", "| ", b.substring(2, b.length() - 2), " |" + eol, true);
                }
            } else if (b.startsWith("<")) {
                fill(s, "html", "", b, eol, false);
            } else {
                fill(s, "paragraph", "", b, eol, true);
            }
            s.put("seq", seq);
            segs.add(s);
            chunks.get(chunk).add(seq);
            seq++;
        }
        return segs;
    }

    private static void fill(ObjectNode s, String type, String prefix, String source, String suffix, boolean translatable) {
        s.put("blockType", type);
        s.put("prefix", prefix);
        s.put("source", source);
        s.put("suffix", suffix);
        s.put("translatable", translatable);
    }

    /** 用夹具驱动 parsed 与逐块 chunk_done（译文由 targetOf 给出），返回最后一个 eventSeq。 */
    private int driveFixture(long id, String text, java.util.function.Function<String, String> targetOf) throws Exception {
        List<List<Integer>> chunks = new ArrayList<>();
        ArrayNode segs = splitFixture(text, chunks);
        ObjectNode parsed = jsonMapper.createObjectNode();
        parsed.set("segments", segs);
        ArrayNode chunkArray = parsed.putArray("chunks");
        for (int c = 0; c < chunks.size(); c++) {
            ObjectNode ch = chunkArray.addObject();
            ch.put("index", c);
            ArrayNode seqs = ch.putArray("segSeqs");
            chunks.get(c).forEach(seqs::add);
            ch.put("group", c);
        }
        parsed.put("detectedLang", "en");
        int eventSeq = 1;
        emit(event(id, eventSeq, "parsed", jsonMapper.writeValueAsString(parsed)));
        for (int c = 0; c < chunks.size(); c++) {
            ObjectNode done = jsonMapper.createObjectNode();
            done.put("chunk", c);
            ArrayNode out = done.putArray("segments");
            for (int seq : chunks.get(c)) {
                JsonNode s = segs.get(seq);
                if (s.path("translatable").asBoolean()) {
                    ObjectNode o = out.addObject();
                    o.put("seq", seq);
                    o.put("target", targetOf.apply(s.path("source").asString()));
                    o.put("reviewScore", 90);
                    o.put("reviewRounds", 0);
                    o.putArray("compliance");
                }
            }
            done.put("cached", false);
            emit(event(id, ++eventSeq, "chunk_done", jsonMapper.writeValueAsString(done)));
        }
        awaitSeq(id, eventSeq);
        assertThat(chunks).hasSize(4);
        return eventSeq;
    }

    // ---------------- 导出 ----------------

    @Test
    void exportWithTargetEqualToSourceIsByteIdenticalToFixture() throws Exception {
        byte[] original = Files.readAllBytes(FIXTURE);
        String text = new String(original, StandardCharsets.UTF_8);
        assertThat(text).contains("\r\n").contains("```").contains("| --- |").contains("<div");
        long id = createTask(text);
        driveFixture(id, text, source -> source);
        JsonNode t = detail(id);
        assertThat(t.path("progressDone").asInt()).isEqualTo(4);
        assertThat(t.path("progressTotal").asInt()).isEqualTo(4);

        MockHttpServletResponse md = export(id, "md");
        assertThat(md.getStatus()).isEqualTo(200);
        assertThat(md.getContentType()).startsWith("text/markdown").containsIgnoringCase("charset=UTF-8");
        assertThat(md.getContentAsByteArray()).isEqualTo(original);
        MockHttpServletResponse txt = export(id, "txt");
        assertThat(txt.getContentType()).startsWith("text/plain");
        assertThat(txt.getContentAsByteArray()).isEqualTo(original);
    }

    @Test
    void translatedExportKeepsStructureAndReplacesOnlyText() throws Exception {
        String text = Files.readString(FIXTURE, StandardCharsets.UTF_8);
        long id = createTask(text);
        driveFixture(id, text, source -> "【" + source + "】");
        String md = export(id, "md").getContentAsString(StandardCharsets.UTF_8);
        assertThat(md).contains("# 【Kubernetes Deployment Guide】")
                .contains("## 【Core Concepts】")
                .contains("  - 【Every Node runs the `kubelet`, which talks to the control plane.】")
                .contains("| 【Pod | Runs one or more containers | Namespace】 |")
                .contains("| --- | --- | --- |")
                .contains("apiVersion: apps/v1\n")
                .contains("<div class=\"note\">The table above lists only the resources used in this guide.</div>");
        assertThat(md.split("\r\n", -1).length).isEqualTo(text.split("\r\n", -1).length);
    }

    @Test
    void bilingualExportAlternatesSourceAndTargetAndKeepsUntranslatableOnce() throws Exception {
        long gpu = createTask(GPU_DOC);
        emitSection("2.1", gpu);
        awaitSeq(gpu, 20);
        MockHttpServletResponse r = export(gpu, "bilingual");
        assertThat(r.getContentType()).startsWith("text/markdown");
        assertThat(r.getContentAsString(StandardCharsets.UTF_8)).isEqualTo("""
                # GPU Basics

                # 图形处理器基础

                A GPU accelerates training.

                图形处理器可加速训练。

                ## Usage

                ## 用法

                Use the GPU for each epoch.

                每个训练轮次都使用图形处理器。
                """);

        String text = Files.readString(FIXTURE, StandardCharsets.UTF_8);
        long k8s = createTask(text);
        driveFixture(k8s, text, source -> "译" + source);
        String bi = export(k8s, "bilingual").getContentAsString(StandardCharsets.UTF_8);
        // 代码块、HTML 只出现一次；表格行原文与译文相邻
        assertThat(bi.split("apiVersion: apps/v1", -1)).hasSize(2);
        assertThat(bi.split("<div class=\"note\">", -1)).hasSize(2);
        assertThat(bi).contains("| Pod | Runs one or more containers | Namespace |\n| 译Pod | Runs one or more containers | Namespace |\n");
        assertThat(bi).contains("- A **Deployment** declares the desired state of your Pods.\n- 译A **Deployment**");
    }

    @Test
    void exportFileNameIsUtf8EncodedAndFormatIsValidated() throws Exception {
        Map<String, Object> body = createBody(GPU_DOC);
        body.put("title", "GPU 入门");
        long id = body(createRaw(body, token)).path("data").path("id").asLong();
        assertThat(perform(bearer(get("/api/doc-tasks/" + id + "/export"), token)).getResponse().getStatus())
                .isEqualTo(409);
        emitSection("2.1", id);
        awaitSeq(id, 20);
        MockHttpServletResponse r = export(id, "md");
        String disposition = r.getHeader("Content-Disposition");
        assertThat(disposition).contains("attachment").contains("filename*=UTF-8''GPU%20%E5%85%A5%E9%97%A8.zh.md");
        assertThat(export(id, "bilingual").getHeader("Content-Disposition")).contains(".bilingual.md");
        assertThat(export(id, "txt").getHeader("Content-Disposition")).contains(".zh.txt");
        MvcResult bad = perform(bearer(get("/api/doc-tasks/" + id + "/export?format=docx"), token));
        assertThat(bad.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(bad).path("code").asString()).isEqualTo("A0410");
    }

    // ---------------- 后编辑 ----------------

    @Test
    void editSegmentMarksEditedAndIsReflectedInExport() throws Exception {
        long id = createTask(GPU_DOC);
        emitSection("2.1", id);
        awaitSeq(id, 20);
        MvcResult r = perform(bearer(jsonBody(put("/api/doc-tasks/" + id + "/segments/1"),
                Map.of("target", "GPU 能加速模型训练。")), token));
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        JsonNode seg = body(r).path("data");
        assertThat(seg.path("seq").asInt()).isEqualTo(1);
        assertThat(seg.path("target").asString()).isEqualTo("GPU 能加速模型训练。");
        assertThat(seg.path("edited").asBoolean()).isTrue();
        assertThat(seg.path("status").asString()).isEqualTo("DONE");
        assertThat(export(id, "md").getContentAsString(StandardCharsets.UTF_8)).contains("\n\nGPU 能加速模型训练。\n\n");

        assertThat(perform(bearer(jsonBody(put("/api/doc-tasks/" + id + "/segments/99"), Map.of("target", "x")), token))
                .getResponse().getStatus()).isEqualTo(404);
        MvcResult missing = perform(bearer(jsonBody(put("/api/doc-tasks/" + id + "/segments/1"), Map.of()), token));
        assertThat(body(missing).path("code").asString()).isEqualTo("A0410");
        String other = registerUser(uniqueName("doco"), "Passw0rd!");
        assertThat(perform(bearer(jsonBody(put("/api/doc-tasks/" + id + "/segments/1"), Map.of("target", "x")),
                accessToken(other, "Passw0rd!"))).getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void untranslatableSegmentsCannotBeEditedOrRetranslated() throws Exception {
        String text = Files.readString(FIXTURE, StandardCharsets.UTF_8);
        long id = createTask(text);
        driveFixture(id, text, source -> source);
        int blank = -1;
        for (JsonNode s : segments(id)) {
            if (!s.path("translatable").asBoolean()) {
                blank = s.path("seq").asInt();
                break;
            }
        }
        MvcResult edit = perform(bearer(jsonBody(put("/api/doc-tasks/" + id + "/segments/" + blank),
                Map.of("target", "x")), token));
        assertThat(body(edit).path("code").asString()).isEqualTo("A0410");
        MvcResult re = perform(bearer(jsonBody(post("/api/doc-tasks/" + id + "/segments/" + blank + "/retranslate"),
                Map.of()), token));
        assertThat(body(re).path("code").asString()).isEqualTo("A0410");
    }

    // ---------------- 单段重译 ----------------

    @Test
    void retranslateAssemblesContextAndDoesNotSave() throws Exception {
        long id = createTask(GPU_DOC);
        List<ObjectNode> sample = DocStreamSample.section("2.1");
        sample.subList(0, 9).forEach(m -> emit(m, id));
        awaitSeq(id, 9);
        JsonNode terms = body(perform(bearer(get("/api/doc-tasks/" + id + "/terms"), token))).path("data");
        List<Map<String, Object>> decisions = new ArrayList<>();
        terms.forEach(t -> {
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("id", t.path("id").asLong());
            d.put("source", t.path("source").asString());
            d.put("target", "epoch".equals(t.path("source").asString()) ? "训练轮次" : t.path("target").asString());
            d.put("status", "training".equals(t.path("source").asString()) ? "REJECTED" : "CONFIRMED");
            decisions.add(d);
        });
        perform(bearer(jsonBody(post("/api/doc-tasks/" + id + "/terms/confirm"), Map.of("terms", decisions)), token));
        sample.subList(9, 20).forEach(m -> emit(m, id));
        awaitSeq(id, 20);

        int before = mockAi().requests(DocTaskService.UPSTREAM_RETRANSLATE_PATH).size();
        MvcResult r = perform(bearer(jsonBody(post("/api/doc-tasks/" + id + "/segments/3/retranslate"),
                Map.of("instruction", "更口语化")), token));
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(200);
        JsonNode result = body(r).path("data");
        assertThat(result.path("target").asString()).isEqualTo("重译：Use the GPU for each epoch.（更口语化）");
        assertThat(result.path("usage").path("promptTokens").asInt()).isEqualTo(12);
        assertThat(result.path("usage").path("completionTokens").asInt()).isEqualTo(5);
        assertThat(result.path("latencyMs").asInt()).isEqualTo(321);
        // 不自动保存
        assertThat(segments(id).get(3).path("target").asString()).isEqualTo("每个训练轮次都使用图形处理器。");
        assertThat(segments(id).get(3).path("edited").asBoolean()).isFalse();

        List<MockAiServer.Received> received = mockAi().requests(DocTaskService.UPSTREAM_RETRANSLATE_PATH);
        assertThat(received).hasSize(before + 1);
        MockAiServer.Received req = received.getLast();
        assertThat(req.internalToken()).isEqualTo("test-internal-token");
        assertThat(req.traceId()).isNotBlank();
        JsonNode b = req.body();
        assertThat(b.path("taskId").asLong()).isEqualTo(id);
        assertThat(b.path("seq").asInt()).isEqualTo(3);
        assertThat(b.path("source").asString()).isEqualTo("Use the GPU for each epoch.");
        assertThat(b.path("prevSource").asString()).isEqualTo("Usage");
        assertThat(b.path("prevTarget").asString()).isEqualTo("用法");
        assertThat(b.path("nextSource").isNull()).isTrue();
        assertThat(b.path("summary").asString()).isEqualTo("本文简要介绍 GPU 在模型训练中的作用及其使用方式。");
        assertThat(b.path("targetLang").asString()).isEqualTo("zh");
        assertThat(b.path("style").asString()).isEqualTo("faithful");
        assertThat(b.path("domain").asString()).isEqualTo("计算机");
        assertThat(b.path("instruction").asString()).isEqualTo("更口语化");
        List<String> pairs = new ArrayList<>();
        b.path("terms").forEach(t -> pairs.add(t.path("source").asString() + "=" + t.path("target").asString()));
        assertThat(pairs).containsExactlyInAnyOrder("GPU=图形处理器", "epoch=训练轮次");

        // 不带要求
        MvcResult plain = perform(bearer(post("/api/doc-tasks/" + id + "/segments/1/retranslate"), token));
        assertThat(body(plain).path("data").path("target").asString()).isEqualTo("重译：A GPU accelerates training.");
        assertThat(mockAi().requests(DocTaskService.UPSTREAM_RETRANSLATE_PATH).getLast().body()
                .path("nextSource").asString()).isEqualTo("Usage");
    }

    @Test
    void retranslateUpstreamFailureReturnsC0110() throws Exception {
        long id = createTask("[[mock:http500]] broken\n");
        emit(event(id, 1, "parsed", "{\"segments\":[{\"seq\":0,\"blockType\":\"paragraph\",\"prefix\":\"\","
                + "\"source\":\"[[mock:http500]] broken\",\"suffix\":\"\\n\",\"translatable\":true}],"
                + "\"chunks\":[{\"index\":0,\"segSeqs\":[0],\"group\":0}],\"detectedLang\":\"en\"}"));
        awaitSeq(id, 1);
        MvcResult r = perform(bearer(post("/api/doc-tasks/" + id + "/segments/0/retranslate"), token));
        assertThat(r.getResponse().getStatus()).isEqualTo(503);
        assertThat(body(r).path("code").asString()).isEqualTo("C0110");
        assertThat(AiServiceClient.INTERNAL_TOKEN_HEADER).isEqualTo("X-Internal-Token");
    }
}
