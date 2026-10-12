## Why

平台目前只处理"文字进、文字出"：短文本、长文档和会话。对照 Google 翻译，它最常用的几类能力我们都没有：同声传译（Live Translate，含耳机收听与双向对话）、拍照/图片翻译、语音输入、译文朗读，以及 2026 年新增的「备选译法 / 理解 / 追问」。

2026 年国内外主流厂商已经把这些能力做成了可直接调用的 API：
- **阿里百炼** `qwen3.8-livetranslate-flash-realtime`：60 语种，支持热词与说话人分离。已用真实密钥联调：句末约 0.8 s 定稿，热词生效。
- **字节豆包** 同声传译 2.0（Seed LiveInterpret 2.0）：端到端全双工，延迟 2–3 s。
- **Google** `gemini-3.5-live-translate-preview`：70+ 语种，2026-06 公测。
- **OpenAI** `gpt-realtime-translate`：70+ 输入语种、13 种输出语种（含中文），$0.034/分钟。
- **阿里百炼** `qwen-mt-image-2.0`：保留版式的图片翻译，可同步调用。
- 中转站上现有的 GPT 模型已实测可以看图，OCR 文字和像素坐标准确。

本 change 把这些能力接进平台。同时提供一条无需新密钥的"本地识别 + 平台翻译 Agent + 语音合成"级联链路，保证随时可以演示；这条链路还能沿用术语库和上下文，这正是平台相对 Google 的差异点。

## What Changes

- **同声传译（新页面 `/interpret`）**，提供三种模式：
  - **同传收听**：多语种语音持续翻译成一种目标语言并语音播报，对应 Google 的 Live Translate / Transcribe。
  - **双向对话**：单设备上两种语言面对面互译，支持按语种自动切换方向，或两侧各自按键说话。
  - **多语会议室**：3–8 人各用自己的设备和语言加入同一房间（房间码），每人看到自己语言的字幕、听到自己语言的语音。Google 翻译没有这种多人场景。
- **同传引擎**，按可用性选择：
  - 百炼 `qwen3.8-livetranslate-flash-realtime`（主力 S2S 引擎，真实联调）；
  - 可选 S2S 引擎：豆包同声传译 2.0、Gemini 3.5 Live Translate、OpenAI `gpt-realtime-translate`，按协议实现，配置密钥即可启用；
  - 平台级联（Silero VAD → 本地 SenseVoice 或 OpenAI 兼容转写（已实测中转站 whisper 可用）→ 平台翻译（带术语与上下文）→ edge-tts 或 OpenAI 兼容 TTS，浏览器朗读兜底）。
- **实时音频通道**：浏览器 ⇄ Spring WebSocket（一次性票据鉴权、房间扇出、记录持久化）⇄ Python WebSocket（音频管线与引擎适配）。全程显示实时字幕、译文和语音，并给出逐句延迟指标；结束后会话转写写入历史。
- **图片翻译（新页面 `/image`）**：
  - 输入方式：上传、拖拽、粘贴或调用摄像头拍照。
  - 默认流程：视觉模型 OCR（文字 + 坐标）→ 术语匹配 → 平台翻译 → 前端在原图上覆盖渲染译文。
  - 查看方式：译图、原图、左右拖拽对比三种；可逐块编辑译文、下载译图、复制文本。
  - 可选引擎：百炼 `qwen-mt-image-2.0`，直接返回译图。
- **语音能力服务**：工作台的语音输入（听写）和原文/译文朗读，由统一的 ASR/TTS 引擎层提供。
- **译文解读**：工作台新增「解读」标签页，对应 Google 的 Alternatives / Understand / Ask。内容包括：
  - 2–3 个备选译法及适用场景，可一键采用；
  - 关键表达的含义与用法说明；
  - 针对当前译文流式追问。
- **模型配置扩展**：
  - 配置增加能力类型：对话 / 语音识别 / 语音合成 / 实时同传 / 图片翻译。
  - 增加提供方 `DASHSCOPE`、`VOLCENGINE`、`GOOGLE`，增加"支持图片输入"标记。
  - 默认模型改为按能力类型各自唯一。**BREAKING**：迁移时原有配置全部归为"对话"能力，行为不变。
- **历史记录**：按「文本 / 图片 / 同传」分标签查看，图片和同传记录有各自的详情面板。
- **导航**：侧边栏新增「同声传译」「图片翻译」。
- **评测**：新增两组实验。
  - E4 同传：识别准确率、语音翻译 chrF、分段延迟 p50/p90；级联与百炼 S2S 同场对比。
  - E5 图片翻译：OCR 准确率、文本块召回、chrF，以及单次视觉翻译与"OCR→平台翻译"两步法的对比。
  - 两组实验写入实验报告第 11 节。

## Capabilities

### New Capabilities
- `live-interpretation`：同传会话（收听、双向对话、多语会议室）、三类引擎、实时音频通道协议、字幕/译文/语音事件、半双工回声规避、逐句延迟指标、会话转写持久化与历史查看、同传页面交互。
- `speech-services`：ASR/TTS 引擎层，包括本地 SenseVoice + Silero VAD、OpenAI 兼容转写与合成、edge-tts、浏览器兜底；引擎可用性查询；听写接口与朗读接口；本地模型下载。
- `image-translation`：图片上传与拍照、OCR→术语→翻译的两步流程与过程事件、`qwen-mt-image` 可选引擎、前端覆盖渲染与对比查看、逐块编辑、记录持久化与历史。
- `translation-insights`：备选译法、关键表达解读、针对译文的流式追问。
- `multimodal-evaluation`：E4 同传评测与 E5 图片翻译评测的数据集、脚本、指标与报告。

### Modified Capabilities
- `model-config`：配置增加能力类型、`DASHSCOPE` 提供方和图片输入标记；默认模型改为按能力唯一；连通性测试覆盖新能力；可用选项可按能力筛选。
- `text-translation-agent`：翻译工作台增加语音输入、原文/译文朗读和「解读」标签页。
- `translation-history`：历史按文本/图片/同传分类检索，增加图片与同传记录的详情。
- `ui-design-system`：应用外壳导航增加「同声传译」「图片翻译」。

## 非目标

- 不做 Google Lens 式的连续取景实时 AR 翻译；拍照翻译只针对单帧图像。
- 不做网站翻译、浏览器插件、手写输入、离线包、口语练习（Practice）。
- 不做 PDF/Word 等文档的版式保留翻译（沿用 ③ 的 Markdown/TXT 范围）。
- 不做声音复刻；也不承诺保留说话人音色。S2S 引擎自带的音色保持能力按厂商默认，级联链路使用标准音色。
- 不做电话或 SIP 接入，不做系统声音（会议软件音频）采集，只采集麦克风。
- 不做同传会话的离线视频字幕导出；会议室不支持访客匿名加入，参与者须登录。
- 不做多实例 Spring 的房间状态共享；房间状态保存在单实例内存中。
- 不对可选 S2S 引擎（豆包、Gemini、OpenAI）做真实联调承诺：暂无对应密钥，用户提供的 OpenAI 中转站也不支持 realtime。这三个引擎按官方协议实现、用协议级模拟服务测试，配置密钥后即可启用；排期紧张时可整组裁剪。百炼引擎必须真实联调。
- 不接入 Azure Live Interpreter、DeepL Voice、Soniox、Speechmatics（理由见设计调研表）。
- 不持久化「解读」里的追问问答。

## 与路线图的关系

本变更是路线图第 ⑦ 步。①–⑥ 均已完成，⑦ 在其基础上实施：
- 依赖 ① 的模型配置与 LLM 适配层（扩展能力类型），以及 ② 的语种识别、术语匹配与快速翻译路径（级联同传和图片翻译复用）。
- 依赖 ④ 的会话上下文思路：同传级联链路用最近几句作为短期上下文。
- 依赖 ⑤ 的评测框架：E4/E5 沿用 chrF 指标、runner 与报告结构。
- 总体设计第 7 节「范围分层」原先把"OCR / 图片 / 语音"列为不做，本变更将其移入范围，并同步更新总体设计。

## Impact

- **springboot-backend**：
  - 新增依赖 `spring-boot-starter-websocket`。
  - 新模块：`module/interpret`（会话、房间、WebSocket 处理器与票据、Python WS 客户端、转写持久化）、`module/image`（上传、存储、SSE 转发、记录）、`module/speech`（听写与朗读代理）、`module/insight`（解读代理）。
  - 改动：`model` 模块增加能力类型、按能力默认、选项筛选；`translate` 历史增加分类。
  - 新迁移 `V6__speech_image.sql`：`interpret_session`、`interpret_segment`、`image_translation`，以及 `model_config` 的新增列与索引重建。
  - 新增错误码；本地文件存储目录 `app.storage.dir`。
- **python-backend**：
  - 新增依赖 `sherpa-onnx`、`edge-tts`、`websockets`、`pillow`；可选豆包引擎增加 `protobuf`。
  - 新包 `app/speech/`（VAD、ASR、TTS 适配器，模型下载）、`app/interpret/`（引擎接口、级联引擎、百炼/豆包/Gemini/OpenAI S2S 适配器、WS 端点）、`app/image/`（OCR、翻译与 qwen-mt-image 适配）、`app/insights/`。
  - 内部接口新增：`/internal/interpret/stream`（WS）、`/internal/speech/{transcribe,tts,engines}`、`/internal/image/translate`（SSE）、`/internal/insights[/ask]`。
- **web**：
  - 新页面 `/interpret`、`/image`。
  - 音频采集 AudioWorklet（16 kHz PCM16）与播放队列（PCM/MP3）。
  - 工作台加语音输入、朗读、「解读」标签页；历史分类标签；模型配置表单支持能力类型；新增 mock 数据。
- **evaluation**：`data/speech/`、`data/image/`、`eval/multimodal/`，结果图表写入 `docs/实验报告.md` 第 11 节。
- **docs**：总体设计（范围分层、架构图、路线图 ⑦、竞品对标表）、`docs/contracts/` 新增实时音频通道协议说明、`.env.example` 新增 `SPEECH_*`、`STORAGE_DIR`。
- **运行环境**：首次使用本地识别需下载 SenseVoice int8（约 230 MB）和 silero_vad.onnx，放在已忽略的 `python-backend/.cache/speech/`。edge-tts 依赖访问微软在线服务，存在被限流（403）的风险，失败时自动退回浏览器朗读。
