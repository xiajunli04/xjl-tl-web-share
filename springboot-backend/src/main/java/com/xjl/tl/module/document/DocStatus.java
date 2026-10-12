package com.xjl.tl.module.document;

import java.util.List;
import java.util.Set;

/**
 * 文档任务状态机（见 design D9）：
 * PENDING → PARSING → ANALYZING →（AWAITING_CONFIRM）→ TRANSLATING → CONSISTENCY → COMPLETED；
 * 任意执行阶段都可能进入 FAILED；取消时经 CANCELLING 转为 CANCELLED。
 */
public final class DocStatus {

    public static final String PENDING = "PENDING";
    public static final String PARSING = "PARSING";
    public static final String ANALYZING = "ANALYZING";
    public static final String AWAITING_CONFIRM = "AWAITING_CONFIRM";
    public static final String TRANSLATING = "TRANSLATING";
    public static final String CONSISTENCY = "CONSISTENCY";
    public static final String COMPLETED = "COMPLETED";
    public static final String FAILED = "FAILED";
    public static final String CANCELLING = "CANCELLING";
    public static final String CANCELLED = "CANCELLED";

    /** 计入并发限制的状态（AWAITING_CONFIRM 不占用执行槽，不计入）。 */
    public static final List<String> RUNNING = List.of(PENDING, PARSING, ANALYZING, TRANSLATING, CONSISTENCY);

    /** 可以取消的状态：运行中或待确认术语。 */
    public static final Set<String> CANCELLABLE = Set.of(PENDING, PARSING, ANALYZING, AWAITING_CONFIRM, TRANSLATING,
            CONSISTENCY);

    /** 终结状态：SSE 发送 snapshot 后直接关闭。 */
    public static final Set<String> TERMINAL = Set.of(COMPLETED, FAILED, CANCELLED);

    private DocStatus() {
    }

    public static boolean isTerminal(String status) {
        return TERMINAL.contains(status);
    }

    /** 执行端阶段 → 任务状态；未知阶段返回 null（只记录 phase，不改状态）。assembling 属于收尾，沿用 CONSISTENCY。 */
    public static String fromPhase(String phase) {
        if (phase == null) {
            return null;
        }
        return switch (phase) {
            case "parsing" -> PARSING;
            case "analyzing" -> ANALYZING;
            case "awaiting_confirm" -> AWAITING_CONFIRM;
            case "translating" -> TRANSLATING;
            case "consistency", "assembling" -> CONSISTENCY;
            default -> null;
        };
    }
}
