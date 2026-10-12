package com.xjl.tl.common.mybatis;

/**
 * SQL 辅助方法。
 */
public final class SqlUtils {

    private SqlUtils() {
    }

    /**
     * 构造 LIKE / ILIKE 的"包含"模式：转义 \ % _ 后两端加 %（PostgreSQL 默认转义符为反斜杠）。
     */
    public static String containsPattern(String keyword) {
        String escaped = keyword.trim()
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_");
        return "%" + escaped + "%";
    }
}
