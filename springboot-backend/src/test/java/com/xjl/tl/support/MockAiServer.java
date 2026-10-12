package com.xjl.tl.support;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 用 JDK HttpServer 模拟 Python AI 服务（进程内单例，供流式集成测试共享）。
 * <p>
 * 翻译场景由原文中的标记 {@code [[mock:场景]]} 选择，缺省为 fast：
 * <ul>
 *   <li>fast / standard：按契约样例逐个事件输出（每个事件后刷新）</li>
 *   <li>pause：start 后静默 1.5 秒再输出 fast 的其余事件</li>
 *   <li>error：输出若干事件后发出 error（C0121）</li>
 *   <li>stall：输出 start 与 translate started 后不再有事件，只每 100ms 写一次注释以探测连接断开（最长 30 秒）</li>
 *   <li>truncated：输出若干事件后直接结束，没有 final</li>
 *   <li>newline：delta 文本含换行和前导空格</li>
 *   <li>passfirst：标准路径首轮评审通过（score 为 null）、refine skipped、没有 detect 事件</li>
 *   <li>http400 / http401 / http500：返回统一信封（A0420 / B0100 / B0001）；http502：返回非信封的 HTML</li>
 *   <li>会话请求（带 session 且没有场景标记）：echo，快速路径、译文为 "译：" + 原文；mode=revise：修订路径</li>
 *   <li>clarify：plan 后中断并推送 clarify 事件（登记 threadId，供 /internal/translate/resume 恢复）</li>
 *   <li>memory：final 之前推送 memory 事件；detail：retrieve 节点事件带 detail</li>
 * </ul>
 * 另外模拟 /internal/translate/resume、DELETE /internal/translate/threads/{id} 与 /internal/tm/* 翻译记忆接口，
 * 以及语音、解读与图片翻译接口（add-speech-and-image-translation 契约 §1.1–1.3、§1.5–1.7，场景见各处理器注释）。
 */
public final class MockAiServer {

    public static final String DETECT_DATA =
            "{\"lang\":\"fr\",\"confidence\":0.98,\"method\":\"lingua\",\"candidates\":[{\"lang\":\"fr\",\"confidence\":0.98},{\"lang\":\"it\",\"confidence\":0.01}]}";

    /** 收到的请求（query 为原始查询串，可能为 null）。 */
    public record Received(String path, String internalToken, String traceId, JsonNode body, String method,
                           String query) {
    }

    private static final Pattern SCENARIO = Pattern.compile("\\[\\[mock:([a-z0-9]+)]]");
    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    private static final MockAiServer INSTANCE = new MockAiServer();

    private final HttpServer server;
    private final List<Received> received = new CopyOnWriteArrayList<>();
    private final Map<String, CountDownLatch> closed = new ConcurrentHashMap<>();
    private final Set<String> threads = ConcurrentHashMap.newKeySet();

    private MockAiServer() {
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        server.setExecutor(Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "mock-ai");
            t.setDaemon(true);
            return t;
        }));
        server.createContext("/internal/translate/stream", this::translate);
        server.createContext("/internal/lang/detect", this::detect);
        server.createContext("/internal/doc/segment/retranslate", this::retranslate);
        server.createContext("/internal/translate/resume", this::resume);
        server.createContext("/internal/translate/threads/", this::deleteThread);
        server.createContext("/internal/tm/entries", this::tmEntries);
        server.createContext("/internal/tm/search", this::tmSearch);
        server.createContext("/internal/speech/engines", this::speechEngines);
        server.createContext("/internal/speech/transcribe", this::transcribe);
        server.createContext("/internal/speech/tts", this::tts);
        server.createContext("/internal/insights", this::insights);
        server.createContext("/internal/insights/ask", this::insightsAsk);
        server.createContext("/internal/image/translate", this::imageTranslate);
        server.start();
    }

    /** 当前仍"存在"的追问检查点（clarify 场景登记，resume 成功或 DELETE 后移除）。 */
    public boolean hasThread(String threadId) {
        return threads.contains(threadId);
    }

    public static MockAiServer get() {
        return INSTANCE;
    }

    public String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** 原文包含 marker 的请求。 */
    public List<Received> requestsContaining(String marker) {
        return received.stream().filter(r -> r.body().path("text").asString("").contains(marker)).toList();
    }

    /** 发往 path 的请求。 */
    public List<Received> requests(String path) {
        return received.stream().filter(r -> r.path().equals(path)).toList();
    }

    /** 原文为 text 的 stall 请求在 Spring 断开连接时计数归零。 */
    public CountDownLatch closedLatch(String text) {
        return closed.computeIfAbsent(text, k -> new CountDownLatch(1));
    }

    // ---------------- 处理器 ----------------

    private void detect(HttpExchange ex) throws IOException {
        record(ex);
        byte[] bytes = ("{\"code\":\"00000\",\"message\":\"成功\",\"data\":" + DETECT_DATA + "}").getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(200, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    /**
     * 单段重译（design D11）：返回 "重译：" + 原文（附加要求时追加 "（要求）"）；原文含 [[mock:http500]] 时返回 500 信封。
     */
    private void retranslate(HttpExchange ex) throws IOException {
        JsonNode body = record(ex);
        String source = body.path("source").asString("");
        int status = 200;
        String json;
        if (source.contains("[[mock:http500]]")) {
            status = 500;
            json = "{\"code\":\"B0001\",\"message\":\"系统执行出错\",\"data\":null,\"traceId\":\"t\"}";
        } else {
            String instruction = body.path("instruction").asString(null);
            String target = "重译：" + source + (instruction == null ? "" : "（" + instruction + "）");
            json = "{\"code\":\"00000\",\"message\":\"成功\",\"data\":{\"target\":"
                    + MAPPER.writeValueAsString(target)
                    + ",\"usage\":{\"promptTokens\":12,\"completionTokens\":5},\"latencyMs\":321}}";
        }
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    private void translate(HttpExchange ex) throws IOException {
        JsonNode body = record(ex);
        String text = body.path("text").asString("");
        Matcher m = SCENARIO.matcher(text);
        boolean explicit = m.find();
        String scenario = explicit ? m.group(1) : "fast";
        if ("revise".equals(body.path("mode").asString(""))) {
            scenario = "revise";
        } else if (!explicit && body.path("session").isObject()) {
            // 会话请求缺省按原文生成译文，便于断言后续轮次的会话上下文
            scenario = "echo";
        }
        if (scenario.startsWith("http")) {
            int status = Integer.parseInt(scenario.substring(4));
            String errorBody = switch (status) {
                case 400 -> "{\"code\":\"A0420\",\"message\":\"不支持的语种：xx\",\"data\":null,\"traceId\":\"t\"}";
                case 401 -> "{\"code\":\"B0100\",\"message\":\"内部服务鉴权失败\",\"data\":null,\"traceId\":\"t\"}";
                case 500 -> "{\"code\":\"B0001\",\"message\":\"系统执行出错\",\"data\":null,\"traceId\":\"t\"}";
                default -> "<html>Bad Gateway</html>";
            };
            byte[] bytes = errorBody.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", errorBody.startsWith("<") ? "text/html" : "application/json");
            ex.sendResponseHeaders(status, bytes.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(bytes);
            }
            return;
        }
        ex.getResponseHeaders().add("Content-Type", "text/event-stream");
        ex.getResponseHeaders().add("Cache-Control", "no-cache");
        ex.sendResponseHeaders(200, 0);
        OutputStream os = ex.getResponseBody();
        try {
            switch (scenario) {
                case "standard" -> replay(os, SampleStreams.upstream("standard"), 0, 10);
                case "pause" -> {
                    List<SampleStreams.Event> events = SampleStreams.upstream("fast");
                    write(os, events.getFirst());
                    sleep(1500);
                    replay(os, events.subList(1, events.size()), 0, 0);
                }
                case "error" -> {
                    replay(os, SampleStreams.upstream("fast").subList(0, 6), 0, 0);
                    write(os, new SampleStreams.Event("error",
                            "{\"code\":\"C0121\",\"message\":\"LLM 鉴权失败（API Key 无效）\"}"));
                }
                case "truncated" -> replay(os, SampleStreams.upstream("fast").subList(0, 6), 0, 0);
                case "newline" -> {
                    write(os, new SampleStreams.Event("start", "{\"requestId\":\"req-nl\"}"));
                    write(os, new SampleStreams.Event("delta", "{\"round\":0,\"text\":\"hello\"}"));
                    write(os, new SampleStreams.Event("delta", "{\"round\":0,\"text\":\"\\n  world\"}"));
                    write(os, new SampleStreams.Event("final",
                            "{\"translation\":\"hello\\n  world\",\"sourceLang\":\"en\",\"targetLang\":\"zh\",\"path\":\"fast\","
                                    + "\"domain\":\"通用\",\"compliance\":[],\"usage\":{\"promptTokens\":1,\"completionTokens\":2},\"latencyMs\":5}"));
                }
                case "stall" -> stall(os, text);
                case "passfirst" -> replay(os, passFirst(), 0, 0);
                case "echo" -> replay(os, echo(text), 0, 0);
                case "revise" -> replay(os, revise(body), 0, 0);
                case "clarify" -> replay(os, clarify(), 0, 0);
                case "memory" -> replay(os, memory(text), 0, 0);
                case "detail" -> replay(os, detail(text), 0, 0);
                default -> replay(os, SampleStreams.upstream("fast"), 0, 10);
            }
            os.close();
        } catch (IOException e) {
            // 下游已断开
            closedLatch(text).countDown();
        }
    }

    /** 标准路径、首轮评审即通过（评审 JSON 解析失败，score 为 null）、用户指定源语言（没有 detect 事件）。 */
    private static List<SampleStreams.Event> passFirst() {
        return List.of(
                new SampleStreams.Event("start", "{\"requestId\":\"req-pass\"}"),
                new SampleStreams.Event("node", "{\"seq\":1,\"node\":\"analyze\",\"status\":\"started\"}"),
                new SampleStreams.Event("terms", "{\"hits\":[{\"source\":\"GPU\",\"target\":\"图形处理器\",\"glossaryId\":7}],\"skippedGlossaries\":[]}"),
                new SampleStreams.Event("node", "{\"seq\":2,\"node\":\"analyze\",\"status\":\"completed\",\"summary\":\"命中 1 条术语\",\"latencyMs\":3}"),
                new SampleStreams.Event("node", "{\"seq\":3,\"node\":\"plan\",\"status\":\"started\"}"),
                new SampleStreams.Event("plan", "{\"path\":\"standard\",\"domain\":\"计算机\",\"reason\":\"命中术语\"}"),
                new SampleStreams.Event("node", "{\"seq\":4,\"node\":\"plan\",\"status\":\"completed\",\"summary\":\"标准路径\",\"latencyMs\":1}"),
                new SampleStreams.Event("node", "{\"seq\":5,\"node\":\"retrieve\",\"status\":\"started\"}"),
                new SampleStreams.Event("node", "{\"seq\":6,\"node\":\"retrieve\",\"status\":\"completed\",\"summary\":\"上下文包\",\"latencyMs\":1}"),
                new SampleStreams.Event("node", "{\"seq\":7,\"node\":\"translate\",\"status\":\"started\"}"),
                new SampleStreams.Event("delta", "{\"round\":0,\"text\":\"图形处理器\"}"),
                new SampleStreams.Event("node", "{\"seq\":8,\"node\":\"translate\",\"status\":\"completed\",\"summary\":\"首译完成\",\"latencyMs\":10,\"usage\":{\"promptTokens\":10,\"completionTokens\":3}}"),
                new SampleStreams.Event("node", "{\"seq\":9,\"node\":\"review\",\"status\":\"started\"}"),
                new SampleStreams.Event("review", "{\"round\":0,\"score\":null,\"passed\":true,\"issues\":[]}"),
                new SampleStreams.Event("node", "{\"seq\":10,\"node\":\"review\",\"status\":\"completed\",\"summary\":\"评审结果解析失败，视为通过\",\"latencyMs\":8}"),
                new SampleStreams.Event("node", "{\"seq\":11,\"node\":\"refine\",\"status\":\"skipped\",\"summary\":\"评审通过，无需修正\"}"),
                new SampleStreams.Event("node", "{\"seq\":12,\"node\":\"finalize\",\"status\":\"started\"}"),
                new SampleStreams.Event("node", "{\"seq\":13,\"node\":\"finalize\",\"status\":\"completed\",\"summary\":\"术语遵循 1/1\",\"latencyMs\":1}"),
                new SampleStreams.Event("final", "{\"translation\":\"图形处理器\",\"sourceLang\":\"en\",\"targetLang\":\"zh\",\"path\":\"standard\",\"domain\":\"计算机\","
                        + "\"compliance\":[{\"source\":\"GPU\",\"target\":\"图形处理器\",\"compliant\":true}],\"usage\":{\"promptTokens\":10,\"completionTokens\":3},\"latencyMs\":30}"));
    }

    // ---------------- 会话 / 修订 / 追问 / 记忆 场景 ----------------

    private static SampleStreams.Event ev(String event, Object data) {
        return new SampleStreams.Event(event, MAPPER.writeValueAsString(data));
    }

    private static Map<String, Object> node(int seq, String node, String status, String summary) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("seq", seq);
        m.put("node", node);
        m.put("status", status);
        if (summary != null) {
            m.put("summary", summary);
            m.put("latencyMs", 5);
        }
        return m;
    }

    private static Map<String, Object> fin(String translation, String path) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("translation", translation);
        m.put("sourceLang", "en");
        m.put("targetLang", "zh");
        m.put("path", path);
        m.put("domain", "通用");
        m.put("compliance", List.of());
        m.put("usage", Map.of("promptTokens", 20, "completionTokens", 6));
        m.put("latencyMs", 40);
        return m;
    }

    /** 会话请求缺省：快速路径，译文为 "译：" + 原文。 */
    private static List<SampleStreams.Event> echo(String text) {
        return List.of(
                ev("start", Map.of("requestId", "req-echo")),
                ev("node", node(1, "analyze", "started", null)),
                ev("detect", Map.of("lang", "en", "confidence", 0.99, "method", "lingua")),
                ev("node", node(2, "analyze", "completed", "识别为英语")),
                ev("node", node(3, "plan", "started", null)),
                ev("plan", Map.of("path", "fast", "domain", "通用", "reason", "短句")),
                ev("node", node(4, "plan", "completed", "快速路径")),
                ev("node", node(5, "translate", "started", null)),
                ev("delta", Map.of("round", 0, "text", "译：" + text)),
                ev("node", node(6, "translate", "completed", "首译完成")),
                ev("final", fin("译：" + text, "fast")));
    }

    /** 修订路径：retrieve / review 以 skipped 推送，译文为 "修订（要求）：" + 原译文。 */
    private static List<SampleStreams.Event> revise(JsonNode body) {
        String instruction = body.path("revise").path("instruction").asString("");
        String translation = "修订（" + instruction + "）：" + body.path("revise").path("baseTarget").asString("");
        Map<String, Object> f = fin(translation, "revise");
        f.put("revisionOf", body.path("revise").path("recordId").asLong());
        return List.of(
                ev("start", Map.of("requestId", "req-revise")),
                ev("node", node(1, "analyze", "completed", "沿用原记录语种")),
                ev("node", node(2, "plan", "started", null)),
                ev("plan", Map.of("path", "revise", "domain", "通用", "reason", "用户提出修订要求")),
                ev("node", node(3, "plan", "completed", "修订路径")),
                ev("node", node(4, "retrieve", "skipped", "修订路径跳过")),
                ev("node", node(5, "translate", "started", null)),
                ev("delta", Map.of("round", 0, "text", translation)),
                ev("node", node(6, "translate", "completed", "修订完成")),
                ev("node", node(7, "review", "skipped", "修订路径跳过")),
                ev("final", f));
    }

    /** 歧义追问：plan 之后 clarify 节点中断，推送 clarify 事件后结束（不发 final）。 */
    private List<SampleStreams.Event> clarify() {
        String threadId = "turn:" + UUID.randomUUID();
        threads.add(threadId);
        Map<String, Object> c = new java.util.LinkedHashMap<>();
        c.put("threadId", threadId);
        c.put("question", "bank 指什么？");
        c.put("options", List.of("银行", "河岸"));
        c.put("span", "bank");
        c.put("reason", "多义词");
        return List.of(
                ev("start", Map.of("requestId", "req-clarify")),
                ev("node", node(1, "analyze", "started", null)),
                ev("detect", Map.of("lang", "en", "confidence", 0.99, "method", "lingua")),
                ev("node", node(2, "analyze", "completed", "识别为英语")),
                ev("node", node(3, "plan", "started", null)),
                ev("plan", Map.of("path", "standard", "domain", "通用", "reason", "会话请求")),
                ev("node", node(4, "plan", "completed", "标准路径，发现歧义")),
                ev("node", node(5, "clarify", "started", null)),
                ev("node", node(6, "clarify", "interrupted", "等待澄清")),
                ev("clarify", c));
    }

    /** 追问恢复：从 clarify 之后继续；answer 含 [[mock:noclar]] 时 final 不带 clarification。 */
    private void resume(HttpExchange ex) throws IOException {
        JsonNode body = record(ex);
        String threadId = body.path("threadId").asString("");
        String answer = body.path("answer").asString("");
        List<SampleStreams.Event> events;
        if (!threads.remove(threadId)) {
            events = List.of(ev("start", Map.of("requestId", "req-resume")),
                    ev("error", Map.of("code", "A0440", "message", "追问已失效")));
        } else {
            Map<String, Object> f = fin("请把它寄到" + answer + "。", "standard");
            if (!answer.contains("[[mock:noclar]]")) {
                f.put("clarification", Map.of("question", "bank 指什么？", "options", List.of("银行", "河岸"),
                        "span", "bank", "answer", answer));
            }
            Map<String, Object> retrieve = node(8, "retrieve", "completed", "命中 1 条翻译记忆");
            retrieve.put("detail", Map.of("tmHits", List.of(Map.of("id", 5, "source", "Send it to the bank.",
                    "target", "把它寄到银行。", "fuzzy", 0.92, "semantic", 0.95, "origin", "workbench",
                    "originRef", "123")), "sessionTurns", 1));
            events = List.of(
                    ev("start", Map.of("requestId", "req-resume")),
                    ev("node", node(7, "clarify", "completed", "用户澄清：bank 指 " + answer)),
                    ev("node", retrieve),
                    ev("node", node(9, "translate", "started", null)),
                    ev("delta", Map.of("round", 0, "text", "请把它寄到" + answer + "。")),
                    ev("node", node(10, "translate", "completed", "首译完成")),
                    ev("node", node(11, "review", "completed", "评审通过")),
                    ev("node", node(12, "finalize", "completed", "完成")),
                    ev("final", f));
        }
        ex.getResponseHeaders().add("Content-Type", "text/event-stream");
        ex.sendResponseHeaders(200, 0);
        try (OutputStream os = ex.getResponseBody()) {
            replay(os, events, 0, 0);
        }
    }

    /** 会话记忆压缩：finalize 之后执行 memorize 节点，在 final 之前推送 memory 事件。 */
    private static List<SampleStreams.Event> memory(String text) {
        Map<String, Object> mem = new java.util.LinkedHashMap<>();
        mem.put("summary", "用户上周购买了 X200 耳机");
        mem.put("entities", List.of(Map.of("source", "X200", "target", "X200", "note", "耳机型号"), "非法实体"));
        mem.put("memorizedUntil", 3);
        return List.of(
                ev("start", Map.of("requestId", "req-memory")),
                ev("node", node(1, "translate", "started", null)),
                ev("delta", Map.of("round", 0, "text", "译：" + text)),
                ev("node", node(2, "translate", "completed", "首译完成")),
                ev("node", node(3, "memorize", "started", null)),
                ev("memory", mem),
                ev("node", node(4, "memorize", "completed", "已压缩第 1–3 轮")),
                ev("final", fin("译：" + text, "fast")));
    }

    /** retrieve 节点事件带 detail（翻译记忆命中与会话轮数）。 */
    private static List<SampleStreams.Event> detail(String text) {
        Map<String, Object> retrieve = node(4, "retrieve", "completed", "命中 1 条翻译记忆（最高 92%）");
        retrieve.put("detail", Map.of("tmHits", List.of(Map.of("id", 5, "source", "Restart the Pod.",
                "target", "重启 Pod。", "fuzzy", 0.92, "semantic", 0.95, "origin", "workbench", "originRef", "123")),
                "sessionTurns", 2));
        Map<String, Object> f = fin("译：" + text, "standard");
        f.put("tmHits", List.of(Map.of("id", 5, "fuzzy", 0.92)));
        return List.of(
                ev("start", Map.of("requestId", "req-detail")),
                ev("node", node(1, "plan", "started", null)),
                ev("plan", Map.of("path", "standard", "domain", "通用", "reason", "标准路径")),
                ev("node", node(2, "plan", "completed", "标准路径")),
                ev("node", node(3, "retrieve", "started", null)),
                ev("node", retrieve),
                ev("node", node(5, "translate", "started", null)),
                ev("delta", Map.of("round", 0, "text", "译：" + text)),
                ev("node", node(6, "translate", "completed", "首译完成")),
                ev("final", f));
    }

    /** DELETE /internal/translate/threads/{threadId}：不存在也返回成功。 */
    private void deleteThread(HttpExchange ex) throws IOException {
        record(ex);
        String raw = ex.getRequestURI().getRawPath().substring("/internal/translate/threads/".length());
        threads.remove(java.net.URLDecoder.decode(raw, StandardCharsets.UTF_8));
        json(ex, 200, "{\"code\":\"00000\",\"message\":\"成功\",\"data\":null}");
    }

    // ---------------- 翻译记忆 ----------------

    /**
     * POST：原文含 [[mock:c0160]] 时返回 503 + C0160，否则 written = 条目数；
     * GET：回显一条记录；DELETE /{id}：id=404 时返回 A0404。
     */
    private void tmEntries(HttpExchange ex) throws IOException {
        JsonNode body = record(ex);
        String method = ex.getRequestMethod();
        String path = ex.getRequestURI().getPath();
        if ("DELETE".equals(method)) {
            if (path.endsWith("/404")) {
                json(ex, 404, "{\"code\":\"A0404\",\"message\":\"翻译记忆不存在\",\"data\":null}");
            } else {
                json(ex, 200, "{\"code\":\"00000\",\"message\":\"成功\",\"data\":null}");
            }
            return;
        }
        if ("GET".equals(method)) {
            json(ex, 200, """
                    {"code":"00000","message":"成功","data":{"records":[{"id":7,"sourceLang":"en","targetLang":"zh",
                    "sourceText":"Restart the Pod.","targetText":"重启 Pod。","origin":"document","originRef":"42:5",
                    "hitCount":3,"lastHitAt":"2026-10-01T10:00:00+08:00","createdAt":"2026-09-30T10:00:00+08:00",
                    "updatedAt":"2026-10-01T10:00:00+08:00","embedding":"忽略未知字段"}],"total":21,"pageNum":2,"pageSize":20}}""");
            return;
        }
        boolean unavailable = false;
        for (JsonNode e : body.path("entries")) {
            unavailable |= e.path("sourceText").asString("").contains("[[mock:c0160]]");
        }
        if (unavailable) {
            json(ex, 503, "{\"code\":\"C0160\",\"message\":\"翻译记忆服务不可用\",\"data\":null}");
        } else {
            json(ex, 200, "{\"code\":\"00000\",\"message\":\"成功\",\"data\":{\"written\":" + body.path("entries").size() + "}}");
        }
    }

    /** 原文含 [[mock:c0160]] 时 available=false，否则返回一条命中。 */
    private void tmSearch(HttpExchange ex) throws IOException {
        JsonNode body = record(ex);
        if (body.path("text").asString("").contains("[[mock:c0160]]")) {
            json(ex, 200, "{\"code\":\"00000\",\"message\":\"成功\",\"data\":{\"available\":false,\"hits\":[]}}");
            return;
        }
        json(ex, 200, """
                {"code":"00000","message":"成功","data":{"available":true,"hits":[{"id":5,"source":"Restart the Pod.",
                "target":"重启 Pod。","fuzzy":0.92,"semantic":0.95,"origin":"workbench","originRef":"123"}]}}""");
    }

    // ---------------- 语音 / 解读 / 图片翻译（契约 §1） ----------------

    /** 引擎列表：cascade 与 qwen-livetranslate 可用，openai-realtime 不可用；vision 可用。 */
    public static final String ENGINES_DATA = """
            {"asr":[{"id":"local-sensevoice","type":"asr","name":"本地 SenseVoice","vendor":"本地","kind":"builtin",
              "available":true,"reason":null,"languages":["zh","en","ja","ko","yue"],"modelConfigId":null}],
             "tts":[{"id":"edge-tts","type":"tts","name":"Edge 在线语音","vendor":"微软","kind":"builtin","available":true,
              "reason":null,"languages":["zh","en","ja"],"modelConfigId":null}],
             "interpret":[
              {"id":"cascade","type":"interpret","name":"平台级联","vendor":"本平台","kind":"builtin","available":true,"reason":null,
               "languages":["zh","en","ja","ko","fr","de","es","ru","pt","it","ar","th","vi","id","tr"],"modelConfigId":null,
               "s2s":false,"maxTargets":5,"autoConverse":true,"constraint":null},
              {"id":"qwen-livetranslate","type":"interpret","name":"千问同传","vendor":"阿里百炼","kind":"config","available":true,
               "reason":null,"languages":["zh","en","ja","ko","fr","de","es","ru","pt","it"],"modelConfigId":12,
               "s2s":true,"maxTargets":3,"autoConverse":false,"constraint":null,"futureField":"忽略未知字段"},
              {"id":"openai-realtime","type":"interpret","name":"OpenAI 实时同传","vendor":"OpenAI","kind":"config",
               "available":false,"reason":"未配置 OpenAI 实时同传","languages":["zh","en"],"modelConfigId":null,
               "s2s":true,"maxTargets":3,"autoConverse":false,"constraint":null}],
             "image":[{"id":"vision","type":"image","name":"视觉模型","vendor":"本平台","kind":"config","available":true,
              "reason":null,"languages":[],"modelConfigId":2}]}""";

    /** AI 对话实时语音模型是否可用（测试可切换；切换后需以 refresh=true 刷新 Spring 的引擎缓存）。 */
    public static volatile boolean realtimeChatAvailable = true;

    /** AI 对话可用引擎（improve-speech-playback-latency D8）。 */
    static String chatEngines() {
        String rt = realtimeChatAvailable
                ? "\"available\":true,\"reason\":null,\"modelConfigId\":21,\"provider\":\"DASHSCOPE\",\"tested\":true"
                : "\"available\":false,\"reason\":\"未配置实时语音对话模型（REALTIME_CHAT）\",\"modelConfigId\":null";
        return "[{\"id\":\"cascade\",\"type\":\"chat\",\"name\":\"平台级联\",\"vendor\":\"本平台\",\"kind\":\"builtin\","
                + "\"available\":true,\"reason\":null,\"languages\":[\"zh\",\"en\",\"ja\",\"ko\"],\"modelConfigId\":null},"
                + "{\"id\":\"realtime-chat\",\"type\":\"chat\",\"name\":\"实时语音模型\",\"vendor\":\"阿里百炼\","
                + "\"kind\":\"config\",\"languages\":[\"zh\",\"en\",\"ja\",\"ko\"]," + rt + "}]";
    }

    private void speechEngines(HttpExchange ex) throws IOException {
        record(ex);
        String data = ENGINES_DATA.substring(0, ENGINES_DATA.lastIndexOf('}')) + ",\"chat\":" + chatEngines() + "}";
        json(ex, 200, "{\"code\":\"00000\",\"message\":\"成功\",\"data\":" + data + "}");
    }

    /** 听写：lang=ko 时返回 503 + C0173（引擎不可用），否则返回固定识别结果。 */
    private void transcribe(HttpExchange ex) throws IOException {
        JsonNode body = record(ex);
        if ("ko".equals(body.path("lang").asString(""))) {
            json(ex, 503, "{\"code\":\"C0173\",\"message\":\"语音引擎不可用：本地识别模型未下载\",\"data\":null}");
            return;
        }
        String engine = body.path("engine").isString() ? body.path("engine").asString() : "local-sensevoice";
        json(ex, 200, "{\"code\":\"00000\",\"message\":\"成功\",\"data\":{\"text\":\"大家好\",\"lang\":\"zh\","
                + "\"durationMs\":3120,\"engine\":" + MAPPER.writeValueAsString(engine) + "}}");
    }

    public static final byte[] TTS_BYTES = "ID3-mock-mp3-bytes".getBytes(StandardCharsets.UTF_8);

    /** 分块朗读模式下两块之间的停顿：用于断言 Spring 不整段缓冲（首块先于第二块到达客户端）。 */
    public static final long TTS_CHUNK_GAP_MS = 600;

    /**
     * 朗读：[[mock:c0172]] → 502 + C0172；[[mock:http500]] → 500 + B0001；[[mock:chunked]] → 分块传输两块、中间停顿
     * {@link #TTS_CHUNK_GAP_MS}；engine=openai-speech → PCM；否则 MP3 字节。
     */
    private void tts(HttpExchange ex) throws IOException {
        JsonNode body = record(ex);
        String text = body.path("text").asString("");
        if (text.contains("[[mock:c0172]]")) {
            json(ex, 502, "{\"code\":\"C0172\",\"message\":\"语音合成失败：edge-tts 返回 403\",\"data\":null}");
            return;
        }
        if (text.contains("[[mock:http500]]")) {
            json(ex, 500, "{\"code\":\"B0001\",\"message\":\"系统执行出错\",\"data\":null}");
            return;
        }
        boolean pcm = "openai-speech".equals(body.path("engine").asString(""));
        ex.getResponseHeaders().add("Content-Type", pcm ? "audio/L16;rate=24000" : "audio/mpeg");
        ex.getResponseHeaders().add("X-Tts-Engine", pcm ? "openai-speech" : "edge-tts");
        ex.getResponseHeaders().add("X-Tts-Voice", "en-US-AvaMultilingualNeural");
        ex.getResponseHeaders().add("X-Other", "not-forwarded");
        ex.getResponseHeaders().add("X-Tts-Cache", "miss");
        if (text.contains("[[mock:chunked]]")) {
            ex.sendResponseHeaders(200, 0);  // 0 = 分块传输
            try (OutputStream os = ex.getResponseBody()) {
                int half = TTS_BYTES.length / 2;
                os.write(TTS_BYTES, 0, half);
                os.flush();
                try {
                    Thread.sleep(TTS_CHUNK_GAP_MS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                os.write(TTS_BYTES, half, TTS_BYTES.length - half);
            }
            return;
        }
        ex.sendResponseHeaders(200, TTS_BYTES.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(TTS_BYTES);
        }
    }

    /** 解读：原文含 [[mock:http400]] 时返回 A0410。 */
    private void insights(HttpExchange ex) throws IOException {
        JsonNode body = record(ex);
        if (body.path("source").asString("").contains("[[mock:http400]]")) {
            json(ex, 400, "{\"code\":\"A0410\",\"message\":\"原文过长\",\"data\":null}");
            return;
        }
        json(ex, 200, """
                {"code":"00000","message":"成功","data":{
                 "alternatives":[{"text":"雨下得很大。","register":"中性","note":"日常叙述最常用"},
                                 {"text":"大雨滂沱。","register":"书面","note":"书面语"}],
                 "expressions":[{"source":"raining cats and dogs","target":"倾盆大雨","meaning":"形容雨下得非常大","note":"英语习语，不能直译"}],
                 "summary":"原文是英语习语，译文采用中文四字成语对应。",
                 "usage":{"promptTokens":210,"completionTokens":180}}}""");
    }

    /** 追问：delta × 2 + done；问题含 [[mock:error]] 时 delta 后发 error。 */
    private void insightsAsk(HttpExchange ex) throws IOException {
        JsonNode body = record(ex);
        ex.getResponseHeaders().add("Content-Type", "text/event-stream");
        ex.sendResponseHeaders(200, 0);
        try (OutputStream os = ex.getResponseBody()) {
            write(os, new SampleStreams.Event("delta", "{\"text\":\"因为\"}"));
            if (body.path("question").asString("").contains("[[mock:error]]")) {
                write(os, new SampleStreams.Event("error", "{\"code\":\"C0120\",\"message\":\"LLM 调用失败\"}"));
                return;
            }
            os.write(": keepalive\n\n".getBytes(StandardCharsets.UTF_8));
            write(os, new SampleStreams.Event("delta", "{\"text\":\"这是英语习语。\"}"));
            write(os, new SampleStreams.Event("done", "{\"usage\":{\"promptTokens\":50,\"completionTokens\":12}}"));
        }
    }

    /** 1×1 PNG 文件头（结果图），用于 qwen-mt-image 场景。 */
    public static final byte[] RESULT_PNG = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D,
            'I', 'H', 'D', 'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0};

    /**
     * 图片翻译 SSE：engine=qwen-mt-image → 结果图；targetLang=ko → OCR 失败（C0171）；targetLang=ja → 没有 done 就结束；
     * 其余为视觉两步法完整事件（2 个文本块，术语命中 1 条）。
     */
    private void imageTranslate(HttpExchange ex) throws IOException {
        JsonNode body = record(ex);
        String target = body.path("targetLang").asString("");
        List<SampleStreams.Event> events = new java.util.ArrayList<>();
        events.add(ev("start", Map.of("requestId", body.path("requestId").asString(""))));
        if ("qwen-mt-image".equals(body.path("engine").asString(""))) {
            events.add(ev("node", node(1, "translate", "started", null)));
            events.add(ev("node", node(2, "translate", "completed", "已生成译图")));
            events.add(ev("node", node(3, "render", "completed", "结果图已下载")));
            Map<String, Object> done = new java.util.LinkedHashMap<>();
            done.put("detectedLang", "en");
            done.put("blocks", List.of());
            done.put("termHits", List.of());
            done.put("trace", List.of(Map.of("node", "translate", "status", "completed", "summary", "已生成译图", "latencyMs", 5)));
            done.put("usage", Map.of("promptTokens", 0, "completionTokens", 0));
            done.put("latencyMs", 900);
            done.put("modelConfigId", body.path("modelConfigId").asLong());
            done.put("resultImageBase64", java.util.Base64.getEncoder().encodeToString(RESULT_PNG));
            events.add(ev("done", done));
        } else if ("ko".equals(target)) {
            events.add(ev("node", node(1, "ocr", "started", null)));
            events.add(ev("error", Map.of("code", "C0171", "message", "OCR 结果解析失败")));
        } else if ("ja".equals(target)) {
            events.add(ev("node", node(1, "ocr", "started", null)));
        } else {
            List<Map<String, Object>> ocr = List.of(
                    Map.of("id", 1, "text", "宫保鸡丁", "bbox", List.of(0.12, 0.20, 0.38, 0.26)),
                    Map.of("id", 2, "text", "麻婆豆腐", "bbox", List.of(0.12, 0.30, 0.38, 0.36)));
            List<Map<String, Object>> translated = List.of(
                    Map.of("id", 1, "text", "宫保鸡丁", "translation", "Kung Pao Chicken", "bbox", List.of(0.12, 0.20, 0.38, 0.26)),
                    Map.of("id", 2, "text", "麻婆豆腐", "translation", "Mapo Doufu", "bbox", List.of(0.12, 0.30, 0.38, 0.36)));
            events.add(ev("node", node(1, "ocr", "started", null)));
            events.add(ev("node", node(2, "ocr", "completed", "识别到 2 个文本块（中文）")));
            events.add(ev("blocks", Map.of("width", 1200, "height", 900, "detectedLang", "zh", "blocks", ocr)));
            events.add(ev("node", node(3, "terms", "completed", "命中 1 条术语")));
            events.add(ev("node", node(4, "translate", "started", null)));
            events.add(ev("node", node(5, "translate", "completed", "已翻译 2 块")));
            events.add(ev("translation", Map.of("blocks", translated)));
            events.add(ev("node", node(6, "render", "completed", "坐标已归一化")));
            Map<String, Object> done = new java.util.LinkedHashMap<>();
            done.put("detectedLang", "zh");
            done.put("blocks", translated);
            done.put("termHits", List.of(Map.of("source", "宫保鸡丁", "target", "Kung Pao Chicken", "followed", true,
                    "blockIds", List.of(1))));
            done.put("trace", List.of(Map.of("node", "ocr", "status", "completed", "summary", "识别到 2 个文本块（中文）", "latencyMs", 3210)));
            done.put("usage", Map.of("promptTokens", 1500, "completionTokens", 420));
            done.put("latencyMs", 5400);
            done.put("modelConfigId", body.path("modelConfigId").asLong());
            done.put("resultImageBase64", null);
            events.add(ev("done", done));
        }
        ex.getResponseHeaders().add("Content-Type", "text/event-stream");
        ex.sendResponseHeaders(200, 0);
        try (OutputStream os = ex.getResponseBody()) {
            replay(os, events, 0, 0);
        } catch (IOException e) {
            // 下游已断开
        }
    }

    private static void json(HttpExchange ex, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    private void stall(OutputStream os, String text) throws IOException {
        List<SampleStreams.Event> fast = SampleStreams.upstream("fast");
        write(os, fast.getFirst());
        write(os, new SampleStreams.Event("node", "{\"seq\":6,\"node\":\"translate\",\"status\":\"started\"}"));
        long deadline = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < deadline) {
            sleep(100);
            // 注释行：Spring 不转发，仅用于探测连接是否已被下游关闭
            os.write(": keepalive\n\n".getBytes(StandardCharsets.UTF_8));
            os.flush();
        }
    }

    private JsonNode record(HttpExchange ex) throws IOException {
        String raw = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        JsonNode body = raw.isBlank() ? MAPPER.createObjectNode() : MAPPER.readTree(raw);
        received.add(new Received(ex.getRequestURI().getPath(), ex.getRequestHeaders().getFirst("X-Internal-Token"),
                ex.getRequestHeaders().getFirst("X-Trace-Id"), body, ex.getRequestMethod(), ex.getRequestURI().getRawQuery()));
        return body;
    }

    private static void replay(OutputStream os, List<SampleStreams.Event> events, int from, long delayMs) throws IOException {
        for (int i = from; i < events.size(); i++) {
            write(os, events.get(i));
            if (delayMs > 0) {
                sleep(delayMs);
            }
        }
    }

    private static void write(OutputStream os, SampleStreams.Event e) throws IOException {
        os.write(("event: " + e.event() + "\ndata: " + e.data() + "\n\n").getBytes(StandardCharsets.UTF_8));
        os.flush();
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
