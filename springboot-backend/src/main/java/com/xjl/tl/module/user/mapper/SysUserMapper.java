package com.xjl.tl.module.user.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.xjl.tl.module.user.entity.SysUser;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.Collection;
import java.util.List;

/**
 * 用户与用户-角色关联的数据访问。
 */
public interface SysUserMapper extends BaseMapper<SysUser> {

    /** 一行用户-角色关系。 */
    record UserRoleRow(Long userId, String code) {
    }

    @Select("""
            <script>
            SELECT ur.user_id AS userId, r.code AS code
            FROM biz.sys_user_role ur JOIN biz.sys_role r ON r.id = ur.role_id
            WHERE ur.user_id IN
            <foreach collection="userIds" item="id" open="(" separator="," close=")">#{id}</foreach>
            ORDER BY r.id
            </script>
            """)
    List<UserRoleRow> selectRoleRows(@Param("userIds") Collection<Long> userIds);

    @Delete("DELETE FROM biz.sys_user_role WHERE user_id = #{userId}")
    int deleteRoles(@Param("userId") Long userId);

    @Insert("""
            <script>
            INSERT INTO biz.sys_user_role (user_id, role_id)
            SELECT #{userId}, r.id FROM biz.sys_role r WHERE r.code IN
            <foreach collection="codes" item="c" open="(" separator="," close=")">#{c}</foreach>
            </script>
            """)
    int insertRoles(@Param("userId") Long userId, @Param("codes") Collection<String> codes);

    @Select("""
            SELECT EXISTS (
              SELECT 1 FROM biz.sys_user u
              JOIN biz.sys_user_role ur ON ur.user_id = u.id
              JOIN biz.sys_role r ON r.id = ur.role_id
              WHERE r.code = 'ADMIN' AND u.deleted = false)
            """)
    boolean existsAdmin();
}
