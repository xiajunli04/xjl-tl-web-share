package com.xjl.tl.module.model.entity;

import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedJdbcTypes;
import org.apache.ibatis.type.MappedTypes;
import org.postgresql.util.PGobject;
import tools.jackson.databind.json.JsonMapper;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * ModelParams ↔ PostgreSQL jsonb（使用 Jackson 3）。
 */
@MappedTypes(ModelParams.class)
@MappedJdbcTypes(JdbcType.OTHER)
public class ModelParamsTypeHandler extends BaseTypeHandler<ModelParams> {

    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, ModelParams parameter, JdbcType jdbcType)
            throws SQLException {
        PGobject obj = new PGobject();
        obj.setType("jsonb");
        obj.setValue(MAPPER.writeValueAsString(parameter));
        ps.setObject(i, obj);
    }

    @Override
    public ModelParams getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return parse(rs.getString(columnName));
    }

    @Override
    public ModelParams getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return parse(rs.getString(columnIndex));
    }

    @Override
    public ModelParams getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return parse(cs.getString(columnIndex));
    }

    private static ModelParams parse(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        return MAPPER.readValue(json, ModelParams.class);
    }
}
