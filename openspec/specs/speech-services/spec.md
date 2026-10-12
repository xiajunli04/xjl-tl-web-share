# speech-services Specification

## Purpose
TBD - created by archiving change add-speech-and-image-translation. Update Purpose after archive.
## Requirements
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
系统 SHALL 提供 `GET /api/speech/engines`，返回 asr、tts、interpret、image、chat 五类引擎。每项包含 id、name、available、reason（不可用原因）和支持的语言列表；chat 类的配置型引擎还包含 provider 和 tested（是否经过真实联调）。

- 内置引擎的可用性由 Python 探测：本地模型文件是否存在、edge-tts 是否可达（探测结果缓存 10 分钟）。
- 配置型引擎来自已启用的对应能力的模型配置。
- chat 类固定包含：
  - `cascade`：可用性取决于 ASR 与对话模型；
  - `realtime-chat`：可用性取决于是否存在已启用的 `REALTIME_CHAT` 配置。

#### Scenario: 本地模型未下载
- **WHEN** SenseVoice 模型文件不存在
- **THEN** local-sensevoice 的 available=false，reason 为"本地识别模型未下载"，其他引擎不受影响

#### Scenario: 配置了实时同传
- **WHEN** 管理员启用了一个 provider=DASHSCOPE、capability=REALTIME_TRANSLATE 的配置
- **THEN** interpret 列表中 qwen-livetranslate 的 available=true

#### Scenario: 未配置实时语音对话
- **WHEN** 系统中没有启用的 REALTIME_CHAT 配置
- **THEN** chat 列表中 cascade 的 available=true；realtime-chat 的 available=false，reason 为"未配置实时语音对话模型"

#### Scenario: 配置了百炼实时语音对话
- **WHEN** 管理员启用了一个 provider=DASHSCOPE、capability=REALTIME_CHAT 的配置
- **THEN** chat 列表中 realtime-chat 的 available=true、provider=DASHSCOPE、tested=true

### Requirement: 听写接口
系统 SHALL 提供 `POST /api/speech/transcribe`（multipart：WAV 文件，16 kHz 单声道 PCM16；可选 lang 提示与引擎），返回 `{text, lang, durationMs, engine}`。音频为空、超过 60 秒或格式错误时 MUST 返回 `A0454`；引擎不可用时 MUST 返回 `C0173`。

#### Scenario: 中文听写
- **WHEN** 用户上传一段 3 秒的中文 WAV
- **THEN** 返回识别文本和 lang=zh

#### Scenario: 音频过长
- **WHEN** 上传 75 秒的音频
- **THEN** 系统返回 HTTP 400、code `A0454`

### Requirement: 朗读接口
系统 SHALL 提供 `POST /api/speech/tts`，请求体为 `{text, lang, voice?, engine?, gender?, rate?}`：
- `gender` 取 `female | male`；
- `rate` 取 0.5–2.0，缺省 1.0。

响应要求：
- 返回音频字节（`audio/mpeg` 或 `audio/L16;rate=24000`），并带响应头 `X-Tts-Engine` 与 `X-Tts-Cache`（`hit | miss`）。
- 未命中缓存时，系统 MUST 采用分块传输：合成出首包后立即开始返回，Python 与 Spring MUST NOT 把整段音频缓冲后再返回。
- 相同的（引擎、音色、语速、文本）组合 SHALL 命中内存缓存，命中时一次性返回。

限制与错误：
- text 上限 2000 字符；rate 超出范围时返回 `A0410`。
- 首包之前合成失败 MUST 返回 `C0172`，前端随即改用浏览器朗读；首包之后中断时，连接提前结束，前端停止播放并提示。

#### Scenario: 朗读译文
- **WHEN** 用户请求朗读一段英文译文
- **THEN** 返回 audio/mpeg 分块响应，前端在收到首个分块后即开始播放

#### Scenario: 边合成边返回
- **WHEN** 用户朗读一段约 300 字的中文，且该文本未命中缓存
- **THEN** 客户端收到首个音频分块的时间早于合成完成的时间，响应头 X-Tts-Cache=miss

#### Scenario: 再次朗读命中缓存
- **WHEN** 用户以相同的音色和语速再次朗读同一段文本
- **THEN** 响应头 X-Tts-Cache=hit，音频一次性返回

#### Scenario: 调整语速
- **WHEN** 用户以 rate=1.2、gender=male 朗读一段英文
- **THEN** 系统使用男声、以 1.2 倍语速合成并返回音频

#### Scenario: 语速越界
- **WHEN** 请求中 rate=3
- **THEN** 系统返回 HTTP 400、code `A0410`

#### Scenario: 合成失败降级
- **WHEN** edge-tts 不可达
- **THEN** 接口返回 HTTP 502、code `C0172`，前端用浏览器 speechSynthesis 朗读

### Requirement: 本地模型下载
系统 SHALL 提供命令 `uv run python -m app.speech.download`，把 SenseVoice int8 模型和 silero_vad.onnx 下载到 `SPEECH_MODEL_DIR`（默认 `.cache/speech/`，不入库），并支持通过 `SPEECH_MODEL_MIRROR` 指定镜像。已存在且校验通过的文件 MUST 跳过。

#### Scenario: 重复执行
- **WHEN** 模型已下载完整后再次执行下载命令
- **THEN** 命令提示已存在并直接退出，不重复下载

