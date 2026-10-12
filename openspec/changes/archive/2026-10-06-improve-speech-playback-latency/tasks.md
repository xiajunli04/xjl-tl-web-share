## 0. 前置与基线（infra / docs）

- [x] 0.1 确认 `add-platform-mascot` 已提交，工作区干净后再开始。验证：`git status` 中无 `web/src/components/interpret/*` 的未提交改动
- [x] 0.2 测量延迟基线：
  - 用 `evaluation` 下的 `uv run python -m eval.multimodal.e4_interpret run --groups cascade_full` 跑 3 遍；
  - 用 `uv run python -m eval.multimodal.chat_smoke` 跑 3 遍；
  - 记录 e2eMs、ttsFirstMs 的中位数，以及 AI 回复从用户句末到首个 `audio` 的时间。

  验证：结果写入 `docs/test/speech-latency/baseline.md`
- [x] 0.3 给 `chat_smoke.py` 增加统计项：AI 回复“首个 audio 时间”和“首个可播放 MP3 段时间”（即首个 `segLast` 或 `last`），用于前后对比。验证：脚本输出包含这两项

## 1. python-backend：TTS 与朗读接口流式化

- [x] 1.1 `app/speech/tts.py`：
  - `TtsEngine.stream` 增加 `rate` 参数：Edge 映射为 `rate="+N%"`（取整到 5%），OpenAI 兼容映射为 `speed`；
  - `resolve_voice` 支持 gender；
  - `OpenAISpeechTTS` 改为实例内共享 `httpx.AsyncClient`，并提供 `aclose()`。

  验证：`uv run pytest tests -k tts` 通过，新增 rate 映射与客户端复用的单测
- [x] 1.2 `app/speech/tts.py` 新增 `open_stream()`（实现时命名）：
  - 先等到首包，首包前失败抛 `C0172`；
  - 之后边产出边 tee，结束后写入 `TtsCache`；
  - 缓存键改为 `(scope, voice, rate, text)`；
  - 新增进程级 Edge 并发信号量（`edge_tts_max_concurrency=4`）。

  验证：单测覆盖命中、未命中、首包前失败、中途失败不写缓存
- [x] 1.3 `app/api/internal/speech.py`：`/internal/speech/tts` 改为返回 `StreamingResponse`（带 `X-Tts-Engine`、`X-Tts-Cache` 头）；校验 rate 范围 0.5–2.0（越界返回 `A0410`）。验证：用 httpx 流式客户端测试，首个 chunk 先于全部完成到达；越界返回 400
- [x] 1.4 `app/speech/asr.py`：`openai-transcribe` 改为共享客户端。验证：现有 ASR 单测通过

## 2. python-backend：音频分段协议与级联流水线

- [x] 2.1 `app/interpret/engine.py` 的 `AudioSequencer`：
  - 支持 `seg` / `segLast`；
  - 分包立即下发，去掉扣包逻辑；
  - track 结束时发空 data 的 `last=true` 终止包；
  - 新增 `open_segment` / `end_segment` 接口。

  验证：单测断言首包不等第二包即下发、段号递增、终止包存在、多语种队列顺序不变
- [x] 2.2 新增 `app/interpret/segmenter.py`：增量切句器 `SentenceSegmenter`，包含：
  - 句末标点与逗号、顿号分句；
  - 首段最小长度可配置；
  - 后续段至少 12 字，拉丁语按词 ×3 折算。

  `chat.py` 的 `split_sentences` 迁移过来并保留兼容导出。验证：中、英、日混合用例的单测
- [x] 2.3 新增 `SpeechPipeline`（放在 `segmenter.py` 同目录的 `pipeline.py`）：
  - 接收段文本，最多 2 路并发合成；
  - 按段号顺序推入 sequencer；
  - 首包不合并，后续按 8 KB 合并；
  - 可取消（打断时）。

  验证：用假 TTS（可控延迟）测试并发上限、乱序完成仍按序下发、取消后不再下发
- [x] 2.4 `app/interpret/cascade.py`：
  - `_translate` 的 delta 喂给 segmenter，切出的段送入 pipeline；
  - `translation.final` 在译文完成时立即发出，不等 TTS；
  - metrics 口径保持不变。

  验证：现有 cascade 单测通过；新增“长译文首段音频早于翻译完成”和“final 早于 TTS 首包”的用例
- [x] 2.5 `latencyMode` 档位：
  - `app/core/config.py` 新增两档参数；
  - `interpret.py` 解析 config 中的 `latencyMode` 并作用于 VAD 静音、首段最小长度和 partial 间隔；
  - 非法值返回配置错误。

  验证：单测断言 fast 档 VAD 参数为 300 ms
- [x] 2.6 识别让路（design D4.1，根据基线追加）：级联引擎跟踪最近约 200 ms 输入的 RMS，低于静音阈值时不再发起新的 partial。验证：单测断言尾部静音期间不触发 partial、说话中仍按间隔触发；3.3 回归中 asrMs 中位数下降

## 3. python-backend：AI 对话（级联）逐句成段

- [x] 3.1 `app/interpret/chat.py`：`_generate` 的切句结果送入 `SpeechPipeline`，每句一个段；打断时取消 pipeline。验证：单测断言 3 句回复中 seg=0 的音频在第 3 句生成前下发；打断后无后续 `audio`
- [x] 3.2 `chat.py` 的母语字幕改为逐句并行翻译：
  - `translation.delta` 下发累计字幕；
  - 全部完成后发 `translation.final`（按句序拼接）；
  - 单句失败用原文占位并发非致命 error；
  - 打断时一并取消。

  验证：单测覆盖“字幕慢不阻塞音频”和“单句字幕失败”
- [x] 3.3 用真实链路回归：
  - 运行 `chat_smoke.py` 3 遍，对比 0.2 的基线；
  - 运行 `e4_interpret run --groups cascade_full` 3 遍。

  验证：结果写入 `docs/test/speech-latency/after-cascade.md`，同传 playMs 中位数下降 ≥ 15%、AI 对话首个可播放音频中位数 ≤ 3.5 s（未达标时记录原因与后续措施）

## 4. python-backend：实时语音对话引擎

- [x] 4.1 查阅百炼 Omni Realtime 当前文档（context7 或官网），确认模型名、音色、输入/输出音频格式和事件名，结论记入 design 的 Open Questions。验证：design.md 中该条已更新为结论
- [x] 4.2 `app/speech/engines.py`：
  - 新增 `REALTIME_CHAT` 能力常量和 `realtime-chat` 引擎解析；
  - 引擎列表新增 `chat` 类别（包含 provider、tested）。

  验证：单测覆盖“有配置可用”“无配置不可用并给出原因”
- [x] 4.3 新增 `app/interpret/realtime_chat.py`：
  - `RealtimeChatEngine` 加上 `DashScopeOmniAdapter`（复用 `qwen_livetranslate.py` 的连接与鉴权工具）；
  - 实现 design D7 的事件映射、开场白和 12 轮上下文；
  - 母语字幕复用 3.2 的逐句翻译。

  验证：用 mock 上游 WS 的单测，覆盖一轮对话的事件顺序
- [x] 4.4 `realtime_chat.py` 的打断与重连：
  - 客户端 `interrupt` 或耳机插话时，发 `response.cancel` 和 `conversation.item.truncate`，并下发 `reply.interrupted`；
  - 上游断开时下发 `C0174`，用最近的对话文本重建一次会话。

  验证：mock 单测覆盖打断和断线重连
- [x] 4.5 `OpenAIRealtimeAdapter`（输入重采样到 24 kHz，标记为实验）。验证：mock 单测通过；`tested=false`
- [x] 4.6 `app/api/internal/interpret.py`：CHAT 允许 `cascade | realtime-chat`，其他模式拒绝 `realtime-chat`。在 `chat_smoke.py` 中增加 `--engine realtime-chat`，用百炼密钥真实联调 3 遍。验证：结果写入 `docs/test/speech-latency/after-realtime.md`，e2e 中位数 ≤ 1.2 s（或记录实测值与原因）

## 5. springboot-backend

- [x] 5.1 `AiServiceClient` 新增 `postStream`（返回 `InputStream` 和响应头）；`SpeechController` 的朗读接口改为 `StreamingResponseBody`，透传 Content-Type、`X-Tts-*` 头，逐块 flush；首包前的错误仍走统一的 Result 错误；设置 `spring.mvc.async.request-timeout`。验证：集成测试（用 MockWebServer 分块返回）断言响应是分块的且错误码正确；`./mvnw test` 通过
- [x] 5.2 `SpeechDtos` 的 TTS 请求新增 `gender`、`rate`（0.5–2.0 校验，越界返回 `A0410`）；引擎列表 DTO 新增 `chat` 数组和 `provider`、`tested` 字段。验证：控制器单测
- [x] 5.3 能力类型 `REALTIME_CHAT`：
  - Flyway `V8__realtime_chat_capability.sql` 修改 CHECK 约束和列注释；
  - `ModelConfig` 常量、`ModelConfigDtos.CAPABILITY_REGEX` 与 Schema 说明、`ModelConfigService` 的组合校验（DASHSCOPE、OPENAI_COMPATIBLE）。

  验证：迁移在本地 docker PostgreSQL 上执行成功；单测覆盖合法组合与 VOLCENGINE 非法组合
- [x] 5.4 `InterpretService`：
  - CHAT 允许 `cascade | realtime-chat`，提示文案改为“AI 对话仅支持平台级联或实时语音模型”；
  - 非 CHAT 模式拒绝 `realtime-chat`；
  - `options.latencyMode` 校验并透传给 Python config；
  - `realtime-chat` 不可用时返回 `C0173`。

  验证：`InterpretService` 单测覆盖 spec 中新增的 4 个场景

## 6. web：流式播放基础

- [x] 6.1 新增 `web/src/lib/audio/streaming.ts`，实现 `StreamingSpeech`：
  - MediaSource / ManagedMediaSource 能力检测；
  - 单个 `<audio>` 元素复用，并通过 `createMediaElementSource` 接入 `AudioPlayer` 的输出总线和 Analyser；
  - MP3 渐进 append、剥离 ID3、`endOfStream`；
  - 降级为分段整解码；
  - 开关 `NEXT_PUBLIC_AUDIO_MSE`。

  验证：vitest 单测（ID3 剥离、能力检测分支，用 mock 的 MediaSource）
- [x] 6.2 `web/src/lib/audio/queue.ts`：
  - MP3 项改走 `StreamingSpeech`，支持 `seg` / `segLast`、空 data 终止包，以及旧格式兼容；
  - 新增 `pause` / `resume`，供重播互斥使用。

  验证：扩展 `queue` 单测，覆盖首段到达即开始播放、空终止包结束 track、旧格式仍然可播
- [x] 6.3 `web/src/lib/http.ts` 新增 `postStream`；`lib/api/speech.ts` 新增 `ttsStream({text, lang, gender, rate})`，返回流和格式；新增 `useSpeak()` hook，统一负责全局单例播放、加载/播放/空闲状态、失败时降级到 `browserSpeak` 和 toast。验证：单测覆盖状态流转与降级
- [x] 6.4 新增朗读偏好 store（音色、语速、自动朗读，localStorage 持久化）。验证：单测断言刷新后保留

## 7. web：翻译工作台朗读体验

> 实施说明：项目约定 UI 组件以截图与走查验证（vitest 只覆盖逻辑层，且本变更不新增 npm 依赖），因此 7.1–7.3 的“组件测试”改为：可测逻辑抽成纯函数单测（`shouldAutoRead`、朗读控制器状态流转），交互与动效以 7.4 截图验收。

- [x] 7.1 `speak-button.tsx` 重写为分体按钮：
  - 主体为播放/停止，三态动效（交叉淡入、加载环、随电平的声波条）；
  - 右侧弹层可选音色与语速；
  - 尊重 reduced-motion。

  验证：组件测试覆盖三态与弹层选项
- [x] 7.2 `target-panel.tsx`：有目标语言时朗读按钮常驻，翻译中禁用并带 tooltip；`session-thread.tsx`：朗读按钮从悬停组中移出并固定可见；原文区与输入框改用新按钮。验证：组件测试断言翻译中按钮存在且为 disabled
- [x] 7.3 「翻译设置」弹层新增“完成后自动朗读”开关；单次翻译完成和会话最新一轮完成时触发自动朗读。验证：组件测试模拟 run 完成后调用了 `useSpeak`
- [x] 7.4 UI/UX 验收：启动应用，截图单次模式（翻译中、播放中）、会话模式（触屏宽度下的历史轮次）和朗读设置弹层，确认布局没有整页平铺、声波动效生效；开启 reduced-motion 后再截一次。验证：截图存入 `docs/test/speech-latency-ui/`

## 8. web：同传与 AI 对话

- [x] 8.1 `hooks/use-interpret-socket.ts`：`audio` 事件按新协议处理（seg、segLast、空终止包）；对 `realtime-chat` 会话正确处理 pcm16 回复与打断。验证：hook 单测用模拟事件序列断言播放调用顺序
- [x] 8.2 `lib/interpret/setup.ts` 与 store：CHAT 支持 engine 选择和 `latencyMode`，请求组装改为不再强制 cascade；从 `/api/speech/engines` 的 `chat` 读取可用性。验证：setup 单测
- [x] 8.3 `settings-step.tsx`：
  - AI 对话新增“对话引擎”双卡片（徽章、置灰原因、实验徽章、layoutId 选中指示）；
  - `advanced-section.tsx` 新增“响应速度”分段控件和说明；
  - 选择实时语音模型时，回复模型、术语库和响应速度置灰并给出提示。

  验证：组件测试覆盖不可用置灰和联动置灰
- [x] 8.4 `chat-view.tsx`、`converse-view.tsx`、`listen-stage.tsx`：
  - 气泡和历史字幕行加“重播”按钮（悬停或长按显示），复用 `useSpeak`，与实时播报队列互斥（`queue.pause/resume`）；
  - 播报中的气泡显示声波条；
  - 母语字幕逐句淡入。

  验证：组件测试覆盖重播互斥
- [x] 8.5 实时引擎连接失败的横幅（可关闭，提供“切换到平台级联重新开始”）。验证：组件测试
- [x] 8.6 管理后台模型配置表单：能力下拉新增 REALTIME_CHAT，提供方选项按组合联动。验证：组件测试和手动新增一条百炼配置
- [x] 8.7 UI/UX 验收：截图 AI 对话向导的引擎卡片（可用和置灰两种状态）、高级设置的响应速度、进行中的重播和声波，以及实时引擎对话界面；确认动效在 reduced-motion 下降级。验证：截图存入 `docs/test/speech-latency-ui/`

## 9. 回归与文档

- [x] 9.1 全量检查：
  - `web`：`npm run lint && npm run typecheck && npm run test && npm run build`；
  - `python-backend`：`uv run pytest`；
  - `springboot-backend`：`./mvnw test`。

  验证：全部通过
- [x] 9.2 （实施说明：本机自动化只有 Chromium；Chromium 主路径与降级路径已实测，Firefox / Safari 未实测，见 compat.md）浏览器兼容抽查：分别在 Chrome、Edge、Firefox 上验证工作台朗读和级联同传的 MP3 渐进播放；用 `NEXT_PUBLIC_AUDIO_MSE=false` 验证分段降级。验证：结果记入 `docs/test/speech-latency/compat.md`
- [x] 9.3 汇总前后对比表：基线、级联优化后、实时引擎三组的 e2eMs、ttsFirstMs，以及 AI 回复首声时间，写入 `docs/test/speech-latency/summary.md`，可作为论文补充材料
- [x] 9.4 更新 `docs/总体设计.md`：
  - 路线图新增本变更一行；
  - 2.2 节补充实时语音对话；
  - 风险清单中“实时语音链路延迟”一项改为本次的措施（流式播放、分段、流水线、可选档位与实时模型）。

  验证：文档 diff 审阅
