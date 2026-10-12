package com.xjl.tl.common.mybatis;

import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedJdbcTypes;
import org.apache.ibatis.type.MappedTypes;

import java.sql.Array;
import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * Long[] ↔ PostgreSQL bigint[]。
 */
@MappedTypes(Long[].class)
@MappedJdbcTypes(JdbcType.ARRAY)
public class LongArrayTypeHandler extends BaseTypeHandler<Long[]> {

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, Long[] parameter, JdbcType jdbcType)
            throws SQLException {
        ps.setArray(i, ps.getConnection().createArrayOf("bigint", parameter));
    }

    @Override
    public Long[] getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return toLongs(rs.getArray(columnName));
    }

    @Override
    public Long[] getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return toLongs(rs.getArray(columnIndex));
    }

    @Override
    public Long[] getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return toLongs(cs.getArray(columnIndex));
    }

    private static Long[] toLongs(Array array) throws SQLException {
        if (array == null) {
            return null;
        }
        Object[] values = (Object[]) array.getArray();
        Long[] result = new Long[values.length];
        for (int i = 0; i < values.length; i++) {
            result[i] = values[i] == null ? null : ((Number) values[i]).longValue();
        }
        return result;
    }
}
