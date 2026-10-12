package com.xjl.tl.module.glossary.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.mybatis.SqlUtils;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.GlossaryQuery;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.GlossaryRequest;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.GlossaryVO;
import com.xjl.tl.module.glossary.entity.Glossary;
import com.xjl.tl.module.glossary.mapper.GlossaryMapper;
import com.xjl.tl.module.translate.SupportedLanguage;
import com.xjl.tl.module.user.entity.SysUser;
import com.xjl.tl.module.user.mapper.SysUserMapper;
import com.xjl.tl.module.user.service.UserService;
import com.xjl.tl.security.CurrentUser;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 术语库管理与可见性规则（见 glossary 规格「术语库管理」）：
 * <ul>
 *   <li>用户可见：自己的术语库 + 全部公共术语库；他人私有库一律返回 A0404（不暴露是否存在）</li>
 *   <li>可编辑：自己的私有库；公共库只有 ADMIN 能改</li>
 *   <li>scope=PUBLIC 只有 ADMIN 能设置，否则 A0301</li>
 * </ul>
 */
@Service
public class GlossaryService {

    private final GlossaryMapper mapper;
    private final SysUserMapper userMapper;

    public GlossaryService(GlossaryMapper mapper, SysUserMapper userMapper) {
        this.mapper = mapper;
        this.userMapper = userMapper;
    }

    // ---------------- 查询 ----------------

    public PageResult<GlossaryVO> page(CurrentUser user, GlossaryQuery q) {
        String kw = q.getKeyword();
        LambdaQueryWrapper<Glossary> w = new LambdaQueryWrapper<Glossary>()
                .and(x -> x.eq(Glossary::getOwnerId, user.id()).or().eq(Glossary::getScope, Glossary.PUBLIC))
                .apply(StringUtils.hasText(kw), "name ILIKE {0}", StringUtils.hasText(kw) ? SqlUtils.containsPattern(kw) : null)
                .eq(StringUtils.hasText(q.getScope()), Glossary::getScope, q.getScope())
                .eq(StringUtils.hasText(q.getSourceLang()), Glossary::getSourceLang, q.getSourceLang())
                .eq(StringUtils.hasText(q.getTargetLang()), Glossary::getTargetLang, q.getTargetLang())
                .orderByDesc(Glossary::getUpdatedAt)
                .orderByDesc(Glossary::getId);
        Page<Glossary> page = mapper.selectPage(q.toPage(), w);
        Map<Long, String> owners = ownerNames(page.getRecords().stream().map(Glossary::getOwnerId).toList());
        return PageResult.of(page, page.getRecords().stream()
                .map(g -> toVO(g, owners.get(g.getOwnerId()), user))
                .toList());
    }

    public GlossaryVO get(CurrentUser user, Long id) {
        return toVO(getReadable(user, id), user);
    }

    // ---------------- 写操作 ----------------

    @Transactional
    public GlossaryVO create(CurrentUser user, GlossaryRequest req) {
        String scope = StringUtils.hasText(req.scope()) ? req.scope() : Glossary.PRIVATE;
        if (Glossary.PUBLIC.equals(scope) && !isAdmin(user)) {
            throw new BizException(ErrorCode.ACCESS_DENIED, "只有管理员可以创建公共术语库");
        }
        validateLanguages(req);
        Glossary g = new Glossary();
        g.setOwnerId(user.id());
        g.setName(req.name().trim());
        g.setDescription(trimToNull(req.description()));
        g.setSourceLang(req.sourceLang());
        g.setTargetLang(req.targetLang());
        g.setDomain(trimToNull(req.domain()));
        g.setScope(scope);
        g.setTermCount(0);
        g.setDeleted(false);
        mapper.insert(g);
        return toVO(mapper.selectById(g.getId()), user);
    }

    @Transactional
    public GlossaryVO update(CurrentUser user, Long id, GlossaryRequest req) {
        Glossary existing = getWritable(user, id);
        String scope = StringUtils.hasText(req.scope()) ? req.scope() : existing.getScope();
        if (Glossary.PUBLIC.equals(scope) && !isAdmin(user)) {
            throw new BizException(ErrorCode.ACCESS_DENIED, "只有管理员可以设置公共术语库");
        }
        validateLanguages(req);
        // 只更新可编辑字段，避免覆盖并发维护的 term_count
        mapper.update(null, new LambdaUpdateWrapper<Glossary>()
                .eq(Glossary::getId, id)
                .set(Glossary::getName, req.name().trim())
                .set(Glossary::getDescription, trimToNull(req.description()))
                .set(Glossary::getSourceLang, req.sourceLang())
                .set(Glossary::getTargetLang, req.targetLang())
                .set(Glossary::getDomain, trimToNull(req.domain()))
                .set(Glossary::getScope, scope)
                .set(Glossary::getUpdatedAt, OffsetDateTime.now()));
        return toVO(mapper.selectById(existing.getId()), user);
    }

    @Transactional
    public void delete(CurrentUser user, Long id) {
        getWritable(user, id);
        mapper.deleteById(id);
    }

    // ---------------- 权限 ----------------

    /** 可读：自己的或公共的；他人私有库与不存在一样返回 A0404。 */
    public Glossary getReadable(CurrentUser user, Long id) {
        Glossary g = mapper.selectById(id);
        if (g == null || !(user.id().equals(g.getOwnerId()) || Glossary.PUBLIC.equals(g.getScope()))) {
            throw new BizException(ErrorCode.NOT_FOUND, "术语库不存在");
        }
        return g;
    }

    /** 可写：在可读基础上要求 editable，否则 A0301。 */
    public Glossary getWritable(CurrentUser user, Long id) {
        Glossary g = getReadable(user, id);
        if (!editable(g, user)) {
            throw new BizException(ErrorCode.ACCESS_DENIED, "无权修改该术语库");
        }
        return g;
    }

    /** 翻译前校验所选术语库都可读（存在、未删除、自己的或公共的），否则 A0404。 */
    public void requireReadable(Long userId, Collection<Long> ids) {
        if (ids == null || ids.isEmpty()) {
            return;
        }
        Set<Long> distinct = new LinkedHashSet<>(ids);
        List<Glossary> found = mapper.selectList(new LambdaQueryWrapper<Glossary>()
                .select(Glossary::getId)
                .in(Glossary::getId, distinct)
                .and(x -> x.eq(Glossary::getOwnerId, userId).or().eq(Glossary::getScope, Glossary.PUBLIC)));
        Set<Long> readable = found.stream().map(Glossary::getId).collect(Collectors.toCollection(HashSet::new));
        for (Long id : distinct) {
            if (!readable.contains(id)) {
                throw new BizException(ErrorCode.NOT_FOUND, "术语库不存在：" + id,
                        List.of(new FieldError("glossaryIds", "术语库不存在：" + id)));
            }
        }
    }

    public static boolean editable(Glossary g, CurrentUser user) {
        if (Glossary.PUBLIC.equals(g.getScope())) {
            return isAdmin(user);
        }
        return user.id().equals(g.getOwnerId());
    }

    public static boolean isAdmin(CurrentUser user) {
        return user.roles() != null && user.roles().contains(UserService.ROLE_ADMIN);
    }

    // ---------------- 内部 ----------------

    private static void validateLanguages(GlossaryRequest req) {
        SupportedLanguage.require("sourceLang", req.sourceLang());
        SupportedLanguage.require("targetLang", req.targetLang());
        if (req.sourceLang().equals(req.targetLang())) {
            throw FieldError.invalid("targetLang", "源语言与目标语言不能相同");
        }
    }

    private Map<Long, String> ownerNames(Collection<Long> ownerIds) {
        if (ownerIds.isEmpty()) {
            return Map.of();
        }
        return userMapper.selectByIds(new LinkedHashSet<>(ownerIds)).stream()
                .collect(Collectors.toMap(SysUser::getId, GlossaryService::displayName, (a, b) -> a));
    }

    private static String displayName(SysUser u) {
        return StringUtils.hasText(u.getNickname()) ? u.getNickname() : u.getUsername();
    }

    private GlossaryVO toVO(Glossary g, CurrentUser user) {
        return toVO(g, ownerNames(List.of(g.getOwnerId())).get(g.getOwnerId()), user);
    }

    private static GlossaryVO toVO(Glossary g, String ownerName, CurrentUser user) {
        return new GlossaryVO(g.getId(), g.getName(), g.getDescription(), g.getSourceLang(), g.getTargetLang(),
                g.getDomain(), g.getScope(), g.getTermCount(), g.getOwnerId(), ownerName, editable(g, user),
                g.getCreatedAt(), g.getUpdatedAt());
    }

    static String trimToNull(String s) {
        return StringUtils.hasText(s) ? s.trim() : null;
    }
}
