package com.xjl.tl.module.document;

import com.xjl.tl.module.document.dto.DocDtos.DocSegmentVO;
import com.xjl.tl.module.document.service.DocAssembler;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 组装规则单元测试：prefix + (target ?? source) + suffix；双语对照的交替与分隔规则。
 */
class DocAssemblerTest {

    private static DocSegmentVO seg(int seq, String type, String prefix, String source, String suffix,
                                    boolean translatable, String target) {
        return new DocSegmentVO(seq, type, null, prefix, source, suffix, translatable, 0, target, "DONE", null, null,
                null, false, null);
    }

    @Test
    void translatedUsesTargetOrFallsBackToSource() {
        List<DocSegmentVO> segs = List.of(
                seg(0, "heading", "## ", "Title", "\r\n\r\n", true, "标题"),
                seg(1, "paragraph", "", "Untranslated.", "\r\n\r\n", true, null),
                seg(2, "code", "", "```\ncode\n```\n", "", false, "不应使用"),
                seg(3, "list_item", "  - ", "item", "\n", true, "条目"));
        assertThat(DocAssembler.translated(segs))
                .isEqualTo("## 标题\r\n\r\nUntranslated.\r\n\r\n```\ncode\n```\n  - 条目\n");
    }

    @Test
    void bilingualSeparatesBlocksAndKeepsLineBlocksAdjacent() {
        List<DocSegmentVO> segs = List.of(
                seg(0, "paragraph", "", "Para.", "\n", true, "段落。"),
                seg(1, "list_item", "- ", "a", "\n", true, "甲"),
                seg(2, "table_row", "| ", "x | y", " |\n", true, "叉 | 歪"),
                seg(3, "table_row", "", "| --- | --- |", "\n", false, null),
                seg(4, "heading", "# ", "End", "", true, "完"));
        assertThat(DocAssembler.bilingual(segs)).isEqualTo(
                "Para.\n\n段落。\n"
                        + "- a\n- 甲\n"
                        + "| x | y |\n| 叉 | 歪 |\n"
                        + "| --- | --- |\n"
                        + "# End\n\n# 完");
    }

    @Test
    void bilingualKeepsCrlfStyle() {
        List<DocSegmentVO> segs = List.of(seg(0, "paragraph", "", "Line.", "\r\n", true, "行。"));
        assertThat(DocAssembler.bilingual(segs)).isEqualTo("Line.\r\n\r\n行。\r\n");
    }
}
