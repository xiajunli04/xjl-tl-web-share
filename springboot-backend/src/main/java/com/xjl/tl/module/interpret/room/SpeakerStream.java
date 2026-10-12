package com.xjl.tl.module.interpret.room;

import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.module.interpret.ws.PythonStreamClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.ByteBuffer;
import java.util.concurrent.CompletableFuture;
import java.util.List;

/**
 * 一条发言流 = 一个成员的麦克风 → 一条到 Python 的内部 WebSocket（add-speech-and-image-translation D3，契约 §1.8）。
 * <ul>
 *   <li>建立连接后首帧发送 config，之后转发音频帧与控制帧（targets / ptt / flush / mute / interrupt / end）</li>
 *   <li>Python 意外断开（非本端关闭、非配置错误 4400/4401、此前未收到 fatal 错误）：向该成员发送
 *       error{C0174, fatal:false} 并立即重建一次；重建后再次断开则放弃该发言流，下次上行音频时（冷却后）重新建立</li>
 *   <li>每次（重新）连接时 Python 的 utteranceId 从 1 开始，成员上的偏移量保证全局 id 不重复</li>
 * </ul>
 * 除监听器回调外，所有方法都在持有所属 {@link Room} 锁时调用；回调中先获取房间锁再处理。
 */
final class SpeakerStream {

    private static final Logger log = LoggerFactory.getLogger(SpeakerStream.class);
    static final String END_FRAME = "{\"type\":\"end\"}";

    private final RoomRegistry registry;
    private final Room room;
    private final Member member;
    private PythonStreamClient.Connection conn;
    /** 连接代次：只处理当前代次连接的回调，旧连接的迟到事件一律忽略。 */
    private int generation;
    private long connectedAt;
    private boolean closing;
    /** 收尾中：已发送 end，等待 Python 处理完积压句子后主动关闭。 */
    private CompletableFuture<Void> drained;
    private boolean rebuildUsed;
    private boolean fatal;
    private List<String> targets;

    SpeakerStream(RoomRegistry registry, Room room, Member member, List<String> targets) {
        this.registry = registry;
        this.room = room;
        this.member = member;
        this.targets = List.copyOf(targets);
    }

    Member member() {
        return member;
    }

    Room room() {
        return room;
    }

    List<String> targets() {
        return targets;
    }

    /** 本次连接相对会话开始的毫秒偏移（Python 的 startedMs / endedMs 相对连接开始）。 */
    long offsetMs() {
        return connectedAt - room.startedAt;
    }

    void markFatal() {
        fatal = true;
    }

    /** 建立连接并发送首帧 config。 */
    void start() {
        connect();
    }

    private void connect() {
        generation++;
        int g = generation;
        member.utteranceBase = member.maxUtterance;
        connectedAt = registry.now();
        fatal = false;
        conn = registry.pythonClient().connect(new Callbacks(g));
        conn.sendText(registry.configFrame(room, member, targets));
    }

    void sendAudio(ByteBuffer payload) {
        // 收尾中（已发送 end）不再上行音频
        if (conn != null && drained == null) {
            conn.sendBinary(payload);
        }
    }

    void sendControl(String json) {
        if (conn != null) {
            conn.sendText(json);
        }
    }

    /** 目标语言变化时下发 {type:"targets"}。 */
    void updateTargets(List<String> next) {
        if (!next.equals(targets)) {
            targets = List.copyOf(next);
            sendControl(registry.targetsFrame(targets));
        }
    }

    /**
     * 优雅收尾：发送 end，Python 处理完已切出的句子（翻译、合成）后发 ended 并关闭连接；
     * 返回的 future 在 Python 关闭连接时完成（超时由调用方控制）。期间事件照常转发，且不会重建连接。
     */
    CompletableFuture<Void> drain() {
        if (conn == null || closing) {
            return CompletableFuture.completedFuture(null);
        }
        if (drained == null) {
            drained = new CompletableFuture<>();
            conn.sendText(END_FRAME);
        }
        return drained;
    }

    /** 本端结束发言流：发送 end 后正常关闭。 */
    void close() {
        if (drained != null) {
            drained.complete(null);
        }
        closing = true;
        if (conn != null) {
            conn.sendText(END_FRAME);
            conn.close();
            conn = null;
        }
    }

    private void onText(int g, String text) {
        synchronized (room) {
            if (g != generation || closing || room.closed) {
                return;
            }
            registry.onPythonEvent(this, text);
        }
    }

    private void onLost(int g, int code, String reason, Throwable error) {
        synchronized (room) {
            if (drained != null && g == generation) {
                // 收尾中 Python 主动关闭：积压句子已处理完，不重建
                drained.complete(null);
                return;
            }
            if (g != generation || closing || room.closed) {
                return;
            }
            PythonStreamClient.Connection dead = conn;
            conn = null;
            if (dead != null) {
                dead.abort();
            }
            log.warn("Python 同传连接断开 session={} participant={} code={} reason={} error={}", room.sessionId(),
                    member.participantId, code, reason, error == null ? null : error.toString());
            if (fatal || code == 4400 || code == 4401) {
                // Python 已发送 error 事件（已转发给浏览器），不再重建
                registry.dropStream(this);
                return;
            }
            registry.sendError(member, ErrorCode.REALTIME_UPSTREAM_FAILED.getCode(),
                    rebuildUsed ? "实时同传上游连接中断" : "实时同传上游连接中断，正在重连", false);
            if (!rebuildUsed) {
                rebuildUsed = true;
                connect();
            } else {
                registry.dropStream(this);
            }
        }
    }

    /** 绑定连接代次的监听器。 */
    private final class Callbacks implements PythonStreamClient.Listener {
        private final int g;

        Callbacks(int g) {
            this.g = g;
        }

        @Override
        public void onText(String text) {
            SpeakerStream.this.onText(g, text);
        }

        @Override
        public void onClosed(int statusCode, String reason) {
            onLost(g, statusCode, reason, null);
        }

        @Override
        public void onFailure(Throwable error) {
            onLost(g, -1, null, error);
        }
    }
}
