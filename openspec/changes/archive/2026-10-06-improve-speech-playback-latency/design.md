## Context

⑦ 搭建了语音引擎层（Edge / OpenAI 兼容 TTS、SenseVoice / 远程 ASR）、同传实时音频通道和级联链路；⑧ 在此基础上加了 AI 对话（CHAT）与打断。功能已验收，但实测时“卡、慢”。调研后确认，延迟主要来自链路里的串行等待和整段缓冲，与模型本身关系不大（按影响排序）：

| # | 位置 | 现状 | 影响 |
|---|---|---|---|
| 1 | `web/src/lib/audio/queue.ts` `advance()` | MP3 分包要等到 `last=true` 才 `playEncoded(concat)` | 默认 Edge TTS 下，每句都要等合成完才出声 |
| 2 | `app/interpret/chat.py` `_start_reply` / `_run_reply` | 一条 AI 回复只有一个 uid、一条 track，回复结束时才 `sequencer.end` | 和第 1 条叠加后，要等整条回复所有句子都合成完才开口 |
| 3 | `app/interpret/cascade.py` `_translate_one` / `_speak` | 译文全文生成完才开始合成；`translation.final` 还要等 TTS 首包 | 首声 = 翻译总耗时 + TTS 首包 |
| 4 | `app/interpret/engine.py` `AudioSequencer._pump` | `len(chunks) > (0 if ended else 1)`，总扣住最后一包；分包合并到 8 KB 才发 | 首包晚一个分包才发出 |
| 5 | `chat.py` `_speak_sentences` | 句子逐个串行合成，没有预取 | 句与句之间有空档 |
| 6 | `tts.py` / `asr.py` | Edge 每句新建 WS；OpenAI 兼容 TTS/ASR 每次新建 `httpx.AsyncClient` | 每句多一次 TLS 握手 |
| 7 | `chat.py` `_subtitle` | 母语字幕要等整条回复生成完再整体翻译 | 字幕滞后，浏览器兜底朗读也滞后 |
| 8 | 朗读接口 | Python `synthesize` 收齐所有分包 → Spring `readAllBytes` → 前端 `res.blob()` | 工作台点了朗读要等整段合成 |
| 9 | VAD | 静音 500 ms 才断句 | 固定开销，属于合理默认，做成可选档位 |

工作台方面：`SpeakButton` 已存在，但单次模式只在 `run.status !== "running"` 时渲染；会话模式非最新一轮的操作栏是 `opacity-0 group-hover:opacity-100`，触屏上基本不可见。所以用户感知为“没有播放”。

约束：
- 单人开发；不新增 Python 或 npm 依赖；
- Edge TTS 保持免密钥默认；
- 浏览器只访问 Spring；
- 同传协议的前后端两侧同步升级。

## Goals / Non-Goals

**Goals:**
- 工作台译文朗读按钮常驻可见；点击后边合成边播放，首声目标：Edge、200 字以内 ≤ 1 s（本机网络）。
- 级联同传（Edge）客户端口径 playMs 的 p50 比基线下降 ≥ 15%。
  - 基线见 `docs/test/speech-latency/baseline.md`：短句的串行等待只占约 0.2 s，主要耗时是模型首字约 1.5 s、识别约 0.85 s、Edge 首包约 0.9 s。
  - 原定的 35% 在不换模型的前提下不可达，因此追加识别侧优化 D4.1。
- AI 对话（级联、Edge）从用户说完到首个可播放音频 p50 ≤ 3.5 s（基线 6.9 s）；实时语音模型引擎 p50 ≤ 1.2 s。
- AI 对话的引擎、响应速度、朗读音色与语速都是可选项，默认值稳妥。
- 所有延迟改进都通过已有的 `metrics` 埋点做前后对比，结果写入 `docs/test/`。

**Non-Goals:**
- 不换默认 TTS 供应商、不做声音复刻、不做 SSML 精细控制；
- 不改 S2S 同传引擎；
- 不做基于 partial 的推测式翻译或回复；
- 不改半双工策略；
- 实时语音模型不支持术语与回复模型选择，也不用于 CHAT 以外的模式。

## Decisions

### D1 MP3 流式播放：前端 MediaSource 渐进播放，分段整解码作为降级

- **决策**：
  - 前端新增 `StreamingSpeech`（`web/src/lib/audio/streaming.ts`）。
  - MP3 在 `MediaSource.isTypeSupported("audio/mpeg")`（或 iOS 的 `ManagedMediaSource`）可用时，为每个播放项挂一个 MediaSource，把分包依次 `appendBuffer`，收到终止包后 `endOfStream()`。
  - 只复用一个 `<audio>` 元素，通过 `createMediaElementSource` 接入现有 `AudioPlayer` 的输出总线和 Analyser，吉祥物口型照常工作。
  - 不支持 MediaSource 时，按 `segLast` 分段整解码播放（见 D3），至少做到逐句出声。
  - PCM 继续走现有 worklet。
- **备选方案**：
  - A. Python 端把 MP3 解码成 PCM16 再下发：需要新增 PyAV 或 miniaudio 依赖，下行带宽变为约 8 倍（会议室按成员数放大）。
  - B. 前端按分包直接 `decodeAudioData`：MP3 位池和编码器延迟会造成断音、爆音。
  - C. 改用只输出 PCM 的付费 TTS：违背“免密钥默认”。
- **理由**：
  - 无新依赖，带宽不变。
  - 主流桌面浏览器都支持 `audio/mpeg` MSE，Safari 17.1+ 支持 ManagedMediaSource。
  - 降级路径仍然比现状好（逐句而非逐条回复）。

### D2 朗读接口流式化：路径不变，改为分块传输

- **决策**：
  - Python `/internal/speech/tts` 先 `await` 拿到首包（以便首包前的失败仍能返回 `C0172`），再返回 `StreamingResponse`，同时把分包写入一个 tee 缓冲，流结束后整体写入 `TtsCache`。缓存命中时直接整段返回。
  - Spring `AiServiceClient` 新增 `postStream`（RestClient `exchange(..., close=false)` 保留上游输入流）；`SpeechController` 直接写 `HttpServletResponse` 输出流，每读到一块就 flush。
  - 实施中发现 `StreamingResponseBody` 拿到的是 `StreamUtils.NonFlushingOutputStream`，flush 被忽略，数据会积在 Tomcat 缓冲区直到结束，因此不采用；项目启用了虚拟线程，同步写出不占平台线程。
  - 前端 `http.ts` 新增 `postStream`，返回 `ReadableStream` 和响应头，交给 `StreamingSpeech`。
- **备选方案**：
  - A. 新开 GET 接口，用一次性票据给 `<audio src>`：浏览器能原生渐进播放，但要多一套票据机制。
  - B. 走 SSE 下发 base64：体积 +33%，还要额外解码。
- **理由**：前端已有 Bearer 鉴权的 fetch 封装；路径和请求体不变，旧调用方（整段 blob）仍然可用。
- **接口契约**：

  ```
  POST /api/speech/tts                    (Spring 对外，Bearer)
  POST /internal/speech/tts               (Python 内部，X-Internal-Token)
  请求：{ text: string(≤2000), lang: string, voice?: string, engine?: "edge-tts"|"openai-speech",
          gender?: "female"|"male", rate?: number /* 0.5–2.0，缺省 1.0 */ }
  成功：200，Transfer-Encoding: chunked
        Content-Type: audio/mpeg | audio/L16;rate=24000
        X-Tts-Engine: edge-tts | openai-speech
        X-Tts-Cache: hit | miss
  失败（首包前）：502 Result{code:"C0172"}；参数非法 400 Result{code:"A0410"}；引擎不可用 503 Result{code:"C0173"}
  中途断流：连接提前结束，前端停止播放并提示“朗读中断”，不自动重试
  ```

  - `rate` 映射：Edge 为 `Communicate(rate="+20%")`（取整到 5%）；OpenAI 兼容为 `speed`。
  - 缓存键扩展为 `(scope, voice, rate, text)`。

### D3 同传音频分段协议与立即下发

- **决策**：`audio` 事件新增两个字段：
  - `seg`：同一 utteranceId + lang 下从 0 递增的段号；
  - `segLast`：本段最后一包。

  每个“段”是一次独立的 TTS 合成（一句或一个分句），MP3 每段都是完整、可独立解码的文件。

  `AudioSequencer` 的改动：
  - 分包到达就立即下发，不再扣包；
  - 段结束时把 `segLast=true` 标在该段最后一包上（段结束由合成任务通知，此时最后一包已知）；
  - 整条 track 结束时额外发一个 `{data:"", last:true}` 终止包；
  - 首包不合并，后续仍按 8 KB 合并以减少帧数。

  前端处理：
  - MSE 路径把各段依次 append 到同一个 SourceBuffer。MP3 是帧流，前后两个文件直接拼接可以连续播放；不同段的 ID3 头由 `StreamingSpeech` 剥离。
  - 降级路径按 `segLast` 逐段解码播放。
- **备选方案**：每句分配新的 utteranceId。这会破坏“一句话 = 一个 utteranceId”的落库、字幕和 metrics 语义，不采用。
- **理由**：协议增量小；`last` 语义不变（track 结束），只是可能落在空包上；旧字段兼容。

### D4 级联同传：译文流式切句即合成，2 路预取

- **决策**：
  - 抽出 `app/interpret/segmenter.py`，包含增量切句器 `SentenceSegmenter`，迁移 `chat.py` 的 `split_sentences` 并补上逗号、顿号等分句规则：
    - 首段至少 `first_min_chars` 字，均衡档 8、极速档 4；
    - 后续段至少 12 字，避免碎片化合成导致语调断裂；
    - CJK 按字计数，拉丁语按词计数（×3 折算）。
  - `_translate` 每收到 delta 就喂给切句器，切出的段立即放入 `SpeechPipeline`：
    - 最多 2 个合成任务并发；
    - 按段号顺序向 sequencer 推送；
    - 后段先合成好时先缓存，等前段推完再推。
  - `translation.final` 在译文生成完立即发出，不再等 TTS 首包。
  - `metrics` 的口径不变：`ttsFirstMs` 仍记首段首包，e2eMs 仍记到首段译音。
  - OpenAI 兼容的 TTS/ASR 改为每个引擎实例共享一个 `httpx.AsyncClient`（keep-alive），会话结束时关闭。
  - Edge 受库限制，每次合成仍新建连接，其开销由预取掩盖。
- **备选方案**：只做 D3、不做分句（实现最简单）。但译文较长时首声仍要等全文，收益不足。
- **理由**：同传单句通常很短，分句的收益主要在长句和 AI 对话；预取并发上限为 2，避免 Edge 限流（429/403）。

### D4.1 识别让路：尾部静音时不再发起 partial（实施中根据基线追加）

- **现象**：SenseVoice 单独解码 4 s 音频约 0.4 s，但同传中 asrMs 的 P50 为 0.85 s。原因是 partial 每 700 ms 对整段重识别一次（每次约 0.4 s），VAD 判句末时，最终识别常与进行中的 partial 争 CPU。
- **决策**：
  - 级联引擎记录最近约 200 ms 输入的 RMS；低于静音阈值（约 −40 dBFS）时认为“可能进入句末”，不再发起新的 partial。
  - 最终识别开始时，若仍有 partial 在执行，其结果直接丢弃（已有 gen 机制）。
- **备选方案**：取消进行中的 partial。线程中的 sherpa 解码无法中断，因此不采用。
- **理由**：partial 在句末的价值最低（字幕即将被 final 覆盖），让路后最终识别可独占 CPU。噪声环境下 RMS 不低于阈值时，行为与现状一致，不会更差。

### D5 AI 对话（级联）：逐句成段、字幕逐句并行

- **决策**：
  - `_generate` 的切句输出改为 `SpeechPipeline` 的段（与 D4 共用），句子边生成、边合成、边播放。
  - 母语字幕：每切出一句，就并行发起这一句的翻译（不注入术语、关闭评审，`max_tokens` 按句估算）。
    - `translation.delta` 下发累计字幕文本；
    - 全部句子完成后发 `translation.final`（按句序拼接）。
    - 字幕的翻译失败只影响该句，用原文占位并在 `error` 中给出非致命提示。
  - 打断时一并取消字幕任务。
  - 浏览器兜底（未开启服务端播报或 TTS 失败）仍在 `transcript.final` 后整条朗读，属于少见路径，本次不改。
- **备选方案**：让 LLM 一次输出“对话语言 + 母语”双语。这会拖慢首句（要先生成另一种语言），还会污染上下文，不采用。
- **理由**：字幕与语音解耦，任何一路慢都不阻塞另一路。

### D6 响应速度档位 `latencyMode`

- **决策**：
  - 会话 options 新增 `latencyMode: "balanced" | "fast"`，缺省 `balanced`，只对级联引擎（含 CHAT 级联）生效。
  - 两档参数：

    | 参数 | balanced | fast |
    |---|---|---|
    | `vad_min_silence_ms` | 500 | 300 |
    | 首段最小长度 | 8 | 4 |
    | partial 间隔 | 700 ms | 500 ms |

    参数在 `core/config.py` 中可配。
  - 极速档在说话停顿较多的人身上可能把一句话切成两句，向导中给出说明。
- **理由**：断句等待是固定开销，但缩短后会增加误切。做成可选项，由用户按场景选择。

### D7 AI 对话实时语音模型引擎 `realtime-chat`

- **决策**：
  - 新增 `app/interpret/realtime_chat.py` 的 `RealtimeChatEngine`，基于 OpenAI Realtime 风格的事件协议，用两个适配器区分厂商：
    - `DashScopeOmniAdapter`：`wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=<模型名>`，默认模型名 `qwen3-omni-flash-realtime`，以模型配置为准；输入 PCM16 16 kHz、输出 PCM16 24 kHz。复用 `qwen_livetranslate.py` 的连接、鉴权和重连工具。
    - `OpenAIRealtimeAdapter`：`/v1/realtime`，输入重采样到 24 kHz。标注“未联调”，与现有可选 S2S 引擎的做法一致。
  - 新增模型能力 `REALTIME_CHAT`，允许的提供方为 DASHSCOPE、OPENAI_COMPATIBLE。
  - 引擎可用性 = 存在启用的 `REALTIME_CHAT` 配置。
  - 会话 `instructions` 由 `chat_prompts.build_system_prompt(scenario, ai_lang, my_lang)` 生成，与级联一致。
  - 开场白通过 `response.create` 触发。
  - 开启上游 server VAD；音色取 `extra.voice`，否则按性别映射默认值。
  - 事件映射：

    | 上游事件 | 平台事件 |
    |---|---|
    | `input_audio_buffer.speech_stopped` | 记录用户句末时间 t0（e2e 起点） |
    | `conversation.item.input_audio_transcription.delta/completed` | 用户 `transcript.partial/final`（role 缺省） |
    | `response.audio_transcript.delta` | AI `transcript.partial`（role=assistant，累计） |
    | `response.audio.delta` | AI `audio`（pcm16，24 kHz，seg=0） |
    | `response.done` | AI `transcript.final` → 触发 D5 的逐句字幕 → 终止包 → `metrics`（asrMs 留空，ttsFirstMs = 首个音频增量） |
    | `input_audio_buffer.speech_started`（AI 播报中且开启耳机模式） | 发 `response.cancel` + `conversation.item.truncate`，下发 `reply.interrupted` |
    | 客户端 `interrupt` | 同上 |
    | 上游断开 | `error{C0174, fatal:false}`，重连一次，并用最近 12 轮文本重建会话上下文 |

  - 落库沿用现有转写段规则。
  - CHAT 的 engine 校验改为 `cascade | realtime-chat`（Spring `InterpretService` 和 Python `interpret.py` 两处）；翻译类 S2S 引擎仍返回 `A0410`。
- **备选方案**：
  - A. 用 qwen-livetranslate 做对话：它只做翻译不做回复，无法实现。
  - B. 级联 + 推测式回复：复杂且收益不确定，列为非目标。
- **理由**：
  - 用户明确希望“有实时的可选”；
  - 已有百炼密钥和 DashScope Realtime 协议实现经验，联调成本最低；
  - 端到端模型省去 ASR 和独立 TTS 两跳，是唯一能把对话延迟压到 1 s 级别的方案。
- **迁移**：Flyway `V8__realtime_chat_capability.sql`，改写 `biz.model_config.capability` 的 CHECK 约束并更新列注释。

### D8 引擎可用性新增 `chat` 类别

- **决策**：
  - `GET /api/speech/engines` 的响应新增 `chat` 数组：
    - `cascade`：始终可用，取决于 ASR/TTS；
    - `realtime-chat`：带 `provider`，以及 `tested: true|false`（DASHSCOPE 为 true）。
  - 前端 AI 对话向导从 `chat` 读取，不再硬编码。
  - 接口契约：

    ```
    GET /api/speech/engines
    data: { asr: Engine[], tts: Engine[], interpret: Engine[], image: Engine[],
            chat: Engine[] }   // 新增
    Engine: { id, name, available, reason?, languages: string[], provider?, tested? }
    ```

  - 同传会话创建请求的 `options` 新增 `latencyMode`；`engine` 在 CHAT 下允许 `realtime-chat`。错误码沿用：引擎不可用 `C0173`（HTTP 503），组合非法 `A0410`。

## UI/UX

### 信息架构

- **翻译工作台 · 译文区**：
  - 底部操作条位置不变（复制、收藏、存入记忆、朗读）。
  - 朗读按钮改为“分体按钮”：主体为播放/停止，右侧小三角打开设置弹层（音色：女声/男声分段控件；语速：0.8×/1.0×/1.2× 分段控件）。
  - 翻译进行中按钮可见但禁用，tooltip 为“译文完成后可朗读”。
- **翻译工作台 · 会话模式**：每轮译文下方的操作栏中，朗读按钮固定可见；其余操作仍在悬停时显示，避免视觉噪音。
- **翻译设置弹层**：新增“完成后自动朗读”开关，放在模型选择下方。只在单次模式与会话最新一轮生效。
- **同传向导 · AI 对话设置**：
  - 在场景卡下方新增“对话引擎”两张卡片：
    - 「平台级联」：徽章“可选回复模型”，说明“识别 → 对话模型 → 合成，可控”；
    - 「实时语音模型」：徽章“最快”，说明“端到端语音模型，语气自然”；不可用时置灰并显示原因，未联调的厂商额外显示“实验”徽章。
  - 选中实时语音模型时，高级设置中的“回复模型”“术语库”“响应速度”折叠项置灰并提示“实时语音模型不支持”。
- **同传向导 · 高级设置（可折叠）**：新增“响应速度”分段控件「均衡 / 极速」及一行说明。
- **同传进行中**：
  - AI 气泡、译文气泡和收听历史字幕行在悬停或长按时显示“重播”图标按钮；
  - 当前正在播报的气泡显示细声波条。

### 关键交互流程

1. **工作台朗读**：翻译完成 → 朗读按钮淡入可用（自动朗读开启时直接开始）→ 点击后按钮显示加载环（首包未到）→ 首包到达，切换为声波动画 → 播完或点击停止，回到默认。失败时 toast“已改用浏览器朗读”，并用浏览器继续朗读。
2. **AI 对话（实时模型）**：选择 AI 对话 → 选场景 → 选“实时语音模型”卡片 → 开始 → Lumi 开场 → 用户说话，吉祥物进入倾听 → 说完即答，吉祥物在思考态一闪而过 → 说话 → 打断与插话同级联。
3. **AI 对话（级联·极速）**：在高级设置中选极速 → 断句更快 → 首句一合成好就开口，后续句子无缝衔接，母语字幕逐句出现。

### 动效清单（motion，统一缓动与时长令牌，`prefers-reduced-motion` 下取消位移与缩放，只保留透明度变化）

| 元素 | 动效 |
|---|---|
| 朗读按钮状态切换 | 图标交叉淡入 + 轻微缩放（150 ms） |
| 朗读按钮加载 | 加载环旋转 |
| 朗读按钮播放 | 三根声波条随 Analyser 电平跳动，reduced-motion 下为静态条 |
| 朗读设置弹层 | 自锚点 scale 0.96 → 1 + 淡入 |
| 引擎卡片 | 选中时边框描光 + layoutId 指示器滑动；不可用卡片悬停时轻微抖动提示原因 |
| “响应速度”分段控件 | 滑块 layout 动画 |
| 重播按钮 | 悬停淡入 |
| 播报中的气泡 | 底部声波条呼吸 |
| 母语字幕逐句出现 | 每句淡入 + 上移 4 px |

空、错误与加载状态：
- 无可用 TTS 时，朗读按钮 tooltip 说明“将使用浏览器朗读”；
- 实时语音模型不可用时，卡片内显示原因和“请管理员在模型配置中添加 REALTIME_CHAT”；
- 实时引擎连接失败时，聊天流顶部出现可关闭的横幅，提供“切换到平台级联重新开始”。

## Risks / Trade-offs

- **[MSE 兼容性]** 部分浏览器不支持 `audio/mpeg` MSE，或 iOS 版本较低 → 能力检测后降级为分段整解码；在 Chrome、Edge、Firefox、Safari 上各验证一次。
- **[MP3 拼接的接缝]** 各段独立编码，拼接处可能有约 20–50 ms 的编码器静音 → 可以接受（听感接近句间停顿）；ID3 头必须剥离，否则部分浏览器会报解码错误。
- **[Edge 并发限流]** 预取并发 2 加上会议室多语种，可能触发 Edge 限流 → 全局（进程级）Edge 并发信号量上限设为 4；失败时退回浏览器朗读（已有路径）。
- **[分句导致语调断裂]** 分句越碎，合成的语调越不自然 → 后续段至少 12 字；首段之后优先按句末标点切分。
- **[极速档误切]** 300 ms 静音会把停顿当成句末 → 默认均衡档，极速档在向导中给出说明。
- **[实时模型协议差异]** DashScope Omni Realtime 的事件名、输入采样率、音色列表可能与 OpenAI 有出入 → 适配器隔离差异；先用真实密钥联调 DashScope，OpenAI 适配器标注“实验”。
- **[实时模型成本]** 端到端语音模型按音频时长计费，比级联贵 → 默认仍是级联，实时模型只在用户主动选择时使用；向导卡片注明。
- **[Spring 流式代理超时]** 同步写出不受异步请求超时限制；上游每次读取受 AI 客户端读超时（60 s）约束，Edge 合成中途卡住时读超时后结束响应。
- **[与 add-platform-mascot 冲突]** 修改的是同一批 interpret 组件 → 该变更提交后再实施。
- **[基线不可比]** 网络抖动会影响延迟对比 → 用 E4 的固定音频集，各跑 3 遍取中位数，前后在同一网络下测量。

## Migration Plan

1. 先做 Python 和前端的协议兼容层：前端能处理带 `seg` 和空终止包的 `audio`，同时兼容旧格式。
2. 依次上线后端的 Sequencer、流水线和 CHAT 分段，前后端一起部署（单体 docker compose，无灰度需求）。
3. Flyway V8 只扩大 CHECK 约束取值，可以安全回滚（删除 `REALTIME_CHAT` 配置后回退约束）。
4. 回滚：前端的 `StreamingSpeech` 留有开关 `NEXT_PUBLIC_AUDIO_MSE=false`，可一键回到分段整解码；后端的 `latencyMode` 缺省为均衡，不影响旧会话。

## Open Questions

- ~~百炼 Omni Realtime 的模型名、音色和音频格式~~。**已确认（2026-10-06 真实联调，事件序列见 `python-backend/tests/fixtures/interpret/omni_realtime_events.jsonl`）**：
  - 模型 `qwen3-omni-flash-realtime` 可用，地址与鉴权与千问同传相同；
  - `session.update` 使用 `modalities: ["text","audio"]`、`voice: "Cherry"`、`input_audio_format: "pcm16"`（16 kHz）、`output_audio_format: "pcm24"`（PCM16 24 kHz）、`input_audio_transcription.model: "gummy-realtime-v1"`、`turn_detection: server_vad`；服务端默认 `create_response=true`、`interrupt_response=true`；
  - 事件名与 OpenAI Realtime 一致；用户转写只有 `input_audio_transcription.completed`（无 delta）；回复文本 `response.audio_transcript.delta` 明显先于音频；`response.cancel` 后收到 `response.done{status:"cancelled"}`；新的 `speech_started` 会让服务端自动取消进行中的回复（同样以 cancelled 结束）；
  - 实测延迟：`speech_stopped` → 首个 `response.audio.delta` 为 445 ms / 1025 ms，`speech_stopped` → 用户转写约 260 ms；
  - 决策：保留服务端 `interrupt_response`。不戴耳机时前端半双工不上行，不会被回声误触发；戴耳机时即为插话打断。服务端取消的回复同样映射为 `reply.interrupted`；
  - `conversation.item.truncate` 未验证，不使用。上游断线重建时，把最近 12 轮对话文本拼进 `instructions` 恢复上下文。
- 测试用的 LLM 中转是否支持 OpenAI Realtime WebSocket？不支持时 OpenAI 适配器只做单元测试（mock 上游）。
- 工作台的“自动朗读”是否也要用于会话模式的历史轮次？当前决定只用于新完成的一轮。
