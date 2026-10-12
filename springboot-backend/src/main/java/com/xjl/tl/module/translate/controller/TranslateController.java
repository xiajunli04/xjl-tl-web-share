package com.xjl.tl.module.translate.controller;

import com.xjl.tl.common.Result;
import com.xjl.tl.module.translate.SupportedLanguage;
import com.xjl.tl.module.translate.dto.TranslateDtos.DetectRequest;
import com.xjl.tl.module.translate.dto.TranslateDtos.DetectResult;
import com.xjl.tl.module.translate.dto.TranslateDtos.LanguageVO;
import com.xjl.tl.module.translate.dto.TranslateDtos.TranslateRequest;
import com.xjl.tl.module.translate.service.TranslateService;
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
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

import java.util.Arrays;
import java.util.List;

@Tag(name = "文本翻译", description = "支持语种、语种识别与 Agent 流式翻译")
@RestController
@RequestMapping("/api/translate")
public class TranslateController {

    private static final List<LanguageVO> LANGUAGES = Arrays.stream(SupportedLanguage.values())
            .map(l -> new LanguageVO(l.code(), l.cnName(), l.nativeName()))
            .toList();

    private final TranslateService service;

    public TranslateController(TranslateService service) {
        this.service = service;
    }

    @Operation(summary = "支持的语种清单", description = "返回 15 种语种的代码、中文名与本族语名称")
    @GetMapping("/languages")
    public Result<List<LanguageVO>> languages() {
        return Result.ok(LANGUAGES);
    }

    @Operation(summary = "语种识别", description = "转发到 AI 服务识别语种；空白文本返回 A0410；每个用户每分钟最多 120 次，超限返回 429 + A0212")
    @PostMapping("/detect")
    public Result<DetectResult> detect(@Valid @RequestBody DetectRequest req) {
        return Result.ok(service.detect(CurrentUser.get().id(), req));
    }

    @Operation(summary = "流式翻译（SSE）", description = """
            以 text/event-stream 返回 Agent 事件流，事件名：start、node、detect、terms、plan、delta、review、memory、clarify、\
            final、error，data 均为单行 JSON；每 15 秒发送一次注释心跳 ": ping"。final 事件中补充 recordId（翻译记录 id）、\
            sessionId、revisionOf。带 sessionId 时使用会话默认参数（请求显式值优先）并注入会话上下文，会话有待回答的追问时\
            视为放弃；会话翻译可能以 clarify（等待回答追问，不写记录）结束。\
            参数校验（A0410 / A0420）、会话与术语库权限（A0404）、模型可用性（C0130）、限流（429 + A0212，每用户每分钟 20 次）、\
            会话并发（409 + A0214）都在建立流之前完成，失败时返回普通 JSON；建立流之后的错误以 error 事件 {code, message} 返回\
            （如 AI 服务不可用 C0110、Agent 执行失败 C0140、翻译超时 C0141），随后流结束。""",
            responses = @ApiResponse(responseCode = "200", description = "SSE 事件流",
                    content = @Content(mediaType = MediaType.TEXT_EVENT_STREAM_VALUE,
                            schema = @Schema(type = "string", example = "event: start\ndata: {\"requestId\":\"req-001\"}\n\n"))))
    @PostMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<String>> stream(@Valid @RequestBody TranslateRequest req, HttpServletResponse response) {
        Flux<ServerSentEvent<String>> events = service.stream(CurrentUser.get().id(), req);
        // 禁止任何一跳缓冲（浏览器、Nginx 等反向代理）
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-cache");
        response.setHeader("X-Accel-Buffering", "no");
        return events;
    }
}
