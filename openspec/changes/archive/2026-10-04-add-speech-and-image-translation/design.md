## Context

①–⑥ 已完成"文字进、文字出"的翻译平台：短文本 Agent、长文档篇章翻译、会话修订与追问、翻译记忆、评测体系。用户要求对标 Google 翻译，把主流厂商已有的实时语音与图片翻译能力接进来。

### 调研结论（2026-10）

| 厂商 / 产品 | 能力 | 接入方式 | 对本项目的意义 |
|---|---|---|---|
| Google 翻译 Live Translate | 两种模式：持续收听（多语种 → 单一目标语言，耳机播报），双向对话（按说话人自动切换输出语言）；70+ 语种；Gemini 原生语音到语音 | 无公开 API | 交互形态的参照 |
| Google 翻译 2026-02 | Alternatives / Understand / Ask：备选译法、讲解为何如此翻译、对译文追问 | 无公开 API | 交互形态的参照 |
| OpenAI `gpt-realtime-translate`（2026-05） | 流式语音到语音翻译，70+ 输入语种，13 种输出语种（含 zh），$0.034/分钟，自动识别源语种 | `wss://api.openai.com/v1/realtime/translations`（服务端），或浏览器 WebRTC + 临时 client secret。事件：`session.update`（`audio.output.language`）、`session.input_audio_buffer.append`（PCM16 24 kHz base64）→ `session.input_transcript.delta`、`session.output_transcript.delta`、`session.output_audio.delta`。双向通话官方建议每个方向一个会话 | S2S 引擎 A |
| 阿里百炼 `qwen3.8-livetranslate-flash-realtime` | 60 语种，约 2.3 s 延迟，热词（`translation.corpus.phrases`），说话人分离，可附带画面辅助翻译 | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=…`（Bearer）。事件：`session.update`（`translation.language`、`voice`、`input_audio_format=pcm`）、`input_audio_buffer.append` → `response.audio_transcript.delta/done`、`response.audio.delta` | S2S 引擎 B |
| 阿里百炼 `qwen3-asr-flash-realtime` / `qwen3-tts-flash-realtime` | 30 语种识别 / 10 语种合成 | WebSocket | 本次不接（见 D5） |
| 阿里百炼 `qwen-mt-image-2.0` | 图片翻译，保留版式，返回译图 URL（24 h 有效）；中/英与其他语种互译；支持领域提示与术语 | `POST /api/v1/services/aigc/image2image/image-synthesis`，同步模式 | 图片引擎 B |
| sherpa-onnx + SenseVoice-small int8 + Silero VAD | 本地离线识别，支持 zh/en/ja/ko/yue 并自带语种识别；CPU 上处理 10 s 音频约 70 ms；VAD 切句后形成准实时识别 | `pip install sherpa-onnx`，模型约 230 MB | 级联 ASR 默认引擎，免密钥 |
| edge-tts 7.2.x | 免费的微软神经语音合成，100+ 语种，流式 MP3 | Python 库 | 级联 TTS 默认引擎；存在 403 风险 |
| 当前中转站 subapi.orzle.xyz | 仅有文本与图像生成模型，无 realtime/ASR/TTS；**gpt-5.6-luna / gpt-6-luna 支持图片输入，OCR 文字与像素 bbox 实测准确** | OpenAI 兼容 | 图片引擎 A（视觉 OCR）可直接落地 |
| 字节 豆包·同声传译 2.0（Seed LiveInterpret 2.0，2025-07） | 端到端全双工同传，延迟 2–3 s，支持 0 样本声音复刻；S2S 模式下源语种或目标语种之一须为中/英，支持 zh/en/ja/pt/es/id/de/fr | `wss://openspeech.bytedance.com/api/v4/ast/v2/translate`，Header 携带 `X-Api-App-Key`、`X-Api-Access-Key`、`X-Api-Resource-Id: volc.service_type.10053`；帧为 **protobuf** 二进制（StartSession=100、TaskRequest=200、FinishSession=102），proto 文件随官方 Demo 下载；24 kHz PCM 输出为 float32 | S2S 可选引擎 |
| Google Gemini 3.5 Live Translate（2026-06 公测） | 70+ 语种语音到语音，边说边译，只接受音频输入 | Live API WebSocket `…BidiGenerateContent?key=`，模型 `gemini-3.5-live-translate-preview`；setup 指定 `targetLanguageCode`、`echoTargetLanguage`、输入/输出转写；输入 16 kHz PCM16，输出 24 kHz PCM16 | S2S 可选引擎 |
| Azure Live Interpreter（2025-09 公测） | 76 种输入语言，自动识别，声音保持 | Azure Speech SDK | 不采用：需要 Azure 订阅，SDK 体积大，且仍在预览 |
| DeepL Voice API（2026-02 GA） | 原文转写 + 至多 5 种译文；语音输出处于 beta 或需付费订阅 | REST + WebSocket | 不采用：语音输出可用性不明确，价格较高 |
| Soniox / Speechmatics | 实时识别 + 译文文本（无译音） | WebSocket | 不采用：功能等同于级联链路的"识别 + 翻译"部分，平台已有 |

### 实测记录（2026-10-04）

| 对象 | 结果 |
|---|---|
| 百炼 `qwen3.8-livetranslate-flash-realtime` | ✅ 端到端可用。说话过程中约 0.4 s 起出现原文与译文增量，首段译音在开始说话约 3 s 后到达；一句话说完（`speech_stopped`）后约 0.8 s 原文和译文定稿。热词 `大模型→LLM` 生效。**必须显式指定 voice（如 `Tina`）**，否则默认音色 `Chelsie` 报 "Voice not supported"。session 字段为 `output_modalities`；服务端事件有 `conversation.item.input_audio_transcription.text/completed`（原文）、`response.audio_transcript.text/done`（译文）、`response.audio.delta`（24 kHz 音频）、`input_audio_buffer.speech_started/stopped` |
| 百炼 `qwen3.5-livetranslate-flash-realtime` | ✅ 可用（偶发 TLS 连接被重置，需要重试）。session 字段为 `modalities` + `input_audio_format/output_audio_format`，事件同上 |
| 中转站 api.vveai.com（用户提供） | `/audio/transcriptions` 的 `whisper-1`、`whisper-large-v3-turbo`、`SenseVoiceSmall` ✅ 可用（6 s 中文音频约 3.5 s 返回；whisper-1 中文无标点）；`/audio/speech` 的 `tts-1` 返回 429（上游饱和），`gpt-4o-mini-tts` 返回 403；`/v1/realtime*` 返回 404/403，**不提供 OpenAI 实时同传** |
| edge-tts（本机网络） | ✅ 可用 |

### 功能对标（Google 翻译 → 本平台）

| Google 翻译功能 | 本平台现状 | 本 change 后 |
|---|---|---|
| 文本翻译（Gemini 上下文） | ✅ Agent 图 + 术语 + TM + 评审 | ✅ |
| 文档翻译 | ✅ Markdown/TXT 篇章翻译 | ✅（不做版式保留） |
| 快/高级模型切换 | ✅ fast/standard/auto | ✅ |
| 听写（语音输入） | ❌ | ✅ 工作台语音输入 |
| 朗读 | ❌ | ✅ 原文/译文朗读 |
| Alternatives / Understand / Ask | ❌（只有会话修订） | ✅「解读」标签页 |
| 收藏 / 常用语 | ✅ 历史收藏 | ✅ |
| 拍照 / 图片翻译 | ❌ | ✅ 上传/拍照/粘贴，覆盖渲染，对比查看 |
| 即时取景 AR | ❌ | ❌ 非目标 |
| Transcribe / 持续收听 | ❌ | ✅ 同传收听 |
| 对话模式 | ❌ | ✅ 双向对话（自动/按键、面对面翻转） |
| Live Translate 耳机播报 | ❌ | ✅ 语音播报 + 耳机模式 |
| 多人多语 | Google 无 | ✅ 多语会议室（差异化） |
| 术语、翻译记忆、过程可观测 | Google 无 | ✅ 级联链路与图片翻译沿用 |
| 手写、离线、网站翻译、Practice | ❌ | ❌ 非目标 |

### 约束

- 浏览器只访问 Spring；Python 不对外暴露，内部接口用 `X-Internal-Token`。
- Spring 是 biz 唯一写入方，Flyway 是 DDL 唯一来源。
- 现有中转站无语音模型，所以"无密钥可演示"的路径必须完全基于本地或免费引擎。
- 单人开发、一学期：引擎适配要可插拔，但每类先只接主流的一两家。

## Goals / Non-Goals

**Goals:**
- 三种同传模式均可在本机无新密钥的情况下演示（级联引擎）；百炼同传作为主力 S2S 引擎完成真实联调。豆包、Gemini、OpenAI 三个 S2S 引擎作为可选项，按协议实现，配置密钥即可启用。
- 级联链路端到端延迟（说话结束 → 首段译音）p50 控制在 3.5 s 以内，并通过 E4 量化各段耗时。
- 图片翻译默认走现有视觉模型，可直接演示；覆盖渲染效果接近 Google 拍照翻译的"原位替换"。
- 工作台补齐听写、朗读与解读三个 Google 常用功能。
- 新能力全部有记录、有历史、有实验数据。

**Non-Goals:** 见 proposal「非目标」。另外，本设计不追求 S2S 级的亚秒延迟；级联链路以"能用上术语和上下文"作为卖点。

## Decisions

### D1 音频通道：浏览器 ⇄ Spring WS ⇄ Python WS，Spring 负责鉴权、扇出与持久化

```
浏览器 (AudioWorklet 16kHz PCM16)
   │  wss /ws/interpret?ticket=…   上行二进制音频 + JSON 控制；下行 JSON 事件(含 base64 音频)
   ▼
Spring  InterpretWebSocketHandler ── RoomRegistry(内存) ── SegmentWriter(批量落库)
   │  每个"发言流"一条  ws://ai/internal/interpret/stream  (X-Internal-Token)
   ▼
Python  InterpretEndpoint → Engine(cascade | qwen-livetranslate | doubao-ast | gemini-live-translate | openai-realtime)
                              └─ cascade: VAD → ASR → 翻译(TranslationContext) → TTS
```

- **决策**：沿用"浏览器只访问 Spring"。Spring 用 `spring-boot-starter-websocket` 的原生 `WebSocketHandler`（音频是二进制帧，所以不用 STOMP）。到 Python 的连接使用 JDK 自带的 `java.net.http.WebSocket`。
- **备选方案**：
  - 浏览器用 WebRTC 直连 OpenAI，服务端只签发临时 client secret（OpenAI 官方推荐）；
  - 浏览器直连 Python WS。
- **理由**：
  - 直连只适用于 OpenAI 一家，级联与千问引擎仍需服务端；还会绕过 Spring 的配额、审计和持久化。
  - 本地两跳的转发开销在毫秒级，远小于 ASR/MT 的秒级耗时。
  - 房间扇出天然属于业务层。

### D2 WS 鉴权：一次性票据

- **决策**：
  - 先调 `POST /api/interpret/sessions`（创建）或 `POST /api/interpret/rooms/{code}/join`（加入），返回 `wsTicket`。票据为 32 字节随机串，存 Redis，键 `ws:ticket:{t}`，TTL 60 s，使用一次后作废。
  - 浏览器再用 `wss://…/ws/interpret?ticket=` 建立连接，握手拦截器校验票据，并把 userId/sessionId/participantId 放入 WS 属性。
  - `/ws/**` 在 Spring Security 中放行（由票据鉴权），握手校验 Origin 为 `WEB_ORIGIN`。
- **备选方案**：
  - JWT 放在 query；
  - `Sec-WebSocket-Protocol` 携带 JWT。
- **理由**：浏览器 WebSocket 不能设置 Authorization 头。JWT 放进 URL 会进入访问日志且有效期长；一次性短票据是主流做法。

### D3 发言流（stream）模型与三种模式的映射

- **发言流定义**：一路麦克风音频，对应一个 Python 引擎实例，具有 `sourceLangs` 与 `targetLangs`。

| 模式 | 发言流 | 路由 |
|---|---|---|
| LISTEN 同传收听 | 1 条，source=auto（或用户提示的语种集合） | target=用户选择的语言 |
| CONVERSE 双向对话 | 1 条，languages=[A, B] | 自动：按识别出的语种发往另一侧（仅级联支持）；按键：`{type:"ptt",side:"A"}` 固定本句方向 |
| ROOM 会议室 | 每个参与者 1 条 | targets = 房间内其他参与者语言的集合（去重、去掉本人语言），成员进出时下发 `{type:"targets"}` 更新 |

- **决策**：S2S 引擎每个目标语言一个上游会话。官方协议是"一个会话一个输出语言"，OpenAI 也明确建议双向时每方向一个会话。因此：
  - S2S 引擎的会议室最多 4 种语言（每条发言流最多 3 个目标）；
  - 级联引擎最多 6 种语言（一次识别，按目标并行翻译和合成）。
- **CONVERSE + S2S** 只支持按键模式：两个上游会话常驻，按下哪一侧就把音频送往哪个会话。界面上对 S2S 引擎禁用"自动"。
- **备选方案**：把单设备音频同时送入两个方向的会话，丢弃"源=目标"的那路输出。
- **理由**：同时送入会使费用翻倍；而且同语种输入在厂商模型上的行为未定义（可能复读）。按键是 Google 对话模式本来就有的交互。

### D4 级联引擎管线

```
PCM16 16k ─▶ SileroVAD(min_silence 500ms, max_speech 10s) ─┬─ 进行中：每 700ms 对已累积音频跑本地 ASR → transcript.partial
                                                           └─ 句末：最终 ASR → transcript.final{text, lang}
transcript.final ─▶ 路由(目标语言集合) ─▶ 每个目标并行：
        翻译：复用快速路径提示词 + TranslationContext{terms(术语匹配), session_ctx(本流最近 3 句原文/译文), domain_hint, style=口语}
              流式 → translation.delta / translation.final
        合成：translation.final → TTS 适配器 → audio{format, data, last}
```

- 每句分配单调递增的 `utteranceId`。句与句之间流水线并行（第 n+1 句识别时，第 n 句可在翻译或合成），但 `audio` 事件按 utteranceId 顺序发出，播放端也按顺序排队。
- 语种：SenseVoice 自带 LID；远程转写返回的 language 优先，没有时用现有 lingua 检测器对文本判定。
- LISTEN 模式下，源语种等于目标语种的句子只出原文字幕，不翻译不播报（如中文用户收听中英混合会场）。
- **为何复用快速路径而不走完整 Agent 图**：同传对延迟敏感，plan/review 环节会增加 2–5 s。保留术语注入和短期上下文这两项最有价值的能力，评审在同传中关闭。E4 会对比"带/不带术语与上下文"的译文质量。
- LLM 调用设置 `max_tokens` 上限 300，并对推理模型传入最低推理强度（参数取自模型配置的 extra params，不支持则忽略）。

### D5 ASR/TTS 引擎层：每类只接两到三家主流实现

| 类型 | 引擎 ID | 实现 | 需配置 | 语种 |
|---|---|---|---|---|
| ASR | `local-sensevoice` | sherpa-onnx `OfflineRecognizer.from_sense_voice` + `VoiceActivityDetector`(silero) | 否（需下载模型） | zh en ja ko yue |
| ASR | `openai-transcribe` | OpenAI 兼容 `POST /audio/transcriptions`（WAV），按句调用 | 模型配置 capability=ASR（已实测 vveai 中转站的 whisper-large-v3-turbo 可用） | 取决于模型（whisper 系约 50+） |
| TTS | `edge-tts` | edge-tts 流式 MP3，按语言映射默认音色 | 否 | 平台支持的 15 语种全部覆盖 |
| TTS | `openai-speech` | OpenAI 兼容 `POST /audio/speech`（`response_format=pcm`，24 kHz） | 模型配置 capability=TTS | 取决于模型 |
| TTS | `browser` | 服务端不出音频，前端 `speechSynthesis` 朗读 `translation.final` | 否 | 取决于浏览器 |

- **决策**：级联只接 OpenAI 兼容的 HTTP 转写与合成，不接百炼的 realtime ASR/TTS WebSocket。
- **备选方案**：接入 `qwen3-asr-flash-realtime` 与 `qwen3-tts-flash-realtime`。
- **理由**：
  - 百炼已有一体化的 livetranslate S2S 引擎；再把它的 ASR/TTS 拆开接入，收益小而协议工作量大。
  - OpenAI 兼容的转写与合成接口被大量服务商采用（OpenAI、Groq、SiliconFlow 等），一个适配器覆盖面最广。
- **TTS 失败兜底**：服务端发 `error{code:"C0172", fatal:false}`，并在该句 `translation.final` 上标记 `ttsFallback=true`，前端改用浏览器朗读。edge-tts 的 403 不会让同传中断。
- **默认音色表**放在 `app/speech/voices.py`：zh→`zh-CN-XiaoxiaoNeural`、en→`en-US-AvaMultilingualNeural`、ja→`ja-JP-NanamiNeural`、ko→`ko-KR-SunHiNeural`、fr→`fr-FR-DeniseNeural`、de→`de-DE-KatjaNeural`、es→`es-ES-ElviraNeural`、ru→`ru-RU-SvetlanaNeural` 等。用户可在设置中切换男声或女声。
- **本地模型**：`uv run python -m app.speech.download` 下载到 `SPEECH_MODEL_DIR`（默认 `.cache/speech/`）。支持 `SPEECH_MODEL_MIRROR`，用 HF 镜像应对 GitHub 下载慢的问题。模型缺失时 `local-sensevoice` 在引擎列表中显示为不可用，并附带原因。

### D6 S2S 引擎：百炼为主力，豆包 / Gemini / OpenAI 为可选

| 引擎 ID | 厂商与模型 | provider | 优先级 | 验证方式 |
|---|---|---|---|---|
| `qwen-livetranslate` | 百炼 `qwen3.8-livetranslate-flash-realtime`（兼容 3.5） | `DASHSCOPE` | **必做** | 真实联调（已有密钥）+ 模拟服务器回放 |
| `doubao-ast` | 火山 豆包·同声传译 2.0 | `VOLCENGINE` | 可选 | protobuf 编解码单测 + 模拟服务器；需要 APP ID / Access Token 才能联调 |
| `gemini-live-translate` | Google `gemini-3.5-live-translate-preview` | `GOOGLE` | 可选 | 模拟服务器；需要 Gemini API Key 才能联调 |
| `openai-realtime` | OpenAI `gpt-realtime-translate` | `OPENAI_COMPATIBLE` | 可选 | 模拟服务器；需要官方 Key（当前中转站不支持） |

- **决策**：选定这四家。国内两家（百炼、豆包）有中文场景优势且网络直连；国外两家（Gemini、OpenAI）语种覆盖最广，是"对标 Google"的直接参照。可选引擎放在独立的任务组，排期紧张时可整组裁剪，不影响必做部分。
- **备选方案**：Azure Live Interpreter、DeepL Voice、Soniox/Speechmatics。
- **理由**：Azure 需要 Azure 订阅与较重的 Speech SDK；DeepL 语音输出的可用性不明确；Soniox/Speechmatics 只输出文本，与级联链路重复（见 Context 调研表）。

各引擎的适配要点：

- `QwenLiveTranslateEngine`（按实测记录实现）：
  - 地址 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=`，Bearer 鉴权。
  - session.update：3.8 用 `output_modalities`，3.5 用 `modalities` + `input_audio_format/output_audio_format`。按模型名分支，并且 **始终显式传 voice**：默认 `Tina`，可在模型配置的额外参数中修改。
  - `translation.language` 为目标语言；命中的术语写入 `translation.corpus.phrases`；`input_audio_transcription.model=qwen3-asr-flash-realtime` 用于获取原文。
  - 事件映射：
    - `conversation.item.input_audio_transcription.text` → `transcript.partial`
    - `conversation.item.input_audio_transcription.completed` → `transcript.final`
    - `response.audio_transcript.text` → `translation.delta`
    - `response.audio_transcript.done` → `translation.final`（作为句子边界）
    - `response.audio.delta` → `audio`（pcm16，24 kHz）
    - `input_audio_buffer.speech_stopped` 作为 e2e 计时起点
  - 建连失败（TLS 重置等）时，最多重试 2 次，指数退避。
- `DoubaoAstEngine`：
  - Header 携带 `X-Api-App-Key`（来自模型配置额外参数 `appId`）、`X-Api-Access-Key`（密钥字段）、`X-Api-Resource-Id: volc.service_type.10053`。
  - 帧编解码使用官方 proto 生成的 Python 类，放在 `app/interpret/vendor/doubao_pb/`，并附上 HOWTO 来源说明。
  - StartSession 设置 `mode=s2s`、源/目标语言与音频格式；输出要求 16 kHz PCM，避开 24 kHz float32。
  - 语种约束：一侧必须是 zh 或 en，引擎列表中如实标注。
- `GeminiLiveTranslateEngine`：
  - 地址 `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=`。
  - setup 设置 `targetLanguageCode`、`echoTargetLanguage=false`、输入/输出转写。
  - 上行 16 kHz PCM16 无需重采样，下行 24 kHz PCM16。
- `OpenAIRealtimeTranslateEngine`：
  - 从 base_url 推导地址：`https`→`wss`，路径为 `/realtime/translations?model=`。
  - 上行由 16 kHz 线性插值重采样到 24 kHz。
  - 服务端没有显式的句子边界，因此 `input_transcript` 静默 1.2 s 或遇到句末标点时生成一个 utterance。
- 所有适配器都映射到平台统一事件（D7）。厂商没有原文流时，`transcript.final` 取厂商提供的最终原文。
- **测试**：每个适配器各配一个协议级模拟 WS 服务器（pytest 内启动的 `websockets.serve`），按官方或实测的事件序列回放，验证事件映射、重采样、分句与错误处理。百炼另做真实联调，并把抓取的事件序列保存为回放夹具。

### D7 统一事件协议（Python → Spring → 浏览器）

浏览器 → Spring：
- 二进制帧：PCM16LE / 16 kHz / 单声道，建议每帧 40 ms（1280 字节），单帧不超过 32 KB。
- 文本帧（JSON）：
  - `{"type":"ptt","side":"A"|"B"|null}`
  - `{"type":"flush"}`：强制断句
  - `{"type":"mute","muted":bool}`
  - `{"type":"end"}`
  - `{"type":"ping"}`

Spring → 浏览器（Python 发出、Spring 补充 speaker 并路由）：

| type | 字段 | 说明 |
|---|---|---|
| `ready` | sessionId, participantId, mode, engine, languages, roomCode? | 连接就绪 |
| `participants` | list[{participantId, displayName, lang, speaking}] | 会议室成员变化（全量） |
| `transcript.partial` | utteranceId, speaker, text | 识别中间结果（级联本地 ASR 才有） |
| `transcript.final` | utteranceId, speaker, text, lang | 原文定稿 |
| `translation.delta` | utteranceId, lang, delta | 译文增量 |
| `translation.final` | utteranceId, lang, text, ttsFallback? | 译文定稿 |
| `audio` | utteranceId, lang, format(`pcm16`\|`mp3`), sampleRate, seq, last, data(base64) | 只发给语言为 lang 的接收者 |
| `metrics` | utteranceId, asrMs, mtFirstMs, mtMs, ttsFirstMs, e2eMs | e2e = 说话结束 → 首段音频（无 TTS 时为译文定稿） |
| `error` | code, message, fatal | fatal=true 后连接关闭 |
| `ended` | reason, stats{durationMs, utterances, avgE2eMs} | 会话结束 |

- **路由规则**：`transcript.*` 与 `translation.*` 广播给房间所有人，前端按自己的语言选择显示哪一份；`audio` 只发给目标语言匹配且开启了播报的接收者。
- **Spring ↔ Python 内部协议**：与上表相同。区别是首帧 JSON 为 `config`：`{engine, mode, sourceLangs, targetLangs, glossaryIds, modelConfigId, asrEngine, ttsEngine, voices, domainHint, userId}`；不含 speaker、participants 等房间概念。
- 下行音频用 JSON + base64，不用二进制帧。代价是 33% 体积开销（24 kHz PCM 约 64 KB/s），换来协议单一、易于调试；在局域网或本机部署下可以接受。

### D8 回声与半双工

- 采集时开启 `getUserMedia({echoCancellation:true, noiseSuppression:true, autoGainControl:true})`。
- 单设备模式（LISTEN、CONVERSE）默认**半双工**：播报期间前端暂停上行音频帧，播报结束 300 ms 后恢复。
- 「耳机模式」开关关闭半双工门控，适合戴耳机或同传收听讲座。
- 会议室各自使用自己的设备，默认全双工；建议佩戴耳机，界面会提示。
- **理由**：Google Play 上有用户评论指出对话模式会"翻译自己的播报"形成循环；半双工是最简单可靠的规避办法。

### D9 会议室

- 房间码为 6 位大写字母和数字（去掉易混淆字符）。房间生命周期跟随创建者的同传会话。
- 房间状态（成员、语言、连接）保存在 Spring 内存的 `RoomRegistry`；落库只记会话和逐句转写。
- 上限：8 人；不同语言数上限为级联 6 种、S2S 4 种，超出时加入接口返回 `A0451`。
- 主持人离开或结束时，房间关闭，其他人收到 `ended{reason:"host_left"}`。普通成员断线 30 s 内重连（重新取票据）可恢复身份。
- 落库：每句的原文与各语种译文合并为一条 `interpret_segment`。所有目标的 `translation.final` 到齐，或 5 s 超时，即写入；由 SegmentWriter 批量写，每 1 s 或累计 20 条刷新一次。

### D10 图片翻译：两步法为默认，qwen-mt-image 为一体化可选引擎

```
上传 → Spring 存原图(STORAGE_DIR/images/yyyy/MM/{uuid}.{ext}) → SSE 转发 Python /internal/image/translate
Python: 预处理(Pillow：EXIF 旋转、长边缩到 2048、记录缩放比)
  → node ocr:   视觉模型一次调用，返回 blocks[{text, bbox(px), lines?}]；JSON 模式
  → node terms: 对全部 OCR 文本做术语匹配
  → node translate: 一次调用批量翻译全部 block（编号 JSON），提示词带整图 OCR 文本作上下文 + 术语硬约束
  → node render: 计算归一化 bbox(0–1)、推断文字方向；返回 blocks[{id, text, translation, bbox, lang}]
Spring：done 时落库 image_translation，返回记录 id
前端：Canvas 覆盖渲染
```

- **决策**：OCR 与翻译分两次调用。
- **备选方案**：
  - 视觉模型一次完成 OCR 与翻译；
  - 本地 PaddleOCR + 文本翻译。
- **理由**：
  - 分开后，翻译环节可以复用术语库（术语匹配需要先拿到文本）和 TranslationContext，翻译模型也可以是不支持视觉的文本模型。
  - 一次调用省一轮请求，但术语只能盲注入。E5 会量化两者在质量、术语和耗时上的差异。
  - PaddleOCR 依赖重（paddle 运行时约 500 MB），而且在 Windows 上部署麻烦；中转站的视觉模型已实测可用。
- **bbox 约定**：提示词告知图像宽高并要求像素坐标 `[x0,y0,x1,y1]`。Python 校验并裁剪越界坐标后，按缩放比还原为原图坐标，再归一化到 0–1。模型返回非法 JSON 时重试一次，仍失败返回 `C0171`。
- **`qwen-mt-image` 引擎**：
  - 需要 capability=IMAGE_TRANSLATE、provider=DASHSCOPE 的配置。
  - 由于接口要求公网 `image_url`，用 data URL 传图。若服务不接受 data URL，引擎在可用性检查中标记为"需公网图床"并禁用，不在本 change 引入对象存储。
  - 返回的译图下载后由 Spring 保存，记录 `result_image_path`；此时 blocks 为空，前端只做原图与译图对比。
- **覆盖渲染**（前端 `lib/image-render.ts`）：
  1. 对每个 bbox 取外扩 4 px 边框像素的中位数作为背景色，用该色填充带 2 px 圆角的矩形；
  2. 文字色取与背景对比度更高的黑或白，若框内存在明显前景色则使用前景色；
  3. 字号二分查找，在 bbox 内自动换行并居中；竖排或旋转文字在本 change 中按水平排版处理。
  4. 导出 PNG 时用原图分辨率重绘。
- **限制**：JPG/PNG/WEBP/BMP，不超过 10 MB，宽高 32–8192 px；超出返回 `A0450`。

### D11 解读（Alternatives / Understand / Ask）

- `POST /api/translations/insights`：输入 `{source, translation, sourceLang, targetLang, recordId?}`，用默认对话模型一次 JSON 调用，返回：
  - `alternatives[2..3]{text, register, note}`
  - `expressions[≤5]{source, target, meaning, note}`
  - `summary`
- `POST /api/translations/insights/ask`：输入 `{source, translation, sourceLang, targetLang, question, history[≤6]}`，以 SSE 返回 `delta`、`done`、`error`，答案用中文。
- 解读是只读辅助：采用备选译法只替换工作台译文区显示，不改写历史记录；复制与存入翻译记忆使用新译文（`POST /api/tm/from-record/{id}` 可选请求体 `{targetText}`），收藏仍标记原记录。问答不落库。
- **备选方案**：把追问并入 ④ 的会话修订。
- **理由**：修订会产生新版本；而 Google 的 Ask 是答疑，不改动译文。两者语义不同，分开更清晰。

### D12 模型配置扩展与默认模型按能力唯一

- 新增列：
  - `capability varchar(24) NOT NULL DEFAULT 'CHAT'`，取值 `CHAT|ASR|TTS|REALTIME_TRANSLATE|IMAGE_TRANSLATE`；
  - `supports_vision boolean NOT NULL DEFAULT false`；
- 改动：
  - provider 的 CHECK 约束增加 `DASHSCOPE`、`VOLCENGINE`、`GOOGLE`；
  - 唯一索引 `uk_model_config_default` 重建为 `(capability) WHERE is_default AND NOT deleted`；
  - 评审模型约束不变，且只允许 CHAT 能力。
- 合法组合：

| capability | 允许的 provider |
|---|---|
| CHAT | OPENAI_COMPATIBLE、ANTHROPIC |
| ASR、TTS | OPENAI_COMPATIBLE |
| REALTIME_TRANSLATE | DASHSCOPE、VOLCENGINE、GOOGLE、OPENAI_COMPATIBLE（OpenAI） |
| IMAGE_TRANSLATE | DASHSCOPE |

  其他组合返回 `A0410`。
- Python 侧 `model_config` 查询"默认模型"时 MUST 加上 `capability='CHAT'`，避免误取语音配置。
- 连通性测试按能力分别实现：

| capability | 测试方法 |
|---|---|
| CHAT | 原有方式 |
| ASR | 转写内置的 1.5 s 中文 WAV 样本 |
| TTS | 合成 "你好" 并返回字节数 |
| REALTIME_TRANSLATE | 建立 WS、发送 session.update、等到 session.created 或 updated 即成功 |
| IMAGE_TRANSLATE | 翻译内置的 64×32 文字图 |

- `GET /api/model-configs/options?capability=CHAT&vision=true`：图片翻译页据此列出视觉模型。
- `GET /api/speech/engines`：Spring 合并两部分后返回 `{asr:[…], tts:[…], interpret:[…], image:[…]}`，每项含 `id, name, available, reason?, languages[]`。两部分来源：DB 中启用的配置，以及 Python 报告的内置引擎可用性（本地模型是否存在、edge-tts 是否可达，探测结果缓存 10 分钟）。

### D13 数据模型（V6__speech_image.sql）

```sql
biz.interpret_session(id bigserial pk, user_id, mode varchar(16) CHECK IN('LISTEN','CONVERSE','ROOM'),
  engine varchar(32), languages jsonb, room_code varchar(8) null, options jsonb,
  status varchar(16) CHECK IN('ACTIVE','ENDED'), title varchar(200) null,
  started_at, ended_at null, duration_ms int null, stats jsonb null, favorite bool, deleted bool, created_at)
biz.interpret_segment(id bigserial pk, session_id fk, seq int, speaker_participant varchar(32), speaker_name varchar(64),
  speaker_user_id bigint null, source_lang varchar(8), source_text text, translations jsonb,  -- {"en":"..."}
  metrics jsonb, started_ms int, ended_ms int, created_at)  UNIQUE(session_id, seq)
biz.image_translation(id bigserial pk, user_id, engine varchar(32), model_config_id null,
  image_path varchar(255), result_image_path null, mime varchar(32), width int, height int, size_bytes int,
  source_lang varchar(8), detected_lang varchar(8) null, target_lang varchar(8),
  blocks jsonb, glossary_ids jsonb, term_hits jsonb, trace jsonb, tokens int, duration_ms int,
  favorite bool, deleted bool, created_at)
```

- 会议室参与者只存在于内存和 segment 的 speaker 字段中。非主持人成员不产生 interpret_session，"我参与的会议"不在本 change 范围内，只有主持人能在历史中看到会议转写。
- 同传时间较长时转写可能很多：segment 单表、按 session_id 索引；历史详情分页加载（每页 100 条）。

### D14 新增错误码

| 码 | HTTP | 含义 |
|---|---|---|
| A0450 | 400 | 图片为空、过大或格式不支持 |
| A0451 | 409 | 会议室已满或语言数超限 |
| A0452 | 404 | 房间不存在或已关闭（与 A0404 区分以便前端提示） |
| A0453 | 401 | WS 票据无效或已使用 |
| A0454 | 400 | 音频为空、过长（听写上限 60 s）或格式不支持 |
| C0170 | 400 | 所选模型不支持图片输入 |
| C0171 | 502 | OCR 结果解析失败 |
| C0172 | 502 | 语音合成失败（同传中为非致命） |
| C0173 | 503 | 语音引擎不可用（本地模型缺失或上游不可达） |
| C0174 | 502 | 实时同传上游连接失败或中断 |

### D15 Web 音频实现

- **采集**：`public/worklets/pcm-capture.js` 是一个 AudioWorkletProcessor，把 AudioContext 采样率（通常 48 kHz）抽取到 16 kHz，转成 Int16 后每 40 ms 投递一帧，同时计算 RMS 电平供动效使用。
- **播放**：`lib/audio/player.ts`。PCM16 用一个 AudioWorklet 环形缓冲连续播放；MP3 片段按句用 `decodeAudioData` 解码后排队。播放状态会驱动半双工门控（D8）。
- **听写**：复用采集 worklet，在前端拼成 WAV 后上传，不引入 MediaRecorder/webm 解码。
- `hooks/use-interpret-socket.ts` 负责票据获取、断线重连（指数退避，最多 3 次）与事件分发，把状态写入 Zustand store `interpret-store`。
- mock 模式（`NEXT_PUBLIC_MOCK_API=1`）用脚本化的事件序列模拟同传和图片翻译，方便截图验收。

## UI/UX

### 信息架构

- **侧边栏**：在「翻译工作台」之后新增「同声传译」（Mic 图标）和「图片翻译」（ScanText 图标），USER 与 ADMIN 均可见。
- **`/interpret` 同声传译**，由两个阶段组成：
  1. **准备**（卡片向导）
     - 第一步选模式：三张模式卡片（收听 / 对话 / 会议室），每张配插画图标与一句说明，悬停时上浮。会议室卡片额外提供「输入房间码加入」入口。
     - 第二步做语言与引擎设置：
       - 语言选择器：收听选目标语言，对话选 A/B 两种语言，会议室选"我的语言"；
       - 引擎选择列表：每项显示厂商标识、语种数和徽章（「本地免密钥」「已配置」「需配置」「已实测」），不可用时置灰并在悬停时说明原因；
       - 可折叠的「高级」分区：术语库、领域提示、音色、语音播报开关、耳机模式。
  2. **进行中**，按模式切换布局：
     - **收听**：上方是舞台区，大字号显示最新译文，上面一行小字是原文；下方是可折叠的历史字幕列表；底部控制条包含麦克风电平光球、状态胶囊（聆听 / 识别 / 翻译 / 播报）、延迟指示、播报开关和结束按钮。
     - **对话**：上下两半面对面布局。上半区可一键旋转 180°，方便坐在对面的人阅读。每半区有语言标签、气泡列表和大号按键说话按钮；中间是「自动」开关（S2S 引擎下禁用并给出提示）。
     - **会议室**：顶部成员条，显示头像、语言徽章和说话时的脉冲环，以及房间码与复制链接；中间是统一消息流，每条显示我的语言的译文，可展开原文和发言人；底部是我的麦克风按钮和播报开关。
  3. **结束**：弹出摘要对话框（时长、句数、平均延迟），提供"查看记录"按钮跳到历史的同传标签。
- **`/image` 图片翻译**
  - **空状态**：大号拖拽区，拖入时边框流光、图标上浮；提供「上传」「拍照」「粘贴」三个按钮和 3 张示例图片。语言选择器与引擎选择器放在顶部工具条。
  - **处理中**：原图居中，一条扫描线自上而下循环；OCR 事件到达后，文本框依次淡入描边，随后译文逐块淡入覆盖；右侧显示步骤胶囊（识别 → 术语 → 翻译 → 渲染）。
  - **结果**：采用主从布局。
    - 左侧是画布查看器，带「译图 / 原图 / 对比」分段控件；对比模式下用可拖拽的分隔滑块左右揭示，另有缩放按钮。
    - 右侧面板有三个标签页：
      - 「文本」：逐块的原文与译文列表。点击某块时画布上对应框高亮脉冲；可行内编辑译文，修改后实时重绘。
      - 「术语」：命中与遵循情况。
      - 「详情」：引擎、模型、耗时、token。
    - 工具条：下载译图、复制全部译文、换目标语言重译、收藏。
  - **拍照弹窗**：调用 `getUserMedia` 的取景框，按快门时有白闪动效；支持切换前后摄像头。移动端直接使用 `<input capture="environment">`。
- **工作台增强**
  - 原文区工具条增加麦克风按钮：按下进入录音态，按钮变为红色脉冲并显示实时电平；松开或再次点击后进入"识别中"态，结果写入原文框并自动设置源语言。
  - 原文区与译文区各增加一个朗读按钮：播放时图标显示声波动画，可以停止。
  - Agent 面板新增第五个标签页「解读」，分三个可折叠分区：
    - 「备选译法」：卡片列表，标注语体徽章，卡片上有「采用」按钮；
    - 「关键表达」：原文片段 → 译文片段，附含义说明；
    - 「问一问」：聊天气泡加输入框，预置快捷问题，如"为什么这样译""更口语一点怎么说"。
- **历史页**：顶部分段标签「文本 / 图片 / 同传」，切换时列表交叉淡入。
  - 图片记录卡片显示缩略图与语言对；详情侧滑面板复用结果页的查看器（只读）和文本列表。
  - 同传记录卡片显示模式、语言和时长；详情面板显示按时间排列的双语转写，可按语言切换和搜索。
- **管理后台模型配置**：表单增加「能力类型」分段控件，切换时表单字段与 provider 选项联动变化；列表按能力分组，并显示「支持图片」徽章。

### 关键交互流程

1. **同传收听**：选择收听 → 目标语言选中文、引擎选级联 → 开始。浏览器请求麦克风权限，拒绝时显示引导卡片。随后进入舞台：说话时光球随电平缩放，原文小字实时出现，句末后译文大字淡入并播报，延迟胶囊显示例如 "2.4 s"。
2. **双向对话（自动）**：A 说中文，气泡出现在 A 侧，英文译文出现在 B 侧（旋转半区）并播报。播报期间麦克风图标显示"播报中，暂停收音"。
3. **会议室**：主持人创建房间并得到房间码；另外两人在各自浏览器输入房间码，选择语言（如日语、英语）加入，成员条依次弹入。任何人发言，其他人都看到自己语言的字幕并听到语音。
4. **图片翻译**：拖入菜单照片 → 扫描线 → 文本框淡入 → 译文覆盖 → 切到「对比」拖动滑块 → 在「文本」页修改一道菜名 → 画布即时重绘 → 下载 PNG。
5. **解读**：翻译完成后点击「解读」→ 骨架屏 → 展示备选译法 → 采用其中一条 → 在「问一问」中提问，回答逐字流出。

### 动效清单（motion 库；时长 150–300 ms，缓动统一用设计令牌；`prefers-reduced-motion` 下降级为淡入或静态）

| 位置 | 动效 | reduced-motion |
|---|---|---|
| 模式卡片 | 进场依次错开出现、悬停上浮与阴影加深 | 仅淡入 |
| 准备 → 进行中 | 共享布局过渡（选中卡片扩展为舞台） | 交叉淡入 |
| 麦克风光球 | 随 RMS 电平缩放（rAF + spring），说话时外环扩散 | 静态电平条 |
| 字幕 | 原文 partial 文字更新做细微透明度过渡，译文定稿时上移淡入 | 无位移 |
| 气泡 / 消息流 | `AnimatePresence` + layout 列表进场 | 仅淡入 |
| 会议室成员 | 加入时弹入，说话时脉冲环 | 静态高亮边框 |
| 半区旋转 | 180° 旋转过渡 | 直接切换 |
| 图片扫描线 | 自上而下的线性循环 | 显示"识别中"进度条 |
| OCR 框与译文 | 依次错开描边淡入，译文交叉淡入 | 直接显示 |
| 对比滑块 | 拖拽跟手，松开时惯性回弹 | 无惯性 |
| 拍照快门 | 白闪 120 ms | 无 |
| 朗读按钮 | 声波条动画 | 静态图标变色 |
| 历史分类标签 | 指示条位移，列表交叉淡入 | 仅淡入 |

## Risks / Trade-offs

- [edge-tts 被微软限流（403）或改协议] → 版本锁定在 7.2.x；失败时非致命降级到浏览器朗读（D5）；引擎列表探测并显示"不可达"；可选配置 OpenAI 兼容 TTS。
- [SenseVoice 仅 5 语种，会议室要求更多语言] → 引擎列表显示每个引擎的语种。选了本地引擎却加入不支持语言的成员时，前端提示改用远程转写或 S2S 引擎；当前中转站无语音模型这一点，在报告中如实说明。
- [中转站模型是推理模型，翻译首 token 慢] → 同传请求关闭评审、限制 max_tokens、设最低推理强度；E4 报告各段耗时，如实给出 p50/p90；如需更快，可在会话设置中为同传单独选择更快的对话模型。
- [可选 S2S 引擎（豆包、Gemini、OpenAI）无法用真实密钥验证] → 协议级模拟服务器测试加官方文档事件对照；报告中注明"待配置密钥联调"。百炼引擎已真实联调，是 E4 的 S2S 对照组。
- [豆包的 proto 文件需从控制台文档下载] → 无法取得时，该引擎保持"未实现"状态并在引擎列表中隐藏，不影响其他部分。
- [百炼 3.8 的默认音色不可用] → 适配器始终显式传 voice（默认 Tina），连通性测试时校验 session.updated 后是否有 error。
- [长时间同传的 WS 中断] → 前端指数退避重连（新票据），已完成的转写不受影响；Spring 检测到 Python 连接断开时，向浏览器发送 `error{C0174, fatal:false}` 并尝试重建一次。
- [音频转发占用 Spring 线程] → WebSocket 处理器只做转发和 JSON 路由，不做阻塞操作；落库由 SegmentWriter 单线程批量异步完成。每用户最多 1 个活跃同传会话，全局并发上限为 20 条发言流（可配置），超出返回 `A0212`。
- [视觉模型 bbox 偏移导致覆盖错位] → 覆盖矩形外扩 4 px；对比模式和「原图」切换让用户自行核对；E5 统计 IoU。
- [图片中有隐私信息] → 原图只存本地 STORAGE_DIR，按用户隔离访问；删除记录时同步删除文件（异步，失败只记日志）。
- [浏览器兼容性] → AudioWorklet 和 getUserMedia 需要安全上下文（https 或 localhost）。本地开发满足；部署说明中注明需要 https。

## Migration Plan

1. 执行 `V6__speech_image.sql`：新建三张表；model_config 增加列并重建索引，已有行 capability 默认为 CHAT，默认与评审语义不变。
2. Python 的默认模型查询加上 capability 过滤（与迁移同版本发布）。
3. 首次部署后运行 `uv run python -m app.speech.download` 下载本地模型；未下载时本地 ASR 显示不可用，其他功能不受影响。
4. 新增 `.env` 项：`STORAGE_DIR`、`SPEECH_MODEL_DIR`、`SPEECH_MODEL_MIRROR`、`INTERPRET_MAX_STREAMS`。
5. **回滚**：新功能都是独立路由和表，回滚代码后旧表不受影响；V6 不删除任何现有列。

## Open Questions

- 已解决：百炼密钥已提供并完成联调；OpenAI 中转站不支持 realtime，OpenAI 引擎降为可选。
- 豆包与 Gemini 的密钥能否取得？取不到时只做协议实现与模拟测试。E4 的 S2S 对照组以百炼为准。
- `qwen-mt-image` 是否接受 data URL？实施时用现有百炼密钥实测；不接受则按 D10 标记为不可用。
