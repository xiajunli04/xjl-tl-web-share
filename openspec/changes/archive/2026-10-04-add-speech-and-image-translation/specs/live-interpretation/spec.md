## ADDED Requirements

### Requirement: 同传会话与模式
系统 SHALL 允许已登录用户创建同传会话，模式为以下三种之一：`LISTEN`（同传收听：多语种语音持续翻译为一种目标语言）、`CONVERSE`（双向对话：两种语言互译）、`ROOM`（多语会议室：多人各用自己的语言）。创建时 MUST 指定引擎和语言：LISTEN 指定目标语言（可选源语种提示），CONVERSE 指定两种不同的语言 A、B，ROOM 指定创建者自己的语言。可选参数包括术语库、领域提示、音色、是否语音播报、耳机模式。创建成功返回会话 id 和一次性 WebSocket 票据。每个用户同一时刻 MUST 最多只有一个进行中的同传会话。

#### Scenario: 创建收听会话
- **WHEN** 用户以 mode=LISTEN、engine=cascade、targetLang=zh 创建同传会话
- **THEN** 返回 sessionId 与 wsTicket，会话状态为 ACTIVE

#### Scenario: 对话语言相同
- **WHEN** 用户以 mode=CONVERSE、languages=[en, en] 创建会话
- **THEN** 系统返回 HTTP 400、code `A0410`

#### Scenario: 已有进行中的会话
- **WHEN** 用户已有一个 ACTIVE 的同传会话时再次创建
- **THEN** 系统返回 HTTP 409、code `A0214`

#### Scenario: 引擎不可用
- **WHEN** 用户选择 engine=openai-realtime，但系统中没有启用的、provider 为 OPENAI_COMPATIBLE 的 REALTIME_TRANSLATE 配置
- **THEN** 系统返回 HTTP 503、code `C0173`

### Requirement: 同传引擎
系统 SHALL 提供以下同传引擎，并统一映射到平台事件协议：
- `cascade`：平台级联，即 VAD 切句 → 语音识别 → 平台翻译（注入术语与本发言流最近 3 句的上下文、关闭评审）→ 语音合成；
- `qwen-livetranslate`：百炼 `qwen3.8-livetranslate-flash-realtime`（兼容 3.5），session 中 MUST 显式指定音色；
- 可选：`doubao-ast`（豆包同声传译 2.0）、`gemini-live-translate`（Gemini 3.5 Live Translate）、`openai-realtime`（OpenAI `gpt-realtime-translate`）。可选引擎未实现或未配置时，MUST 在引擎列表中显示为不可用，不影响其他引擎。

S2S 引擎 MUST 为每个目标语言建立一个上游会话，并在千问引擎中把命中的术语写入热词。级联引擎 MUST 对一句话只识别一次，各目标语言并行翻译与合成。各引擎可用的语言范围 MUST 来自引擎列表接口，前端只允许选择所选引擎支持的语言。

#### Scenario: 级联注入术语
- **WHEN** 用户选择含 "大模型 → LLM" 的术语库，以级联引擎同传收听（目标 en），并说出包含"大模型"的句子
- **THEN** 该句的 `translation.final` 译文包含 "LLM"

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
浏览器 SHALL 通过 `wss://{api}/ws/interpret?ticket=` 连接 Spring。票据有效期 60 秒，只能使用一次。握手 MUST 校验票据与 Origin，失败时拒绝握手。

连接建立后：
- 浏览器上行二进制帧为 PCM16LE、16 kHz、单声道音频，以及 JSON 控制帧（`ptt`、`flush`、`mute`、`end`、`ping`）；
- Spring 为每条发言流向 Python `/internal/interpret/stream` 建立内部 WebSocket（携带 `X-Internal-Token`），首帧发送 config，然后转发音频；
- 下行事件为 JSON：`ready`、`participants`、`transcript.partial`、`transcript.final`、`translation.delta`、`translation.final`、`audio`、`metrics`、`error`、`ended`，字段见设计 D7。`audio` 的 format 为 `pcm16` 或 `mp3`，数据为 base64。

#### Scenario: 票据重复使用
- **WHEN** 客户端用已经使用过的票据再次连接
- **THEN** 握手被拒绝（HTTP 401，code `A0453`）

#### Scenario: 一句话的事件顺序
- **WHEN** 用户在级联引擎下说完一句话
- **THEN** 客户端依次收到同一 utteranceId 的若干 `transcript.partial`、一个 `transcript.final`、若干 `translation.delta`、一个 `translation.final`、若干 `audio`（最后一个 last=true）和一个 `metrics`

#### Scenario: 上游中断
- **WHEN** Python 与 S2S 上游的连接意外断开
- **THEN** 客户端收到 `error{code:"C0174", fatal:false}`，系统尝试重建一次上游会话，已完成的转写不丢失

### Requirement: 语音播报与回声规避
开启语音播报时，客户端 SHALL 按 utteranceId 顺序排队播放 `audio` 事件；服务端 TTS 失败时，客户端 SHALL 改用浏览器朗读该句译文。单设备模式（LISTEN、CONVERSE）未开启耳机模式时，客户端 MUST 在播报期间暂停上行音频，并在播报结束 300 ms 后恢复。采集 MUST 开启回声消除、降噪和自动增益。

#### Scenario: 半双工
- **WHEN** 双向对话中译文正在播报，且未开启耳机模式
- **THEN** 播报期间不上行音频帧，界面显示"播报中，暂停收音"

#### Scenario: TTS 降级
- **WHEN** edge-tts 返回 403
- **THEN** 客户端收到 `error{code:"C0172", fatal:false}`，该句 `translation.final` 带 `ttsFallback=true`，客户端用浏览器朗读该句，同传继续

### Requirement: 双向对话路由
CONVERSE 模式 SHALL 支持两种路由方式：
- **自动**：根据识别出的语种发往另一种语言，仅级联引擎支持；
- **按键说话**：客户端发送 `{type:"ptt", side:"A"|"B"}`，按住期间的音频固定以该侧语言为源、另一侧语言为目标。

使用 S2S 引擎时，系统 MUST 只允许按键说话。

#### Scenario: 自动切换方向
- **WHEN** 语言为 zh/en 的级联自动对话中先后说了一句中文和一句英文
- **THEN** 第一句的译文语言为 en，第二句的译文语言为 zh

#### Scenario: S2S 禁用自动
- **WHEN** 用户以 qwen-livetranslate 引擎进入双向对话
- **THEN** 「自动」开关不可用并提示"该引擎仅支持按键说话"

### Requirement: 多语会议室
ROOM 会话 SHALL 生成 6 位房间码。其他已登录用户可以通过 `POST /api/interpret/rooms/{code}/join`（提交显示名与语言）获取票据加入。

房间规则：
- 房间最多 8 人；不同语言数上限为级联 6 种、S2S 4 种，超出时返回 `A0451`。
- 每个参与者的麦克风是一条发言流，目标为其他参与者语言的集合；成员进出时目标集合 MUST 随之更新。
- 字幕与译文事件 SHALL 广播给全体成员；`audio` 事件 MUST 只发给语言匹配且开启播报的成员。
- 主持人结束或离开时，房间关闭，成员收到 `ended{reason:"host_left"}`。成员断线 30 秒内重新加入可恢复身份。

#### Scenario: 三人三语
- **WHEN** 主持人（zh）创建房间，成员甲（en）和乙（ja）加入，主持人说一句中文
- **THEN** 甲收到该句的 en 译文和 en 语音，乙收到 ja 译文和 ja 语音，三人都看到原文

#### Scenario: 房间不存在
- **WHEN** 用户用一个不存在或已关闭的房间码加入
- **THEN** 系统返回 HTTP 404、code `A0452`

#### Scenario: 房间已满
- **WHEN** 第 9 个用户尝试加入
- **THEN** 系统返回 HTTP 409、code `A0451`

### Requirement: 逐句延迟指标
系统 SHALL 为每句话发出 `metrics` 事件，包含 asrMs、mtFirstMs、mtMs、ttsFirstMs 和 e2eMs。e2eMs 定义为从说话结束（VAD 判定句末，或 S2S 输入转写的最后一次增量）到首段译音；未开启播报时，终点为译文定稿。进行中界面 SHALL 显示最近一句的 e2e 延迟；会话结束时 SHALL 汇总平均延迟。

#### Scenario: 显示延迟
- **WHEN** 一句话的 metrics.e2eMs=2400
- **THEN** 控制条的延迟胶囊显示 "2.4 s"

### Requirement: 同传记录持久化
系统 SHALL 把每句话的发言人、源语种、原文、各语种译文、指标和时间偏移合并保存为一条转写段，写入时机为所有目标译文定稿或 5 秒超时。会话结束（用户结束、主持人离开或连接全部断开 60 秒）时 SHALL 写入结束时间、时长和统计，状态改为 ENDED。只有会话创建者可以在历史中查看、收藏、删除该会话。

#### Scenario: 结束后可在历史查看
- **WHEN** 用户结束一次包含 12 句话的同传收听
- **THEN** 历史的「同传」标签出现该会话，详情按时间顺序显示 12 句双语转写

#### Scenario: 隔离他人记录
- **WHEN** 用户 A 请求用户 B 的同传会话详情
- **THEN** 系统返回 HTTP 404、code `A0404`

### Requirement: 同传页面
系统 SHALL 提供 `/interpret` 页面。

准备阶段为卡片向导：
- 先选择模式卡片；
- 再设置语言与引擎（引擎带「本地免密钥/需配置」徽章，不可用项置灰并说明原因）；
- 高级选项放在可折叠分区中。

进行中阶段按模式切换布局：
- 收听：舞台式大字幕加历史字幕；
- 对话：上下面对面两半区，上半区可旋转 180°，每侧有按键说话按钮；
- 会议室：成员条、统一消息流、房间码复制。

页面 SHALL 显示随电平变化的麦克风光球、状态胶囊（聆听/识别/翻译/播报）和延迟。麦克风权限被拒绝时 SHALL 显示引导卡片。结束时弹出摘要对话框。动效 MUST 尊重 `prefers-reduced-motion`。

#### Scenario: 麦克风被拒绝
- **WHEN** 用户点击开始后拒绝麦克风权限
- **THEN** 页面显示引导卡片，说明如何在浏览器中开启麦克风，并提供重试按钮

#### Scenario: 面对面翻转
- **WHEN** 用户在双向对话中点击上半区的旋转按钮
- **THEN** 上半区以 180° 旋转动画翻转，reduced-motion 下直接切换
