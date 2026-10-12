## Why

同传与 AI 对话已经跑通，但实测"说话不好用"。根因有两类。

**断句只看静音时长。**
- 级联引擎用 Silero VAD 判句末：静音 500 ms（极速 300 ms）就定稿；实时语音模型的 server_vad 也是 500 ms，百炼的缺省值为 800 ms。人在想词、说"嗯…那个…"时的自然停顿通常就超过这个时长。
- 结果是一句话被切成几段：
  - 半句被单独翻译和播报；
  - 纯语气词也会成句；
  - AI 对话在用户停顿时抢先回复。
- 未开耳机的单设备模式下，播报开始就暂停收音，用户接着说的后半句会丢失。

**前端事件归并不完整，出现空白光标框与抖动。**
- 识别中间结果（partial）一到就建气泡。如果最终识别为空（咳嗽、呼吸），这个带光标的气泡永远留着。
- 会议室视图不过滤无文字语句；收听舞台在原文为空时显示孤立光标。
- 实时语音模型的用户转写晚于 AI 回复到达，用户气泡会排到回复后面。
- 每个 token 都触发平滑滚动和整列重渲染。

主流方案已经比较成熟：
- **两段式断句**：短静音只作为候选句末，由语义或声学判断是否说完，没说完就延长等待。Pipecat Smart Turn、LiveKit turn detector、OpenAI semantic_vad、Deepgram Flux 都是这个思路。
- **字幕显示**：稳定前缀与不稳定尾部分开显示（Google / AWS / Azure 的 partial stability）。
- **语音助手界面**：开口时只显示"正在听"、有文字才建气泡，空结果直接撤回。

本变更把这些做法落到本平台。

## What Changes

- **两段式断句（级联同传与级联 AI 对话）**：
  - VAD 静音达到阈值只算"候选句末"。判断已说完的立即定稿，完整句延迟不变；判断未说完的进入等待：
    - 等待期间恢复说话 → 续说并入同一句（同一 utteranceId，合并音频重新识别）；
    - 超时 → 定稿。
  - 是否说完的判断：
    - 先用文本启发式：句末标点、结尾连接词与语气词、长度；
    - 可选声学模型 Pipecat Smart Turn v3（8 MB int8 ONNX，BSD-2，支持中文），离线评测证明有效后才默认开启。
  - 等待上限与合并上限按场景配置：同传均衡、同传极速、AI 对话各一套，AI 对话最宽松。
- **语气词与噪声不成句**：识别为空或只有语气词的语音段不翻译、不回复、不播报；已经显示过的进行中语句由新事件撤回。
- **协议扩展（向后兼容）**：
  - 新增下行事件 `transcript.discard{utteranceId}`；
  - `transcript.partial` 增加可选字段 `hold`（正在等待续说）；
  - `metrics` 增加可选字段 `holdMs`；
  - 控制帧 `interrupt` 增加可选字段 `yield`。
- **AI 对话回复让位**：
  - AI 回复还没开始播放、用户又接着说时，客户端发 `interrupt{yield:true}`。服务端撤回该回复：下发 discard，不写入对话记忆与记录。用户前后两段话作为同一轮回应。如果续说只是噪声，恢复回应原句。
  - 耳机模式的自动插话改为需要有效语音（去掉语气词后至少 2 个字或 1 个词）才触发，咳嗽不再打断 AI。
- **半双工播报择机开始**：单设备模式未开耳机时，下一句播报开始前，如果本机用户正在说话或本机语句尚未定稿，推迟开播，最多 4 s。播报期间暂停收音的规则不变。
- **实时语音模型断句参数**：
  - 百炼 server_vad 静音 500 → 800 ms（可配置），支持 semantic_vad 的模型改用 semantic_vad；
  - OpenAI 适配器改用 semantic_vad，eagerness 可配置，缺省 `low`。
- **前端实时字幕体验**：
  - 不再出现空白气泡与孤立光标：有文字才渲染气泡；已开口未出字时显示"正在听"指示，会议室显示"某某正在说话"；
  - 光标只在当前进行中的语句上显示；等待续说时显示呼吸点；
  - partial 采用"稳定前缀 + 淡显尾部"，避免整句闪烁；
  - 按发言流序号插入，迟到的用户转写排在它触发的 AI 回复之前；
  - 跟随滚动：用户上翻时不抢滚动，并显示"新消息"胶囊；
  - 事件按帧合并后批量归并，消息行 memo 化；
  - 同一发言人的连续消息合并显示（会议室，以及 AI 对话的用户侧）。
- **E6 停顿鲁棒性评测**：基于现有 40 句语音数据集合成三种变体：
  - 句中停顿 600 / 900 / 1200 ms；
  - 停顿处插入语气词；
  - 两句之间短间隔（用于误合并对照）。

  统计碎句率、误合并率、语气词成句数、完整句 e2e 延迟与整句 chrF，出改动前后对比报告。Smart Turn 是否默认开启以 E6 结果决定。

## Capabilities

### New Capabilities

- `speech-endpointing`：语音句末判定，涵盖：
  - 候选句末与"是否说完"判断（文本启发式与可选声学模型）；
  - 等待续说与合并；
  - 语气词或噪声段丢弃；
  - 各场景的参数档位。

  供级联同传与级联 AI 对话使用。

### Modified Capabilities

- `live-interpretation`：
  - 「同传引擎」：级联使用两段式断句；
  - 「实时音频通道」：新增 `transcript.discard`、`hold`、`interrupt.yield`，并修改事件顺序约定；
  - 「语音播报与回声规避」：半双工择机开播；
  - 「响应速度档位」：增加续说等待参数；
  - 「AI 对话打断」：回复让位，插话需要有效语音；
  - 「实时语音对话引擎」：断句参数与 semantic_vad；
  - 「逐句延迟指标」：e2e 含续说等待，新增 holdMs；
  - 「同传页面」：实时字幕渲染规则。
- `speech-services`：「本地模型下载」可选下载 Smart Turn v3 模型。
- `multimodal-evaluation`：新增「E6 停顿鲁棒性评测」。

## Impact

- **python-backend**：
  - 新增 `app/speech/endpointing.py`：判定器与 Smart Turn 推理；
  - 改造 `app/interpret/cascade.py`：候选、等待与合并状态机，以及 discard；
  - `chat.py`：让位与恢复；
  - `realtime_chat.py`：适配器断句参数；
  - `engine.py`：metrics 增加 holdMs；
  - `core/config.py`：各档参数；
  - `app/speech/download.py` 与 `models.py`：可选模型；
  - 新增依赖 `onnxruntime`（仅 Smart Turn 使用，缺失时自动退回启发式）。
- **springboot-backend**：`RoomRegistry` 收到 `transcript.discard` 时从 `RecentUtterances` 移除该句，`SegmentWriter` 新增 `discard` 撤销待写或已写的转写段；该事件照常广播，不落库。控制帧原样转发，无需改动。
- **web**：
  - `lib/interpret/protocol.ts`、`reducer.ts`（discard、按序插入、过期收尾）；
  - `stores/interpret-store.ts`（按帧批量归并）；
  - `hooks/use-interpret-socket.ts`（择机开播、让位、插话门槛）；
  - `lib/audio/queue.ts`（开播门控）；
  - 新增 `components/interpret/streaming-text.tsx`、`listening-indicator.tsx` 与 `hooks/use-stick-to-bottom.ts`；
  - 改造 room / listen / converse / chat 四个视图；
  - mock 同传 socket 补充 discard 与 hold 事件。
- **evaluation**：`eval/multimodal/e6_pause.py` 与数据合成脚本，结果在 `results/multimodal/e6_*`。
- **文档**：
  - `docs/contracts/speech-image-api.md` 补充事件协议；
  - `docs/总体设计.md` 增加路线图 ⑧.5 与风险清单；
  - 新增测试报告 `docs/test/endpointing/`。
- **依赖关系**：
  - 依赖 ⑧.3 improve-speech-playback-latency：分段播报队列、响应速度档位、实时语音对话引擎；
  - 依赖 ⑧.4 improve-prompts-and-context-memory：对话消息规范化会合并相邻同角色消息，让位后两段用户话依赖它合并为一轮；
  - 复用 ⑦ 的 E4 推流评测框架。

## 非目标

- 不更换识别模型。仍用 SenseVoice 整段识别，不改为流式 ASR（如 paraformer-streaming），partial 仍按间隔重识别。
- 不使用基于 LLM 的语义断句模型（如 LiveKit 0.5B turn detector），CPU 延迟与体积不合适。
- 不做"句末之前就预先生成回复"的投机式启动（Deepgram EagerEndOfTurn）。本变更在定稿后生成，播放前可让位，已覆盖主要收益。
- 不改 S2S 同传引擎（百炼 / 豆包 / Gemini / OpenAI 同传）的上游断句，只受益于前端通用的渲染与撤回规则。
- 不迁移 OpenAI Realtime 适配器到 GA 接口。据第三方消息，beta 头 `realtime=v1` 已下线，需另起变更联调；本变更只调整其断句参数。
- 不在浏览器端加载神经网络 VAD 模型。本机是否在说话只用现有电平加挂起时间判断。
