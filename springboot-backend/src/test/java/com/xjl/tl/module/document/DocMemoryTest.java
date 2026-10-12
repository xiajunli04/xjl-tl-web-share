package com.xjl.tl.module.document;

import com.xjl.tl.support.MockAiServer;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * document-task / tasks 3.6：translationMemory 选项、段落 tmHits、后编辑异步写入翻译记忆、一键写入（仅 COMPLETED，分批 200）。
 */
class DocMemoryTest extends DocTaskTestBase {

    private static final String ENTRIES = "/internal/tm/entries";

    /** 解析出给定段落（全部在分块 0），返回事件序号的下一个值。 */
    private int parsed(long id, List<Map<String, Object>> segments) {
        ObjectNode data = jsonMapper.createObjectNode();
        data.set("segments", jsonMapper.valueToTree(segments));
        ArrayNode seqs = jsonMapper.createArrayNode();
        segments.forEach(s -> seqs.add((Integer) s.get("seq")));
        ArrayNode chunks = data.putArray("chunks");
        chunks.addObject().put("index", 0).set("segSeqs", seqs);
        data.put("detectedLang", "en");
        emit(event(id, 1, "parsed", jsonMapper.writeValueAsString(data)));
        return 2;
    }

    private static Map<String, Object> seg(int seq, String source, boolean translatable) {
        return Map.of("seq", seq, "blockType", translatable ? "paragraph" : "code", "prefix", "", "source", source,
                "suffix", "\n\n", "translatable", translatable);
    }

    private List<MockAiServer.Received> entriesWith(String originRef) {
        return mockAi().requests(ENTRIES).stream()
                .filter(r -> "POST".equals(r.method()))
                .filter(r -> r.body().path("entries").valueStream()
                        .anyMatch(e -> originRef.equals(e.path("originRef").asString())))
                .toList();
    }

    @Test
    void optionCanBeDisabledAndIsPersisted() throws Exception {
        Map<String, Object> body = createBody("# T\n\nHello.");
        body.put("options", Map.of("translationMemory", false));
        JsonNode task = body(createRaw(body, token)).path("data");
        assertThat(task.path("options").path("translationMemory").asBoolean()).isFalse();
        assertThat(task.path("options").path("contextWindow").asBoolean()).isTrue();
        long id = task.path("id").asLong();
        JsonNode payload = jsonMapper.readTree(commandsFor(id).getFirst().get("payload"));
        assertThat(payload.path("options").path("translationMemory").asBoolean()).isFalse();
        assertThat(detail(id).path("options").path("translationMemory").asBoolean()).isFalse();
    }

    @Test
    void segmentTmHitsEditWriteAndBulkWrite() throws Exception {
        long id = createTask("# GPU Basics\n\nA GPU accelerates training.");
        int seq = parsed(id, List.of(
                seg(0, "GPU Basics", true),
                seg(1, "Run ⟦0⟧ on the GPU.", true),
                seg(2, "```\ncode\n```", false),
                seg(3, "Untranslated paragraph.", true),
                seg(4, "Broken [[mock:c0160]] memory.", true)));
        String chunkDone = """
                {"chunk":0,"segments":[
                 {"seq":0,"target":"图形处理器基础","reviewScore":95,"reviewRounds":0,"compliance":[],
                  "tmHits":[{"id":5,"source":"GPU basics","target":"图形处理器基础","fuzzy":0.92,"semantic":0.97,
                   "origin":"document","originRef":"9:0"}]},
                 {"seq":1,"target":"在 GPU 上运行 ⟦0⟧。","reviewScore":90,"reviewRounds":0,"compliance":[]},
                 {"seq":2,"target":"不应写入","reviewScore":null,"reviewRounds":null,"compliance":[]}],
                 "tmHits":[{"seq":0,"fuzzy":0.92,"origin":"document"}],"usage":{"promptTokens":1,"completionTokens":1},
                 "latencyMs":1,"cached":false}""";
        emit(event(id, seq++, "chunk_done", chunkDone));
        awaitSeq(id, seq - 1);
        JsonNode segs = segments(id);
        assertThat(segs.get(0).path("tmHits").size()).isEqualTo(1);
        assertThat(segs.get(0).path("tmHits").get(0).path("fuzzy").asDouble()).isEqualTo(0.92);
        assertThat(segs.get(1).path("tmHits").isArray()).isTrue();
        assertThat(segs.get(1).path("tmHits").size()).isZero();
        assertThat(segs.get(3).path("tmHits").size()).isZero();

        // 未完成的任务不能一键写入
        MvcResult early = perform(bearer(post("/api/doc-tasks/" + id + "/memory"), token));
        assertThat(early.getResponse().getStatus()).isEqualTo(409);
        assertThat(body(early).path("code").asString()).isEqualTo("A0431");

        // 后编辑：立即返回，随后异步写入（原文去掉受保护标记）
        MvcResult edit = perform(bearer(jsonBody(put("/api/doc-tasks/" + id + "/segments/3"),
                Map.of("target", "未翻译的段落。")), token));
        assertThat(edit.getResponse().getStatus()).isEqualTo(200);
        assertThat(body(edit).path("data").path("edited").asBoolean()).isTrue();
        awaitUntil(() -> !entriesWith(id + ":3").isEmpty(), "等待编辑后写入翻译记忆");
        MockAiServer.Received w = entriesWith(id + ":3").getFirst();
        assertThat(w.body().path("userId").asLong()).isEqualTo(userId);
        JsonNode entry = w.body().path("entries").get(0);
        assertThat(w.body().path("entries").size()).isEqualTo(1);
        assertThat(entry.path("sourceLang").asString()).isEqualTo("en");
        assertThat(entry.path("targetLang").asString()).isEqualTo("zh");
        assertThat(entry.path("sourceText").asString()).isEqualTo("Untranslated paragraph.");
        assertThat(entry.path("targetText").asString()).isEqualTo("未翻译的段落。");
        assertThat(entry.path("origin").asString()).isEqualTo("document");

        // 写入失败（C0160）不影响编辑结果
        MvcResult failing = perform(bearer(jsonBody(put("/api/doc-tasks/" + id + "/segments/4"),
                Map.of("target", "坏掉的记忆。")), token));
        assertThat(failing.getResponse().getStatus()).isEqualTo(200);
        awaitUntil(() -> !entriesWith(id + ":4").isEmpty(), "等待异步写入调用");
        assertThat(segments(id).get(4).path("target").asString()).isEqualTo("坏掉的记忆。");

        // 完成后一键写入：只写可翻译且有译文的段落（seq 4 因模拟 C0160 不能在同一批，先清空它的译文）
        jdbcTemplate.update("UPDATE biz.doc_segment SET target_text = NULL WHERE task_id = ? AND seq = 4", id);
        emit(event(id, seq++, "completed", "{\"usage\":{\"promptTokens\":1,\"completionTokens\":1},\"latencyMs\":5}"));
        awaitSeq(id, seq - 1);
        int before = mockAi().requests(ENTRIES).size();
        MvcResult bulk = perform(bearer(post("/api/doc-tasks/" + id + "/memory"), token));
        assertThat(bulk.getResponse().getStatus()).isEqualTo(200);
        assertThat(body(bulk).path("data").path("written").asInt()).isEqualTo(3);
        List<MockAiServer.Received> calls = mockAi().requests(ENTRIES);
        assertThat(calls).hasSize(before + 1);
        JsonNode entries = calls.getLast().body().path("entries");
        assertThat(entries.valueStream().map(e -> e.path("originRef").asString()).toList())
                .containsExactly(id + ":0", id + ":1", id + ":3");
        assertThat(entries.get(1).path("sourceText").asString()).isEqualTo("Run  on the GPU.");

        String other = registerUser(uniqueName("dmo"), "Passw0rd!");
        assertThat(perform(bearer(post("/api/doc-tasks/" + id + "/memory"), accessToken(other, "Passw0rd!")))
                .getResponse().getStatus()).isEqualTo(404);
    }

    @Test
    void bulkWriteIsBatchedByTwoHundredAndC0160IsReturned() throws Exception {
        long id = createTask("# Many\n\nLines.");
        int n = 205;
        List<Map<String, Object>> list = new java.util.ArrayList<>();
        StringBuilder done = new StringBuilder("{\"chunk\":0,\"segments\":[");
        for (int i = 0; i < n; i++) {
            list.add(seg(i, "Line " + i + ".", true));
            done.append(i == 0 ? "" : ",").append("{\"seq\":").append(i).append(",\"target\":\"第 ").append(i)
                    .append(" 行。\",\"compliance\":[]}");
        }
        done.append("],\"cached\":false}");
        int seq = parsed(id, list);
        emit(event(id, seq++, "chunk_done", done.toString()));
        emit(event(id, seq++, "completed", "{}"));
        awaitSeq(id, seq - 1);
        int before = mockAi().requests(ENTRIES).size();
        JsonNode r = body(perform(bearer(post("/api/doc-tasks/" + id + "/memory"), token))).path("data");
        assertThat(r.path("written").asInt()).isEqualTo(n);
        List<MockAiServer.Received> calls = mockAi().requests(ENTRIES).subList(before, mockAi().requests(ENTRIES).size());
        assertThat(calls).extracting(c -> c.body().path("entries").size()).containsExactly(200, 5);

        jdbcTemplate.update("UPDATE biz.doc_segment SET source_text = 'x [[mock:c0160]]' WHERE task_id = ? AND seq = 0", id);
        MvcResult fail = perform(bearer(post("/api/doc-tasks/" + id + "/memory"), token));
        assertThat(fail.getResponse().getStatus()).isEqualTo(503);
        assertThat(body(fail).path("code").asString()).isEqualTo("C0160");
    }
}
