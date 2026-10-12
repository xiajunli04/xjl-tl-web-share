package com.xjl.tl.common;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.ConstraintViolationException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authorization.AuthorizationDeniedException;
import org.springframework.validation.BindException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.support.MissingServletRequestPartException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.ArrayList;
import java.util.List;

/**
 * 全局异常处理：统一转换为 Result 信封，未预期异常不暴露内部细节。
 * 响应显式声明 application/json：流式接口（Accept: text/event-stream）在建立流之前失败时同样返回普通 JSON。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Result<Object>> handleBiz(BizException e) {
        log.info("业务异常 code={} message={}", e.getCode(), e.getMessage());
        return json(e.getHttpStatus()).body(Result.fail(e.getCode(), e.getMessage(), e.getData()));
    }

    /** @RequestBody / 查询对象校验失败（MethodArgumentNotValidException 是 BindException 的子类）。 */
    @ExceptionHandler(BindException.class)
    public ResponseEntity<Result<Object>> handleBind(BindException e) {
        List<FieldError> errors = e.getBindingResult().getFieldErrors().stream()
                .map(fe -> new FieldError(fe.getField(), fe.getDefaultMessage()))
                .toList();
        return paramInvalid(errors);
    }

    @ExceptionHandler(HandlerMethodValidationException.class)
    public ResponseEntity<Result<Object>> handleMethodValidation(HandlerMethodValidationException e) {
        List<FieldError> errors = new ArrayList<>();
        e.getParameterValidationResults().forEach(r -> r.getResolvableErrors().forEach(err ->
                errors.add(new FieldError(r.getMethodParameter().getParameterName(), err.getDefaultMessage()))));
        return paramInvalid(errors);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<Result<Object>> handleConstraint(ConstraintViolationException e) {
        List<FieldError> errors = e.getConstraintViolations().stream()
                .map(v -> {
                    String path = v.getPropertyPath().toString();
                    return new FieldError(path.substring(path.lastIndexOf('.') + 1), v.getMessage());
                })
                .toList();
        return paramInvalid(errors);
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public ResponseEntity<Result<Object>> handleMissingParam(MissingServletRequestParameterException e) {
        return paramInvalid(List.of(new FieldError(e.getParameterName(), "不能为空")));
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Result<Object>> handleTypeMismatch(MethodArgumentTypeMismatchException e) {
        return paramInvalid(List.of(new FieldError(e.getName(), "格式不正确")));
    }

    @ExceptionHandler(MissingServletRequestPartException.class)
    public ResponseEntity<Result<Object>> handleMissingPart(MissingServletRequestPartException e) {
        return paramInvalid(List.of(new FieldError(e.getRequestPartName(), "不能为空")));
    }

    /** 上传文件超过 spring.servlet.multipart 限制：图片接口返回 A0450，听写接口返回 A0454，其余返回 A0421。 */
    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<Result<Object>> handleUploadTooLarge(MaxUploadSizeExceededException e, HttpServletRequest request) {
        String uri = request.getRequestURI();
        ErrorCode code = ErrorCode.IMPORT_FILE_INVALID;
        if (uri.startsWith("/api/image-translations")) {
            code = ErrorCode.IMAGE_INVALID;
        } else if (uri.startsWith("/api/speech")) {
            code = ErrorCode.AUDIO_INVALID;
        }
        return json(400).body(Result.fail(code.getCode(), "上传文件过大", null));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Result<Object>> handleNotReadable(HttpMessageNotReadableException e) {
        return paramInvalid(List.of(new FieldError("body", "请求体格式不正确")));
    }

    @ExceptionHandler({NoResourceFoundException.class, NoHandlerFoundException.class})
    public ResponseEntity<Result<Object>> handleNotFound(Exception e) {
        return json(404).body(Result.fail(ErrorCode.NOT_FOUND));
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Result<Object>> handleMethodNotSupported(HttpRequestMethodNotSupportedException e) {
        return json(405)
                .body(Result.fail(ErrorCode.PARAM_INVALID.getCode(), "不支持的请求方法", null));
    }

    /** 方法级鉴权失败交还给 Spring Security 的 AccessDeniedHandler 风格处理。 */
    @ExceptionHandler({AccessDeniedException.class, AuthorizationDeniedException.class})
    public ResponseEntity<Result<Object>> handleAccessDenied(Exception e) {
        return json(403).body(Result.fail(ErrorCode.ACCESS_DENIED));
    }

    /** 流式响应期间客户端断开：连接已不可用，无需（也无法）再写响应。 */
    @ExceptionHandler(AsyncRequestNotUsableException.class)
    public void handleClientGone(AsyncRequestNotUsableException e) {
        log.debug("客户端已断开：{}", e.getMessage());
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Result<Object>> handleUnexpected(Exception e) {
        // 完整堆栈写入服务端日志（日志格式中带 traceId），响应只给通用提示
        log.error("未预期异常 traceId={}", TraceIdHolder.get(), e);
        return json(500).body(Result.fail(ErrorCode.SYSTEM_ERROR));
    }

    private ResponseEntity<Result<Object>> paramInvalid(List<FieldError> errors) {
        return json(400)
                .body(Result.fail(ErrorCode.PARAM_INVALID.getCode(), ErrorCode.PARAM_INVALID.getMessage(), errors));
    }

    private static ResponseEntity.BodyBuilder json(int status) {
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON);
    }
}
