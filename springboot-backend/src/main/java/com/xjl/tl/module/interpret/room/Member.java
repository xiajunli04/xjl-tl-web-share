package com.xjl.tl.module.interpret.room;

import org.springframework.web.socket.WebSocketSession;

/**
 * 房间成员（内存状态，见 add-speech-and-image-translation D9）。字段只在持有所属 {@link Room} 的锁时访问。
 * LISTEN / CONVERSE 会话只有一个成员（创建者）。
 */
public final class Member {

    final String participantId;
    final Long userId;
    final boolean host;
    String displayName;
    /** 成员语言：ROOM 为本人语言；LISTEN 为目标语言；CONVERSE 为语言 A。 */
    String lang;
    /** 是否接收语音播报。 */
    boolean tts;
    /** 当前 WebSocket 连接（离线为 null）。 */
    WebSocketSession connection;
    /** 最近一次断线时间（毫秒）；在线时为 0。加入后尚未连接时为加入时间。 */
    long disconnectedAt;
    long lastSpeechAt;
    boolean speaking;
    boolean muted;
    /** 当前发言流（首次上行音频或按键时建立）。 */
    SpeakerStream stream;
    /** 发言流建立失败或并发超限后，下次允许重试的时间。 */
    long streamRetryAt;
    /** 全局 utteranceId 偏移：重建或新建发言流时 Python 的编号从 1 重新开始，这里累加保证 "&lt;participantId&gt;:&lt;n&gt;" 不重复。 */
    int utteranceBase;
    int maxUtterance;
    /** 最近的定稿语句与 AI 对话记忆摘要（improve-prompts-and-context-memory D5），发言流重建时随 config 下发。 */
    final RecentUtterances recent = new RecentUtterances();
    String chatMemory;

    Member(String participantId, Long userId, boolean host, String displayName, String lang, boolean tts, long now) {
        this.participantId = participantId;
        this.userId = userId;
        this.host = host;
        this.displayName = displayName;
        this.lang = lang;
        this.tts = tts;
        this.disconnectedAt = now;
    }

    public String participantId() {
        return participantId;
    }

    public Long userId() {
        return userId;
    }

    public boolean host() {
        return host;
    }

    public String displayName() {
        return displayName;
    }

    public String lang() {
        return lang;
    }

    boolean online() {
        return connection != null;
    }

    /** 是否仍算作房间成员：在线，或断线未超过宽限期。 */
    boolean present(long now, long graceMs) {
        return connection != null || now - disconnectedAt < graceMs;
    }
}
