package com.xjl.tl.common.mybatis;

import org.apache.ibatis.type.BaseTypeHandler;
import org.apache.ibatis.type.JdbcType;
import org.apache.ibatis.type.MappedJdbcTypes;
import org.apache.ibatis.type.MappedTypes;
import org.postgresql.util.PGobject;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.sql.CallableStatement;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * JsonNode ↔ PostgreSQL jsonb（Jackson 3），用于结构不固定的 JSON 列（compliance、term_hits、detail 等）。
 */
@MappedTypes(JsonNode.class)
@MappedJdbcTypes(JdbcType.OTHER)
public class JsonNodeTypeHandler extends BaseTypeHandler<JsonNode> {

    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, JsonNode parameter, JdbcType jdbcType)
            throws SQLException {
        PGobject obj = new PGobject();
        obj.setType("jsonb");
        obj.setValue(MAPPER.writeValueAsString(parameter));
        ps.setObject(i, obj);
    }

    @Override
    public JsonNode getNullableResult(ResultSet rs, String columnName) throws SQLException {
        return parse(rs.getString(columnName));
    }

    @Override
    public JsonNode getNullableResult(ResultSet rs, int columnIndex) throws SQLException {
        return parse(rs.getString(columnIndex));
    }

    @Override
    public JsonNode getNullableResult(CallableStatement cs, int columnIndex) throws SQLException {
        return parse(cs.getString(columnIndex));
    }

    private static JsonNode parse(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        return MAPPER.readTree(json);
    }
}
