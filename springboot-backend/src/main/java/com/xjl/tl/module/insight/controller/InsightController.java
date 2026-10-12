package com.xjl.tl.module.insight.controller;

import com.xjl.tl.common.Result;
import com.xjl.tl.module.insight.dto.InsightDtos.AskRequest;
import com.xjl.tl.module.insight.dto.InsightDtos.InsightRequest;
import com.xjl.tl.module.insight.dto.InsightDtos.InsightResult;
import com.xjl.tl.module.insight.service.InsightService;
import com.xjl.tl.security.CurrentUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

/**
 * 解读接口。路径与历史接口 /api/translations/{id} 共存：本控制器只有 POST 字面路径，
 * 字面路径优先于模板变量匹配，"insights" 不会被当作记录 id 解析。
 */
@Tag(name = "翻译解读", description = "备选译法、关键表达与针对译文追问（只读辅助，不落库），见 add-speech-and-image-translation D11")
@RestController
@RequestMapping("/api/translations/insights")
public class InsightController {

    private final InsightService service;

    public InsightController(InsightService service) {
        this.service = service;
    }

    @Operation(summary = "备选译法与关键表达", description = """
            用默认对话模型返回 2–3 个备选译法（语体 + 中文说明）、至多 5 个关键表达与一句话总结。\
            原文超过 2000 字符返回 A0410；语言不支持返回 A0420；recordId 不是自己的记录返回 A0404；\
            与文本翻译共用限流（每用户每分钟 20 次，429 + A0212）。""")
    @PostMapping
    public Result<InsightResult> insights(@Valid @RequestBody InsightRequest req) {
        return Result.ok(service.insights(CurrentUser.get().id(), req));
    }

    @Operation(summary = "针对译文追问（SSE）", description = """
            以 text/event-stream 返回 delta {text}、done {usage} 或 error {code, message}，答案为中文，不修改译文、不落库。\
            history 最多取最近 6 轮。参数校验与限流在建立流之前完成，失败时返回普通 JSON。""",
            responses = @ApiResponse(responseCode = "200", description = "SSE 事件流",
                    content = @Content(mediaType = MediaType.TEXT_EVENT_STREAM_VALUE,
                            schema = @Schema(type = "string", example = "event: delta\ndata: {\"text\":\"因为\"}\n\n"))))
    @PostMapping(value = "/ask", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> ask(@Valid @RequestBody AskRequest req, HttpServletResponse response) {
        Flux<ServerSentEvent<String>> events = service.ask(CurrentUser.get().id(), req);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
        return events;
    }
}
