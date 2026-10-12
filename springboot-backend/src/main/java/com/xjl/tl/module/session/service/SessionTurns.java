package com.xjl.tl.module.session.service;

import com.xjl.tl.module.translate.dto.TranslateDtos.MemorizeTurnPayload;
import com.xjl.tl.module.translate.dto.TranslateDtos.SessionTurnPayload;
import tools.jackson.databind.JsonNode;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 会话轮次的组装规则（纯函数，见共享契约 A）：
 * <ul>
 *   <li>轮次（turn）= 会话内 revision_of 为空的记录，按创建顺序编号（含已从历史删除的记录，保证轮次号稳定）</li>
 *   <li>修订是该轮的版本：沿 revision_of 追溯到根记录即所属轮次；版本链只含未删除的记录</li>
 *   <li>采用版本：分支中 adopted=true 的记录（多条时取最新），没有则取最新版本</li>
 *   <li>上下文窗口：本轮之前尚未并入摘要的采用版本，至少取最近 6 轮、最多 8 轮（滑出 6 轮但还不足 3 轮、尚未压缩的轮次
 *       仍以原文出现，不留缺口），原文截断到 500 字符，总量超过 4000 字符时从最早的轮次丢弃</li>
 *   <li>待压缩：seq ≤ 本轮 seq - 6 且 &gt; memorizedUntil 的轮次，不足 3 轮时为空</li>
 * </ul>
 */
public final class SessionTurns {

    public static final int WINDOW = 6;
    public static final int MAX_SOURCE = 500;
    public static final int MAX_TOTAL = 4000;
    public static final int MIN_MEMORIZE = 3;
    /** 窗口上限：6 轮窗口 + 最多 2 轮已滑出但尚未压缩的轮次。 */
    public static final int MAX_WINDOW = WINDOW + MIN_MEMORIZE - 1;

    private SessionTurns() {
    }

    /** 会话内的一条记录（含已删除的记录，用于稳定编号）。 */
    public record Row(long id, String sourceText, String targetText, Long revisionOf, String reviseInstruction,
                      boolean adopted, boolean deleted, String mode, String path, Integer reviewScore,
                      JsonNode clarification, OffsetDateTime createdAt) {
    }

    /** 一轮：版本链（未删除，按创建顺序）与采用版本（没有可见版本时为 null）。 */
    public record Turn(int seq, long rootId, List<Row> versions, Row adopted) {
    }

    /** 按创建顺序（rows 已按 created_at, id 升序）组装全部轮次，包括没有可见版本的轮次。 */
    public static List<Turn> build(List<Row> rows) {
        Map<Long, Row> byId = new HashMap<>();
        rows.forEach(r -> byId.put(r.id(), r));
        Map<Long, List<Row>> branches = new LinkedHashMap<>();
        for (Row r : rows) {
            if (r.revisionOf() == null) {
                branches.put(r.id(), new ArrayList<>());
            }
        }
        for (Row r : rows) {
            Long root = rootOf(r, byId);
            List<Row> branch = branches.get(root);
            if (branch != null && !r.deleted()) {
                branch.add(r);
            }
        }
        List<Turn> turns = new ArrayList<>();
        int seq = 0;
        for (Map.Entry<Long, List<Row>> e : branches.entrySet()) {
            seq++;
            List<Row> versions = e.getValue();
            Row adopted = null;
            for (Row v : versions) {
                if (v.adopted()) {
                    adopted = v;
                }
            }
            if (adopted == null && !versions.isEmpty()) {
                adopted = versions.getLast();
            }
            turns.add(new Turn(seq, e.getKey(), List.copyOf(versions), adopted));
        }
        return turns;
    }

    /** 沿 revision_of 追溯到根记录 id（链断裂时以断点为根）。 */
    static Long rootOf(Row r, Map<Long, Row> byId) {
        Row cur = r;
        int guard = 0;
        while (cur.revisionOf() != null && guard++ < 10_000) {
            Row parent = byId.get(cur.revisionOf());
            if (parent == null) {
                return cur.revisionOf();
            }
            cur = parent;
        }
        return cur.id();
    }

    /** 记录所属轮次；记录不在会话中时返回 null。 */
    public static Turn turnOf(List<Turn> turns, List<Row> rows, long recordId) {
        Map<Long, Row> byId = new HashMap<>();
        rows.forEach(r -> byId.put(r.id(), r));
        Row row = byId.get(recordId);
        if (row == null) {
            return null;
        }
        Long root = rootOf(row, byId);
        return turns.stream().filter(t -> t.rootId() == root).findFirst().orElse(null);
    }

    /**
     * 本轮之前的上下文（seq 升序）：尚未并入摘要（seq &gt; memorizedUntil）的轮次，至少取最近 6 轮、最多 8 轮；
     * 按总量上限从最早的轮次丢弃。修订较早的轮次时未压缩轮数可能为 0，仍取最近 6 轮。
     */
    public static List<SessionTurnPayload> recentTurns(List<Turn> turns, int turnSeq, int memorizedUntil) {
        List<Turn> before = turns.stream().filter(t -> t.seq() < turnSeq && t.adopted() != null).toList();
        long pending = before.stream().filter(t -> t.seq() > memorizedUntil).count();
        int take = (int) Math.max(WINDOW, Math.min(pending, MAX_WINDOW));
        List<SessionTurnPayload> recent = new ArrayList<>();
        for (Turn t : before.subList(Math.max(0, before.size() - take), before.size())) {
            Row a = t.adopted();
            recent.add(new SessionTurnPayload(t.seq(), truncate(a.sourceText(), MAX_SOURCE), a.targetText(),
                    a.reviseInstruction()));
        }
        while (!recent.isEmpty() && totalLength(recent) > MAX_TOTAL) {
            recent.removeFirst();
        }
        return recent;
    }

    /** 待压缩进摘要的轮次：seq ≤ turnSeq - 6 且 &gt; memorizedUntil，不足 3 轮时为空。 */
    public static List<MemorizeTurnPayload> toMemorize(List<Turn> turns, int turnSeq, int memorizedUntil) {
        List<MemorizeTurnPayload> out = turns.stream()
                .filter(t -> t.adopted() != null && t.seq() <= turnSeq - WINDOW && t.seq() > memorizedUntil)
                .map(t -> new MemorizeTurnPayload(t.seq(), t.adopted().sourceText(), t.adopted().targetText()))
                .toList();
        return out.size() >= MIN_MEMORIZE ? out : List.of();
    }

    private static int totalLength(List<SessionTurnPayload> turns) {
        int n = 0;
        for (SessionTurnPayload t : turns) {
            n += length(t.source()) + length(t.target()) + length(t.instruction());
        }
        return n;
    }

    private static int length(String s) {
        return s == null ? 0 : s.length();
    }

    /** 按码点截断（不拆开代理对）。 */
    static String truncate(String s, int max) {
        if (s == null || s.codePointCount(0, s.length()) <= max) {
            return s;
        }
        return s.substring(0, s.offsetByCodePoints(0, max));
    }
}
