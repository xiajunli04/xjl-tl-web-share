package com.xjl.tl.module.document.service;

import com.xjl.tl.module.document.dto.DocDtos.DocSegmentVO;

import java.util.List;
import java.util.Set;

/**
 * 全文组装（design D3「组装（P6）由 Spring 按 prefix + (target ?? source) + suffix 拼接」）。
 * <p>
 * 执行端保证 {@code 拼接(prefix + source + suffix) == 原文}（逐字节，含 CRLF），因此"译文 = 原文"时导出结果与原文完全一致；
 * 没有译文（未翻译或不可翻译）的段落使用原文。
 *
 * <h2>导出格式</h2>
 * <ul>
 *   <li><b>md</b>（译文 Markdown）：逐段输出 {@code prefix + (target ?? source) + suffix}</li>
 *   <li><b>txt</b>（纯文本）：与 md 相同的拼接规则（对 txt 源文档即纯文本译文；对 md 源文档保留其标记，
 *       以免丢失列表缩进、表格与代码块结构），以 text/plain 下载</li>
 *   <li><b>bilingual</b>（双语对照 Markdown）：原文段与译文段交替出现。对每个有译文的可翻译段落输出
 *       {@code prefix + source + 分隔 + prefix + target + suffix}；不可翻译段（代码、HTML、分隔线、空行）与没有译文的段落
 *       只按原文输出一次。分隔规则：
 *       <ul>
 *         <li>列表项、表格行：分隔为原 suffix（不以换行结尾时补一个换行），使原文行与译文行相邻，
 *             列表保持同级、表格保持同一张表</li>
 *         <li>其他块（段落、标题、引用等）：分隔为原 suffix 补足到一个空行，使原文与译文成为两个独立的块</li>
 *       </ul>
 *       换行风格沿用该段 suffix 中的换行（CRLF 段落补 CRLF，否则补 LF）。</li>
 * </ul>
 */
public final class DocAssembler {

    /** 双语模式下原文行与译文行紧邻的块类型。 */
    private static final Set<String> LINE_BLOCKS = Set.of("list_item", "table_row");

    private DocAssembler() {
    }

    /** md / txt：prefix + (target ?? source) + suffix。 */
    public static String translated(List<DocSegmentVO> segments) {
        StringBuilder sb = new StringBuilder();
        for (DocSegmentVO s : segments) {
            sb.append(nz(s.prefix())).append(effectiveText(s)).append(nz(s.suffix()));
        }
        return sb.toString();
    }

    /** bilingual：原文段与译文段交替，不可翻译段只输出一次（格式见类注释）。 */
    public static String bilingual(List<DocSegmentVO> segments) {
        StringBuilder sb = new StringBuilder();
        for (DocSegmentVO s : segments) {
            String prefix = nz(s.prefix());
            String suffix = nz(s.suffix());
            if (!Boolean.TRUE.equals(s.translatable()) || s.target() == null) {
                sb.append(prefix).append(nz(s.source())).append(suffix);
                continue;
            }
            sb.append(prefix).append(nz(s.source())).append(separator(s.blockType(), suffix))
                    .append(prefix).append(s.target()).append(suffix);
        }
        return sb.toString();
    }

    static String separator(String blockType, String suffix) {
        String nl = suffix.contains("\r\n") ? "\r\n" : "\n";
        if (LINE_BLOCKS.contains(blockType)) {
            return endsWithNewline(suffix) ? suffix : suffix + nl;
        }
        String sep = suffix;
        if (!endsWithNewline(sep)) {
            sep += nl;
        }
        if (!endsWithBlankLine(sep)) {
            sep += nl;
        }
        return sep;
    }

    private static boolean endsWithNewline(String s) {
        return s.endsWith("\n");
    }

    /** 以空行结尾：最后两行换行之间只有空白（兼容 CRLF）。 */
    private static boolean endsWithBlankLine(String s) {
        if (!s.endsWith("\n")) {
            return false;
        }
        String body = s.substring(0, s.length() - 1);
        if (body.endsWith("\r")) {
            body = body.substring(0, body.length() - 1);
        }
        int lastNl = body.lastIndexOf('\n');
        if (lastNl < 0) {
            return false;
        }
        return body.substring(lastNl + 1).isBlank();
    }

    private static String effectiveText(DocSegmentVO s) {
        return s.target() != null && Boolean.TRUE.equals(s.translatable()) ? s.target() : nz(s.source());
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }
}
