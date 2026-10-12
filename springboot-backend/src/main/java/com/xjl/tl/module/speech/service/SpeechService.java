package com.xjl.tl.module.speech.service;

import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.config.MediaProperties;
import com.xjl.tl.infra.ai.AiServiceClient;
import com.xjl.tl.infra.ai.AiServiceClient.StreamResponse;
import com.xjl.tl.module.speech.dto.SpeechDtos.EngineInfo;
import com.xjl.tl.module.speech.dto.SpeechDtos.SpeechEngines;
import com.xjl.tl.module.speech.dto.SpeechDtos.TranscribeResult;
import com.xjl.tl.module.speech.dto.SpeechDtos.TtsRequest;
import com.xjl.tl.module.speech.dto.SpeechDtos.UpstreamTranscribeRequest;
import com.xjl.tl.module.speech.dto.SpeechDtos.UpstreamTtsRequest;
import com.xjl.tl.module.translate.SupportedLanguage;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;

/**
 * 语音服务（add-speech-and-image-translation D5 / D12，契约 §1.1–1.3）：
 * <ul>
 *   <li>引擎列表：代理 Python，内存缓存 {@link #ENGINES_TTL}（refresh=true 时绕过缓存并要求 Python 重新探测）</li>
 *   <li>听写：按 WAV 头计算时长，超过上限、空音频或非 PCM WAV 返回 A0454；base64 后转发</li>
 *   <li>朗读：文本长度与语言校验后转发，音频以上游输入流的形式边读边返回（improve-speech-playback-latency D2）；
 *       Python 首包前的 JSON 错误按信封转换为业务异常</li>
 * </ul>
 */
@Service
public class SpeechService {

    public static final String UPSTREAM_ENGINES_PATH = "/internal/speech/engines";
    public static final String UPSTREAM_TRANSCRIBE_PATH = "/internal/speech/transcribe";
    public static final String UPSTREAM_TTS_PATH = "/internal/speech/tts";
    /** 引擎列表缓存时长：Python 内置引擎探测本身缓存 10 分钟，这里只做短暂缓存以吸收页面并发请求。 */
    static final Duration ENGINES_TTL = Duration.ofSeconds(30);

    private final AiServiceClient aiServiceClient;
    private final MediaProperties props;
    private volatile CachedEngines cache;

    public SpeechService(AiServiceClient aiServiceClient, MediaProperties props) {
        this.aiServiceClient = aiServiceClient;
        this.props = props;
    }

    private record CachedEngines(SpeechEngines engines, long fetchedAtMillis) {
    }

    // ---------------- 引擎 ----------------

    public SpeechEngines engines(boolean refresh) {
        CachedEngines c = cache;
        long now = System.currentTimeMillis();
        if (!refresh && c != null && now - c.fetchedAtMillis() < ENGINES_TTL.toMillis()) {
            return c.engines();
        }
        SpeechEngines fetched = aiServiceClient.get(UPSTREAM_ENGINES_PATH, Map.of(),
                Map.of("refresh", refresh ? "true" : ""), SpeechEngines.class);
        if (fetched == null) {
            throw new BizException(ErrorCode.AI_SERVICE_UNAVAILABLE);
        }
        SpeechEngines normalized = new SpeechEngines(orEmpty(fetched.asr()), orEmpty(fetched.tts()),
                orEmpty(fetched.interpret()), orEmpty(fetched.image()), orEmpty(fetched.chat()));
        cache = new CachedEngines(normalized, now);
        return normalized;
    }

    /** 可用的同传引擎；不存在（未实现）或不可用时抛出 C0173，消息带上不可用原因。 */
    public EngineInfo requireInterpretEngine(String id) {
        EngineInfo engine = engines(false).interpretEngine(id);
        if (engine == null) {
            throw new BizException(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "同传引擎不存在或未实现：" + id);
        }
        if (!engine.usable()) {
            String reason = StringUtils.hasText(engine.reason()) ? "：" + engine.reason() : "";
            throw new BizException(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "同传引擎不可用" + reason);
        }
        return engine;
    }

    /** 可用的 AI 对话引擎；不存在或不可用时抛出 C0173，消息带上不可用原因。 */
    public EngineInfo requireChatEngine(String id) {
        EngineInfo engine = engines(false).chatEngine(id);
        if (engine == null) {
            throw new BizException(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "AI 对话引擎不存在：" + id);
        }
        if (!engine.usable()) {
            String reason = StringUtils.hasText(engine.reason()) ? "：" + engine.reason() : "";
            throw new BizException(ErrorCode.SPEECH_ENGINE_UNAVAILABLE, "AI 对话引擎不可用" + reason);
        }
        return engine;
    }

    private static List<EngineInfo> orEmpty(List<EngineInfo> list) {
        return list == null ? List.of() : list;
    }

    // ---------------- 听写 ----------------

    public TranscribeResult transcribe(MultipartFile file, String lang, String engine) {
        if (file == null || file.isEmpty()) {
            throw new BizException(ErrorCode.AUDIO_INVALID, "音频为空");
        }
        String hint = StringUtils.hasText(lang) ? lang : SupportedLanguage.AUTO;
        SupportedLanguage.requireSource("lang", hint);
        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException e) {
            throw new BizException(ErrorCode.AUDIO_INVALID, "音频读取失败");
        }
        WavHeader wav = WavHeader.parse(bytes);
        if (wav.durationMs() > props.transcribeMaxSeconds() * 1000L) {
            throw new BizException(ErrorCode.AUDIO_INVALID, "音频过长，听写最长 " + props.transcribeMaxSeconds() + " 秒");
        }
        UpstreamTranscribeRequest req = new UpstreamTranscribeRequest(Base64.getEncoder().encodeToString(bytes), hint,
                StringUtils.hasText(engine) ? engine : null, null);
        return aiServiceClient.post(UPSTREAM_TRANSCRIBE_PATH, req, TranscribeResult.class);
    }

    // ---------------- 朗读 ----------------

    public StreamResponse tts(TtsRequest req) {
        if (req.text().length() > props.ttsMaxChars()) {
            throw FieldError.invalid("text", "朗读文本最长 " + props.ttsMaxChars() + " 字符");
        }
        SupportedLanguage.require("lang", req.lang());
        UpstreamTtsRequest upstream = new UpstreamTtsRequest(req.text(), req.lang(),
                StringUtils.hasText(req.voice()) ? req.voice() : null,
                StringUtils.hasText(req.gender()) ? req.gender() : "female",
                StringUtils.hasText(req.engine()) ? req.engine() : null, null, req.rate() != null ? req.rate() : 1.0);
        return aiServiceClient.postStream(UPSTREAM_TTS_PATH, upstream);
    }
}
