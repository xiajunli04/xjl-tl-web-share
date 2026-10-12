package com.xjl.tl.module.interpret.room;

import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 成员最近的定稿语句（improve-prompts-and-context-memory D5）：发言流重建时随首帧 config 的 history 下发，
 * 供 Python 恢复同传上下文与 AI 对话窗口。只在会话存续期间保存在内存中，访问方持有房间锁。
 * <ul>
 *   <li>按 utteranceId 去重、按首次定稿的顺序排列，最多 {@value #MAX} 条，超出时丢弃最早的一条</li>
 *   <li>transcript.final 插入或更新原文（同一句可能因降级补发两次）；translation.final 回填该语言的译文</li>
 *   <li>被打断的 AI 回复改为"已生成部分 + …"</li>
 *   <li>下发时每段文本截断到 {@value #MAX_TEXT} 字符</li>
 * </ul>
 */
final class RecentUtterances {

    static final int MAX = 24;
    static final int MAX_TEXT = 500;
    static final String ROLE_USER = "user";
    static final String INTERRUPTED_MARK = "…";

    private static final class Entry {
        final String role;
        String lang;
        String text;
        final Map<String, String> translations = new LinkedHashMap<>();

        Entry(String role) {
            this.role = role;
        }
    }

    private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();

    void transcript(String uid, String role, String lang, String text) {
        if (uid == null || text == null || text.isBlank()) {
            return;
        }
        Entry e = entries.computeIfAbsent(uid, k -> new Entry(role));
        e.lang = lang;
        e.text = text;
        while (entries.size() > MAX) {
            Iterator<String> it = entries.keySet().iterator();
            it.next();
            it.remove();
        }
    }

    void translation(String uid, String lang, String text) {
        Entry e = uid == null ? null : entries.get(uid);
        if (e != null && lang != null && !lang.isBlank() && text != null && !text.isBlank()) {
            e.translations.put(lang, text);
        }
    }

    /** AI 回复被打断：text 为已生成的部分（为空时不变）。 */
    void interrupted(String uid, String text) {
        Entry e = uid == null ? null : entries.get(uid);
        if (e != null && text != null && !text.isBlank()) {
            e.text = text.endsWith(INTERRUPTED_MARK) ? text : text + INTERRUPTED_MARK;
        }
    }

    /** 语句被撤回（transcript.discard：噪声 / 语气词，或让位撤回的 AI 回复）：不再作为上下文下发。 */
    void remove(String uid) {
        if (uid != null) {
            entries.remove(uid);
        }
    }

    int size() {
        return entries.size();
    }

    ArrayNode toJson(JsonMapper mapper) {
        ArrayNode arr = mapper.createArrayNode();
        for (Entry e : entries.values()) {
            ObjectNode o = arr.addObject();
            o.put("role", e.role);
            o.put("lang", e.lang);
            o.put("text", cut(e.text));
            ObjectNode t = o.putObject("translations");
            e.translations.forEach((k, v) -> t.put(k, cut(v)));
        }
        return arr;
    }

    private static String cut(String s) {
        return s.length() <= MAX_TEXT ? s : s.substring(0, MAX_TEXT);
    }
}
