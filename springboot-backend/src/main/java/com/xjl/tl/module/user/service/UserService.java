package com.xjl.tl.module.user.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.module.user.dto.UserDtos.ChangePasswordRequest;
import com.xjl.tl.module.user.dto.UserDtos.CreateUserRequest;
import com.xjl.tl.module.user.dto.UserDtos.UpdateProfileRequest;
import com.xjl.tl.module.user.dto.UserDtos.UserInfo;
import com.xjl.tl.module.user.dto.UserDtos.UserQuery;
import com.xjl.tl.module.user.entity.SysUser;
import com.xjl.tl.module.user.mapper.SysUserMapper;
import com.xjl.tl.security.TokenRevocationService;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 用户服务：注册/创建、查询、管理员操作、个人资料。
 */
@Service
public class UserService {

    public static final String ROLE_ADMIN = "ADMIN";
    public static final String ROLE_USER = "USER";

    private final SysUserMapper userMapper;
    private final PasswordEncoder passwordEncoder;
    private final TokenRevocationService revocationService;

    public UserService(SysUserMapper userMapper, PasswordEncoder passwordEncoder,
                       TokenRevocationService revocationService) {
        this.userMapper = userMapper;
        this.passwordEncoder = passwordEncoder;
        this.revocationService = revocationService;
    }

    // ---------------- 查询 ----------------

    public SysUser findByUsername(String username) {
        return userMapper.selectOne(new LambdaQueryWrapper<SysUser>().eq(SysUser::getUsername, username));
    }

    public SysUser getRequired(Long id) {
        SysUser user = userMapper.selectById(id);
        if (user == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "用户不存在");
        }
        return user;
    }

    public List<String> rolesOf(Long userId) {
        return userMapper.selectRoleRows(List.of(userId)).stream().map(SysUserMapper.UserRoleRow::code).toList();
    }

    public UserInfo toInfo(SysUser user) {
        return toInfo(user, rolesOf(user.getId()));
    }

    public UserInfo getInfo(Long id) {
        return toInfo(getRequired(id));
    }

    /** 分页查询：用户名模糊、状态、角色过滤，按创建时间倒序。 */
    public PageResult<UserInfo> page(UserQuery q) {
        LambdaQueryWrapper<SysUser> w = new LambdaQueryWrapper<SysUser>()
                .like(StringUtils.hasText(q.getUsername()), SysUser::getUsername, q.getUsername())
                .eq(StringUtils.hasText(q.getStatus()), SysUser::getStatus, q.getStatus())
                .apply(StringUtils.hasText(q.getRole()),
                        "id IN (SELECT ur.user_id FROM biz.sys_user_role ur JOIN biz.sys_role r ON r.id = ur.role_id WHERE r.code = {0})",
                        q.getRole())
                .orderByDesc(SysUser::getCreatedAt)
                .orderByDesc(SysUser::getId);
        Page<SysUser> page = userMapper.selectPage(q.toPage(), w);
        Map<Long, List<String>> roles = rolesOf(page.getRecords().stream().map(SysUser::getId).toList());
        List<UserInfo> records = page.getRecords().stream()
                .map(u -> toInfo(u, roles.getOrDefault(u.getId(), List.of())))
                .toList();
        return PageResult.of(page, records);
    }

    // ---------------- 创建 ----------------

    /** 创建用户（注册、管理员创建、初始管理员共用）。 */
    @Transactional
    public SysUser create(String username, String rawPassword, String nickname, String email, Collection<String> roles) {
        if (findByUsername(username) != null) {
            throw new BizException(ErrorCode.USERNAME_EXISTS);
        }
        SysUser user = new SysUser();
        user.setUsername(username);
        user.setPasswordHash(passwordEncoder.encode(rawPassword));
        user.setNickname(StringUtils.hasText(nickname) ? nickname : username);
        user.setEmail(StringUtils.hasText(email) ? email : null);
        user.setStatus(SysUser.ENABLED);
        user.setDeleted(false);
        try {
            userMapper.insert(user);
        } catch (DuplicateKeyException e) {
            // 并发注册时由部分唯一索引兜底
            throw new BizException(ErrorCode.USERNAME_EXISTS);
        }
        userMapper.insertRoles(user.getId(), new LinkedHashSet<>(roles));
        return user;
    }

    @Transactional
    public UserInfo adminCreate(CreateUserRequest req) {
        SysUser user = create(req.username(), req.password(), req.nickname(), req.email(), req.roles());
        return getInfo(user.getId());
    }

    // ---------------- 管理员操作 ----------------

    @Transactional
    public void updateStatus(Long operatorId, Long userId, String status) {
        if (operatorId.equals(userId) && SysUser.DISABLED.equals(status)) {
            throw FieldError.invalid("status", "不能禁用自己");
        }
        SysUser user = getRequired(userId);
        user.setStatus(status);
        userMapper.updateById(user);
        revocationService.revokeAllForUser(userId);
    }

    @Transactional
    public void updateRoles(Long operatorId, Long userId, List<String> roles) {
        Set<String> target = new LinkedHashSet<>(roles);
        if (operatorId.equals(userId) && !target.contains(ROLE_ADMIN)) {
            throw FieldError.invalid("roles", "不能移除自己的 ADMIN 角色");
        }
        SysUser user = getRequired(userId);
        userMapper.deleteRoles(user.getId());
        userMapper.insertRoles(user.getId(), target);
        touch(user);
        revocationService.revokeAllForUser(userId);
    }

    @Transactional
    public void resetPassword(Long userId, String rawPassword) {
        SysUser user = getRequired(userId);
        user.setPasswordHash(passwordEncoder.encode(rawPassword));
        userMapper.updateById(user);
        revocationService.revokeAllForUser(userId);
    }

    @Transactional
    public void delete(Long operatorId, Long userId) {
        if (operatorId.equals(userId)) {
            throw FieldError.invalid("id", "不能删除自己");
        }
        getRequired(userId);
        userMapper.deleteById(userId);
        revocationService.revokeAllForUser(userId);
    }

    // ---------------- 个人资料 ----------------

    @Transactional
    public UserInfo updateProfile(Long userId, UpdateProfileRequest req) {
        SysUser user = getRequired(userId);
        if (req.nickname() != null) {
            user.setNickname(req.nickname());
        }
        if (req.email() != null) {
            user.setEmail(StringUtils.hasText(req.email()) ? req.email() : null);
        }
        userMapper.updateById(user);
        return toInfo(user);
    }

    @Transactional
    public void changePassword(Long userId, ChangePasswordRequest req) {
        SysUser user = getRequired(userId);
        if (!passwordEncoder.matches(req.oldPassword(), user.getPasswordHash())) {
            throw new BizException(ErrorCode.OLD_PASSWORD_WRONG);
        }
        user.setPasswordHash(passwordEncoder.encode(req.newPassword()));
        userMapper.updateById(user);
        revocationService.revokeAllForUser(userId);
    }

    /** 登录成功后更新最近登录时间。 */
    public void markLogin(SysUser user) {
        user.setLastLoginAt(OffsetDateTime.now());
        userMapper.updateById(user);
    }

    public boolean existsAdmin() {
        return userMapper.existsAdmin();
    }

    // ---------------- 内部 ----------------

    private void touch(SysUser user) {
        userMapper.updateById(user);
    }

    private Map<Long, List<String>> rolesOf(Collection<Long> userIds) {
        if (userIds.isEmpty()) {
            return Map.of();
        }
        return userMapper.selectRoleRows(userIds).stream().collect(Collectors.groupingBy(
                SysUserMapper.UserRoleRow::userId,
                Collectors.mapping(SysUserMapper.UserRoleRow::code, Collectors.toList())));
    }

    private UserInfo toInfo(SysUser u, List<String> roles) {
        return new UserInfo(u.getId(), u.getUsername(), u.getNickname(), u.getEmail(), u.getStatus(),
                roles, u.getLastLoginAt(), u.getCreatedAt());
    }
}
