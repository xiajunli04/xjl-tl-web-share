package com.xjl.tl.module.log.aspect;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 敏感字段脱敏：字段名包含 password / apikey / secret / token 的值统一替换为 ******。
 */
public final class SensitiveMasker {

    public static final String MASK = "******";
    private static final Set<String> KEYWORDS = Set.of("password", "apikey", "api_key", "secret", "cipher");

    private SensitiveMasker() {
    }

    public static boolean isSensitive(String fieldName) {
        String lower = fieldName.toLowerCase(Locale.ROOT);
        // "token" 用后缀匹配，避免误伤 maxTokens 之类的普通参数
        return lower.endsWith("token") || KEYWORDS.stream().anyMatch(lower::contains);
    }

    /** 递归脱敏（原地修改）。 */
    public static void mask(JsonNode node) {
        if (node instanceof ObjectNode obj) {
            List<String> names = new ArrayList<>(obj.propertyNames());
            for (String name : names) {
                JsonNode child = obj.get(name);
                if (isSensitive(name) && child != null && !child.isNull()) {
                    obj.put(name, MASK);
                } else {
                    mask(child);
                }
            }
        } else if (node instanceof ArrayNode arr) {
            arr.forEach(SensitiveMasker::mask);
        }
    }
}
