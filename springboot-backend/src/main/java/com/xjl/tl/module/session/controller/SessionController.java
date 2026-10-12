package com.xjl.tl.module.session.controller;

import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.Result;
import com.xjl.tl.module.log.annotation.OperationLog;
import com.xjl.tl.module.session.dto.SessionDtos.ClarifyRequest;
import com.xjl.tl.module.session.dto.SessionDtos.ReviseRequest;
import com.xjl.tl.module.session.dto.SessionDtos.SessionDetailVO;
import com.xjl.tl.module.session.dto.SessionDtos.SessionQuery;
import com.xjl.tl.module.session.dto.SessionDtos.SessionRequest;
import com.xjl.tl.module.session.dto.SessionDtos.SessionSummaryVO;
import com.xjl.tl.module.session.dto.SessionDtos.SessionVO;
import com.xjl.tl.module.session.service.SessionService;
import com.xjl.tl.module.translate.service.TranslateService;
import com.xjl.tl.security.CurrentUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

@Tag(name = "翻译会话", description = "多轮翻译会话：会话管理、修订、追问回答与采用版本；他人会话返回 A0404")
@RestController
@RequestMapping("/api/translate/sessions")
public class SessionController {

    public static final String MODULE = "翻译会话";
    private static final String SSE_EXAMPLE = "event: start\ndata: {\"requestId\":\"req-001\"}\n\n";

    private final SessionService sessionService;
    private final TranslateService translateService;

    public SessionController(SessionService sessionService, TranslateService translateService) {
        this.sessionService = sessionService;
        this.translateService = translateService;
    }

    @Operation(summary = "创建会话", description = """
            targetLang 必填，sourceLang 缺省 auto，style 缺省 faithful，clarifyEnabled 缺省 true；标题缺省为空，\
            首轮翻译完成后取原文前 20 个字符。语种不支持返回 A0420，术语库不可访问返回 A0404，模型已停用返回 C0130。""")
    @OperationLog(module = MODULE, action = "新建会话")
    @PostMapping
    public Result<SessionVO> create(@Valid @RequestBody SessionRequest req) {
        return Result.ok(sessionService.create(CurrentUser.get().id(), req));
    }

    @Operation(summary = "分页查询会话", description = "按更新时间倒序；keyword 匹配标题（不区分大小写）")
    @GetMapping
    public Result<PageResult<SessionSummaryVO>> page(@ParameterObject SessionQuery query) {
        return Result.ok(sessionService.page(CurrentUser.get().id(), query));
    }

    @Operation(summary = "会话详情", description = "含会话记忆（摘要、实体表、已压缩轮次）、等待回答的追问，以及按轮次的版本链与采用版本")
    @GetMapping("/{id}")
    public Result<SessionDetailVO> detail(@PathVariable Long id) {
        return Result.ok(sessionService.detail(CurrentUser.get().id(), id));
    }

    @Operation(summary = "修改会话", description = "修改标题与默认参数，未给出的字段保持不变")
    @OperationLog(module = MODULE, action = "修改会话")
    @PutMapping("/{id}")
    public Result<SessionVO> update(@PathVariable Long id, @Valid @RequestBody SessionRequest req) {
        return Result.ok(sessionService.update(CurrentUser.get().id(), id, req));
    }

    @Operation(summary = "删除会话（逻辑删除）", description = "会话内的翻译记录仍保留在历史中")
    @OperationLog(module = MODULE, action = "删除会话")
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        sessionService.delete(CurrentUser.get().id(), id);
        return Result.ok();
    }

    @Operation(summary = "修订（SSE）", description = """
            对会话中的一条记录提出修订要求（1–500 字符），以与流式翻译相同的事件协议返回（plan 的 path 为 revise）；\
            成功后写入新记录（revisionOf 指向被修订记录、mode=revise）并成为该轮的采用版本，final 中补充 recordId、\
            sessionId、revisionOf。记录不属于该会话返回 A0404；会话中已有进行中的翻译返回 409 + A0214。""",
            responses = @ApiResponse(responseCode = "200", description = "SSE 事件流",
                    content = @Content(mediaType = MediaType.TEXT_EVENT_STREAM_VALUE,
                            schema = @Schema(type = "string", example = SSE_EXAMPLE))))
    @PostMapping(value = "/{id}/revise", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> revise(@PathVariable Long id, @Valid @RequestBody ReviseRequest req,
                                                HttpServletResponse response) {
        Flux<ServerSentEvent<String>> events = translateService.revise(CurrentUser.get().id(), id, req);
        noBuffering(response);
        return events;
    }

    @Operation(summary = "回答追问（SSE）", description = """
            回答会话中等待回答的追问（选项或 1–200 字符的自由文本），AI 服务从断点继续，事件流以 start 开始、final 结束；\
            成功后写入记录（clarification 保存问答，轨迹合并中断前后）并清空追问。没有待回答的追问或 threadId 不一致\
            返回 409 + A0440；会话中已有进行中的翻译返回 409 + A0214。""",
            responses = @ApiResponse(responseCode = "200", description = "SSE 事件流",
                    content = @Content(mediaType = MediaType.TEXT_EVENT_STREAM_VALUE,
                            schema = @Schema(type = "string", example = SSE_EXAMPLE))))
    @PostMapping(value = "/{id}/clarify", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> clarify(@PathVariable Long id, @Valid @RequestBody ClarifyRequest req,
                                                 HttpServletResponse response) {
        Flux<ServerSentEvent<String>> events = translateService.clarify(CurrentUser.get().id(), id, req);
        noBuffering(response);
        return events;
    }

    @Operation(summary = "设为采用版本", description = "把记录设为所在轮次的采用版本（同一轮只有一个采用版本），之后的会话上下文使用该版本；记录不属于该会话返回 A0404")
    @PutMapping("/{id}/records/{recordId}/adopt")
    public Result<SessionDetailVO> adopt(@PathVariable Long id, @PathVariable Long recordId) {
        return Result.ok(sessionService.adopt(CurrentUser.get().id(), id, recordId));
    }

    /** 禁止任何一跳缓冲（浏览器、Nginx 等反向代理）。 */
    private static void noBuffering(HttpServletResponse response) {
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
    }
}
