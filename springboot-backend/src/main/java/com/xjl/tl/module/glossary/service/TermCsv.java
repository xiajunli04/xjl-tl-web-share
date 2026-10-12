package com.xjl.tl.module.glossary.service;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 术语 CSV 读写（RFC 4180）：UTF-8（兼容 BOM），表头必须包含 source、target，note 可选，列顺序不限。
 * 文件级错误（编码、表头、行数超限、引号未闭合）抛出 A0421；行级错误由调用方逐行校验。
 */
public final class TermCsv {

    public static final int MAX_ROWS = 5000;
    private static final char BOM = (char) 0xFEFF;
    private static final byte[] BOM_BYTES = {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF};

    private TermCsv() {
    }

    /** 一行数据：line 为该记录在文件中的起始行号（表头为第 1 行）。 */
    public record Row(int line, String source, String target, String note) {
    }

    public static List<Row> parse(byte[] bytes) {
        String text = decodeUtf8(bytes);
        if (!text.isEmpty() && text.charAt(0) == BOM) {
            text = text.substring(1);
        }
        if (text.indexOf('\0') >= 0) {
            throw invalid("文件不是 UTF-8 文本");
        }
        List<Record> records = readRecords(text);
        int headerIndex = -1;
        for (int i = 0; i < records.size(); i++) {
            if (!records.get(i).isBlank()) {
                headerIndex = i;
                break;
            }
        }
        if (headerIndex < 0) {
            throw invalid("文件为空，缺少 source、target 表头");
        }
        Map<String, Integer> columns = new HashMap<>();
        List<String> header = records.get(headerIndex).fields();
        for (int i = 0; i < header.size(); i++) {
            columns.putIfAbsent(header.get(i).trim().toLowerCase(Locale.ROOT), i);
        }
        if (!columns.containsKey("source") || !columns.containsKey("target")) {
            throw invalid("表头必须包含 source 和 target 列");
        }
        int sourceIdx = columns.get("source");
        int targetIdx = columns.get("target");
        Integer noteIdx = columns.get("note");
        List<Row> rows = new ArrayList<>();
        for (int i = headerIndex + 1; i < records.size(); i++) {
            Record r = records.get(i);
            if (r.isBlank()) {
                continue;
            }
            if (rows.size() >= MAX_ROWS) {
                throw invalid("单次导入不能超过 " + MAX_ROWS + " 行");
            }
            rows.add(new Row(r.line(), field(r, sourceIdx), field(r, targetIdx), noteIdx == null ? "" : field(r, noteIdx)));
        }
        return rows;
    }

    /** 导出：带 BOM（便于 Excel 识别 UTF-8），CRLF 换行，可原样重新导入。 */
    public static byte[] write(List<String[]> rows) {
        StringBuilder sb = new StringBuilder();
        sb.append("source,target,note\r\n");
        for (String[] row : rows) {
            for (int i = 0; i < row.length; i++) {
                if (i > 0) {
                    sb.append(',');
                }
                sb.append(escape(row[i]));
            }
            sb.append("\r\n");
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(BOM_BYTES);
        out.writeBytes(sb.toString().getBytes(StandardCharsets.UTF_8));
        return out.toByteArray();
    }

    // ---------------- 内部 ----------------

    private record Record(int line, List<String> fields) {
        boolean isBlank() {
            return fields.stream().allMatch(f -> f.isBlank());
        }
    }

    private static String decodeUtf8(byte[] bytes) {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException e) {
            throw invalid("文件不是 UTF-8 编码");
        }
    }

    private static List<Record> readRecords(String text) {
        List<Record> records = new ArrayList<>();
        List<String> fields = new ArrayList<>();
        StringBuilder field = new StringBuilder();
        boolean inQuotes = false;
        boolean fieldQuoted = false;
        int line = 1;
        int recordLine = 1;
        int n = text.length();
        for (int i = 0; i < n; i++) {
            char c = text.charAt(i);
            if (inQuotes) {
                if (c == '"') {
                    if (i + 1 < n && text.charAt(i + 1) == '"') {
                        field.append('"');
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    if (c == '\n') {
                        line++;
                    }
                    field.append(c);
                }
                continue;
            }
            switch (c) {
                case '"' -> {
                    if (field.toString().isBlank() && !fieldQuoted) {
                        field.setLength(0);
                        inQuotes = true;
                        fieldQuoted = true;
                    } else {
                        field.append(c);
                    }
                }
                case ',' -> {
                    fields.add(field.toString());
                    field.setLength(0);
                    fieldQuoted = false;
                }
                case '\r', '\n' -> {
                    if (c == '\r' && i + 1 < n && text.charAt(i + 1) == '\n') {
                        i++;
                    }
                    fields.add(field.toString());
                    records.add(new Record(recordLine, fields));
                    fields = new ArrayList<>();
                    field.setLength(0);
                    fieldQuoted = false;
                    line++;
                    recordLine = line;
                }
                default -> field.append(c);
            }
        }
        if (inQuotes) {
            throw invalid("第 " + recordLine + " 行引号未闭合");
        }
        if (field.length() > 0 || !fields.isEmpty()) {
            fields.add(field.toString());
            records.add(new Record(recordLine, fields));
        }
        return records;
    }

    private static String field(Record r, int idx) {
        return idx < r.fields().size() ? r.fields().get(idx).trim() : "";
    }

    private static String escape(String v) {
        if (v == null) {
            return "";
        }
        boolean needQuote = v.indexOf(',') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0
                || v.indexOf('\r') >= 0 || (!v.isEmpty() && (Character.isWhitespace(v.charAt(0))
                || Character.isWhitespace(v.charAt(v.length() - 1))));
        return needQuote ? '"' + v.replace("\"", "\"\"") + '"' : v;
    }

    private static BizException invalid(String message) {
        return new BizException(ErrorCode.IMPORT_FILE_INVALID, ErrorCode.IMPORT_FILE_INVALID.getMessage() + "：" + message);
    }
}
