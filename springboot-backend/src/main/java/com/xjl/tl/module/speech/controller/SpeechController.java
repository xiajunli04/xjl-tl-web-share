package com.xjl.tl.module.speech.controller;

import com.xjl.tl.common.Result;
import com.xjl.tl.infra.ai.AiServiceClient.StreamResponse;
import com.xjl.tl.module.speech.dto.SpeechDtos.SpeechEngines;
import com.xjl.tl.module.speech.dto.SpeechDtos.TranscribeResult;
import com.xjl.tl.module.speech.dto.SpeechDtos.TtsRequest;
import com.xjl.tl.module.speech.service.SpeechService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;

@Tag(name = "语音服务", description = "引擎列表、听写（语音识别）与朗读（语音合成），见 add-speech-and-image-translation D5 / D12")
@RestController
@RequestMapping("/api/speech")
public class SpeechController {

    /** 朗读接口透传的 Python 响应头。 */
    static final List<String> TTS_HEADERS = List.of("X-Tts-Engine", "X-Tts-Voice", "X-Tts-Cache");
    private static final int STREAM_BUFFER_BYTES = 8192;

    private final SpeechService service;

    public SpeechController(SpeechService service) {
        this.service = service;
    }

    @Operation(summary = "语音、同传与图片引擎列表", description = """
            返回 asr / tts / interpret / image / chat 五类引擎（chat 为 AI 对话可用引擎，含 provider / tested；id、名称、厂商、是否可用与原因、支持的语言、同传引擎的 s2s / \
            maxTargets / autoConverse）。内置引擎可用性由 AI 服务探测，配置型引擎来自已启用的对应能力模型配置；\
            结果缓存 30 秒，refresh=true 时强制重新探测。""")
    @GetMapping("/engines")
    public Result<SpeechEngines> engines(@RequestParam(defaultValue = "false") boolean refresh) {
        return Result.ok(service.engines(refresh));
    }

    @Operation(summary = "听写", description = """
            multipart 上传 16 kHz 单声道 PCM16 WAV（file，≤60 秒），可选 lang 提示（缺省 auto）与 engine。\
            空音频、超过 60 秒、非 PCM WAV 返回 A0454；语言不支持返回 A0420；引擎不可用返回 503 + C0173。""")
    @PostMapping(value = "/transcribe", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Result<TranscribeResult> transcribe(
            @Parameter(description = "WAV 音频") @RequestPart(value = "file", required = false) MultipartFile file,
            @Parameter(description = "语言提示，缺省 auto") @RequestParam(required = false) String lang,
            @Parameter(description = "识别引擎，缺省由 AI 服务选择") @RequestParam(required = false) String engine) {
        return Result.ok(service.transcribe(file, lang, engine));
    }

    @Operation(summary = "朗读", description = """
            成功时以分块传输边合成边返回音频（audio/mpeg 或 audio/L16;rate=24000），命中缓存时一次返回；\
            透传 X-Tts-Engine、X-Tts-Voice、X-Tts-Cache（hit | miss）响应头。可选 gender（female | male）与 rate（0.5–2.0）。\
            首包前失败返回 Result JSON：文本为空或超过 2000 字符、语速越界 A0410，语言不支持 A0420，合成失败 502 + C0172，\
            引擎不可用 503 + C0173（前端随即改用浏览器朗读）；首包后中断则提前结束响应。""",
            responses = @ApiResponse(responseCode = "200", description = "音频字节",
                    content = @Content(mediaType = "audio/mpeg", schema = @Schema(type = "string", format = "binary"))))
    @PostMapping("/tts")
    public void tts(@Valid @RequestBody TtsRequest req, HttpServletResponse response) throws IOException {
        StreamResponse audio = service.tts(req);
        // 首包前的失败已在 service.tts 中以业务异常抛出（Result JSON）；此后边读边写出并逐块 flush，
        // 不经 StreamingResponseBody（其输出流忽略 flush，会被 Tomcat 缓冲到结束才发出）
        try (audio; InputStream in = audio.body()) {
            // 原样透传 Content-Type 字符串（MediaType 会把 audio/L16 规范化为小写）
            String contentType = audio.headers().getFirst(HttpHeaders.CONTENT_TYPE);
            response.setStatus(HttpServletResponse.SC_OK);
            response.setHeader(HttpHeaders.CONTENT_TYPE,
                    contentType != null ? contentType : MediaType.APPLICATION_OCTET_STREAM_VALUE);
            response.setHeader(HttpHeaders.CACHE_CONTROL, CacheControl.noStore().getHeaderValue());
            for (String name : TTS_HEADERS) {
                String value = audio.headers().getFirst(name);
                if (value != null) {
                    response.setHeader(name, value);
                }
            }
            OutputStream out = response.getOutputStream();
            byte[] buf = new byte[STREAM_BUFFER_BYTES];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
                out.flush();
            }
        }
    }
}
