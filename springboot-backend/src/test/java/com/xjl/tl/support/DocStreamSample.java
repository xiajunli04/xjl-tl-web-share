package com.xjl.tl.support;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 读取共享契约样例 docs/contracts/doc-stream-sample.md（design D2）：按标题分节收集 jsonl 代码块中的消息，
 * 并按线上格式（全部字段为字符串、payload / data 为单行 JSON）转换为 Stream 字段。
 */
public final class DocStreamSample {

    private static final Path FILE = Path.of("..", "docs", "contracts", "doc-stream-sample.md");
    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    /** 标题（如 "2.1 开启术语确认的完整执行…"）→ 消息。 */
    private static final Map<String, List<ObjectNode>> SECTIONS = load();

    private DocStreamSample() {
    }

    /** 标题以 prefix 开头的小节中的全部消息（如 "1." 命令、"2.1"、"2.2"、"2.3"）。 */
    public static List<ObjectNode> section(String prefix) {
        return SECTIONS.entrySet().stream()
                .filter(e -> e.getKey().startsWith(prefix))
                .findFirst()
                .map(Map.Entry::getValue)
                .orElseThrow(() -> new IllegalArgumentException("样例中没有小节：" + prefix))
                .stream().map(ObjectNode::deepCopy).toList();
    }

    /** 转为 Stream 字段：taskId 替换为 taskId，数字转字符串，对象转单行 JSON。 */
    public static Map<String, String> toFields(ObjectNode message, long taskId) {
        Map<String, String> fields = new LinkedHashMap<>();
        for (Map.Entry<String, JsonNode> e : message.properties()) {
            JsonNode v = e.getValue();
            String value = v.isContainer() ? MAPPER.writeValueAsString(v) : v.asString();
            fields.put(e.getKey(), value);
        }
        if (fields.containsKey("taskId")) {
            fields.put("taskId", String.valueOf(taskId));
        }
        return fields;
    }

    private static Map<String, List<ObjectNode>> load() {
        List<String> lines;
        try {
            lines = Files.readAllLines(FILE, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("无法读取契约样例 " + FILE.toAbsolutePath(), e);
        }
        Map<String, List<ObjectNode>> result = new LinkedHashMap<>();
        String heading = "";
        boolean inJsonl = false;
        for (String line : lines) {
            if (!inJsonl && line.startsWith("#")) {
                heading = line.replaceFirst("^#+\\s*", "").trim();
                continue;
            }
            if (line.startsWith("```jsonl")) {
                inJsonl = true;
                result.computeIfAbsent(heading, k -> new ArrayList<>());
                continue;
            }
            if (line.startsWith("```")) {
                inJsonl = false;
                continue;
            }
            if (inJsonl && !line.isBlank()) {
                result.get(heading).add((ObjectNode) MAPPER.readTree(line));
            }
        }
        return result;
    }
}
