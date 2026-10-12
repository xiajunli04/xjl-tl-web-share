## MODIFIED Requirements

### Requirement: 同传引擎
系统 SHALL 提供以下同传引擎，并统一映射到平台事件协议：
- `cascade`：平台级联，即两段式断句（见 speech-endpointing）→ 语音识别 → 平台翻译（使用同声传译专用提示词，注入术语与本发言流最近 6 句的上下文，关闭评审）→ 语音合成；
- `qwen-livetranslate`：百炼 `qwen3.8-livetranslate-flash-realtime`（兼容 3.5），session 中 MUST 显式指定音色；
- 可选：`doubao-ast`（豆包同声传译 2.0）、`gemini-live-translate`（Gemini 3.5 Live Translate）、`openai-realtime`（OpenAI `gpt-realtime-translate`）。可选引擎未实现或未配置时，MUST 在引擎列表中显示为不可用，不影响其他引擎。

级联引擎的上下文 MUST 按发言流统一维护，不再按目标语言分桶：
- 窗口为最近 6 句（可配置），总长超过 1500 字符（可配置）时从最早的一句开始丢弃；
- 双向对话 MUST 同时包含双方的语句；
- 每句给出原话及其语言；已有当前目标语言的译文、且原话不是目标语言时，一并给出该译文；
- 一句话在 `transcript.final` 时即进入上下文，不等待其译文完成；被丢弃（`transcript.discard`）的语句 MUST NOT 进入上下文。

S2S 引擎 MUST 为每个目标语言建立一个上游会话，并在千问引擎中把命中的术语写入热词。级联引擎 MUST 对一句话只翻译一次（续说合并后的整句），各目标语言并行翻译与合成。各引擎可用的语言范围 MUST 来自引擎列表接口，前端只允许选择所选引擎支持的语言。

#### Scenario: 级联注入术语
- **WHEN** 用户选择含 "大模型 → LLM" 的术语库，以级联引擎同传收听（目标 en），并说出包含"大模型"的句子
- **THEN** 该句的 `translation.final` 译文包含 "LLM"

#### Scenario: 双向对话的回答带上提问
- **WHEN** 双向对话（A=zh、B=en）中，A 说"你们周几能发货"，随后 B 说 "We can ship it on Friday."
- **THEN** 翻译 B 这一句（目标 zh）时，提示词的上下文中包含 A 的原话"你们周几能发货"

#### Scenario: 上下文窗口
- **WHEN** 级联同传收听已定稿 8 句，开始翻译第 9 句
- **THEN** 提示词的上下文中只包含第 3–8 句，按时间顺序排列

#### Scenario: 停顿后的整句只翻译一次
- **WHEN** 级联同传中用户说了一句中途停顿 900 ms 的话，两段被合并为同一句
- **THEN** 该句只有一次翻译与一组 `translation.*` 事件，译文对应完整的一句话

#### Scenario: S2S 多目标
- **WHEN** 会议室使用 qwen-livetranslate 引擎，发言人语言为 zh，其他成员语言为 en 和 ja
- **THEN** Python 为该发言流建立 2 个上游会话，目标分别为 en 和 ja

#### Scenario: 百炼引擎真实同传
- **WHEN** 管理员配置了百炼 REALTIME_TRANSLATE 密钥，用户以 qwen-livetranslate 引擎同传收听（目标 en）并说一句中文
- **THEN** 客户端收到该句的原文、英文译文与 24 kHz pcm16 音频，metrics.e2eMs 有值

#### Scenario: 源语种等于目标语种
- **WHEN** LISTEN 模式目标为 zh，级联引擎识别到一句中文
- **THEN** 只发出该句的 `transcript.final`，不发 `translation.*` 和 `audio`

### Requirement: 实时音频通道
浏览器 SHALL 通过 `wss://{api}/ws/interpret?ticket=` 连接 Spring（局域网访问时经前端同源代理转发）。票据有效期 60 秒，只能使用一次。握手 MUST 校验票据；请求携带 Origin 时 MUST 在允许的来源内，不带 Origin（前端同源代理或非浏览器客户端）时只校验票据。校验失败时拒绝握手。

连接建立后：
- 浏览器上行二进制帧为 PCM16LE、16 kHz、单声道音频，以及 JSON 控制帧（`ptt`、`flush`、`mute`、`interrupt`、`end`、`ping`）；
  - `interrupt` 可携带 `yield: true`，表示让位（见「AI 对话回复让位」）；
- Spring 为每条发言流向 Python `/internal/interpret/stream` 建立内部 WebSocket（携带 `X-Internal-Token`），首帧发送 config，然后转发音频与控制帧；
- 下行事件为 JSON：`ready`、`participants`、`transcript.partial`、`transcript.final`、`transcript.discard`、`translation.delta`、`translation.final`、`audio`、`metrics`、`reply.interrupted`、`error`、`ended`，字段见设计 D7 与本变更设计 D5。
  - `audio` 的 format 为 `pcm16` 或 `mp3`，数据为 base64。
  - 带 utteranceId 的事件可以携带 `role`（`user` | `assistant`），缺省为 `user`。
  - `transcript.partial` 可携带 `hold: true`，表示服务端正在等待续说。
  - `transcript.discard{utteranceId}` 撤回一条尚未定稿的语句。Spring MUST 照常广播，并从最近语句与待写转写段中移除该句；已写出的转写行 MUST 删除。

#### Scenario: 票据重复使用
- **WHEN** 客户端用已经使用过的票据再次连接
- **THEN** 握手被拒绝（HTTP 401，code `A0453`）

#### Scenario: 局域网经同源代理连接
- **WHEN** 局域网设备打开前端（如 `http://192.168.66.121:3001`）加入多语言会议室，前端同源代理转发握手时去掉了 Origin
- **THEN** 票据有效时握手成功，成员收到 `ready`

#### Scenario: 外站来源
- **WHEN** 握手携带不在允许列表内的 Origin（如 `http://evil.example`）
- **THEN** 握手被拒绝（HTTP 403，code `A0301`），票据不被消耗

#### Scenario: 一句话的事件顺序
- **WHEN** 用户在级联引擎下说完一句话
- **THEN** 客户端依次收到同一 utteranceId 的：
  - 若干 `transcript.partial`（可能含 `hold:true`）；
  - 一个 `transcript.final`；
  - 若干 `translation.delta`、一个 `translation.final`；
  - 若干 `audio`（最后一个 last=true）；
  - 一个 `metrics`。

#### Scenario: 被撤回的语句
- **WHEN** 级联引擎为一段语音发出过 partial，定稿时识别文本只有语气词
- **THEN** 客户端收到该 utteranceId 的 `transcript.discard`，此后不再收到该 utteranceId 的任何事件，同传记录中没有这一句

#### Scenario: 上游中断
- **WHEN** Python 与 S2S 上游的连接意外断开
- **THEN** 客户端收到 `error{code:"C0174", fatal:false}`，系统尝试重建一次上游会话，已完成的转写不丢失

#### Scenario: 非 CHAT 模式忽略打断
- **WHEN** 客户端在 LISTEN 模式下发送 `{type:"interrupt"}`
- **THEN** 该控制帧被忽略，同传继续，不返回错误

### Requirement: 语音播报与回声规避
开启语音播报时，客户端 SHALL 按 utteranceId 顺序排队播放 `audio` 事件，并 MUST 边收边播：
- `pcm16` 收到分包即写入播放缓冲；
- `mp3` 在浏览器支持 MediaSource（`audio/mpeg`）时，把分包渐进追加到媒体缓冲播放；不支持时，按 `segLast` 以段为单位解码播放。
- 任何格式下，客户端 MUST NOT 等整条 track 结束（`last=true`）才开始播放。

服务端 TTS 失败时，客户端 SHALL 改用浏览器朗读该句译文。单设备模式（LISTEN、CONVERSE）未开启耳机模式时，客户端 MUST 在播报期间暂停上行音频，并在播报结束 300 ms 后恢复。采集 MUST 开启回声消除、降噪和自动增益。

择机开播：
- 适用范围：半双工的 LISTEN / CONVERSE，以及任意 CHAT。
- 下一句开始播放前，如果本机用户正在说话（电平持续超过说话阈值，含 600 ms 挂起），或本机有未定稿的语句（最近 3 秒内收到过本人 partial 且尚未定稿或撤回），客户端 MUST 推迟开播。
- 推迟最长 4 秒，超过后照常开播。
- 已开始播放的句子不受影响；用户主动重播不受影响。
- 播报开始而本机仍有处于续说等待的语句时，客户端 SHALL 发送 `flush`。

#### Scenario: 半双工
- **WHEN** 双向对话中译文正在播报，且未开启耳机模式
- **THEN** 播报期间不上行音频帧，界面显示"播报中，暂停收音"

#### Scenario: 用户还在说话时推迟播报
- **WHEN** 双向对话未开耳机，A 的上一句译文已到达，而 A 仍在说下一句
- **THEN** 译文暂不开播；A 停下（或推迟满 4 秒）后才开始播放，A 正在说的内容没有因为关麦而丢失

#### Scenario: TTS 降级
- **WHEN** edge-tts 返回 403，该句尚未发出任何音频
- **THEN** 客户端收到 `error{code:"C0172", fatal:false}` 和该句带 `ttsFallback=true` 的 `translation.final`（若此前已发出不带降级标记的定稿，则补发一次同文定稿），客户端用浏览器朗读该句，同传继续

#### Scenario: MP3 首段即播
- **WHEN** 级联引擎使用 edge-tts，一句译文被切成 2 段合成
- **THEN** 客户端在第 1 段的音频到达后即开始播放，不等第 2 段合成完成

#### Scenario: 不支持 MediaSource 的降级
- **WHEN** 浏览器不支持 `audio/mpeg` 的 MediaSource
- **THEN** 客户端在每段的 segLast 分包到达后解码播放该段，各段按顺序衔接

### Requirement: 逐句延迟指标
系统 SHALL 为每句话发出 `metrics` 事件，包含 asrMs、mtFirstMs、mtMs、ttsFirstMs、e2eMs，级联引擎另含 holdMs。
- e2eMs 定义为从说话结束（最后一个语音段的结束，或 S2S 输入转写的最后一次增量）到首段译音；未开启播报时，终点为译文定稿。e2eMs 因此包含续说等待。
- holdMs 为该句在续说等待中累计停留的时长，判为说完的句子为 0。
- holdMs MUST 随转写段的指标一并保存。

进行中界面 SHALL 显示最近一句的 e2e 延迟；会话结束时 SHALL 汇总平均延迟。

#### Scenario: 显示延迟
- **WHEN** 一句话的 metrics.e2eMs=2400
- **THEN** 控制条的延迟胶囊显示 "2.4 s"

#### Scenario: 续说等待计入指标
- **WHEN** 级联同传中一句话因判为未说完而等待了 700 ms 后定稿
- **THEN** 该句 metrics.holdMs=700，且 e2eMs 包含这 700 ms

### Requirement: AI 对话打断
在 CHAT 模式下，客户端 SHALL 可以发送控制帧 `{type:"interrupt"}` 打断 AI 当前的回复。收到后，系统 MUST 立即取消该回复尚未完成的生成、字幕翻译与语音合成，并下发 `reply.interrupted{utteranceId, text}`，其中 text 为已生成的文本。被打断的回复 SHALL 以已生成的部分写入对话上下文与记录。客户端 MUST 在发出打断后立即停止本地播放。

开启耳机模式时，AI 播报期间收到用户新的、**有效**的 `transcript.partial`，客户端 SHALL 自动发送打断。有效指去掉标点与语气词后，中日韩至少 2 个字，或拉丁语至少 1 个长度 ≥ 2 的词。只有语气词或噪声的 partial MUST NOT 触发自动打断。

#### Scenario: 点击打断
- **WHEN** AI 正在朗读一段较长的回复，用户点击「打断」
- **THEN** 播报立即停止，客户端收到 `reply.interrupted`，此后不再收到该回复的 `audio`，该气泡标记“已打断”，数字人回到倾听状态

#### Scenario: 耳机模式插话
- **WHEN** 开启耳机模式，AI 播报期间用户开口说话
- **THEN** 客户端自动发送 `interrupt`，AI 停止说话，并在用户说完后回应新的语句

#### Scenario: 咳嗽不打断
- **WHEN** 开启耳机模式，AI 播报期间用户咳嗽一声，产生内容为"嗯"的 partial
- **THEN** 客户端不发送打断，AI 继续说话

### Requirement: 响应速度档位
级联引擎（含 CHAT 的级联引擎）SHALL 支持 `latencyMode`：

| 参数 | `balanced`（缺省） | `fast` |
|---|---|---|
| 候选静音（VAD） | 500 ms | 300 ms |
| 未说完时的续说等待（同传 / 对话） | 700 ms / 1500 ms | 400 ms / 1000 ms |
| 首段合成的最小长度 | 8 字 | 4 字 |
| 识别中间结果的间隔 | 700 ms | 500 ms |

各档参数 SHALL 可通过服务端配置调整。S2S 与实时语音模型引擎忽略该选项。同传向导 SHALL 在高级设置中提供「均衡 / 极速」分段控件，并说明“极速档停顿较多时可能把一句话切成两句”。

#### Scenario: 极速档断句
- **WHEN** 用户以 latencyMode=fast 开始级联同传收听，说完一句后停顿 350 ms
- **THEN** 该句已到达候选句末并开始识别；判为说完时立即定稿

#### Scenario: 均衡档断句
- **WHEN** 用户以缺省档位说完一句后停顿 350 ms 又继续说
- **THEN** 前后两部分被识别为同一句

### Requirement: 实时语音对话引擎
系统 SHALL 提供 AI 对话专用引擎 `realtime-chat`：
- 使用 `REALTIME_CHAT` 能力的模型配置，通过端到端实时语音模型直接理解用户语音并以语音回复，不经过平台 ASR 与 TTS；
- 提供方支持 DASHSCOPE（百炼 Omni Realtime，经过真实联调）与 OPENAI_COMPATIBLE（Realtime 协议，标注为实验）。

该引擎 MUST 遵守 AI 对话模式的以下约定：
- 场景身份、开场白，以及与级联引擎相同的对话提示词（回复长度、按需示范、对话记忆与追问）；
- 事件角色与发言人；
- 母语字幕：在每条回复的文本定稿后逐句并行翻译；
- 打断：客户端 `interrupt` 与耳机模式下的插话 MUST 取消上游当前回复并下发 `reply.interrupted`；
- 12 轮上下文与对话记忆：会话进行中依赖上游自身的上下文；对话记忆的压缩使用平台默认的对话模型，没有可用模型时不压缩，只保留最近 24 轮；
- 落库规则。

上游断句：
- DASHSCOPE 缺省使用 `server_vad`，`silence_duration_ms` 取配置值（缺省 800 ms）；模型名以 `qwen3.5-omni` 开头时使用 `semantic_vad`。
- OPENAI_COMPATIBLE 使用 `semantic_vad`，`eagerness` 取配置值（缺省 `low`）。
- 管理员可在模型配置 `extra.turnDetection` 中用 `server` 或 `semantic` 覆盖自动选择。

音频与指标：
- 回复语音以 `pcm16`、24 kHz 下发；
- `metrics` 的 e2eMs 定义为用户说话结束到首个回复音频。

上游异常：
- 上游连接意外断开时，系统 MUST 下发 `error{code:"C0174", fatal:false}`，并尝试用对话记忆和最近的对话文本重建一次上游会话；
- 重建失败时下发致命错误，前端提示切换到平台级联。

该引擎不支持术语库、回复模型选择、响应速度档位与回复让位。

#### Scenario: 实时语音对话一轮
- **WHEN** 用户以 engine=realtime-chat、languages=[zh, en] 开始 AI 对话，并用中文说一句话
- **THEN** 客户端收到该句的用户转写、一条 role=assistant 的英文回复（流式文本与 pcm16 语音）、中文字幕和含 e2eMs 的 metrics

#### Scenario: 百炼断句静音
- **WHEN** 以 DASHSCOPE 的 qwen3-omni-flash-realtime 模型开始实时语音对话
- **THEN** 发给上游的 session.update 中 `turn_detection` 为 `server_vad`，`silence_duration_ms` 为 800

#### Scenario: 实时语音对话打断
- **WHEN** AI 正在以实时语音模型回复，用户点击「打断」
- **THEN** 上游回复被取消，客户端收到 `reply.interrupted`，此后不再收到该回复的 `audio`

#### Scenario: 上游断开后恢复
- **WHEN** 实时语音模型的上游连接意外断开
- **THEN** 客户端收到 `error{code:"C0174", fatal:false}`，系统重建上游会话后对话可以继续，此前的对话上下文仍然有效

#### Scenario: 向导中的引擎选择
- **WHEN** 用户在同传向导中选择 AI 对话
- **THEN** 设置步骤显示「平台级联」与「实时语音模型」两张引擎卡片；实时语音模型不可用时置灰并显示原因。选中实时语音模型后，高级设置中的回复模型、术语库与响应速度置灰，并提示“实时语音模型不支持”

## ADDED Requirements

### Requirement: AI 对话回复让位
级联 CHAT 中，AI 回复尚未在客户端开始播放（包括被择机推迟）时，客户端收到本人新的有效 `transcript.partial`（有效的定义同「AI 对话打断」），SHALL 执行让位：
- 客户端丢弃该回复已排队的音频，在本地隐藏该回复，并发送 `{type:"interrupt", yield:true}`。
- 服务端 MUST：
  - 取消该回复的生成、字幕与合成，并下发 `transcript.discard{utteranceId, role:"assistant"}`；
  - 不把该回复写入对话记忆与同传记录；已写入的 MUST 撤销。
- 用户随后定稿的新语句与之前那句用户语句相邻，SHALL 作为同一轮一并回应。
- 续说被丢弃（只有语气词或噪声），或让位后 3 秒内没有新的用户语句定稿时，服务端 MUST 为之前那句用户语句重新生成回复。

已经开始播放的回复不做让位，按「AI 对话打断」处理。

#### Scenario: AI 抢答后用户接着说
- **WHEN** 用户说"我想订一张"后停顿，该句被定稿，AI 回复尚未开始播放；用户接着说"明天去上海的高铁票"
- **THEN** AI 的第一条回复从对话流中淡出并被撤回；AI 随后只回复一次，内容针对"订一张明天去上海的高铁票"；历史记录中没有被撤回的回复

#### Scenario: 让位后只是咳嗽
- **WHEN** 让位由一段有效 partial 触发，但该段最终被判为噪声而丢弃
- **THEN** 服务端为之前那句用户语句重新生成回复，AI 正常开口

### Requirement: 实时字幕渲染
同传进行中的各视图（收听、对话、会议室、AI 对话）SHALL 遵守以下渲染规则：
- **不渲染空白语句**：没有可显示文字（原文与该视图语言的译文都为空）的语句 MUST NOT 渲染为气泡或字幕行；收听舞台的原文行 MUST NOT 只显示光标。
- **正在听指示**：本机已开口但还没有可显示的文字时，消息流底部 SHALL 显示"正在听…"指示；会议室中其他成员说话时显示"某某正在说话…"。
- **光标与续说**：
  - 光标 MUST 只出现在当前进行中的语句上（未定稿、未处于续说等待、且为该视图最后一条进行中语句）；
  - 处于续说等待（hold）的语句显示呼吸点；
  - AI 对话的数字人状态说明显示"等你说完…"。
- **撤回**：收到 `transcript.discard` 时，对应语句 SHALL 以退出动画移除。
- **过期收尾**（兜底）：同一发言流中序号更大的用户语句定稿时，更早的未定稿用户语句处理如下：
  - 没有译文的 MUST 移除；
  - 有译文的视为已定稿，不再显示光标。
- **顺序**：新语句 SHALL 按发言流序号插入，同一发言流中序号小的排在前面；utteranceId 无法解析时按到达顺序。
- **稳定显示**：partial 更新时，与上一次文本的公共前缀正常显示，变化的尾部以浅色淡入，整句 MUST NOT 闪烁重排。
- **跟随滚动**：用户位于底部附近时自动跟随（流式增长不使用平滑滚动）；用户上翻后 MUST NOT 被抢回底部，并显示"新消息"胶囊，点击后回到底部。
- **分组**：会议室中同一发言人在 60 秒内的连续消息，以及 AI 对话中用户侧的连续气泡，SHALL 分组显示，后续条不重复头像与名字。
- **批量归并**：客户端 SHALL 按动画帧合并下行文本事件后批量归并，消息行只在自身数据变化时重渲染。
- 动效 MUST 尊重 `prefers-reduced-motion`。

#### Scenario: 噪声不留空白气泡
- **WHEN** 会议室成员咳嗽一声，服务端为其发出 partial 后又发出 `transcript.discard`
- **THEN** 所有成员的消息流中不残留任何空白气泡或光标

#### Scenario: 开口但未出字
- **WHEN** 用户在 AI 对话中刚开口，服务端尚未返回任何 partial
- **THEN** 对话流底部显示"正在听…"指示，而不是空白的用户气泡

#### Scenario: 用户转写晚到
- **WHEN** 实时语音对话中，用户语句（序号 5）的转写晚于其触发的 AI 回复（序号 6）的首个事件到达
- **THEN** 用户气泡显示在 AI 回复气泡之前

#### Scenario: 上翻历史不被打断
- **WHEN** 会议室进行中，用户向上滚动查看历史，此时有新消息到达
- **THEN** 滚动位置保持不变，底部出现"新消息"胶囊；点击后平滑滚动到底部

#### Scenario: 续说等待的显示
- **WHEN** 级联同传中一句话进入续说等待
- **THEN** 该句气泡末尾的光标变为呼吸点；用户继续说话后，文字在同一气泡内继续增长
