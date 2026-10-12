package com.xjl.tl.module.log.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.module.log.dto.LogDtos.LoginLogQuery;
import com.xjl.tl.module.log.dto.LogDtos.LoginLogVO;
import com.xjl.tl.module.log.dto.LogDtos.OperationLogQuery;
import com.xjl.tl.module.log.dto.LogDtos.OperationLogVO;
import com.xjl.tl.module.log.entity.LoginLog;
import com.xjl.tl.module.log.entity.OperationLogEntity;
import com.xjl.tl.module.log.mapper.LoginLogMapper;
import com.xjl.tl.module.log.mapper.OperationLogMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

/**
 * 登录日志与操作日志：异步写库、分页查询。
 */
@Service
public class LogService {

    private static final Logger log = LoggerFactory.getLogger(LogService.class);

    private final LoginLogMapper loginLogMapper;
    private final OperationLogMapper operationLogMapper;

    public LogService(LoginLogMapper loginLogMapper, OperationLogMapper operationLogMapper) {
        this.loginLogMapper = loginLogMapper;
        this.operationLogMapper = operationLogMapper;
    }

    @Async
    public void saveLoginLog(LoginLog entry) {
        try {
            loginLogMapper.insert(entry);
        } catch (Exception e) {
            log.warn("写登录日志失败", e);
        }
    }

    @Async
    public void saveOperationLog(OperationLogEntity entry) {
        try {
            operationLogMapper.insert(entry);
        } catch (Exception e) {
            log.warn("写操作日志失败", e);
        }
    }

    public PageResult<LoginLogVO> pageLoginLogs(LoginLogQuery q) {
        LambdaQueryWrapper<LoginLog> w = new LambdaQueryWrapper<LoginLog>()
                .like(StringUtils.hasText(q.getUsername()), LoginLog::getUsername, q.getUsername())
                .eq(q.getSuccess() != null, LoginLog::getSuccess, q.getSuccess())
                .ge(q.getStartTime() != null, LoginLog::getCreatedAt, q.getStartTime())
                .le(q.getEndTime() != null, LoginLog::getCreatedAt, q.getEndTime())
                .orderByDesc(LoginLog::getCreatedAt)
                .orderByDesc(LoginLog::getId);
        return PageResult.of(loginLogMapper.selectPage(q.toPage(), w), l -> new LoginLogVO(l.getId(), l.getUserId(),
                l.getUsername(), l.getIp(), l.getUserAgent(), l.getSuccess(), l.getFailReason(), l.getCreatedAt()));
    }

    public PageResult<OperationLogVO> pageOperationLogs(OperationLogQuery q) {
        LambdaQueryWrapper<OperationLogEntity> w = new LambdaQueryWrapper<OperationLogEntity>()
                .like(StringUtils.hasText(q.getUsername()), OperationLogEntity::getUsername, q.getUsername())
                .eq(StringUtils.hasText(q.getModule()), OperationLogEntity::getModule, q.getModule())
                .ge(q.getStartTime() != null, OperationLogEntity::getCreatedAt, q.getStartTime())
                .le(q.getEndTime() != null, OperationLogEntity::getCreatedAt, q.getEndTime())
                .orderByDesc(OperationLogEntity::getCreatedAt)
                .orderByDesc(OperationLogEntity::getId);
        return PageResult.of(operationLogMapper.selectPage(q.toPage(), w), o -> new OperationLogVO(o.getId(),
                o.getUserId(), o.getUsername(), o.getModule(), o.getAction(), o.getMethod(), o.getPath(),
                o.getParams(), o.getResultCode(), o.getDurationMs(), o.getIp(), o.getTraceId(), o.getCreatedAt()));
    }
}
