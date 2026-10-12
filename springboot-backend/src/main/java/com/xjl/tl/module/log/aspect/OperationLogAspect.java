package com.xjl.tl.module.log.aspect;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.RequestUtils;
import com.xjl.tl.common.Result;
import com.xjl.tl.common.TraceIdHolder;
import com.xjl.tl.module.log.annotation.OperationLog;
import com.xjl.tl.module.log.entity.OperationLogEntity;
import com.xjl.tl.module.log.service.LogService;
import com.xjl.tl.security.CurrentUser;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.reflect.MethodSignature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.InputStreamSource;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;
import org.springframework.validation.BindingResult;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 操作日志切面：记录操作人、路径、脱敏后截断的参数、结果码、耗时、IP、traceId，异步写库。
 */
@Aspect
@Component
public class OperationLogAspect {

    private static final Logger log = LoggerFactory.getLogger(OperationLogAspect.class);
    private static final int MAX_PARAMS_LENGTH = 2000;

    private final LogService logService;
    private final JsonMapper jsonMapper;

    public OperationLogAspect(LogService logService, JsonMapper jsonMapper) {
        this.logService = logService;
        this.jsonMapper = jsonMapper;
    }

    @Around("@annotation(operationLog)")
    public Object around(ProceedingJoinPoint pjp, OperationLog operationLog) throws Throwable {
        long start = System.currentTimeMillis();
        String resultCode = ErrorCode.SUCCESS.getCode();
        try {
            Object ret = pjp.proceed();
            if (ret instanceof Result<?> r) {
                resultCode = r.code();
            }
            return ret;
        } catch (BizException e) {
            resultCode = e.getCode();
            throw e;
        } catch (Throwable e) {
            resultCode = ErrorCode.SYSTEM_ERROR.getCode();
            throw e;
        } finally {
            record(pjp, operationLog, resultCode, System.currentTimeMillis() - start);
        }
    }

    private void record(ProceedingJoinPoint pjp, OperationLog annotation, String resultCode, long duration) {
        try {
            OperationLogEntity entry = new OperationLogEntity();
            CurrentUser user = CurrentUser.getOrNull();
            if (user != null) {
                entry.setUserId(user.id());
                entry.setUsername(user.username());
            }
            entry.setModule(annotation.module());
            entry.setAction(annotation.action());
            if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attrs) {
                HttpServletRequest request = attrs.getRequest();
                entry.setMethod(request.getMethod());
                entry.setPath(RequestUtils.truncate(request.getRequestURI(), 255));
                entry.setIp(RequestUtils.clientIp(request));
            }
            entry.setParams(serializeParams(pjp));
            entry.setResultCode(resultCode);
            entry.setDurationMs(duration);
            entry.setTraceId(TraceIdHolder.get());
            logService.saveOperationLog(entry);
        } catch (Exception e) {
            // 日志记录失败不影响业务
            log.warn("记录操作日志失败", e);
        }
    }

    /** 参数序列化：跳过 Servlet/认证等对象，敏感字段脱敏后截断。 */
    String serializeParams(ProceedingJoinPoint pjp) {
        String[] names = ((MethodSignature) pjp.getSignature()).getParameterNames();
        Object[] args = pjp.getArgs();
        Map<String, Object> params = new LinkedHashMap<>();
        for (int i = 0; i < args.length; i++) {
            Object arg = args[i];
            if (arg instanceof ServletRequest || arg instanceof ServletResponse || arg instanceof BindingResult
                    || arg instanceof Authentication || arg instanceof InputStreamSource) {
                continue;
            }
            params.put(names != null && i < names.length ? names[i] : "arg" + i, arg);
        }
        JsonNode tree = jsonMapper.valueToTree(params);
        SensitiveMasker.mask(tree);
        return RequestUtils.truncate(jsonMapper.writeValueAsString(tree), MAX_PARAMS_LENGTH);
    }
}
