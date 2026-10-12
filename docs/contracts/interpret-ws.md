# 同传实时音频通道协议与真实事件样例

> 字段定义见 [speech-image-api.md](speech-image-api.md) §1.8（Python 内部 WS）与 §2.6（浏览器 WS）；本文给出联调时抓取的真实事件，用于对照实现。
> 抓取时间 2026-10-04，环境：本机 Spring + Python，级联引擎（本地 SenseVoice + qwen-turbo + edge-tts），音频为 E4 数据集的合成中文语音。

## 1. 连接流程

```
浏览器                         Spring                                   Python
  │ POST /api/interpret/sessions ─▶ 建会话、签发一次性票据（Redis，60 s）
  │ ◀── {sessionId, participantId, wsTicket, …}
  │ WS /ws/interpret?ticket=…  ─▶ 握手：校验 Origin → GETDEL 票据
  │ ◀── ready / participants
  │ ══ PCM16 16 kHz（40 ms/帧）══▶ 首帧音频时建立发言流 ─WS /internal/interpret/stream (X-Internal-Token)─▶
  │                               ─── config（首帧 JSON）──────────────────────────────────────────────▶
  │                               ═══ 音频帧转发 ═══════════════════════════════════════════════════════▶
  │                               ◀── transcript.* / translation.* / audio / metrics（utteranceId 为整数）
  │ ◀── 补 speaker、utteranceId 改写为 "p1:n"，audio 只发给语言匹配的成员
  │ {"type":"end"} ─────────────▶ 收尾：停止转发音频 → 向发言流发 end → Python 处理完积压句子后关闭（≤8 s）
  │ ◀── ended{reason, stats}      → 转写段落库、写入统计 → 关闭连接（1000）
```

关闭码：1000 正常结束；4400 配置非法（不重建）；4401 内部鉴权失败（不重建）；4404 会话不存在或已结束；4409 被同一成员的新连接替换；1011 致命错误。
其他异常断开时 Spring 向浏览器发 `error{code:"C0174", fatal:false}` 并重建一次发言流。

## 2. 浏览器收到的事件（级联引擎，收听模式 中→英，节选）

时间为相对连接建立的秒数；`audio.data` 截断。

```
  0.05s  {"type": "ready", "sessionId": 3, "participantId": "p1", "mode": "LISTEN", "engine": "cascade", "languages": ["en"], "roomCode": null, "isHost": true}
  0.05s  {"type": "participants", "list": [{"participantId": "p1", "displayName": "admin", "lang": "en", "speaking": false, "isHost": true, "online": true}]}
  2.84s  {"type": "transcript.final", "utteranceId": "p1:1", "text": "大家好。", "lang": "zh", "startedMs": 166, "endedMs": 684, "speaker": {"participantId": "p1", "displayName": "admin", "lang": "en"}}
  3.04s  {"type": "transcript.partial", "utteranceId": "p1:2", "text": "今天我们讨论新版本的发布。", "speaker": {"participantId": "p1", "displayName": "admin", "lang": "en"}}
  3.83s  {"type": "transcript.final", "utteranceId": "p1:2", "text": "今天我们讨论新版本的发布计划。", "lang": "zh", "startedMs": 1286, "endedMs": 3084, "speaker": {"participantId": "p1", "displayName": "admin", "lang": "en"}}
  4.62s  {"type": "translation.delta", "utteranceId": "p1:1", "lang": "en", "delta": "Hello", "speaker": {"participantId": "p1", "displayName": "admin", "lang": "en"}}
  4.62s  {"type": "translation.delta", "utteranceId": "p1:1", "lang": "en", "delta": " everyone", "speaker": {"participantId": "p1", "displayName": "admin", "lang": "en"}}
  6.04s  {"type": "translation.final", "utteranceId": "p1:1", "lang": "en", "text": "Hello everyone.", "ttsFallback": false, "speaker": {"participantId": "p1", "displayName": "admin", "lang": "en"}}
  6.12s  {"type": "audio", "utteranceId": "p1:1", "lang": "en", "format": "mp3", "sampleRate": 24000, "seq": 0, "last": false, "data": "//NkxAANMBo4NnmGABjQ45Ag…", "speaker": {"participantId": "p1", "displayName": "admin", "lang": "en"}}
  6.28s  {"type": "audio", "utteranceId": "p1:1", "lang": "en", "format": "mp3", "sampleRate": 24000, "seq": 1, "last": false, "data": "//NkxGAzgrZkAMPNqK0U1C2F…", "speaker": {"participantId": "p1", "displayName": "admin", "lang": "en"}}
  6.28s  {"type": "metrics", "utteranceId": "p1:1", "asrMs": 113, "mtFirstMs": 1783, "mtMs": 1824, "ttsFirstMs": 1378, "e2eMs": 3415, "speaker": {"participantId": "p1", "displayName": "admin", "lang": "en"}}
```

要点：
- 一句话的事件顺序：`transcript.partial*` → `transcript.final` → `translation.delta*` → `translation.final` → `audio*`（最后一包 `last=true`）→ `metrics`。
- 句与句流水线并行：第 2 句的原文定稿可以早于第 1 句的译文定稿。
- `metrics.e2eMs` = 说话结束（VAD 句末）→ 首段译音就绪；未开播报时终点为译文定稿。

## 3. 百炼 qwen3.8-livetranslate 上游事件（Python ↔ 百炼，节选）

来自 `python-backend/tests/fixtures/interpret/qwen_livetranslate_events.jsonl`（真实抓取，`_dir` 为方向，`_t` 为秒）。
注意：必须显式指定 `voice`（默认音色 Chelsie 不可用）；原文增量事件名为 `conversation.item.input_audio_transcription.delta`，译文增量为 `response.audio_transcript.delta`。

```
{"_dir": "client", "_t": 0.0, "type": "session.update", "session": {"output_modalities": ["text", "audio"], "voice": "Tina", "input_audio_transcription": {"model": "qwen3-asr-flash-realtime"}, "translation": {"language": "en", "corpus": {"phrases": {"大模型": "LLM"}}}}}
{"_dir": null, "_t": 2.813, "type": "session.created", "session": {"voice": "Chelsie", "…": "…"}}
{"_dir": null, "_t": 3.224, "type": "session.updated", "session": {"voice": "Tina", "…": "…"}}
{"event_id": "event_NxD82czNDAmDSvgalTL2m", "type": "input_audio_buffer.speech_started", "audio_start_ms": 24, "item_id": "item_IVx1kkkn1BqUyYxmWX4ez", "_t": 4.174}
{"event_id": "event_BOPI24yaESgo7cksDGrDa", "type": "conversation.item.input_audio_transcription.delta", "item_id": "item_IVx1kkkn1BqUyYxmWX4ez", "content_index": 0, "delta": "大家好 ", "obfuscation": "AJZgDazRoX5bjw", "_t": 4.356}
{"event_id": "event_VpCjMhpCYiDCKNBtifLQm", "type": "response.audio_transcript.delta", "response_id": "resp_GbNUQudArNpKxyOqiV228", "item_id": "item_UnjL8FLYgYxUPdnna9k1l", "output_index": 0, "content_index": 0, "delta": "Hello everyone.", "_t": 4.364}
{"event_id": "event_Fg9aNsHU487bpRtbg95Mn", "type": "response.audio.delta", "response_id": "resp_GbNUQudArNpKxyOqiV228", "item_id": "item_UnjL8FLYgYxUPdnna9k1l", "output_index": 0, "content_index": 0, "delta": "AAAAAAAAAAAAAAAA…", "delta_len": 15360, "_t": 4.561}
{"event_id": "event_LDaDeEQ7IZ4TgzgTyemTw", "type": "input_audio_buffer.speech_stopped", "audio_end_ms": 1100, "item_id": "item_IVx1kkkn1BqUyYxmWX4ez", "_t": 4.88}
{"event_id": "event_YuvVlPOZmOcaONoHFGrNq", "type": "conversation.item.input_audio_transcription.completed", "item_id": "item_IVx1kkkn1BqUyYxmWX4ez", "content_index": 0, "transcript": "大家好 ", "_t": 4.959}
{"event_id": "event_K4pdPe9EwWlYCbRfkMeuv", "type": "response.audio_transcript.done", "response_id": "resp_GbNUQudArNpKxyOqiV228", "item_id": "item_UnjL8FLYgYxUPdnna9k1l", "output_index": 0, "content_index": 0, "transcript": "Hello everyone. ", "_t": 4.959}
{"event_id": "event_T3OMks4ml3DB8j7XY9rpU", "type": "response.audio.done", "response_id": "resp_GbNUQudArNpKxyOqiV228", "item_id": "item_UnjL8FLYgYxUPdnna9k1l", "output_index": 0, "content_index": 0, "_t": 4.959}
{"event_id": "event_SFxSDDLPHc25XRzGATun6", "type": "response.done", "response": {"id": "resp_GbNUQudArNpKxyOqiV228", "object": "realtime.response", "conversation_id": "conv_TcaBDLr76xYfIwihtvq4P", "status": "completed", "modalities": ["text", "audio"], "voice": "Tina", "output_audio_format": "pcm24", "output": [{"id": "item_UnjL8FLYgYxUPdnna9k1l", "object": "realtime.item", "type": "message", "status": "completed", "role": "assistant", "content": [{"type": "audio", "transcript": "Hello everyone. "}]}], "usage": {"total_tokens": 105, "input_tokens": 84, "output_tokens": 21, "input_tokens_details": {"text_tokens": 70, "audio_tokens": 14}, "output_tokens_details": {"text_tokens": 7, "audio_tokens": 14}}}, "_t": 4.965}
{"event_id": "event_O72PJunOWhaTbW9kM9HoH", "type": "input_audio_buffer.speech_started", "audio_start_ms": 1100, "item_id": "item_V1aGDhDvnsO22gLF4jl51", "_t": 5.294}
{"event_id": "event_P1yW4fYaoH5HUOwDjQWFZ", "type": "input_audio_buffer.speech_stopped", "audio_end_ms": 3900, "item_id": "item_V1aGDhDvnsO22gLF4jl51", "_t": 7.927}
{"event_id": "event_GCi6GS8Eh5PL2wMIvrpUb", "type": "conversation.item.input_audio_transcription.completed", "item_id": "item_V1aGDhDvnsO22gLF4jl51", "content_index": 0, "transcript": "今天我们讨论大模型 在翻译中的应用 ", "_t": 8.654}
{"event_id": "event_Yv4PV2RmZNifUzSZB4RF9", "type": "response.audio_transcript.done", "response_id": "resp_Qk9JN5ZPRkpLHGAPakAqb", "item_id": "item_DNICzYZxZlBzgGcNPa3J3", "output_index": 0, "content_index": 0, "transcript": "Today we are going to discuss LLMs. specifically their application in translation. ", "_t": 8.654}
```

Python 侧映射：`input_audio_transcription.delta/completed` → `transcript.partial/final`；`response.audio_transcript.delta/done` → `translation.delta/final`；
`response.audio.delta` → `audio`（pcm16，24 kHz）；`input_audio_buffer.speech_stopped` 作为 e2e 计时起点。

## 4. AI 对话（CHAT）事件样例（Python 内部 WS，节选）

来自 `evaluation/eval/multimodal/chat_smoke.py` 的真实联调（2026-10-05，餐厅场景，中转站对话模型 + 本地 SenseVoice + edge-tts）。
经 Spring 转发后，`role=assistant` 的事件会被补上 `speaker: {participantId:"ai", displayName:"Lumi", lang:"en"}`。

```jsonc
// 就绪后 AI 先开口（开场白，uid=1）
{"type":"transcript.partial","utteranceId":1,"role":"assistant","text":"Welcome to our"}
{"type":"transcript.final","utteranceId":1,"role":"assistant","text":"Welcome to our restaurant. Here is the menu. What would you like to drink?","lang":"en","ttsFallback":false}
{"type":"translation.delta","utteranceId":1,"role":"assistant","lang":"zh","delta":"欢迎"}
{"type":"translation.final","utteranceId":1,"role":"assistant","lang":"zh","text":"欢迎来到我们的餐厅。这是菜单。你想喝点什么？","ttsFallback":false}
{"type":"audio","utteranceId":1,"role":"assistant","lang":"en","format":"mp3","sampleRate":24000,"seq":0,"last":false,"data":"…"}
{"type":"metrics","utteranceId":1,"role":"assistant","mtFirstMs":2913,"ttsFirstMs":1405,"e2eMs":5430}

// 用户说了一句中文（uid=2）：只转写，metrics 只有 asrMs
{"type":"transcript.final","utteranceId":2,"text":"大家好。","lang":"zh","startedMs":166,"endedMs":684}
{"type":"metrics","utteranceId":2,"asrMs":239,"mtFirstMs":null,"mtMs":null,"ttsFirstMs":null,"e2eMs":null}

// AI 回复（uid=3）还在播报时，用户的第二句定稿（uid=4）→ 插话打断
{"type":"transcript.final","utteranceId":3,"role":"assistant","text":"Hello there. What would you like to drink?","lang":"en","ttsFallback":false}
{"type":"transcript.final","utteranceId":4,"text":"今天我们讨论新版本的发布计划。","lang":"zh","startedMs":1286,"endedMs":3084}
{"type":"reply.interrupted","utteranceId":3,"role":"assistant","text":"Hello there. What would you like to drink?"}

// 对新句的回复（uid=5）：先示范更地道的说法，再回到场景
{"type":"transcript.final","utteranceId":5,"role":"assistant","text":"You could say: \"Today we are discussing the release plan for the new version.\" What would you like to drink?","lang":"en","ttsFallback":false}
```

实测：用户句末到 AI 首段语音 e2e 约 2.6 s（回复首字 1.5 s + 首句合成 0.8 s）。
