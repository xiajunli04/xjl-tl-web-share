package com.xjl.tl.module.session;

import com.xjl.tl.module.session.service.SessionTurns;
import com.xjl.tl.module.session.service.SessionTurns.Row;
import com.xjl.tl.module.session.service.SessionTurns.Turn;
import com.xjl.tl.module.translate.dto.TranslateDtos.MemorizeTurnPayload;
import com.xjl.tl.module.translate.dto.TranslateDtos.SessionTurnPayload;
import org.junit.jupiter.api.Test;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 会话轮次组装规则（契约 A）：轮次编号、版本链与采用版本、窗口与截断、待压缩轮次。
 */
class SessionTurnsTest {

    private static final OffsetDateTime T0 = OffsetDateTime.parse("2026-10-01T10:00:00+08:00");

    private static Row row(long id, String source, String target, Long revisionOf, boolean adopted, boolean deleted) {
        return new Row(id, source, target, revisionOf, revisionOf == null ? null : "更口语", adopted, deleted,
                revisionOf == null ? "auto" : "revise", revisionOf == null ? "fast" : "revise", null, null,
                T0.plusMinutes(id));
    }

    private static List<Row> plainTurns(int n) {
        List<Row> rows = new ArrayList<>();
        for (int i = 1; i <= n; i++) {
            rows.add(row(i, "s" + i, "t" + i, null, true, false));
        }
        return rows;
    }

    @Test
    void revisionsBelongToTheirRootTurnAndAdoptedVersionWins() {
        List<Row> rows = List.of(
                row(1, "a", "A", null, true, false),
                row(2, "b", "B", null, false, false),
                row(3, "b", "B2", 2L, false, false),
                row(4, "b", "B3", 3L, true, false),
                row(5, "c", "C", null, true, true),
                row(6, "d", "D", null, false, false));
        List<Turn> turns = SessionTurns.build(rows);
        assertThat(turns).extracting(Turn::seq).containsExactly(1, 2, 3, 4);
        assertThat(turns.get(1).versions()).extracting(Row::id).containsExactly(2L, 3L, 4L);
        assertThat(turns.get(1).adopted().id()).isEqualTo(4L);
        // 已删除记录仍占轮次号，但没有可见版本
        assertThat(turns.get(2).versions()).isEmpty();
        assertThat(turns.get(2).adopted()).isNull();
        // 没有 adopted=true 时取最新版本
        assertThat(turns.get(3).adopted().id()).isEqualTo(6L);
        assertThat(SessionTurns.turnOf(turns, rows, 3L).seq()).isEqualTo(2);
        assertThat(SessionTurns.turnOf(turns, rows, 99L)).isNull();

        List<SessionTurnPayload> recent = SessionTurns.recentTurns(turns, 5, 0);
        assertThat(recent).extracting(SessionTurnPayload::seq).containsExactly(1, 2, 4);
        assertThat(recent.get(1).target()).isEqualTo("B3");
        assertThat(recent.get(1).instruction()).isEqualTo("更口语");
    }

    @Test
    void windowKeepsLastSixTurnsBeforeCurrentAndTruncatesSource() {
        List<Row> rows = plainTurns(8);
        rows.set(7, row(8, "x".repeat(600), "t8", null, true, false));
        List<Turn> turns = SessionTurns.build(rows);
        // 第 1–2 轮已并入摘要：窗口为最近 6 轮
        List<SessionTurnPayload> recent = SessionTurns.recentTurns(turns, 9, 2);
        assertThat(recent).extracting(SessionTurnPayload::seq).containsExactly(3, 4, 5, 6, 7, 8);
        assertThat(recent.getLast().source()).hasSize(SessionTurns.MAX_SOURCE);
        // 修订轮：只取被修订轮之前的轮次
        assertThat(SessionTurns.recentTurns(turns, 2, 0)).extracting(SessionTurnPayload::seq).containsExactly(1);
    }

    @Test
    void windowCoversTurnsNotYetMemorized() {
        // improve-prompts-and-context-memory D6：滑出 6 轮但尚未压缩的轮次仍以原文出现，不留缺口
        List<Turn> turns = SessionTurns.build(plainTurns(11));
        assertThat(SessionTurns.recentTurns(turns, 9, 0)).extracting(SessionTurnPayload::seq)
                .containsExactly(1, 2, 3, 4, 5, 6, 7, 8);
        assertThat(SessionTurns.recentTurns(turns, 8, 0)).extracting(SessionTurnPayload::seq)
                .containsExactly(1, 2, 3, 4, 5, 6, 7);
        // 第 1–3 轮已压缩：第 10 轮带第 4–9 轮
        assertThat(SessionTurns.recentTurns(turns, 10, 3)).extracting(SessionTurnPayload::seq)
                .containsExactly(4, 5, 6, 7, 8, 9);
        // 压缩持续失败时最多 8 轮
        assertThat(SessionTurns.recentTurns(turns, 12, 0)).extracting(SessionTurnPayload::seq)
                .containsExactly(4, 5, 6, 7, 8, 9, 10, 11);
        // 修订较早的轮次：未压缩轮数为 0，仍取该轮之前的轮次（最多 6 轮）
        assertThat(SessionTurns.recentTurns(turns, 2, 6)).extracting(SessionTurnPayload::seq).containsExactly(1);
    }

    @Test
    void totalLengthOverLimitDropsEarliestTurns() {
        List<Row> rows = new ArrayList<>();
        for (int i = 1; i <= 4; i++) {
            rows.add(row(i, "s".repeat(400), "t".repeat(900), null, true, false));
        }
        List<SessionTurnPayload> recent = SessionTurns.recentTurns(SessionTurns.build(rows), 5, 0);
        // 每轮 1300 字符：4 轮 5200 > 4000，丢弃最早一轮后 3900
        assertThat(recent).extracting(SessionTurnPayload::seq).containsExactly(2, 3, 4);
    }

    @Test
    void toMemorizeNeedsAtLeastThreeTurnsOutsideWindow() {
        List<Turn> turns = SessionTurns.build(plainTurns(8));
        List<MemorizeTurnPayload> m = SessionTurns.toMemorize(turns, 9, 0);
        assertThat(m).extracting(MemorizeTurnPayload::seq).containsExactly(1, 2, 3);
        assertThat(m.getFirst().source()).isEqualTo("s1");
        assertThat(m.getFirst().target()).isEqualTo("t1");
        assertThat(SessionTurns.toMemorize(turns, 8, 0)).isEmpty();
        assertThat(SessionTurns.toMemorize(turns, 9, 1)).isEmpty();
    }

    @Test
    void brokenRevisionChainUsesMissingParentAsRoot() {
        List<Row> rows = List.of(row(1, "a", "A", null, true, false), row(5, "b", "B", 4L, true, false));
        List<Turn> turns = SessionTurns.build(rows);
        assertThat(turns).hasSize(1);
        assertThat(SessionTurns.turnOf(turns, rows, 5L)).isNull();
    }
}
