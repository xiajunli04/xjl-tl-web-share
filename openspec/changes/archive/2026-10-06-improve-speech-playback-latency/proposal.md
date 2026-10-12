## Why

⑦⑧ 的语音功能都已打通，但用户实测体验“卡、慢”：

- 翻译工作台的译文朗读按钮只在翻译结束后出现，会话模式里还要悬停才显示，用户以为“没有播放”。点了之后，也要等整段音频合成完、经 Python → Spring → 浏览器三层整段缓冲才出声。
- 同传和 AI 对话的延迟主要来自链路里的串行等待，而不是模型本身：
  - 默认 Edge TTS 输出 MP3，前端要等一句的音频全部到齐才开始解码播放；
  - AI 对话把整条回复（多句）当成一句，要等所有句子都合成完才开口；
  - 级联同传要等译文全文生成完才开始合成；
  - 服务端还会把每句的最后一个音频包扣住，等下一包到了才发。
- AI 对话只能走“识别 → 对话模型 → 合成”的级联链路，没有像同传那样可选的实时语音模型。

功能已经验收，现在需要一轮专门的体验与延迟优化，让“能用”变成“好用”。答辩演示的核心场景（同传、和 Lumi 对话）也依赖这一点。

## What Changes

- **朗读改为边合成边播放**：
  - `POST /api/speech/tts` 改为分块流式返回，Python → Spring → 浏览器全程不再整段缓冲；接口路径与请求不变。缓存命中时一次性返回。
  - 新增可选参数：语速 `rate`、音色性别 `gender`。
  - 前端新增统一的流式播放器：MP3 走 MediaSource 渐进播放，PCM 走现有 worklet；不支持 MediaSource 的浏览器降级为整段播放。
- **翻译工作台的译文朗读一眼可见、可设置**：
  - 译文区的朗读按钮常驻：翻译中显示为禁用态并提示“完成后可朗读”；会话模式每轮译文的朗读按钮不再依赖悬停。
  - 按钮有三态：加载、播放（声波）、停止。
  - 小弹层可选男声/女声和语速；「翻译设置」中新增“翻译完成后自动朗读”，默认关闭。偏好本地持久化。
- **同传播报改为流式、分段**：
  - `audio` 事件新增分段字段 `seg` / `segLast`，前端 MP3 也做到边收边播；
  - 服务端去掉“扣住最后一包”，改为立即下发，并用一个空的终止包标记 `last`；
  - 首包合并阈值降低。
- **级联同传改为流水线**：
  - 译文按句或分句边生成边合成，不再等译文全文；`translation.final` 不再等 TTS 首包；
  - TTS 合成最多 2 句并发预取，播放顺序不变；
  - 远程 ASR/TTS 复用 HTTP 连接。
- **AI 对话（级联）提速**：
  - 回复逐句成段、逐句播放，后句的合成与前句的播放并行；
  - 母语字幕改为逐句并行翻译，不再等整条回复生成完。
- **新增可选的“响应速度”档位**（级联引擎，`均衡` / `极速`，默认均衡）：极速档缩短 VAD 断句静音（500 → 300 ms），并降低首句合成的最小长度。
- **AI 对话新增可选的实时语音模型引擎** `realtime-chat`：
  - 端到端语音模型直接听、直接说，延迟最低、语气最自然；
  - 首选百炼 Qwen-Omni Realtime（复用已有的 DashScope 实时协议经验），OpenAI 兼容的 Realtime 作为可选（未联调）；
  - 新增模型能力类型 `REALTIME_CHAT`；
  - 向导中 AI 对话的引擎改为二选一卡片：「平台级联（可选回复模型、更可控）」/「实时语音模型（最快、需管理员配置）」，不可用时置灰并说明原因。
- **同传各模式的字幕气泡（AI 回复、译文）增加“重播”按钮**，复用流式朗读。
- **BREAKING（仅内部协议）**：
  - 同传 `audio` 事件的 `last=true` 可能落在 `data` 为空的终止包上；
  - 前端必须按 `seg` / `segLast` 处理 MP3 分段。
  - 两端同时升级，不涉及对外 API 兼容问题。

## 非目标

- 不更换默认 TTS 供应商，也不引入付费 TTS 作为默认；Edge 仍是免密钥默认。
- 不做声音复刻、情感语音或 SSML 精细控制。
- 不改动 S2S 同传引擎（千问 / 豆包 / Gemini / OpenAI）的上游协议，它们已经是流式 PCM。
- 不做基于识别中间结果（partial）的推测式翻译或推测式回复。
- 不改半双工回声规避的策略（播报期间暂停收音、结束后 300 ms 恢复）。
- 实时语音模型引擎不支持术语库注入与回复模型选择；该引擎只用于 AI 对话，不用于收听、对话、会议室模式。
- 不改动数字人或吉祥物的形象与动画，只沿用其口型能量输入。

## 与路线图的依赖关系

- 依赖 ⑦ `add-speech-and-image-translation`（语音引擎层、实时音频通道、级联链路、朗读接口）和 ⑧ `add-ai-avatar-and-landing`（AI 对话模式、打断）。
- 依赖进行中的 `add-platform-mascot`：本变更会修改 `chat-view.tsx`、`converse-view.tsx` 等同批文件。必须在该变更提交后再实施，避免冲突。
- 完成后在 `docs/总体设计.md` 路线图中补一行，作为 ⑧ 系列之后的体验优化变更；同时更新第 11 节风险清单中“实时语音链路延迟”一项的应对措施。
- 延迟改进复用 ⑤ 的评测框架与 ⑦ E4 的逐句延迟指标做前后对比，可作为论文“发现问题 → 改进 → 验证”的补充材料。

## Capabilities

### New Capabilities

（无。实时语音对话作为 AI 对话模式的可选引擎，归入 `live-interpretation`。）

### Modified Capabilities

- `speech-services`：
  - 朗读接口改为流式返回，并支持语速与音色性别；
  - 引擎可用性新增 `chat` 类别（AI 对话可用引擎）。
- `live-interpretation`：
  - CHAT 模式允许 `realtime-chat` 引擎；
  - 语音播报改为流式、分段播放；
  - AI 对话回复逐句成段、字幕逐句并行；
  - 新增级联低延迟流水线、音频分段协议、响应速度档位、实时语音对话引擎、字幕重播等需求。
- `text-translation-agent`：新增“译文朗读体验”需求，包括常驻按钮、三态、音色与语速、自动朗读。
- `model-config`：能力类型新增 `REALTIME_CHAT`，允许的提供方为 DASHSCOPE、OPENAI_COMPATIBLE。

## Impact

- **python-backend**：
  - `app/speech/tts.py`：流式合成与缓存、共享 HTTP 客户端、rate/gender 参数；
  - `app/speech/asr.py`：远程客户端复用；
  - `app/api/internal/speech.py`：StreamingResponse；
  - `app/interpret/engine.py`：AudioSequencer 的分段、立即下发与终止包；
  - `app/interpret/cascade.py`：分句流水线、预取、响应速度档位；
  - `app/interpret/chat.py`：逐句成段、字幕并行；
  - 新增 `app/interpret/realtime_chat.py`；
  - `app/speech/engines.py`：chat 类别与引擎解析；
  - `app/api/internal/interpret.py`：CHAT 引擎校验；
  - `app/core/config.py`：新配置项。
- **springboot-backend**：
  - `SpeechController` / `AiServiceClient`：流式代理（StreamingResponseBody）；
  - 模型能力类型 `REALTIME_CHAT`（`ModelConfig`、`ModelConfigDtos`、`ModelConfigService` 的组合校验）；
  - Flyway 新迁移，修改 `biz.model_config.capability` 的 CHECK 约束；
  - 同传会话创建时的 CHAT 引擎校验、`latencyMode` 选项透传。
- **web**：
  - `lib/audio/`：新增流式播放器，`queue.ts` 支持 MP3 渐进与分段；
  - `lib/api/speech.ts` / `lib/http.ts`：流式读取；
  - `components/translate/speak-button.tsx`、`target-panel.tsx`、`session-thread.tsx`、翻译设置弹层；
  - `components/interpret/`：settings-step 的引擎卡片、advanced-section 的响应速度、各视图的重播按钮；
  - `hooks/use-interpret-socket.ts`、`lib/interpret/setup.ts`；
  - 管理后台模型配置表单新增能力选项。
- **外部依赖**：不新增 Python 或 npm 依赖；实时语音模型需要管理员配置百炼（或 OpenAI 兼容）密钥。
- **文档**：`docs/总体设计.md` 路线图与风险清单；`docs/test/` 下的延迟前后对比记录。
