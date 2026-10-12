package com.xjl.tl.support;

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
 * 读取共享契约样例 docs/contracts/translate-stream-sample.txt（design D5）。
 * 样例是浏览器收到的版本；{@link #upstream(String)} 去掉 final 中的 recordId，即 Python 发出的版本。
 */
public final class SampleStreams {

    /** 一个 SSE 事件。 */
    public record Event(String event, String data) {
    }

    private static final Path FILE = Path.of("..", "docs", "contracts", "translate-stream-sample.txt");
    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    private static final Map<String, List<Event>> STREAMS = load();

    private SampleStreams() {
    }

    /** 浏览器版本（final 带 recordId）。 */
    public static List<Event> browser(String name) {
        List<Event> events = STREAMS.get(name);
        if (events == null) {
            throw new IllegalArgumentException("样例中没有流：" + name);
        }
        return events;
    }

    /** Python 版本（final 不带 recordId）。 */
    public static List<Event> upstream(String name) {
        return browser(name).stream().map(e -> {
            if (!"final".equals(e.event())) {
                return e;
            }
            ObjectNode n = (ObjectNode) MAPPER.readTree(e.data());
            n.remove("recordId");
            return new Event(e.event(), MAPPER.writeValueAsString(n));
        }).toList();
    }

    private static Map<String, List<Event>> load() {
        List<String> lines;
        try {
            lines = Files.readAllLines(FILE, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("无法读取契约样例 " + FILE.toAbsolutePath(), e);
        }
        Map<String, List<Event>> result = new LinkedHashMap<>();
        List<Event> current = null;
        String event = null;
        for (String line : lines) {
            if (line.startsWith("### STREAM:")) {
                current = new ArrayList<>();
                result.put(line.substring("### STREAM:".length()).trim(), current);
                continue;
            }
            if (current == null || line.startsWith("#") || line.startsWith(":")) {
                continue;
            }
            if (line.startsWith("event:")) {
                event = line.substring("event:".length()).trim();
            } else if (line.startsWith("data:")) {
                current.add(new Event(event, line.substring("data:".length()).trim()));
                event = null;
            }
        }
        return result;
    }
}
