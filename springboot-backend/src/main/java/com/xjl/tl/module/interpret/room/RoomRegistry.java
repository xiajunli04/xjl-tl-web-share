package com.xjl.tl.module.interpret.room;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.config.MediaProperties;
import com.xjl.tl.module.interpret.entity.InterpretSession;
import com.xjl.tl.module.interpret.service.SegmentWriter;
import com.xjl.tl.module.interpret.service.SegmentWriter.FinishInfo;
import com.xjl.tl.module.interpret.service.SegmentWriter.Speaker;
import com.xjl.tl.module.interpret.ws.PythonStreamClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 同传房间注册表（内存，add-speech-and-image-translation D3 / D7 / D9，契约 §2.6）。
 * <ul>
 *   <li>成员：创建会话时登记主持人（p1）；会议室凭房间码加入（人数上限 8、语言数上限级联 6 / S2S 4，超出 A0451；
 *       房间不存在或已关闭 A0452）；断线 30 s 内凭 participantId（或同一用户）重新加入恢复身份</li>
 *   <li>连接：握手成功后绑定成员并下发 ready 与 participants；同一成员的新连接替换旧连接</li>
 *   <li>发言流：首次上行音频或按键时建立（全局并发上限 app.media.max-streams，超出向该成员发送 A0212）；
 *       会议室成员进出时重算每条发言流的目标语言并下发 targets</li>
 *   <li>事件路由：Python 事件补 speaker、改写 utteranceId 为 "&lt;participantId&gt;:&lt;n&gt;"；transcript / translation /
 *       metrics 广播给全体，audio 只发给语言匹配且开启播报的成员；原文、译文与指标交给 SegmentWriter 合并落库；
 *       transcript.discard 照常广播，并撤销该句的上下文与转写段</li>
 *   <li>说话状态：最近 1.5 s 内有 partial / final 视为正在说话，状态变化时广播 participants</li>
 *   <li>结束：用户结束（user_end，会议室其他成员收到 host_left）、主持人断线超过宽限期（host_left）、
 *       全部连接断开 60 s（idle）；结束时关闭全部发言流，由 SegmentWriter 写完转写并更新会话后下发 ended</li>
 * </ul>
 * 每个房间的可变状态只在持有该 {@link Room} 锁时访问；向浏览器发送使用 ConcurrentWebSocketSessionDecorator，不阻塞。
 */
@Component
public class RoomRegistry implements DisposableBean {

    public static final String REASON_USER_END = "user_end";
    /** 结束时等待各发言流处理完积压句子的上限。 */
    static final java.time.Duration DRAIN_TIMEOUT = java.time.Duration.ofSeconds(8);
    public static final String REASON_HOST_LEFT = "host_left";
    public static final String REASON_IDLE = "idle";
    public static final String REASON_ERROR = "error";
    static final long SPEAKING_WINDOW_MS = 1500;
    static final long TICK_MS = 200;
    /** 发言流建立失败或并发超限后的重试冷却。 */
    static final long STREAM_RETRY_MS = 3000;
    /** 房间码字符集：大写字母与数字，去掉易混淆的 0 O 1 I L。 */
    public static final String CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    /** AI 对话中 AI 伙伴的发言人身份（add-ai-avatar-and-landing D6） */
    public static final String AI_PARTICIPANT = "ai";
    public static final String AI_NAME = "Lumi";
    static final String ROLE_ASSISTANT = "assistant";

    private static final Logger log = LoggerFactory.getLogger(RoomRegistry.class);

    private final Map<Long, Room> rooms = new ConcurrentHashMap<>();
    private final Map<String, Room> byCode = new ConcurrentHashMap<>();
    private final Map<String, Binding> connections = new ConcurrentHashMap<>();
    private final AtomicInteger activeStreams = new AtomicInteger();
    private final MediaProperties props;
    private final PythonStreamClient pythonClient;
    private final SegmentWriter segmentWriter;
    private final JsonMapper jsonMapper;
    private final ScheduledExecutorService ticker;

    public RoomRegistry(MediaProperties props, PythonStreamClient pythonClient, SegmentWriter segmentWriter,
                        JsonMapper jsonMapper) {
        this.props = props;
        this.pythonClient = pythonClient;
        this.segmentWriter = segmentWriter;
        this.jsonMapper = jsonMapper;
        this.ticker = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "interpret-room-ticker");
            t.setDaemon(true);
            return t;
        });
        ticker.scheduleWithFixedDelay(this::tick, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS);
    }

    /** 连接与成员的绑定。 */
    private record Binding(Room room, Member member) {
    }

    long now() {
        return System.currentTimeMillis();
    }

    PythonStreamClient pythonClient() {
        return pythonClient;
    }

    private long graceMs() {
        return props.rejoinGrace().toMillis();
    }

    // ---------------- 房间与成员 ----------------

    /** 登记新会话的房间，主持人 / 创建者为 p1。 */
    public Room open(RoomSpec spec) {
        long now = now();
        Room room = new Room(spec, now);
        String hostLang = spec.languages().getFirst();
        Member host = new Member(Room.HOST_ID, spec.hostUserId(), true, spec.hostName(), hostLang, spec.tts(), now);
        room.members.put(host.participantId, host);
        room.participantsEver.add(host.participantId);
        room.languagesEver.addAll(spec.languages());
        rooms.put(spec.sessionId(), room);
        if (spec.roomCode() != null) {
            byCode.put(spec.roomCode(), room);
        }
        return room;
    }

    public Room find(long sessionId) {
        Room room = rooms.get(sessionId);
        return room == null || room.closed ? null : room;
    }

    /** 按房间码查找进行中的房间（不区分大小写），不存在返回 null。 */
    public Room findByCode(String code) {
        Room room = code == null ? null : byCode.get(code.trim().toUpperCase());
        return room == null || room.closed ? null : room;
    }

    /** 房间码是否被进行中的房间占用。 */
    public boolean codeInUse(String code) {
        return byCode.containsKey(code);
    }

    /** 主持人 / 创建者成员。 */
    public Member host(Room room) {
        synchronized (room) {
            return room.members.get(Room.HOST_ID);
        }
    }

    /**
     * 加入会议室。participantId 属于同一用户时恢复原身份（同一用户再次加入也复用原成员）；主持人凭房间码加入时返回主持人身份。
     * 人数或语言数超限 A0451；房间不存在或已关闭 A0452；引擎不支持该语言 A0410。
     */
    public Member join(String code, Long userId, String displayName, String lang, String participantId, Boolean tts) {
        Room room = code == null ? null : byCode.get(code.trim().toUpperCase());
        if (room == null) {
            throw new BizException(ErrorCode.ROOM_NOT_FOUND);
        }
        synchronized (room) {
            if (room.closed || room.ending) {
                throw new BizException(ErrorCode.ROOM_NOT_FOUND);
            }
            long now = now();
            Member existing = null;
            if (participantId != null) {
                Member m = room.members.get(participantId);
                if (m != null && m.userId.equals(userId)) {
                    existing = m;
                }
            }
            if (existing == null) {
                existing = room.members.values().stream().filter(m -> m.userId.equals(userId)).findFirst().orElse(null);
            }
            if (existing != null && existing.host) {
                return existing;
            }
            final Member self = existing;
            List<Member> others = room.members.values().stream()
                    .filter(m -> m != self && m.present(now, graceMs())).toList();
            if (self == null && others.size() >= props.roomMaxMembers()) {
                throw new BizException(ErrorCode.ROOM_FULL, "会议室已满（最多 " + props.roomMaxMembers() + " 人）");
            }
            Set<String> langs = new LinkedHashSet<>();
            others.forEach(m -> langs.add(m.lang));
            langs.add(lang);
            if (langs.size() > room.spec.maxLanguages()) {
                throw new BizException(ErrorCode.ROOM_FULL, "会议室语言数已达上限（" + room.spec.maxLanguages() + " 种）");
            }
            List<String> supported = room.spec.engineLanguages();
            if (supported != null && !supported.isEmpty() && !supported.contains(lang)) {
                throw FieldError.invalid("lang", "所选引擎不支持该语言：" + lang);
            }
            Member member;
            if (self != null) {
                member = self;
                member.displayName = displayName;
                member.lang = lang;
                if (tts != null) {
                    member.tts = tts;
                }
                if (!member.online()) {
                    // 重新计算宽限期，保证新票据可以连上
                    member.disconnectedAt = now;
                }
            } else {
                member = new Member("p" + room.nextSeq++, userId, false, displayName, lang, tts == null || tts, now);
                room.members.put(member.participantId, member);
            }
            room.participantsEver.add(member.participantId);
            room.languagesEver.add(lang);
            refreshTargets(room);
            broadcastParticipants(room);
            return member;
        }
    }

    // ---------------- WebSocket 连接 ----------------

    /**
     * 握手成功后绑定连接；房间已结束或成员已不存在时返回 false（调用方发送 A0452 并关闭）。
     * 下发 ready 与 participants。
     */
    public boolean attach(WebSocketSession ws, long sessionId, String participantId, Long userId) {
        Room room = rooms.get(sessionId);
        if (room == null) {
            return false;
        }
        synchronized (room) {
            Member m = room.members.get(participantId);
            if (room.closed || m == null || !m.userId.equals(userId)) {
                return false;
            }
            WebSocketSession old = m.connection;
            if (old != null && !old.getId().equals(ws.getId())) {
                connections.remove(old.getId());
                closeQuietly(old, new CloseStatus(4409, "replaced"));
            }
            m.connection = ws;
            m.disconnectedAt = 0;
            connections.put(ws.getId(), new Binding(room, m));
            send(m, readyFrame(room, m));
            broadcastParticipants(room);
            return true;
        }
    }

    /** 浏览器上行音频：必要时建立发言流后转发。 */
    public void onAudio(String wsId, ByteBuffer payload) {
        Binding b = connections.get(wsId);
        if (b == null) {
            return;
        }
        synchronized (b.room()) {
            if (b.room().closed || b.room().ending) {
                return;
            }
            SpeakerStream s = ensureStream(b.room(), b.member());
            if (s != null) {
                s.sendAudio(payload);
            }
        }
    }

    /** 浏览器控制帧：ptt / flush / mute / interrupt 转发给发言流；end 由主持人结束会话、成员离开房间。 */
    public void onControl(String wsId, ObjectNode msg) {
        Binding b = connections.get(wsId);
        if (b == null) {
            return;
        }
        Room room = b.room();
        Member m = b.member();
        String type = msg.path("type").asString("");
        if ("end".equals(type)) {
            if (m.host) {
                end(room.sessionId(), REASON_USER_END);
            } else {
                leave(room, m);
            }
            return;
        }
        synchronized (room) {
            if (room.closed || room.ending) {
                return;
            }
            switch (type) {
                case "ptt" -> {
                    SpeakerStream s = ensureStream(room, m);
                    if (s != null) {
                        s.sendControl(write(msg));
                    }
                }
                case "flush" -> {
                    if (m.stream != null) {
                        m.stream.sendControl(write(msg));
                    }
                }
                case "interrupt" -> {
                    // 只有 AI 对话有可打断的回复；其他模式静默忽略
                    if (room.spec.chat() && m.stream != null) {
                        m.stream.sendControl(write(msg));
                    }
                }
                case "mute" -> {
                    m.muted = msg.path("muted").asBoolean(false);
                    if (m.stream != null) {
                        m.stream.sendControl(write(msg));
                    }
                }
                default -> sendError(m, ErrorCode.PARAM_INVALID.getCode(), "未知的控制帧类型：" + type, false);
            }
        }
    }

    /** 连接关闭：成员转为离线（进入宽限期）并关闭其发言流。 */
    public void detach(String wsId) {
        Binding b = connections.remove(wsId);
        if (b == null) {
            return;
        }
        Room room = b.room();
        synchronized (room) {
            Member m = b.member();
            if (m.connection == null || !m.connection.getId().equals(wsId)) {
                return;
            }
            m.connection = null;
            m.disconnectedAt = now();
            m.speaking = false;
            drainStream(room, m);
            if (!room.anyOnline()) {
                room.allOfflineSince = now();
            }
            if (!room.closed) {
                broadcastParticipants(room);
            }
        }
    }

    /** 成员主动离开（发送 end）：立即移出房间。 */
    private void leave(Room room, Member m) {
        WebSocketSession ws;
        synchronized (room) {
            if (room.closed || room.members.remove(m.participantId) == null) {
                return;
            }
            closeStream(m);
            ws = m.connection;
            m.connection = null;
            if (ws != null) {
                connections.remove(ws.getId());
            }
            if (!room.anyOnline()) {
                room.allOfflineSince = now();
            }
            refreshTargets(room);
            broadcastParticipants(room);
        }
        if (ws != null) {
            closeQuietly(ws, CloseStatus.NORMAL);
        }
    }

    // ---------------- 发言流 ----------------

    private SpeakerStream ensureStream(Room room, Member m) {
        if (m.stream != null) {
            return m.stream;
        }
        long now = now();
        if (now < m.streamRetryAt) {
            return null;
        }
        if (activeStreams.incrementAndGet() > props.maxStreams()) {
            activeStreams.decrementAndGet();
            m.streamRetryAt = now + STREAM_RETRY_MS;
            sendError(m, ErrorCode.TOO_MANY_REQUESTS.getCode(), "同传并发发言流已达上限，请稍后再试", false);
            return null;
        }
        SpeakerStream s = new SpeakerStream(this, room, m, initialTargets(room, m));
        m.stream = s;
        s.start();
        return s;
    }

    /** 放弃发言流（重建失败或 Python 报告致命错误），冷却后可重新建立。调用方持有房间锁。 */
    void dropStream(SpeakerStream s) {
        Member m = s.member();
        if (m.stream == s) {
            m.stream = null;
            activeStreams.decrementAndGet();
            m.streamRetryAt = now() + STREAM_RETRY_MS;
        }
    }

    /**
     * 断线（如刷新页面）时的发言流收尾：让 Python 处理完已切出的句子并落库，最长 DRAIN_TIMEOUT 后关闭。
     * 收尾期间发言流仍挂在成员上（不上行音频），完成后才释放，避免与重连后新建的发言流句子编号冲突。
     */
    private void drainStream(Room room, Member m) {
        SpeakerStream s = m.stream;
        if (s == null) {
            return;
        }
        s.drain()
                .completeOnTimeout(null, DRAIN_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)
                .whenComplete((v, err) -> {
                    synchronized (room) {
                        if (m.stream == s) {
                            closeStream(m);
                        }
                    }
                });
    }

    private void closeStream(Member m) {
        if (m.stream != null) {
            m.maxUtterance = Math.max(m.maxUtterance, m.utteranceBase);
            m.stream.close();
            m.stream = null;
            activeStreams.decrementAndGet();
        }
    }

    /** 当前活跃的发言流数。 */
    public int activeStreams() {
        return activeStreams.get();
    }

    private List<String> initialTargets(Room room, Member m) {
        if (room.spec.chat()) {
            // AI 对话：用户语句不翻译，AI 回复的母语字幕由 Python 按 chat 配置生成
            return List.of();
        }
        return room.isRoomMode() ? roomTargets(room, m) : room.spec.languages();
    }

    /** 会议室目标：其他在场成员语言的集合（去重、去掉本人语言）；只有本人时为 [本人语言]（只出原文）。 */
    private List<String> roomTargets(Room room, Member m) {
        long now = now();
        Set<String> langs = new LinkedHashSet<>();
        for (Member o : room.members.values()) {
            if (o != m && o.present(now, graceMs()) && !o.lang.equals(m.lang)) {
                langs.add(o.lang);
            }
        }
        return langs.isEmpty() ? List.of(m.lang) : List.copyOf(langs);
    }

    /** 成员进出后重算会议室每条发言流的目标语言。 */
    private void refreshTargets(Room room) {
        if (!room.isRoomMode()) {
            return;
        }
        for (Member m : room.members.values()) {
            if (m.stream != null) {
                m.stream.updateTargets(roomTargets(room, m));
            }
        }
    }

    String configFrame(Room room, Member m, List<String> targets) {
        RoomSpec spec = room.spec;
        ObjectNode c = jsonMapper.createObjectNode();
        c.put("type", "config");
        c.put("streamId", "s-" + spec.sessionId() + "-" + m.participantId);
        c.put("sessionId", spec.sessionId());
        c.put("userId", spec.hostUserId());
        c.put("mode", spec.mode());
        c.put("engine", spec.engine());
        List<String> sources = switch (spec.mode()) {
            case InterpretSession.MODE_LISTEN -> spec.sourceHints() == null || spec.sourceHints().isEmpty()
                    ? List.of("auto") : spec.sourceHints();
            case InterpretSession.MODE_CONVERSE, InterpretSession.MODE_CHAT -> spec.languages();
            default -> List.of(m.lang);
        };
        c.set("sourceLangs", jsonMapper.valueToTree(sources));
        c.set("targetLangs", jsonMapper.valueToTree(targets));
        c.put("converseRouting", spec.converseRouting());
        c.set("glossaryIds", jsonMapper.valueToTree(spec.glossaryIds() == null ? List.of() : spec.glossaryIds()));
        c.put("domainHint", spec.domainHint());
        if (spec.modelConfigId() == null) {
            c.putNull("modelConfigId");
        } else {
            c.put("modelConfigId", spec.modelConfigId());
        }
        c.put("asrEngine", spec.asrEngine());
        c.put("ttsEngine", spec.ttsEngine());
        boolean tts = spec.tts();
        if (room.isRoomMode()) {
            long now = now();
            tts = room.members.values().stream().anyMatch(o -> o != m && o.tts && o.present(now, graceMs()));
        }
        c.put("tts", tts);
        c.set("voices", jsonMapper.valueToTree(spec.voices() == null ? Map.of() : spec.voices()));
        c.put("gender", spec.gender());
        c.put("latencyMode", spec.latencyMode());
        if (spec.chat()) {
            ObjectNode chat = c.putObject("chat");
            chat.put("scenario", spec.chatScenario());
            chat.put("myLang", spec.languages().get(0));
            chat.put("aiLang", spec.languages().get(1));
            chat.put("persona", AI_NAME);
            // 发言流重建（Python 断线重连）时不再重复开场白
            chat.put("greet", m.maxUtterance == 0);
            chat.put("memory", m.chatMemory);
        }
        // 发言流重建时恢复上下文：本成员最近的定稿语句（首次建流时为空数组）
        c.set("history", m.recent.toJson(jsonMapper));
        return write(c);
    }

    String targetsFrame(List<String> targets) {
        ObjectNode t = jsonMapper.createObjectNode();
        t.put("type", "targets");
        t.set("targetLangs", jsonMapper.valueToTree(targets));
        return write(t);
    }

    // ---------------- Python 事件路由 ----------------

    /** 处理一条 Python 事件（调用方持有房间锁）。 */
    void onPythonEvent(SpeakerStream s, String text) {
        JsonNode parsed = parse(text);
        if (!(parsed instanceof ObjectNode ev)) {
            return;
        }
        Room room = s.room();
        Member m = s.member();
        String type = ev.path("type").asString("");
        switch (type) {
            case "ready", "ended" -> {
                // 发言流级别的就绪 / 结束不转发：浏览器的 ready 与 ended 由 Spring 按会话下发
                return;
            }
            case "error" -> {
                if (ev.path("fatal").asBoolean(false)) {
                    s.markFatal();
                }
                send(m, write(ev));
                return;
            }
            case "memory" -> {
                // AI 对话记忆摘要：只暂存，供发言流重建时下发；不转发给浏览器、不落库
                String summary = ev.path("summary").asString("");
                if (!summary.isBlank()) {
                    m.chatMemory = summary;
                }
                return;
            }
            default -> {
                // 其余事件继续处理
            }
        }
        boolean assistant = room.spec.chat() && ROLE_ASSISTANT.equals(ev.path("role").asString(""));
        String uid = rewriteUtterance(ev, m, assistant ? room.spec : null);
        Speaker speaker = assistant ? new Speaker(AI_PARTICIPANT, AI_NAME, null)
                : new Speaker(m.participantId, m.displayName, m.userId);
        long sessionId = room.sessionId();
        switch (type) {
            case "transcript.partial" -> {
                if (!assistant) {
                    markSpeaking(room, m);
                }
            }
            case "transcript.final" -> {
                if (!assistant) {
                    markSpeaking(room, m);
                }
                if (uid != null) {
                    String lang = ev.path("lang").asString(null);
                    m.recent.transcript(uid, assistant ? ROLE_ASSISTANT : RecentUtterances.ROLE_USER, lang,
                            ev.path("text").asString(""));
                    // AI 回复期待一条母语字幕（与对话语言相同时没有）
                    List<String> targets = assistant ? List.of(room.spec.languages().get(0)) : s.targets();
                    segmentWriter.transcript(sessionId, uid, speaker, lang, ev.path("text").asString(""),
                            offset(s, ev.get("startedMs")), offset(s, ev.get("endedMs")),
                            expectedTargets(targets, lang));
                }
            }
            case "translation.final" -> {
                if (uid != null) {
                    m.recent.translation(uid, ev.path("lang").asString(""), ev.path("text").asString(""));
                    segmentWriter.translation(sessionId, uid, speaker, ev.path("lang").asString(""),
                            ev.path("text").asString(""));
                }
            }
            case "metrics" -> {
                JsonNode e2e = ev.get("e2eMs");
                if (e2e != null && e2e.isNumber()) {
                    room.e2e.add(e2e.asInt());
                }
                if (uid != null) {
                    segmentWriter.metrics(sessionId, uid, speaker, metricsOf(ev));
                }
            }
            case "reply.interrupted" -> m.recent.interrupted(uid, ev.path("text").asString(""));
            case "transcript.discard" -> {
                // 撤回一句（噪声 / 语气词，或让位撤回的 AI 回复）：不再作为上下文，撤销待写或已写的转写段；照常广播
                if (uid != null) {
                    m.recent.remove(uid);
                    segmentWriter.discard(sessionId, uid);
                }
            }
            default -> {
                // translation.delta / audio 只转发
            }
        }
        String json = write(ev);
        if ("audio".equals(type)) {
            routeAudio(room, ev.path("lang").asString(""), json);
        } else {
            broadcast(room, json);
        }
    }

    /**
     * utteranceId 改写为 "&lt;participantId&gt;:&lt;n&gt;" 并补 speaker；没有 utteranceId 的事件返回 null。
     * AI 对话中 role=assistant 的事件（aiSpec 非空）发言人为 AI，utteranceId 仍按本人发言流编号以保证唯一。
     */
    private String rewriteUtterance(ObjectNode ev, Member m, RoomSpec aiSpec) {
        JsonNode raw = ev.get("utteranceId");
        if (raw == null || raw.isNull()) {
            return null;
        }
        int n = raw.isNumber() ? raw.asInt() : parseInt(raw.asString(""));
        String uid;
        if (n > 0) {
            int global = m.utteranceBase + n;
            m.maxUtterance = Math.max(m.maxUtterance, global);
            uid = m.participantId + ":" + global;
        } else {
            uid = m.participantId + ":" + raw.asString("");
        }
        ev.put("utteranceId", uid);
        ObjectNode speaker = ev.putObject("speaker");
        if (aiSpec != null) {
            speaker.put("participantId", AI_PARTICIPANT);
            speaker.put("displayName", AI_NAME);
            speaker.put("lang", aiSpec.languages().get(1));
        } else {
            speaker.put("participantId", m.participantId);
            speaker.put("displayName", m.displayName);
            speaker.put("lang", m.lang);
        }
        return uid;
    }

    private static int parseInt(String s) {
        try {
            return Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static Integer offset(SpeakerStream s, JsonNode ms) {
        return ms != null && ms.isNumber() ? (int) (s.offsetMs() + ms.asLong()) : null;
    }

    /** 期望到齐的译文语言：发言流当前目标去掉源语种（yue 视为 zh）。 */
    static Set<String> expectedTargets(List<String> targets, String sourceLang) {
        String src = "yue".equals(sourceLang) ? "zh" : sourceLang;
        Set<String> expected = new LinkedHashSet<>(targets);
        if (src != null) {
            expected.remove(src);
        }
        return expected;
    }

    private ObjectNode metricsOf(ObjectNode ev) {
        ObjectNode m = jsonMapper.createObjectNode();
        for (String f : new String[]{"asrMs", "mtFirstMs", "mtMs", "ttsFirstMs", "e2eMs", "holdMs"}) {
            JsonNode v = ev.get(f);
            if (v != null) {
                m.set(f, v);
            }
        }
        return m;
    }

    private void markSpeaking(Room room, Member m) {
        m.lastSpeechAt = now();
        if (!m.speaking) {
            m.speaking = true;
            broadcastParticipants(room);
        }
    }

    /** audio：会议室只发给语言匹配且开启播报的在线成员；LISTEN / CONVERSE 只有一个连接，全部下发。 */
    private void routeAudio(Room room, String lang, String json) {
        for (Member m : room.members.values()) {
            if (m.online() && (!room.isRoomMode() || (m.tts && m.lang.equals(lang)))) {
                sendText(m.connection, json);
            }
        }
    }

    private void broadcast(Room room, String json) {
        for (Member m : room.members.values()) {
            if (m.online()) {
                sendText(m.connection, json);
            }
        }
    }

    private void broadcastParticipants(Room room) {
        long now = now();
        ObjectNode p = jsonMapper.createObjectNode();
        p.put("type", "participants");
        ArrayNode list = p.putArray("list");
        for (Member m : room.members.values()) {
            if (!m.present(now, graceMs())) {
                continue;
            }
            ObjectNode o = list.addObject();
            o.put("participantId", m.participantId);
            o.put("displayName", m.displayName);
            o.put("lang", m.lang);
            o.put("speaking", m.speaking);
            o.put("isHost", m.host);
            o.put("online", m.online());
        }
        broadcast(room, write(p));
    }

    private String readyFrame(Room room, Member m) {
        RoomSpec spec = room.spec;
        ObjectNode r = jsonMapper.createObjectNode();
        r.put("type", "ready");
        r.put("sessionId", spec.sessionId());
        r.put("participantId", m.participantId);
        r.put("mode", spec.mode());
        r.put("engine", spec.engine());
        r.set("languages", jsonMapper.valueToTree(room.isRoomMode() ? List.of(m.lang) : spec.languages()));
        r.put("roomCode", spec.roomCode());
        r.put("isHost", m.host);
        return write(r);
    }

    void sendError(Member m, String code, String message, boolean fatal) {
        ObjectNode e = jsonMapper.createObjectNode();
        e.put("type", "error");
        e.put("code", code);
        e.put("message", message);
        e.put("fatal", fatal);
        send(m, write(e));
    }

    private void send(Member m, String json) {
        if (m.online()) {
            sendText(m.connection, json);
        }
    }

    private static void sendText(WebSocketSession ws, String json) {
        try {
            if (ws.isOpen()) {
                ws.sendMessage(new TextMessage(json));
            }
        } catch (Exception e) {
            log.debug("向浏览器发送同传事件失败 ws={}：{}", ws.getId(), e.toString());
        }
    }

    private static void closeQuietly(WebSocketSession ws, CloseStatus status) {
        try {
            ws.close(status);
        } catch (Exception e) {
            log.debug("关闭 WebSocket 失败 ws={}：{}", ws.getId(), e.toString());
        }
    }

    // ---------------- 结束 ----------------

    /**
     * 结束会话（幂等）：关闭全部发言流，SegmentWriter 写完转写并更新会话后，向在线成员发送
     * ended{reason, stats} 并关闭连接。返回结束统计（含 durationMs）；房间不存在时返回已完成的 null。
     */
    public CompletableFuture<ObjectNode> end(long sessionId, String reason) {
        Room room = rooms.get(sessionId);
        if (room == null) {
            return CompletableFuture.completedFuture(null);
        }
        List<CompletableFuture<Void>> drains = new ArrayList<>();
        synchronized (room) {
            if (room.endFuture != null) {
                return room.endFuture;
            }
            // 先收尾：停止转发新音频，让各发言流把已切出的句子翻译、合成完（最长 DRAIN_TIMEOUT），再关闭并落库
            room.ending = true;
            for (Member m : room.members.values()) {
                if (m.stream != null) {
                    drains.add(m.stream.drain());
                }
            }
            room.endFuture = CompletableFuture.allOf(drains.toArray(CompletableFuture[]::new))
                    .completeOnTimeout(null, DRAIN_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)
                    .handle((v, err) -> null)
                    .thenCompose(v -> closeAndFinish(room, reason));
        }
        // 收尾期间房间仍留在内存中：并发的结束请求（如前端在 WS end 之后再调 REST 结束接口）拿到同一个 endFuture，
        // 不会误走"残留会话"的兜底写入；收尾完成后再移除
        return room.endFuture.whenComplete((stats, err) -> {
            rooms.remove(sessionId, room);
            if (room.roomCode() != null) {
                byCode.remove(room.roomCode(), room);
            }
        });
    }

    /** 收尾完成后：关闭全部发言流，SegmentWriter 写完转写并更新会话，再通知在线成员。 */
    private CompletableFuture<ObjectNode> closeAndFinish(Room room, String reason) {
        List<Member> members;
        FinishInfo info;
        synchronized (room) {
            room.closed = true;
            members = new ArrayList<>(room.members.values());
            for (Member m : members) {
                closeStream(m);
            }
            info = new FinishInfo(room.sessionId(), List.copyOf(room.e2e), room.participantsEver.size(),
                    List.copyOf(room.languagesEver));
        }
        log.info("结束同传会话 session={} reason={}", room.sessionId(), reason);
        return segmentWriter.finish(info)
                .handle((stats, err) -> {
                    notifyEnded(room, members, reason, err == null ? stats : null);
                    return stats;
                });
    }

    private void notifyEnded(Room room, List<Member> members, String reason, ObjectNode stats) {
        for (Member m : members) {
            WebSocketSession ws;
            synchronized (room) {
                ws = m.connection;
                m.connection = null;
            }
            if (ws == null) {
                continue;
            }
            connections.remove(ws.getId());
            ObjectNode e = jsonMapper.createObjectNode();
            e.put("type", "ended");
            // 会议室由主持人结束时，其他成员看到的是"主持人离开"
            e.put("reason", REASON_USER_END.equals(reason) && room.isRoomMode() && !m.host ? REASON_HOST_LEFT : reason);
            e.set("stats", stats);
            sendText(ws, write(e));
            closeQuietly(ws, CloseStatus.NORMAL);
        }
    }

    /** 定时任务：说话状态过期、断线成员超过宽限期、主持人离开、全部断开超时。 */
    void tick() {
        long now = now();
        for (Room room : List.copyOf(rooms.values())) {
            String endReason = null;
            try {
                synchronized (room) {
                    if (room.closed) {
                        continue;
                    }
                    boolean changed = false;
                    boolean membership = false;
                    Iterator<Member> it = room.members.values().iterator();
                    while (it.hasNext()) {
                        Member m = it.next();
                        if (m.speaking && now - m.lastSpeechAt > SPEAKING_WINDOW_MS) {
                            m.speaking = false;
                            changed = true;
                        }
                        if (!m.online() && now - m.disconnectedAt >= graceMs()) {
                            if (m.host) {
                                if (room.isRoomMode()) {
                                    endReason = REASON_HOST_LEFT;
                                }
                            } else {
                                it.remove();
                                closeStream(m);
                                changed = true;
                                membership = true;
                            }
                        }
                    }
                    if (endReason == null && !room.anyOnline()
                            && now - room.allOfflineSince >= props.idleEndAfter().toMillis()) {
                        endReason = REASON_IDLE;
                    }
                    if (endReason == null) {
                        if (membership) {
                            refreshTargets(room);
                        }
                        if (changed) {
                            broadcastParticipants(room);
                        }
                    }
                }
                if (endReason != null) {
                    end(room.sessionId(), endReason);
                }
            } catch (RuntimeException e) {
                log.error("同传房间定时任务失败 session={}", room.sessionId(), e);
            }
        }
    }

    private JsonNode parse(String text) {
        try {
            return jsonMapper.readTree(text);
        } catch (RuntimeException e) {
            log.debug("Python 同传事件不是合法 JSON：{}", text);
            return null;
        }
    }

    private String write(JsonNode node) {
        return jsonMapper.writeValueAsString(node);
    }

    /** 关闭时结束全部进行中的会话（reason=error），最多等待 3 秒。 */
    @Override
    public void destroy() {
        ticker.shutdownNow();
        List<CompletableFuture<ObjectNode>> futures = new ArrayList<>();
        for (Long id : List.copyOf(rooms.keySet())) {
            futures.add(end(id, REASON_ERROR));
        }
        try {
            CompletableFuture.allOf(futures.toArray(CompletableFuture[]::new)).get(3, TimeUnit.SECONDS);
        } catch (Exception e) {
            log.warn("关闭时结束同传会话未全部完成：{}", e.toString());
        }
    }
}
