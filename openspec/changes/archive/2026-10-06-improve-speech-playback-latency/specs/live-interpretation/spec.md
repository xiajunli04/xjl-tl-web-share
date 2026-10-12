## MODIFIED Requirements

### Requirement: 同传会话与模式
系统 SHALL 允许已登录用户创建同传会话，模式为以下四种之一：
- `LISTEN`（同传收听）：多语种语音持续翻译为一种目标语言；
- `CONVERSE`（双向对话）：两种语言互译；
- `ROOM`（多语会议室）：多人各用自己的语言；
- `CHAT`（AI 对话）：用户与 AI 伙伴语音对话。

创建时 MUST 指定引擎和语言：
- LISTEN 指定目标语言，可选源语种提示；
- CONVERSE 指定两种不同的语言 A、B；
- ROOM 指定创建者自己的语言；
- CHAT 指定 `[我的语言, 对话语言]`（两者可以相同），以及可选场景 `chatScenario`（`free | travel | restaurant | business | interview`，缺省 `free`）。CHAT 只允许 `cascade`（平台级联）与 `realtime-chat`（实时语音模型）两种引擎。

可选参数包括：术语库、领域提示、音色、是否语音播报、耳机模式、响应速度 `latencyMode`（`balanced | fast`，缺省 `balanced`，只对级联引擎生效）。创建成功返回会话 id 和一次性 WebSocket 票据。每个用户同一时刻 MUST 最多只有一个进行中的同传会话。

#### Scenario: 创建收听会话
- **WHEN** 用户以 mode=LISTEN、engine=cascade、targetLang=zh 创建同传会话
- **THEN** 返回 sessionId 与 wsTicket，会话状态为 ACTIVE

#### Scenario: 对话语言相同
- **WHEN** 用户以 mode=CONVERSE、languages=[en, en] 创建会话
- **THEN** 系统返回 HTTP 400、code `A0410`

#### Scenario: 创建 AI 对话
- **WHEN** 用户以 mode=CHAT、engine=cascade、languages=[zh, en]、chatScenario=travel 创建会话
- **THEN** 返回 sessionId 与 wsTicket，会话 options 中记录 chatScenario=travel

#### Scenario: AI 对话使用实时语音模型
- **WHEN** 系统已启用 REALTIME_CHAT 配置，用户以 mode=CHAT、engine=realtime-chat、languages=[zh, en] 创建会话
- **THEN** 返回 sessionId 与 wsTicket，会话 engine 为 realtime-chat

#### Scenario: AI 对话使用翻译类 S2S 引擎
- **WHEN** 用户以 mode=CHAT、engine=qwen-livetranslate 创建会话
- **THEN** 系统返回 HTTP 400、code `A0410`，提示“AI 对话仅支持平台级联或实时语音模型”

#### Scenario: 实时语音模型用于非 CHAT 模式
- **WHEN** 用户以 mode=LISTEN、engine=realtime-chat 创建会话
- **THEN** 系统返回 HTTP 400、code `A0410`

#### Scenario: 非法响应速度
- **WHEN** 用户以 latencyMode=turbo 创建会话
- **THEN** 系统返回 HTTP 400、code `A0410`

#### Scenario: 非法场景
- **WHEN** 用户以 mode=CHAT、chatScenario=karaoke 创建会话
- **THEN** 系统返回 HTTP 400、code `A0410`

#### Scenario: 已有进行中的会话
- **WHEN** 用户已有一个 ACTIVE 的同传会话时再次创建
- **THEN** 系统返回 HTTP 409、code `A0214`，data 为该进行中会话（供前端提供继续或结束）

#### Scenario: 查询进行中的会话
- **WHEN** 用户请求 `GET /api/interpret/sessions/active`
- **THEN** 返回其进行中的会话，没有时 data 为 null；库中残留但内存中已无房间的会话被就地结束并返回 null

#### Scenario: 引擎不可用
- **WHEN** 用户选择 engine=openai-realtime，但系统中没有启用的、provider 为 OPENAI_COMPATIBLE 的 REALTIME_TRANSLATE 配置
- **THEN** 系统返回 HTTP 503、code `C0173`

#### Scenario: 实时语音模型未配置
- **WHEN** 系统中没有启用的 REALTIME_CHAT 配置，用户以 mode=CHAT、engine=realtime-chat 创建会话
- **THEN** 系统返回 HTTP 503、code `C0173`

### Requirement: 语音播报与回声规避
开启语音播报时，客户端 SHALL 按 utteranceId 顺序排队播放 `audio` 事件，并 MUST 边收边播：
- `pcm16` 收到分包即写入播放缓冲；
- `mp3` 在浏览器支持 MediaSource（`audio/mpeg`）时，把分包渐进追加到媒体缓冲播放；不支持时，按 `segLast` 以段为单位解码播放。
- 任何格式下，客户端 MUST NOT 等整条 track 结束（`last=true`）才开始播放。

服务端 TTS 失败时，客户端 SHALL 改用浏览器朗读该句译文。单设备模式（LISTEN、CONVERSE）未开启耳机模式时，客户端 MUST 在播报期间暂停上行音频，并在播报结束 300 ms 后恢复。采集 MUST 开启回声消除、降噪和自动增益。

#### Scenario: 半双工
- **WHEN** 双向对话中译文正在播报，且未开启耳机模式
- **THEN** 播报期间不上行音频帧，界面显示"播报中，暂停收音"

#### Scenario: TTS 降级
- **WHEN** edge-tts 返回 403，该句尚未发出任何音频
- **THEN** 客户端收到 `error{code:"C0172", fatal:false}` 和该句带 `ttsFallback=true` 的 `translation.final`（若此前已发出不带降级标记的定稿，则补发一次同文定稿），客户端用浏览器朗读该句，同传继续

#### Scenario: MP3 首段即播
- **WHEN** 级联引擎使用 edge-tts，一句译文被切成 2 段合成
- **THEN** 客户端在第 1 段的音频到达后即开始播放，不等第 2 段合成完成

#### Scenario: 不支持 MediaSource 的降级
- **WHEN** 浏览器不支持 `audio/mpeg` 的 MediaSource
- **THEN** 客户端在每段的 segLast 分包到达后解码播放该段，各段按顺序衔接

### Requirement: AI 对话模式
`CHAT` 模式 SHALL 让用户用语音与 AI 伙伴（Lumi）实时对话，规则如下：
- 会话开始后，AI MUST 先按场景说一句开场白。
- 用户每说完一句，系统 SHALL 生成一条 AI 回复，回复使用对话语言（aiLang），口语化，长度为 1–3 句。
- AI 回复的事件 MUST 带 `role:"assistant"`，发言人为 `{participantId:"ai", displayName:"Lumi", lang:aiLang}`，事件包括：
  - 流式的 `transcript.partial`（累计文本）；
  - `transcript.final`；
  - myLang 与 aiLang 不同时，发母语字幕 `translation.delta/final`（lang=myLang）；
  - 回复语音 `audio`（lang=aiLang）；
  - `metrics`。
- 级联引擎下，回复 MUST 逐句成段：
  - 每生成完一句即开始合成该句，作为一个音频段下发；
  - 后句的合成与前句的播放并行；
  - 母语字幕逐句并行翻译，`translation.delta` 下发累计字幕；
  - 语音与字幕 MUST NOT 等待整条回复生成完成。
- 用户自己的语句只发转写事件与只含 asrMs 的 `metrics`，不发译文。

系统 SHALL 在会话内保留最近 12 轮对话作为上下文。场景提示词 MUST 决定 AI 扮演的身份：`free` 为聊天伙伴，`travel` 为当地人，`restaurant` 为服务员，`business` 为合作方，`interview` 为面试官。AI 回复与用户语句 SHALL 按现有同传记录规则落库，并能在历史中按发言人回看。

#### Scenario: AI 先开口
- **WHEN** 用户以 mode=CHAT、languages=[zh, en]、chatScenario=restaurant 开始对话
- **THEN** 连接就绪后，客户端收到一条 role=assistant 的英文开场白（以服务员身份）、其中文字幕和英文语音

#### Scenario: 一轮对话
- **WHEN** 用户说“我想要一份不辣的菜”
- **THEN** 客户端先收到该句的 `transcript.final`（role 缺省，lang=zh），随后收到一条新 utteranceId 的 role=assistant 英文回复、中文字幕和英文语音

#### Scenario: 多句回复逐句开口
- **WHEN** 级联引擎下 AI 回复包含 3 句
- **THEN** 第 1 句的音频段（seg=0）在第 3 句生成完成之前就已下发，客户端随即开始播放

#### Scenario: 字幕不阻塞语音
- **WHEN** 级联引擎下母语字幕翻译较慢
- **THEN** 回复语音照常开始播放，字幕逐句补齐，最终 `translation.final` 为各句字幕按顺序拼接

#### Scenario: 历史回看
- **WHEN** 用户结束一次包含 3 轮问答的 AI 对话，并在历史中打开该会话
- **THEN** 详情按时间顺序显示 1 句开场白和 6 句对话，其中 AI 句的发言人为 Lumi，并附中文字幕

## ADDED Requirements

### Requirement: 音频分段与即时下发
`audio` 事件 SHALL 在原有字段之外携带：
- `seg`：同一 utteranceId 与 lang 下从 0 递增的段号；
- `segLast`：是否为本段最后一包。

每个段对应一次独立的语音合成；`mp3` 格式下每段都 MUST 能够独立解码。

下发规则：
- 服务端 MUST 在音频分包产生后立即下发，MUST NOT 为了标记结束而扣住任何分包；
- 每条 track 的首包 MUST 不做合并；
- 段的最后一包标记 `segLast=true`；合成方结束时缓冲已空的情况下，该包 data 可以为空；
- track 结束且已发出过音频时，服务端 SHALL 发出一个 `last=true` 的终止包，其 data 为空；被打断的 track 不发终止包。

客户端 MUST 忽略空 data 的音频内容，只用它来结束对应的段或 track。

#### Scenario: 首包不等待
- **WHEN** TTS 为某段产出第一个分包，而第二个分包尚未产出
- **THEN** 该首包已下发给客户端

#### Scenario: 空终止包
- **WHEN** 一句译文的最后一段合成完成
- **THEN** 客户端收到该段 segLast=true 的分包，随后收到一个 data 为空、last=true 的终止包

### Requirement: 级联低延迟流水线
级联引擎 SHALL 把译文以流水线方式送去合成：
- 翻译流式输出时，按句末标点及逗号、顿号等分句边界增量切段；
- 首段达到最小长度即送去合成；后续段至少 12 个字（拉丁语按词折算）。

流水线规则：
- 合成 MUST 最多 2 段并发，并按段号顺序下发；
- `translation.final` MUST 在译文生成完成时立即发出，不等待语音合成；
- 同一引擎实例访问 OpenAI 兼容的 ASR 与 TTS 时 MUST 复用连接；
- 系统 SHALL 用全局并发上限（缺省 4）约束同时进行的 edge-tts 合成数。

`metrics` 的口径不变：ttsFirstMs 为首段首包，e2eMs 为说话结束到首段译音。

#### Scenario: 长句提前开口
- **WHEN** 用户说了一句较长的中文，英文译文包含两个分句
- **THEN** 第一个分句的语音在第二个分句翻译完成之前开始下发

#### Scenario: 译文定稿不等合成
- **WHEN** 译文生成完成，但 TTS 首包尚未产出
- **THEN** 客户端已收到该句的 `translation.final`

#### Scenario: 合成顺序
- **WHEN** 第 2 段比第 1 段先合成完成
- **THEN** 客户端仍然先收到第 1 段的音频，再收到第 2 段

### Requirement: 响应速度档位
级联引擎（含 CHAT 的级联引擎）SHALL 支持 `latencyMode`：

| 参数 | `balanced`（缺省） | `fast` |
|---|---|---|
| VAD 断句静音 | 500 ms | 300 ms |
| 首段合成的最小长度 | 8 字 | 4 字 |
| 识别中间结果的间隔 | 700 ms | 500 ms |

各档参数 SHALL 可通过服务端配置调整。S2S 与实时语音模型引擎忽略该选项。同传向导 SHALL 在高级设置中提供「均衡 / 极速」分段控件，并说明“极速档停顿较多时可能把一句话切成两句”。

#### Scenario: 极速档断句
- **WHEN** 用户以 latencyMode=fast 开始级联同传收听，说完一句后停顿 350 ms
- **THEN** 该句已被判定为结束并开始识别

#### Scenario: 均衡档断句
- **WHEN** 用户以缺省档位说完一句后停顿 350 ms 又继续说
- **THEN** 前后两部分被识别为同一句

### Requirement: 实时语音对话引擎
系统 SHALL 提供 AI 对话专用引擎 `realtime-chat`：
- 使用 `REALTIME_CHAT` 能力的模型配置，通过端到端实时语音模型直接理解用户语音并以语音回复，不经过平台 ASR 与 TTS；
- 提供方支持 DASHSCOPE（百炼 Omni Realtime，经过真实联调）与 OPENAI_COMPATIBLE（Realtime 协议，标注为实验）。

该引擎 MUST 遵守 AI 对话模式的以下约定：
- 场景身份与开场白；
- 事件角色与发言人；
- 母语字幕：在每条回复的文本定稿后逐句并行翻译；
- 打断：客户端 `interrupt` 与耳机模式下的插话 MUST 取消上游当前回复并下发 `reply.interrupted`；
- 12 轮上下文；
- 落库规则。

音频与指标：
- 回复语音以 `pcm16`、24 kHz 下发；
- `metrics` 的 e2eMs 定义为用户说话结束到首个回复音频。

上游异常：
- 上游连接意外断开时，系统 MUST 下发 `error{code:"C0174", fatal:false}`，并尝试用最近的对话文本重建一次上游会话；
- 重建失败时下发致命错误，前端提示切换到平台级联。

该引擎不支持术语库、回复模型选择与响应速度档位。

#### Scenario: 实时语音对话一轮
- **WHEN** 用户以 engine=realtime-chat、languages=[zh, en] 开始 AI 对话，并用中文说一句话
- **THEN** 客户端收到该句的用户转写、一条 role=assistant 的英文回复（流式文本与 pcm16 语音）、中文字幕和含 e2eMs 的 metrics

#### Scenario: 实时语音对话打断
- **WHEN** AI 正在以实时语音模型回复，用户点击「打断」
- **THEN** 上游回复被取消，客户端收到 `reply.interrupted`，此后不再收到该回复的 `audio`

#### Scenario: 上游断开后恢复
- **WHEN** 实时语音模型的上游连接意外断开
- **THEN** 客户端收到 `error{code:"C0174", fatal:false}`，系统重建上游会话后对话可以继续，此前的对话上下文仍然有效

#### Scenario: 向导中的引擎选择
- **WHEN** 用户在同传向导中选择 AI 对话
- **THEN** 设置步骤显示「平台级联」与「实时语音模型」两张引擎卡片；实时语音模型不可用时置灰并显示原因。选中实时语音模型后，高级设置中的回复模型、术语库与响应速度置灰，并提示“实时语音模型不支持”

### Requirement: 字幕重播
同传进行中，AI 对话的 AI 气泡、双向对话的译文气泡和收听模式的历史字幕行 SHALL 提供“重播”按钮，用流式朗读接口以该句语言朗读该句文本。重播与实时播报 MUST 互斥：
- 重播时暂停实时播报队列，重播结束后继续；
- 半双工规则同样适用于重播。

#### Scenario: 重播 AI 回复
- **WHEN** AI 对话中用户点击上一条 AI 气泡的重播按钮
- **THEN** 该气泡显示播报中的声波，并以对话语言朗读该条回复；播放结束后声波消失

#### Scenario: 重播期间到达新译音
- **WHEN** 收听模式中用户正在重播一条历史字幕，此时一句新的译音到达
- **THEN** 新译音进入队列，在重播结束后播放
