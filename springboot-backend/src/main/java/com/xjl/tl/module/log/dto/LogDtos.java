package com.xjl.tl.module.log.dto;

import com.xjl.tl.common.PageQuery;
import io.swagger.v3.oas.annotations.media.Schema;
import org.springframework.format.annotation.DateTimeFormat;

import java.time.OffsetDateTime;

/**
 * 日志模块 DTO（字段契约见 design D13）。
 */
public final class LogDtos {

    private LogDtos() {
    }

    @Schema(description = "登录日志")
    public record LoginLogVO(Long id, Long userId, String username, String ip, String userAgent,
                             Boolean success, String failReason, OffsetDateTime createdAt) {
    }

    @Schema(description = "操作日志")
    public record OperationLogVO(Long id, Long userId, String username, String module, String action,
                                 String method, String path, String params, String resultCode, Long durationMs,
                                 String ip, String traceId, OffsetDateTime createdAt) {
    }

    /** 公共时间范围条件（ISO-8601，带时区偏移）。 */
    public static class TimeRangeQuery extends PageQuery {
        @Schema(description = "用户名（模糊匹配）")
        private String username;
        @Schema(description = "开始时间（含），ISO-8601", example = "2026-10-01T00:00:00+08:00")
        @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
        private OffsetDateTime startTime;
        @Schema(description = "结束时间（含），ISO-8601", example = "2026-10-02T00:00:00+08:00")
        @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
        private OffsetDateTime endTime;

        public String getUsername() {
            return username;
        }

        public void setUsername(String username) {
            this.username = username;
        }

        public OffsetDateTime getStartTime() {
            return startTime;
        }

        public void setStartTime(OffsetDateTime startTime) {
            this.startTime = startTime;
        }

        public OffsetDateTime getEndTime() {
            return endTime;
        }

        public void setEndTime(OffsetDateTime endTime) {
            this.endTime = endTime;
        }
    }

    @Schema(description = "登录日志查询条件")
    public static class LoginLogQuery extends TimeRangeQuery {
        @Schema(description = "是否成功")
        private Boolean success;

        public Boolean getSuccess() {
            return success;
        }

        public void setSuccess(Boolean success) {
            this.success = success;
        }
    }

    @Schema(description = "操作日志查询条件")
    public static class OperationLogQuery extends TimeRangeQuery {
        @Schema(description = "模块")
        private String module;

        public String getModule() {
            return module;
        }

        public void setModule(String module) {
            this.module = module;
        }
    }
}
