package com.xjl.tl.common;

import java.util.Arrays;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 统一错误码（参照《阿里巴巴 Java 开发手册》，见 design D2）。
 * A：用户端错误；B：系统错误；C：第三方服务（AI 服务 / LLM）错误。
 */
public enum ErrorCode {

    SUCCESS("00000", "成功", 200),
    USERNAME_EXISTS("A0111", "用户名已存在", 409),
    TERM_EXISTS("A0112", "术语已存在", 409),
    BAD_CREDENTIALS("A0201", "用户名或密码错误", 401),
    ACCOUNT_DISABLED("A0202", "账号已禁用", 403),
    LOGIN_LOCKED("A0211", "登录失败次数过多，请稍后再试", 429),
    TOO_MANY_REQUESTS("A0212", "请求过于频繁，请稍后再试", 429),
    TOO_MANY_DOC_TASKS("A0213", "同时运行的文档任务过多", 429),
    SESSION_BUSY("A0214", "会话中已有进行中的翻译", 409),
    ACCESS_TOKEN_EXPIRED("A0230", "访问令牌已过期", 401),
    ACCESS_TOKEN_INVALID("A0231", "访问令牌无效或已吊销", 401),
    REFRESH_TOKEN_INVALID("A0232", "刷新令牌无效或已过期", 401),
    OLD_PASSWORD_WRONG("A0240", "原密码错误", 400),
    ACCESS_DENIED("A0301", "无访问权限", 403),
    NOT_FOUND("A0404", "资源不存在", 404),
    PARAM_INVALID("A0410", "请求参数校验失败", 400),
    LANGUAGE_UNSUPPORTED("A0420", "不支持的语种", 400),
    IMPORT_FILE_INVALID("A0421", "导入文件格式错误", 400),
    DOC_INVALID("A0430", "文档为空、过大或格式不支持", 400),
    DOC_TASK_STATE_INVALID("A0431", "当前任务状态不允许该操作", 409),
    CLARIFY_EXPIRED("A0440", "追问已失效", 409),
    IMAGE_INVALID("A0450", "图片为空、过大或格式不支持", 400),
    ROOM_FULL("A0451", "会议室已满或语言数超限", 409),
    ROOM_NOT_FOUND("A0452", "房间不存在或已关闭", 404),
    WS_TICKET_INVALID("A0453", "连接票据无效或已使用", 401),
    AUDIO_INVALID("A0454", "音频为空、过长或格式不支持", 400),
    SYSTEM_ERROR("B0001", "系统执行出错", 500),
    INTERNAL_AUTH_FAILED("B0100", "内部服务鉴权失败", 401),
    AI_SERVICE_UNAVAILABLE("C0110", "AI 服务不可用", 503),
    LLM_CALL_FAILED("C0120", "LLM 调用失败", 502),
    LLM_AUTH_FAILED("C0121", "LLM 鉴权失败（API Key 无效）", 502),
    LLM_TIMEOUT("C0122", "LLM 调用超时", 504),
    LLM_RATE_LIMITED("C0123", "LLM 限流", 502),
    MODEL_CONFIG_UNAVAILABLE("C0130", "模型配置不存在或已停用", 400),
    AGENT_FAILED("C0140", "Agent 执行失败", 502),
    TRANSLATE_TIMEOUT("C0141", "翻译超时", 504),
    DOC_TASK_FAILED("C0150", "文档任务执行失败", 502),
    TM_UNAVAILABLE("C0160", "翻译记忆服务不可用", 503),
    VISION_UNSUPPORTED("C0170", "所选模型不支持图片输入", 400),
    OCR_PARSE_FAILED("C0171", "OCR 结果解析失败", 502),
    TTS_FAILED("C0172", "语音合成失败", 502),
    SPEECH_ENGINE_UNAVAILABLE("C0173", "语音引擎不可用", 503),
    REALTIME_UPSTREAM_FAILED("C0174", "实时同传上游连接失败或中断", 502);

    private static final Map<String, ErrorCode> BY_CODE =
            Arrays.stream(values()).collect(Collectors.toMap(ErrorCode::getCode, Function.identity()));

    private final String code;
    private final String message;
    private final int httpStatus;

    ErrorCode(String code, String message, int httpStatus) {
        this.code = code;
        this.message = message;
        this.httpStatus = httpStatus;
    }

    public String getCode() {
        return code;
    }

    public String getMessage() {
        return message;
    }

    public int getHttpStatus() {
        return httpStatus;
    }

    /** 按字符串码查找，未知码返回 null。 */
    public static ErrorCode fromCode(String code) {
        return code == null ? null : BY_CODE.get(code);
    }
}
