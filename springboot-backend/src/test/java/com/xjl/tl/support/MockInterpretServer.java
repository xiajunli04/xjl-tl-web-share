package com.xjl.tl.support;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 模拟 Python 同传 WebSocket 服务 /internal/interpret/stream（契约 §1.8，进程内单例，供同传集成测试共享）。
 * <ul>
 *   <li>首帧 config：记录配置并回复 ready；domainHint 含 [[reject]] 时发送 error{A0212, fatal:true} 后以 1011 关闭</li>
 *   <li>targets / ptt / mute 控制帧：记录；end：以 1000 关闭</li>
 *   <li>flush：模拟说完一句话，按契约顺序发出 transcript.partial、transcript.final、各目标的 translation.delta /
 *       translation.final / audio，最后 metrics。源语种为 sourceLangs[0]（auto 视为 zh），可用 flush 帧的 mockLang 覆盖</li>
 *   <li>domainHint 场景：[[drop]] 该发言流第一条连接在 flush 时以 1011 断开；[[dropalways]] 每条连接都断开；
 *       [[partial]] 只发 transcript.final 与第一个目标的 translation.final（无 metrics，用于段合并超时）；
 *       [[drain]] 收到 end 时先模拟处理完一句积压的话（同 flush）再以 1000 关闭；
 *       [[memory]]（CHAT）每条 AI 回复后发一条 memory{summary, turns}</li>
 *   <li>flush 帧带 mockDrop=true 时以 1011 断开（模拟进行中的连接意外中断）；带 mockDiscard=true 时只发该句的
 *       partial{hold:true} 与 transcript.discard（模拟语气词 / 噪声被撤回）</li>
 *   <li>interrupt 帧带 yield=true 时对最近一条 AI 回复发 transcript.discard（模拟回复让位）</li>
 *   <li>CHAT 模式：flush 的用户句只发转写与 metrics（仅 asrMs），随后发一条 role=assistant 的 AI 回复（对话语言原文、母语字幕、音频、metrics）；
 *       interrupt：记录并回发 reply.interrupted（针对最近一条 AI 回复）</li>
 * </ul>
 */
public final class MockInterpretServer extends WebSocketServer {

    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    private static final MockInterpretServer INSTANCE = new MockInterpretServer();

    /** 一条发言流连接的状态。 */
    public static final class Stream {
        public final String internalToken;
        public volatile JsonNode config;
        public volatile List<String> targets = List.of();
        public final AtomicInteger audioFrames = new AtomicInteger();
        public final List<JsonNode> controls = new CopyOnWriteArrayList<>();
        public volatile boolean closed;
        final AtomicInteger utterance = new AtomicInteger();

        Stream(String internalToken) {
            this.internalToken = internalToken;
        }

        public String streamId() {
            return config == null ? null : config.path("streamId").asString(null);
        }

        public String domainHint() {
            return config == null ? "" : config.path("domainHint").asString("");
        }
    }

    private final Map<WebSocket, Stream> states = new ConcurrentHashMap<>();
    private final List<Stream> all = new CopyOnWriteArrayList<>();
    private final Map<String, AtomicInteger> connectionsPerStream = new ConcurrentHashMap<>();
    private final CountDownLatch started = new CountDownLatch(1);

    private MockInterpretServer() {
        super(new InetSocketAddress("127.0.0.1", 0));
        setReuseAddr(true);
        setDaemon(true);
        start();
        try {
            if (!started.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("模拟同传服务启动超时");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    public static MockInterpretServer get() {
        return INSTANCE;
    }

    public String url() {
        return "ws://127.0.0.1:" + getPort() + "/internal/interpret/stream";
    }

    /** 全部发言流连接（含已关闭的）。 */
    public List<Stream> streams() {
        return List.copyOf(all);
    }

    /** 某发言流最近一条连接，没有返回 null。 */
    public Stream latest(String streamId) {
        Stream found = null;
        for (Stream s : all) {
            if (streamId.equals(s.streamId())) {
                found = s;
            }
        }
        return found;
    }

    /** 某发言流建立过的连接数（收到 config 的次数）。 */
    public int connections(String streamId) {
        AtomicInteger n = connectionsPerStream.get(streamId);
        return n == null ? 0 : n.get();
    }

    @Override
    public void onStart() {
        started.countDown();
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        Stream s = new Stream(handshake.getFieldValue("X-Internal-Token"));
        states.put(conn, s);
        all.add(s);
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        Stream s = states.remove(conn);
        if (s != null) {
            s.closed = true;
        }
    }

    @Override
    public void onMessage(WebSocket conn, ByteBuffer message) {
        Stream s = states.get(conn);
        if (s != null) {
            s.audioFrames.incrementAndGet();
        }
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        Stream s = states.get(conn);
        if (s == null) {
            return;
        }
        JsonNode msg = MAPPER.readTree(message);
        String type = msg.path("type").asString("");
        switch (type) {
            case "config" -> {
                s.config = msg;
                s.targets = strings(msg.path("targetLangs"));
                connectionsPerStream.computeIfAbsent(s.streamId(), k -> new AtomicInteger()).incrementAndGet();
                if (s.domainHint().contains("[[reject]]")) {
                    send(conn, obj("type", "error", "code", "A0212", "message", "并发发言流已达上限").put("fatal", true));
                    conn.close(1011, "too many streams");
                    return;
                }
                ObjectNode ready = obj("type", "ready", "engine", msg.path("engine").asString(""));
                ready.set("sourceLangs", msg.path("sourceLangs"));
                ready.set("targetLangs", msg.path("targetLangs"));
                send(conn, ready);
            }
            case "targets" -> {
                s.controls.add(msg);
                s.targets = strings(msg.path("targetLangs"));
            }
            case "flush" -> {
                s.controls.add(msg);
                flush(conn, s, msg);
            }
            case "end" -> {
                s.controls.add(msg);
                if (s.domainHint().contains("[[drain]]")) {
                    flush(conn, s, msg);
                }
                conn.close(1000, "end");
            }
            case "interrupt" -> {
                s.controls.add(msg);
                int last = s.utterance.get();
                if (last > 0 && msg.path("yield").asBoolean(false)) {
                    send(conn, obj("type", "transcript.discard", "role", "assistant").put("utteranceId", last));
                } else if (last > 0) {
                    send(conn, obj("type", "reply.interrupted", "role", "assistant", "text", "AI 回复")
                            .put("utteranceId", last));
                }
            }
            default -> s.controls.add(msg);
        }
    }

    private void flush(WebSocket conn, Stream s, JsonNode msg) {
        String hint = s.domainHint();
        if (msg.path("mockDrop").asBoolean(false)
                || hint.contains("[[dropalways]]") || (hint.contains("[[drop]]") && connections(s.streamId()) == 1)) {
            conn.close(1011, "upstream reset");
            return;
        }
        int n = s.utterance.incrementAndGet();
        String src = msg.path("mockLang").asString(null);
        if (src == null) {
            List<String> sources = strings(s.config.path("sourceLangs"));
            src = sources.isEmpty() || "auto".equals(sources.getFirst()) ? "zh" : sources.getFirst();
        }
        String text = "第" + n + "句";
        if (msg.path("mockDiscard").asBoolean(false)) {
            send(conn, obj("type", "transcript.partial", "text", "嗯").put("utteranceId", n).put("hold", true));
            send(conn, obj("type", "transcript.discard").put("utteranceId", n));
            return;
        }
        if ("CHAT".equals(s.config.path("mode").asString(""))) {
            chatTurn(conn, s, n, text);
            return;
        }
        send(conn, obj("type", "transcript.partial", "text", "第").put("utteranceId", n));
        send(conn, obj("type", "transcript.final", "text", text, "lang", src).put("utteranceId", n)
                .put("startedMs", 100).put("endedMs", 900));
        List<String> targets = new ArrayList<>();
        for (String t : s.targets) {
            if (!t.equals(src)) {
                targets.add(t);
            }
        }
        if (hint.contains("[[partial]]")) {
            if (!targets.isEmpty()) {
                send(conn, obj("type", "translation.final", "lang", targets.getFirst(), "text", "[" + targets.getFirst() + "]" + text)
                        .put("utteranceId", n).put("ttsFallback", false));
            }
            return;
        }
        for (String t : targets) {
            send(conn, obj("type", "translation.delta", "lang", t, "delta", "[" + t + "]").put("utteranceId", n));
            send(conn, obj("type", "translation.final", "lang", t, "text", "[" + t + "]" + text)
                    .put("utteranceId", n).put("ttsFallback", false));
            send(conn, obj("type", "audio", "lang", t, "format", "pcm16", "data", "AAAA")
                    .put("utteranceId", n).put("sampleRate", 24000).put("seq", 1).put("last", true));
        }
        send(conn, obj("type", "metrics").put("utteranceId", n).put("asrMs", 100).put("mtFirstMs", 200)
                .put("mtMs", 300).put("ttsFirstMs", 400).put("e2eMs", 1000 + n * 100).put("holdMs", n * 10));
    }

    /** CHAT：用户句（只转写）+ AI 回复（新 utteranceId，role=assistant）。 */
    private void chatTurn(WebSocket conn, Stream s, int n, String text) {
        JsonNode chat = s.config.path("chat");
        String my = chat.path("myLang").asString("zh");
        String ai = chat.path("aiLang").asString("en");
        send(conn, obj("type", "transcript.final", "text", text, "lang", my).put("utteranceId", n)
                .put("startedMs", 100).put("endedMs", 900));
        // 用户句没有译文，只带识别耗时的 metrics（转写段据此完成合并）
        send(conn, obj("type", "metrics").put("utteranceId", n).put("asrMs", 100));
        int r = s.utterance.incrementAndGet();
        String reply = "[" + ai + "]回复" + r;
        send(conn, obj("type", "transcript.partial", "role", "assistant", "text", "[" + ai + "]").put("utteranceId", r));
        send(conn, obj("type", "transcript.final", "role", "assistant", "text", reply, "lang", ai).put("utteranceId", r));
        if (!my.equals(ai)) {
            send(conn, obj("type", "translation.final", "role", "assistant", "lang", my, "text", "[" + my + "]回复" + r)
                    .put("utteranceId", r).put("ttsFallback", false));
        }
        send(conn, obj("type", "audio", "role", "assistant", "lang", ai, "format", "pcm16", "data", "AAAA")
                .put("utteranceId", r).put("sampleRate", 24000).put("seq", 1).put("last", true));
        send(conn, obj("type", "metrics", "role", "assistant").put("utteranceId", r).put("e2eMs", 2000));
        if (s.domainHint().contains("[[memory]]")) {
            send(conn, obj("type", "memory", "summary", "摘要至第" + r + "句").put("turns", n));
        }
    }

    private static List<String> strings(JsonNode arr) {
        List<String> out = new ArrayList<>();
        arr.forEach(n -> out.add(n.asString()));
        return out;
    }

    private static ObjectNode obj(String... kv) {
        ObjectNode o = MAPPER.createObjectNode();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            o.put(kv[i], kv[i + 1]);
        }
        return o;
    }

    private static void send(WebSocket conn, JsonNode node) {
        if (conn.isOpen()) {
            conn.send(MAPPER.writeValueAsString(node));
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        // 测试中忽略连接错误
    }
}
