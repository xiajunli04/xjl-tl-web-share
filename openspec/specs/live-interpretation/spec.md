# live-interpretation Specification

## Purpose
TBD - created by archiving change add-speech-and-image-translation. Update Purpose after archive.
## Requirements
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

### Requirement: 同传引擎
系统 SHALL 提供以下同传引擎，并统一映射到平台事件协议：
- `cascade`：平台级联，即 VAD 切句 → 语音识别 → 平台翻译（使用同声传译专用提示词，注入术语与本发言流最近 6 句的上下文，关闭评审）→ 语音合成；
- `qwen-livetranslate`：百炼 `qwen3.8-livetranslate-flash-realtime`（兼容 3.5），session 中 MUST 显式指定音色；
- 可选：`doubao-ast`（豆包同声传译 2.0）、`gemini-live-translate`（Gemini 3.5 Live Translate）、`openai-realtime`（OpenAI `gpt-realtime-translate`）。可选引擎未实现或未配置时，MUST 在引擎列表中显示为不可用，不影响其他引擎。

级联引擎的上下文 MUST 按发言流统一维护，不再按目标语言分桶：
- 窗口为最近 6 句（可配置），总长超过 1500 字符（可配置）时从最早的一句开始丢弃；
- 双向对话 MUST 同时包含双方的语句；
- 每句给出原话及其语言；已有当前目标语言的译文、且原话不是目标语言时，一并给出该译文；
- 一句话在 `transcript.final` 时即进入上下文，不等待其译文完成。

S2S 引擎 MUST 为每个目标语言建立一个上游会话，并在千问引擎中把命中的术语写入热词。级联引擎 MUST 对一句话只识别一次，各目标语言并行翻译与合成。各引擎可用的语言范围 MUST 来自引擎列表接口，前端只允许选择所选引擎支持的语言。

#### Scenario: 级联注入术语
- **WHEN** 用户选择含 "大模型 → LLM" 的术语库，以级联引擎同传收听（目标 en），并说出包含"大模型"的句子
- **THEN** 该句的 `translation.final` 译文包含 "LLM"

#### Scenario: 双向对话的回答带上提问
- **WHEN** 双向对话（A=zh、B=en）中，A 说"你们周几能发货"，随后 B 说 "We can ship it on Friday."
- **THEN** 翻译 B 这一句（目标 zh）时，提示词的上下文中包含 A 的原话"你们周几能发货"

#### Scenario: 上下文窗口
- **WHEN** 级联同传收听已定稿 8 句，开始翻译第 9 句
- **THEN** 提示词的上下文中只包含第 3–8 句，按时间顺序排列

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
- Spring 为每条发言流向 Python `/internal/interpret/stream` 建立内部 WebSocket（携带 `X-Internal-Token`），首帧发送 config，然后转发音频与控制帧；
- 下行事件为 JSON：`ready`、`participants`、`transcript.partial`、`transcript.final`、`translation.delta`、`translation.final`、`audio`、`metrics`、`reply.interrupted`、`error`、`ended`，字段见设计 D7。
  - `audio` 的 format 为 `pcm16` 或 `mp3`，数据为 base64。
  - 带 utteranceId 的事件可以携带 `role`（`user` | `assistant`），缺省为 `user`。

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
- **THEN** 客户端依次收到同一 utteranceId 的若干 `transcript.partial`、一个 `transcript.final`、若干 `translation.delta`、一个 `translation.final`、若干 `audio`（最后一个 last=true）和一个 `metrics`

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
系统 SHALL 把每句话的发言人、源语种、原文、各语种译文、指标和时间偏移合并保存为一条转写段，写入时机为所有目标译文定稿或 15 秒超时；超时写入后才到达的译文与指标 MUST 回填到该转写段，不得丢弃。会话结束（用户结束、主持人离开或连接全部断开 60 秒）时 SHALL 写入结束时间、时长和统计，状态改为 ENDED。只有会话创建者可以在历史中查看、收藏、删除该会话。

#### Scenario: 结束后可在历史查看
- **WHEN** 用户结束一次包含 12 句话的同传收听
- **THEN** 历史的「同传」标签出现该会话，详情按时间顺序显示 12 句双语转写

#### Scenario: 隔离他人记录
- **WHEN** 用户 A 请求用户 B 的同传会话详情
- **THEN** 系统返回 HTTP 404、code `A0404`

### Requirement: 同传页面
系统 SHALL 提供 `/interpret` 页面。

准备阶段为卡片向导：
- 先选择模式卡片（收听 / 对话 / 会议室 / AI 对话）；
- 再设置语言与引擎（引擎带「本地免密钥/需配置」徽章，不可用项置灰并说明原因）。AI 对话改为设置“我的语言、对话语言、场景卡”，引擎只提供平台级联；
- 高级选项放在可折叠分区中。

进行中阶段按模式切换布局：
- 收听：舞台式大字幕加历史字幕；
- 对话：上下面对面两半区，上半区可旋转 180°，每侧有按键说话按钮。中间控制条居中显示“AI 译员”数字人（可关闭）；
- 会议室：成员条、统一消息流、房间码复制；
- AI 对话：桌面为主从两栏（左侧数字人舞台与状态说明、打断按钮，右侧对话流：AI 气泡含对话语言原文与母语字幕），移动端为上下布局。

页面 SHALL 显示随电平变化的麦克风光球（或数字人电平外环）、状态胶囊（聆听/识别/翻译/播报）和延迟。麦克风权限被拒绝时 SHALL 显示引导卡片。结束时弹出摘要对话框。动效 MUST 尊重 `prefers-reduced-motion`。

#### Scenario: 刷新页面后恢复
- **WHEN** 用户在同传进行中刷新页面（或离开后再回到同传页），会话仍在服务端进行
- **THEN** 准备页顶部显示进行中会话的恢复卡片（模式、语言、已进行时长），提供「继续同传」与「结束并重新开始」；继续后以创建者身份重连，已落库的转写回放到字幕区，计时从会话开始时间继续

#### Scenario: 创建时已有进行中的会话
- **WHEN** 用户已有进行中的会话时再次点击开始
- **THEN** 不只提示错误，而是刷新恢复卡片并以抖动提示，引导用户继续或结束旧会话

#### Scenario: 进行中离开页面提醒
- **WHEN** 同传进行中用户刷新或关闭页面
- **THEN** 浏览器先弹出离开确认

#### Scenario: 麦克风被拒绝
- **WHEN** 用户点击开始后拒绝麦克风权限
- **THEN** 页面显示引导卡片，说明如何在浏览器中开启麦克风，并提供重试按钮

#### Scenario: 面对面翻转
- **WHEN** 用户在双向对话中点击上半区的旋转按钮
- **THEN** 上半区以 180° 旋转动画翻转，reduced-motion 下直接切换

#### Scenario: 双向对话中的 AI 译员
- **WHEN** 用户开始双向对话，并且一方说了一句话
- **THEN** 中间控制条的数字人先进入倾听状态，再在译文播报时开口说话

#### Scenario: AI 对话布局
- **WHEN** 用户在桌面浏览器开始 AI 对话
- **THEN** 左侧为数字人舞台，右侧为对话流，页面不是从上到下整页平铺；AI 播报时出现「打断」按钮

### Requirement: AI 对话模式
`CHAT` 模式 SHALL 让用户用语音与 AI 伙伴（Lumi）实时对话，规则如下：
- 会话开始后，AI MUST 先按场景说一句开场白。
- 用户每说完一句，系统 SHALL 生成一条 AI 回复，回复使用对话语言（aiLang），口语化，不使用 Markdown、列表符号或表情符号。回复长度：
  - 平时为 1–3 句；
  - 用户要求解释、总结、列举、比较或回顾时，SHALL 放宽到最多 6 句，把要点说完整。
- AI 此前被打断的回复（以"…"结尾）MUST NOT 在下一条回复中重复，AI 直接回应用户的新话。
- 场景提示词 SHALL 写明该场景的身份、流程与语气（如点餐按"饮品 → 菜品 → 忌口 → 确认点单 → 结账"推进，面试每次只问一个问题）。
- 语言陪练示范（myLang 与 aiLang 不同时）SHALL 按需进行：
  - 只在用户尝试说对话语言但有明显错误，或用母语说日常短句时，在回复开头示范最多一句更地道的说法；
  - 用户提问、追问、要求解释或总结时 MUST 直接回答，不做示范；
  - 不连续两轮示范；级联引擎在上一轮已示范、或用户用母语提问时，MUST 在提示词中明确要求本轮不示范。
- AI 回复的事件 MUST 带 `role:"assistant"`，发言人为 `{participantId:"ai", displayName:"Lumi", lang:aiLang}`，事件包括：
  - 流式的 `transcript.partial`（累计文本）；
  - `transcript.final`；
  - myLang 与 aiLang 不同时，发母语字幕 `translation.delta/final`（lang=myLang）。字幕使用专门的字幕提示词：逐句翻译时 MUST 带上用户上一句和本条回复前面的句子作为上下文；回复中示范的对话语言说法 MUST 保留原文，后面用括号附上母语意思；
  - 回复语音 `audio`（lang=aiLang）；
  - `metrics`。
- 级联引擎下，回复 MUST 逐句成段：
  - 每生成完一句即开始合成该句，作为一个音频段下发；
  - 后句的合成与前句的播放并行；
  - 母语字幕逐句并行翻译，`translation.delta` 下发累计字幕；
  - 语音与字幕 MUST NOT 等待整条回复生成完成。
- 用户自己的语句只发转写事件与只含 asrMs 的 `metrics`，不发译文。

系统 SHALL 在会话内保留最近至少 12 轮对话原文作为上下文；更早的轮次 SHALL 并入对话记忆（见「AI 对话长期记忆」）。场景提示词 MUST 决定 AI 扮演的身份：`free` 为聊天伙伴（也回答用户的问题），`travel` 为当地人，`restaurant` 为服务员，`business` 为合作方，`interview` 为面试官。AI 回复与用户语句 SHALL 按现有同传记录规则落库，并能在历史中按发言人回看。

#### Scenario: AI 先开口
- **WHEN** 用户以 mode=CHAT、languages=[zh, en]、chatScenario=restaurant 开始对话
- **THEN** 连接就绪后，客户端收到一条 role=assistant 的英文开场白（以服务员身份）、其中文字幕和英文语音

#### Scenario: 一轮对话
- **WHEN** 用户说“我想要一份不辣的菜”
- **THEN** 客户端先收到该句的 `transcript.final`（role 缺省，lang=zh），随后收到一条新 utteranceId 的 role=assistant 英文回复、中文字幕和英文语音

#### Scenario: 用母语提问时直接回答
- **WHEN** languages=[zh, en]、chatScenario=free，用户用中文问“预训练和微调有什么区别”
- **THEN** AI 的英文回复直接回答这个问题，不以 "You could say" 一类的示范开头

#### Scenario: 要求总结
- **WHEN** 用户与 AI 讨论了 3 个要点后说“帮我总结一下刚才说的”
- **THEN** AI 的回复按顺序覆盖这 3 个要点，不超过 6 句，不含 Markdown 或列表符号

#### Scenario: 被打断后不重复
- **WHEN** AI 正在介绍三道菜时被用户打断，用户接着问“有没有素食”
- **THEN** AI 的下一条回复直接回答素食问题，不重新介绍被打断前的菜品

#### Scenario: 字幕保留示范句
- **WHEN** languages=[zh, en]，AI 回复 "You could say: \"I'd like a window seat.\" Sure, let me check."
- **THEN** 中文字幕保留 "I'd like a window seat." 原文，并在括号中附上中文意思

#### Scenario: 多句回复逐句开口
- **WHEN** 级联引擎下 AI 回复包含 3 句
- **THEN** 第 1 句的音频段（seg=0）在第 3 句生成完成之前就已下发，客户端随即开始播放

#### Scenario: 字幕不阻塞语音
- **WHEN** 级联引擎下母语字幕翻译较慢
- **THEN** 回复语音照常开始播放，字幕逐句补齐，最终 `translation.final` 为各句字幕按顺序拼接

#### Scenario: 历史回看
- **WHEN** 用户结束一次包含 3 轮问答的 AI 对话，并在历史中打开该会话
- **THEN** 详情按时间顺序显示 1 句开场白和 6 句对话，其中 AI 句的发言人为 Lumi，并附中文字幕

### Requirement: AI 对话打断
在 CHAT 模式下，客户端 SHALL 可以发送控制帧 `{type:"interrupt"}` 打断 AI 当前的回复。收到后，系统 MUST 立即取消该回复尚未完成的生成、字幕翻译与语音合成，并下发 `reply.interrupted{utteranceId, text}`，其中 text 为已生成的文本。被打断的回复 SHALL 以已生成的部分写入对话上下文与记录。客户端 MUST 在发出打断后立即停止本地播放。开启耳机模式时，AI 播报期间检测到用户开始说话（收到新的用户 `transcript.partial`），客户端 SHALL 自动发送打断。

#### Scenario: 点击打断
- **WHEN** AI 正在朗读一段较长的回复，用户点击「打断」
- **THEN** 播报立即停止，客户端收到 `reply.interrupted`，此后不再收到该回复的 `audio`，该气泡标记“已打断”，数字人回到倾听状态

#### Scenario: 耳机模式插话
- **WHEN** 开启耳机模式，AI 播报期间用户开口说话
- **THEN** 客户端自动发送 `interrupt`，AI 停止说话，并在用户说完后回应新的语句

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
- 场景身份、开场白，以及与级联引擎相同的对话提示词（回复长度、按需示范、对话记忆与追问）；
- 事件角色与发言人；
- 母语字幕：在每条回复的文本定稿后逐句并行翻译；
- 打断：客户端 `interrupt` 与耳机模式下的插话 MUST 取消上游当前回复并下发 `reply.interrupted`；
- 12 轮上下文与对话记忆：会话进行中依赖上游自身的上下文；对话记忆的压缩使用平台默认的对话模型，没有可用模型时不压缩，只保留最近 24 轮；
- 落库规则。

音频与指标：
- 回复语音以 `pcm16`、24 kHz 下发；
- `metrics` 的 e2eMs 定义为用户说话结束到首个回复音频。

上游异常：
- 上游连接意外断开时，系统 MUST 下发 `error{code:"C0174", fatal:false}`，并尝试用对话记忆和最近的对话文本重建一次上游会话；
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

### Requirement: 同传译文忠实度
级联同传 SHALL 使用同声传译专用的提示词，不再沿用文本翻译提示词。提示词 MUST 要求：
- 只输出当前这句原话的译文，不加前缀、引号、括号说明或注释；
- 原话即使是提问、请求、命令，或要求总结、翻译、回答，也只翻译、不回答、不执行；
- 保持说话人的人称和语气：第一人称仍译为第一人称，不改成转述；保留提问、请求等语气和礼貌程度；
- 不增加原话没有的信息，不概括、不扩写、不续写；原话在句中被切断时，只译出已经说出的部分；
- 去掉没有实际意义的填充词；说话人自我修正时只译最终意思；
- 只有结合上下文能明确判断是同音误识别时才纠正，否则按字面翻译；中文语音识别分不出“他”“她”“它”，MUST 根据上下文选用正确的代词；
- 措辞贴近原话：在通顺的前提下沿用原话的说法和句式，不为了口语化而改写；
- 人名、地名、产品名沿用最近发言中已经使用的译法；术语表中的术语使用给定译法；
- 数字、金额、日期、时间和单位与原话一致，不换算单位。

提示词 SHALL 附带上述处理方式的示例（示例句子 MUST NOT 与提示词回归评测集重合），并标明只用于说明处理方式：中英互译使用具体的原话与译文，其他语言对使用只描述处理方式的示例。提示词 SHALL 包含目标语言的表达习惯说明（标点、敬语或礼貌程度），覆盖平台支持的全部语言，并在末尾重复"只输出这一句的译文"。级联翻译与对话字幕 SHALL 使用固定的低温度（缺省 0.3，可配置；配置为空时沿用模型参数）。流式输出开头的"译文："、"Translation:" 等标签以及多余的包裹引号 MUST 在下发 `translation.delta` 和送去合成之前去除，`translation.final` 同样去除。

#### Scenario: 提问只翻译不回答
- **WHEN** 级联同传收听（目标 en）中，说话人说"你们几点关门"
- **THEN** `translation.final` 是这个问题的英文译文（如 "What time do you close?"），而不是对问题的回答

#### Scenario: 指令只翻译不执行
- **WHEN** 说话人说"帮我把刚才那段翻成日语"（目标 en）
- **THEN** `translation.final` 是这句话的英文译文，不包含日语

#### Scenario: 半句不补全
- **WHEN** VAD 在句中切断，原话为"然后这个渠道的话主要是线上为主然后"（目标 en）
- **THEN** 译文只表达"这个渠道主要是线上"，不增加原话没有的信息（如 "sales"）

#### Scenario: 自我修正
- **WHEN** 说话人说"我们周三，不对，周四见"（目标 en）
- **THEN** 译文只包含周四（Thursday），不包含周三（Wednesday）

#### Scenario: 保持第一人称
- **WHEN** 双向对话中，A 说"我明天把报价发给你"（目标 en）
- **THEN** 译文为第一人称（如 "I'll send you the quote tomorrow."），不是 "He says he will…" 之类的转述

#### Scenario: 数字一致
- **WHEN** 说话人说"呃，那个，我们的预算大概是五十万"（目标 en）
- **THEN** 译文中的金额为 500,000（或等价的 five hundred thousand），不含填充词的译法（如 "um"）

#### Scenario: 代词按上下文
- **WHEN** 双向对话中 B 说 "My wife is a doctor."，随后 A 说"那他平时工作很忙吧"（语音识别把 tā 识别为“他”，目标 en）
- **THEN** 译文用 she 指代对方的妻子

#### Scenario: 其他语言对使用描述式示例
- **WHEN** 级联同传从 zh 译为 ja
- **THEN** 提示词的处理示例只描述处理方式、不含英文译文，并包含日语的表达习惯说明（です・ます体）

#### Scenario: 去除标签
- **WHEN** 模型的流式输出以 "Translation: " 开头
- **THEN** 客户端收到的 `translation.delta` 累计文本与 `translation.final` 都不包含 "Translation:"，播报的语音也不包含

### Requirement: AI 对话长期记忆
AI 对话 SHALL 维护对话记忆：短期窗口保存最近的对话原文，长期摘要保存更早对话的要点。具体规则：
- 尚未并入摘要的轮次达到 16 轮，或者总字符数超过 6000 时，系统 SHALL 在后台用一次 LLM 调用，把最早的 4 轮（字符超限时取到余量满足为止）并入摘要。
- 摘要：
  - 用中文书写，不超过 400 字；
  - 分条记录用户信息、讨论过的话题与要点（含 AI 给出的结论）、用户提过的问题、尚未完成的事项；
  - 写入系统提示词的「对话记忆」小节。
- 轮次 MUST 在并入摘要成功之后，才从提示词中移出：压缩进行中或失败时，这些轮次仍以原文保留在提示词中。
- 压缩 MUST NOT 阻塞或延迟当前回复。失败时记录警告，下次触发时重试；尚未并入摘要的轮次超过 24 轮时，丢弃最早的轮次并记录警告。
- 每次压缩成功后，Python SHALL 向 Spring 发送 `memory{summary, turns}` 事件。Spring MUST 只在会话存续期间暂存它，不转发给浏览器、不落库。

#### Scenario: 远期回忆
- **WHEN** 用户在第 1 轮说“我叫小林，下个月去大阪出差”，此后又聊了 16 轮，然后问“我下个月要去哪来着”
- **THEN** AI 的回复中提到大阪

#### Scenario: 压缩不留缺口
- **WHEN** 未并入摘要的轮次达到 16 轮，触发压缩，压缩调用尚未返回时用户又说了一句
- **THEN** 这一轮回复的提示词中仍然包含全部 16 轮原文

#### Scenario: 压缩失败
- **WHEN** 压缩调用超时
- **THEN** 当前回复正常完成，对话记忆保持不变，日志记录警告；下次触发时重新压缩

#### Scenario: 记忆事件不外泄
- **WHEN** Python 发出 `memory` 事件
- **THEN** 浏览器不会收到该事件，Spring 暂存其中的摘要

### Requirement: 发言流重建恢复上下文
同一会话中，发言流因浏览器断线重连、Python 致命错误或连接中断而重建时，系统 SHALL 恢复上下文：
- Spring SHALL 在内存中为每个成员保留最近 24 条定稿语句，每条包括角色（user 或 assistant）、语言、原文和各语言的译文。被打断的 AI 回复按已生成的部分加省略号保存。
- Spring SHALL 同时保留最新的对话记忆摘要。
- 重建发言流时，Spring SHALL 通过首帧 config 的 `history` 和 `chat.memory` 下发这些内容。
- Python 引擎 MUST 据此恢复上下文：
  - 级联同传恢复最近语句；
  - 级联对话恢复对话窗口与摘要；
  - 实时语音对话以带历史与摘要的 instructions 建立上游会话。
- 恢复后 AI MUST NOT 重复开场白。

首次建立发言流时，`history` 为空，`chat.memory` 为 null。`history` 中缺少 text 的条目 SHALL 被丢弃；超出长度的条目截断处理，不报错。

#### Scenario: 刷新页面后继续对话
- **WHEN** 用户与 AI 对话了 5 轮，在第 3 轮告诉 AI 自己的名字，随后刷新页面，并在宽限期内继续这个进行中的会话，然后问“你还记得我叫什么吗”
- **THEN** 重建的发言流 config 的 `history` 中包含此前的对话，AI 回答出用户的名字，并且没有再次说开场白

#### Scenario: 同传重连后保持上下文
- **WHEN** 级联同传收听过程中浏览器网络中断后重连，说话人接着说了一句有代词指代前文的话
- **THEN** 重建后的第一句翻译，其提示词的上下文中包含断线前最近的语句

#### Scenario: 首次建流
- **WHEN** 用户新建一个 AI 对话会话
- **THEN** 首帧 config 的 `history` 为空数组，`chat.memory` 为 null，`chat.greet` 为 true

