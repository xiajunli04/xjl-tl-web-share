package com.xjl.tl.module.interpret.room;

import com.xjl.tl.module.interpret.entity.InterpretSession;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * 一个进行中的同传会话的内存状态（add-speech-and-image-translation D9）。可变字段只在持有本对象锁时访问。
 */
public final class Room {

    public static final String HOST_ID = "p1";

    final RoomSpec spec;
    final long startedAt;
    final Map<String, Member> members = new LinkedHashMap<>();
    /** 参与过的成员与出现过的语言（结束统计用）。 */
    final Set<String> participantsEver = new LinkedHashSet<>();
    final Set<String> languagesEver = new LinkedHashSet<>();
    /** 会话内全部 metrics.e2eMs。 */
    final List<Integer> e2e = new ArrayList<>();
    int nextSeq = 2;
    boolean closed;
    /** 结束收尾中：不再转发上行音频与控制帧，但继续转发 Python 处理积压句子产生的事件。 */
    boolean ending;
    CompletableFuture<ObjectNode> endFuture;
    /** 最近一次"全部成员离线"的时间。 */
    long allOfflineSince;

    Room(RoomSpec spec, long now) {
        this.spec = spec;
        this.startedAt = now;
        this.allOfflineSince = now;
    }

    public long sessionId() {
        return spec.sessionId();
    }

    public String roomCode() {
        return spec.roomCode();
    }

    public RoomSpec spec() {
        return spec;
    }

    boolean isRoomMode() {
        return InterpretSession.MODE_ROOM.equals(spec.mode());
    }

    boolean anyOnline() {
        return members.values().stream().anyMatch(Member::online);
    }
}
