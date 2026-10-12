## ADDED Requirements

### Requirement: 语音引擎层
Python AI 服务 SHALL 提供统一的 ASR 与 TTS 适配接口，至少包含以下引擎：
- ASR：`local-sensevoice`（sherpa-onnx SenseVoice + Silero VAD，本地运行，支持 zh/en/ja/ko/yue 并返回语种）和 `openai-transcribe`（OpenAI 兼容 `/audio/transcriptions`，使用 capability=ASR 的模型配置）；
- TTS：`edge-tts`（按语种映射默认音色，输出 MP3）、`openai-speech`（OpenAI 兼容 `/audio/speech`，使用 capability=TTS 的模型配置，输出 24 kHz PCM16）和 `browser`（服务端不合成）。

ASR 返回文本与语种；远程引擎未返回语种时，系统 MUST 用平台语种检测器对文本判定。

#### Scenario: 本地识别返回语种
- **WHEN** 用 local-sensevoice 识别一段日语音频
- **THEN** 返回日语文本和 lang=ja

#### Scenario: 远程转写补判语种
- **WHEN** openai-transcribe 返回文本但不含 language 字段
- **THEN** 系统用语种检测器对文本判定后返回 lang

### Requirement: 引擎可用性
系统 SHALL 提供 `GET /api/speech/engines`，返回 asr、tts、interpret、image 四类引擎。每项包含 id、name、available、reason（不可用原因）和支持的语言列表。内置引擎的可用性由 Python 探测：本地模型文件是否存在、edge-tts 是否可达（探测结果缓存 10 分钟）。配置型引擎来自已启用的对应能力的模型配置。

#### Scenario: 本地模型未下载
- **WHEN** SenseVoice 模型文件不存在
- **THEN** local-sensevoice 的 available=false，reason 为"本地识别模型未下载"，其他引擎不受影响

#### Scenario: 配置了实时同传
- **WHEN** 管理员启用了一个 provider=DASHSCOPE、capability=REALTIME_TRANSLATE 的配置
- **THEN** interpret 列表中 qwen-livetranslate 的 available=true

### Requirement: 听写接口
系统 SHALL 提供 `POST /api/speech/transcribe`（multipart：WAV 文件，16 kHz 单声道 PCM16；可选 lang 提示与引擎），返回 `{text, lang, durationMs, engine}`。音频为空、超过 60 秒或格式错误时 MUST 返回 `A0454`；引擎不可用时 MUST 返回 `C0173`。

#### Scenario: 中文听写
- **WHEN** 用户上传一段 3 秒的中文 WAV
- **THEN** 返回识别文本和 lang=zh

#### Scenario: 音频过长
- **WHEN** 上传 75 秒的音频
- **THEN** 系统返回 HTTP 400、code `A0454`

### Requirement: 朗读接口
系统 SHALL 提供 `POST /api/speech/tts`，请求体为 `{text, lang, voice?, engine?}`，返回音频字节（`audio/mpeg` 或 `audio/L16;rate=24000`）。text 上限 2000 字符。相同的（引擎、音色、文本）组合 SHALL 命中内存缓存。合成失败 MUST 返回 `C0172`，前端随即改用浏览器朗读。

#### Scenario: 朗读译文
- **WHEN** 用户请求朗读一段英文译文
- **THEN** 返回 audio/mpeg 字节，前端播放

#### Scenario: 合成失败降级
- **WHEN** edge-tts 不可达
- **THEN** 接口返回 HTTP 502、code `C0172`，前端用浏览器 speechSynthesis 朗读

### Requirement: 本地模型下载
系统 SHALL 提供命令 `uv run python -m app.speech.download`，把 SenseVoice int8 模型和 silero_vad.onnx 下载到 `SPEECH_MODEL_DIR`（默认 `.cache/speech/`，不入库），并支持通过 `SPEECH_MODEL_MIRROR` 指定镜像。已存在且校验通过的文件 MUST 跳过。

#### Scenario: 重复执行
- **WHEN** 模型已下载完整后再次执行下载命令
- **THEN** 命令提示已存在并直接退出，不重复下载
