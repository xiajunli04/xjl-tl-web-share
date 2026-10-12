package com.xjl.tl.module.speech;

import com.xjl.tl.support.MockAiServer;
import com.xjl.tl.support.StreamingTestBase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * speech-services「引擎可用性」「听写接口」「朗读接口」/ tasks 6.1：引擎列表代理与缓存、WAV 时长校验与转发、
 * TTS 二进制透传与错误转换。模拟 Python 见 {@link MockAiServer}。
 */
class SpeechApiTest extends StreamingTestBase {

    private String token;

    @BeforeEach
    void user() throws Exception {
        String name = registerUser(uniqueName("sp"), "Passw0rd!");
        token = accessToken(name, "Passw0rd!");
    }

    /** 构造 PCM16 WAV：sampleRate、声道与时长（毫秒）。 */
    static byte[] wav(int sampleRate, int channels, int durationMs) {
        int byteRate = sampleRate * channels * 2;
        int dataBytes = (int) ((long) byteRate * durationMs / 1000);
        ByteBuffer b = ByteBuffer.allocate(44 + dataBytes).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + dataBytes).put("WAVE".getBytes(StandardCharsets.US_ASCII));
        b.put("fmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) channels)
                .putInt(sampleRate).putInt(byteRate).putShort((short) (channels * 2)).putShort((short) 16);
        b.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(dataBytes);
        return b.array();
    }

    private MvcResult transcribe(byte[] bytes, Map<String, String> params) throws Exception {
        var req = multipart("/api/speech/transcribe").file(new MockMultipartFile("file", "a.wav", "audio/wav", bytes));
        params.forEach(req::param);
        return mockMvc.perform(req.header("Authorization", "Bearer " + token)).andReturn();
    }

    private MvcResult tts(Map<String, Object> body) throws Exception {
        return perform(bearer(jsonBody(post("/api/speech/tts"), body), token));
    }

    @Test
    void enginesAreProxiedAndCachedBriefly() throws Exception {
        int before = mockAi().requests("/internal/speech/engines").size();
        JsonNode data = body(perform(bearer(get("/api/speech/engines").param("refresh", "true"), token))).path("data");
        assertThat(mockAi().requests("/internal/speech/engines")).hasSize(before + 1);
        assertThat(mockAi().requests("/internal/speech/engines").getLast().query()).isEqualTo("refresh=true");
        JsonNode cascade = data.path("interpret").get(0);
        assertThat(cascade.path("id").asString()).isEqualTo("cascade");
        assertThat(cascade.path("autoConverse").asBoolean()).isTrue();
        assertThat(cascade.path("maxTargets").asInt()).isEqualTo(5);
        JsonNode openai = data.path("interpret").get(2);
        assertThat(openai.path("available").asBoolean()).isFalse();
        assertThat(openai.path("reason").asString()).isEqualTo("未配置 OpenAI 实时同传");
        assertThat(data.path("asr").get(0).path("languages").size()).isEqualTo(5);
        assertThat(data.path("image").get(0).path("modelConfigId").asLong()).isEqualTo(2);
        JsonNode chat = data.path("chat");
        assertThat(chat.get(0).path("id").asString()).isEqualTo("cascade");
        assertThat(chat.get(1).path("id").asString()).isEqualTo("realtime-chat");
        assertThat(chat.get(1).path("provider").asString()).isEqualTo("DASHSCOPE");
        assertThat(chat.get(1).path("tested").asBoolean()).isTrue();

        // 缓存期内不再请求 AI 服务
        perform(bearer(get("/api/speech/engines"), token));
        assertThat(mockAi().requests("/internal/speech/engines")).hasSize(before + 1);
    }

    @Test
    void transcribeForwardsBase64WavAndReturnsResult() throws Exception {
        byte[] audio = wav(16000, 1, 3000);
        JsonNode r = body(transcribe(audio, Map.of("lang", "zh", "engine", "openai-transcribe")));
        assertThat(r.path("code").asString()).isEqualTo("00000");
        assertThat(r.path("data").path("text").asString()).isEqualTo("大家好");
        assertThat(r.path("data").path("engine").asString()).isEqualTo("openai-transcribe");
        MockAiServer.Received up = mockAi().requests("/internal/speech/transcribe").getLast();
        assertThat(up.internalToken()).isEqualTo("test-internal-token");
        assertThat(Base64.getDecoder().decode(up.body().path("audioBase64").asString())).isEqualTo(audio);
        assertThat(up.body().path("lang").asString()).isEqualTo("zh");
        assertThat(up.body().path("modelConfigId").isNull()).isTrue();

        // 缺省 lang=auto、engine 不传
        body(transcribe(wav(16000, 1, 1000), Map.of()));
        MockAiServer.Received up2 = mockAi().requests("/internal/speech/transcribe").getLast();
        assertThat(up2.body().path("lang").asString()).isEqualTo("auto");
        assertThat(up2.body().path("engine").isNull()).isTrue();
    }

    @Test
    void audioOver60SecondsEmptyOrNotWavIsRejected() throws Exception {
        int calls = mockAi().requests("/internal/speech/transcribe").size();
        MvcResult tooLong = transcribe(wav(16000, 1, 75_000), Map.of());
        assertThat(tooLong.getResponse().getStatus()).isEqualTo(400);
        assertThat(body(tooLong).path("code").asString()).isEqualTo("A0454");
        assertThat(body(tooLong).path("message").asString()).contains("60");
        // 恰好 60 秒允许
        assertThat(body(transcribe(wav(16000, 1, 60_000), Map.of())).path("code").asString()).isEqualTo("00000");

        assertThat(body(transcribe("not a wav file at all".getBytes(StandardCharsets.UTF_8), Map.of()))
                .path("code").asString()).isEqualTo("A0454");
        assertThat(body(transcribe(new byte[0], Map.of())).path("code").asString()).isEqualTo("A0454");
        assertThat(body(transcribe(wav(16000, 1, 0), Map.of())).path("code").asString()).isEqualTo("A0454");
        MvcResult missing = mockMvc.perform(multipart("/api/speech/transcribe").header("Authorization", "Bearer " + token)).andReturn();
        assertThat(body(missing).path("code").asString()).isEqualTo("A0454");
        assertThat(body(transcribe(wav(16000, 1, 1000), Map.of("lang", "xx"))).path("code").asString()).isEqualTo("A0420");
        assertThat(mockAi().requests("/internal/speech/transcribe")).hasSize(calls + 1);
    }

    @Test
    void engineUnavailableFromAiServiceIsPassedThrough() throws Exception {
        MvcResult r = transcribe(wav(16000, 1, 1000), Map.of("lang", "ko"));
        assertThat(r.getResponse().getStatus()).isEqualTo(503);
        assertThat(body(r).path("code").asString()).isEqualTo("C0173");
        assertThat(body(r).path("message").asString()).contains("本地识别模型未下载");
    }

    @Test
    void ttsStreamsBinaryAudioWithEngineHeaders() throws Exception {
        MvcResult r = tts(Map.of("text", "Hello", "lang", "en"));
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        assertThat(r.getResponse().getContentType()).isEqualTo("audio/mpeg");
        assertThat(r.getResponse().getContentAsByteArray()).isEqualTo(MockAiServer.TTS_BYTES);
        assertThat(r.getResponse().getHeader("X-Tts-Engine")).isEqualTo("edge-tts");
        assertThat(r.getResponse().getHeader("X-Tts-Voice")).isEqualTo("en-US-AvaMultilingualNeural");
        assertThat(r.getResponse().getHeader("X-Tts-Cache")).isEqualTo("miss");
        assertThat(r.getResponse().getHeader("X-Other")).isNull();
        assertThat(r.getResponse().getHeader("Cache-Control")).contains("no-store");
        JsonNode up = mockAi().requests("/internal/speech/tts").getLast().body();
        assertThat(up.path("gender").asString()).isEqualTo("female");
        assertThat(up.path("engine").isNull()).isTrue();
        assertThat(up.path("rate").asDouble()).isEqualTo(1.0);

        Map<String, Object> pcm = new HashMap<>(Map.of("text", "Hello", "lang", "en", "engine", "openai-speech",
                "gender", "male", "voice", "alloy"));
        MvcResult r2 = tts(pcm);
        assertThat(r2.getResponse().getContentType()).isEqualTo("audio/L16;rate=24000");
        assertThat(r2.getResponse().getHeader("X-Tts-Engine")).isEqualTo("openai-speech");
        JsonNode up2 = mockAi().requests("/internal/speech/tts").getLast().body();
        assertThat(up2.path("gender").asString()).isEqualTo("male");
        assertThat(up2.path("voice").asString()).isEqualTo("alloy");

        tts(Map.of("text", "Hello", "lang", "en", "rate", 1.2));
        assertThat(mockAi().requests("/internal/speech/tts").getLast().body().path("rate").asDouble()).isEqualTo(1.2);
    }

    @Test
    void ttsIsStreamedChunkByChunkOverRealHttp() throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/speech/tts"))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json(Map.of("text", "Hi [[mock:chunked]]", "lang", "en"))))
                .build();
        long start = System.nanoTime();
        HttpResponse<InputStream> resp = client.send(req, HttpResponse.BodyHandlers.ofInputStream());
        assertThat(resp.statusCode()).isEqualTo(200);
        assertThat(resp.headers().firstValue("Content-Type")).hasValue("audio/mpeg");
        try (InputStream in = resp.body()) {
            int first = in.read();
            long firstMs = (System.nanoTime() - start) / 1_000_000;
            byte[] rest = in.readAllBytes();
            long totalMs = (System.nanoTime() - start) / 1_000_000;
            // 首块在模拟 Python 停顿结束前就已到达客户端：Spring 没有整段缓冲
            assertThat(totalMs - firstMs).isGreaterThan(MockAiServer.TTS_CHUNK_GAP_MS / 2);
            byte[] all = new byte[rest.length + 1];
            all[0] = (byte) first;
            System.arraycopy(rest, 0, all, 1, rest.length);
            assertThat(all).isEqualTo(MockAiServer.TTS_BYTES);
        }
    }

    @Test
    void ttsJsonErrorsBecomeResultErrors() throws Exception {
        MvcResult failed = tts(Map.of("text", "Hi [[mock:c0172]]", "lang", "en"));
        assertThat(failed.getResponse().getStatus()).isEqualTo(502);
        assertThat(failed.getResponse().getContentType()).startsWith(MediaType.APPLICATION_JSON_VALUE);
        assertThat(body(failed).path("code").asString()).isEqualTo("C0172");
        assertThat(body(failed).path("message").asString()).contains("403");

        MvcResult down = tts(Map.of("text", "Hi [[mock:http500]]", "lang", "en"));
        assertThat(down.getResponse().getStatus()).isEqualTo(503);
        assertThat(body(down).path("code").asString()).isEqualTo("C0110");

        int calls = mockAi().requests("/internal/speech/tts").size();
        assertThat(body(tts(Map.of("text", "x".repeat(2001), "lang", "en"))).path("code").asString()).isEqualTo("A0410");
        assertThat(body(tts(Map.of("text", " ", "lang", "en"))).path("code").asString()).isEqualTo("A0410");
        assertThat(body(tts(Map.of("text", "Hi", "lang", "xx"))).path("code").asString()).isEqualTo("A0420");
        assertThat(body(tts(Map.of("text", "Hi", "lang", "en", "gender", "robot"))).path("code").asString())
                .isEqualTo("A0410");
        assertThat(body(tts(Map.of("text", "Hi", "lang", "en", "rate", 3))).path("code").asString()).isEqualTo("A0410");
        assertThat(body(tts(Map.of("text", "Hi", "lang", "en", "rate", 0.4))).path("code").asString()).isEqualTo("A0410");
        assertThat(mockAi().requests("/internal/speech/tts")).hasSize(calls);
    }

    @Test
    void uploadOverMultipartLimitMapsToAudioError() throws Exception {
        // 超过 spring.servlet.multipart 上限的处理器映射（图片接口 A0450 / 听写接口 A0454 / 其他 A0421）
        var handler = new com.xjl.tl.common.GlobalExceptionHandler();
        var ex = new org.springframework.web.multipart.MaxUploadSizeExceededException(1);
        for (var c : List.of(List.of("/api/speech/transcribe", "A0454"), List.of("/api/image-translations", "A0450"),
                List.of("/api/glossaries/1/terms/import", "A0421"))) {
            var req = new org.springframework.mock.web.MockHttpServletRequest("POST", c.get(0));
            assertThat(handler.handleUploadTooLarge(ex, req).getBody().code()).isEqualTo(c.get(1));
        }
    }

    @Test
    void requiresLogin() throws Exception {
        assertThat(perform(get("/api/speech/engines")).getResponse().getStatus()).isEqualTo(401);
    }
}
