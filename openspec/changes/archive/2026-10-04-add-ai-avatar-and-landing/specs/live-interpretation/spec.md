## ADDED Requirements

### Requirement: AI 对话模式
`CHAT` 模式 SHALL 让用户用语音与 AI 伙伴（Lumi）实时对话，规则如下：
- 会话开始后，AI MUST 先按场景说一句开场白。
- 用户每说完一句，系统 SHALL 生成一条 AI 回复，回复使用对话语言（aiLang），口语化，长度为 1–3 句。
- AI 回复的事件 MUST 带 `role:"assistant"`，发言人为 `{participantId:"ai", displayName:"Lumi", lang:aiLang}`，事件依次为：
  - 流式的 `transcript.partial`（累计文本）；
  - `transcript.final`；
  - myLang 与 aiLang 不同时，再发母语字幕 `translation.delta/final`（lang=myLang）；
  - 回复语音 `audio`（lang=aiLang）；
  - `metrics`。
- 用户自己的语句只发转写事件与只含 asrMs 的 `metrics`，不发译文。

系统 SHALL 在会话内保留最近 12 轮对话作为上下文。场景提示词 MUST 决定 AI 扮演的身份：`free` 为聊天伙伴，`travel` 为当地人，`restaurant` 为服务员，`business` 为合作方，`interview` 为面试官。AI 回复与用户语句 SHALL 按现有同传记录规则落库，并能在历史中按发言人回看。

#### Scenario: AI 先开口
- **WHEN** 用户以 mode=CHAT、languages=[zh, en]、chatScenario=restaurant 开始对话
- **THEN** 连接就绪后，客户端收到一条 role=assistant 的英文开场白（以服务员身份）、其中文字幕和英文语音

#### Scenario: 一轮对话
- **WHEN** 用户说“我想要一份不辣的菜”
- **THEN** 客户端先收到该句的 `transcript.final`（role 缺省，lang=zh），随后收到一条新 utteranceId 的 role=assistant 英文回复、中文字幕和英文语音

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
- CHAT 指定 `[我的语言, 对话语言]`（两者可以相同）以及可选场景 `chatScenario`（`free | travel | restaurant | business | interview`，缺省 `free`）。CHAT 只允许级联引擎。

可选参数包括术语库、领域提示、音色、是否语音播报、耳机模式。创建成功返回会话 id 和一次性 WebSocket 票据。每个用户同一时刻 MUST 最多只有一个进行中的同传会话。

#### Scenario: 创建收听会话
- **WHEN** 用户以 mode=LISTEN、engine=cascade、targetLang=zh 创建同传会话
- **THEN** 返回 sessionId 与 wsTicket，会话状态为 ACTIVE

#### Scenario: 对话语言相同
- **WHEN** 用户以 mode=CONVERSE、languages=[en, en] 创建会话
- **THEN** 系统返回 HTTP 400、code `A0410`

#### Scenario: 创建 AI 对话
- **WHEN** 用户以 mode=CHAT、engine=cascade、languages=[zh, en]、chatScenario=travel 创建会话
- **THEN** 返回 sessionId 与 wsTicket，会话 options 中记录 chatScenario=travel

#### Scenario: AI 对话使用 S2S 引擎
- **WHEN** 用户以 mode=CHAT、engine=qwen-livetranslate 创建会话
- **THEN** 系统返回 HTTP 400、code `A0410`，提示“AI 对话仅支持平台级联引擎”

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

### Requirement: 实时音频通道
浏览器 SHALL 通过 `wss://{api}/ws/interpret?ticket=` 连接 Spring。票据有效期 60 秒，只能使用一次。握手 MUST 校验票据与 Origin，失败时拒绝握手。

连接建立后：
- 浏览器上行二进制帧为 PCM16LE、16 kHz、单声道音频，以及 JSON 控制帧（`ptt`、`flush`、`mute`、`interrupt`、`end`、`ping`）；
- Spring 为每条发言流向 Python `/internal/interpret/stream` 建立内部 WebSocket（携带 `X-Internal-Token`），首帧发送 config，然后转发音频与控制帧；
- 下行事件为 JSON：`ready`、`participants`、`transcript.partial`、`transcript.final`、`translation.delta`、`translation.final`、`audio`、`metrics`、`reply.interrupted`、`error`、`ended`，字段见设计 D7。
  - `audio` 的 format 为 `pcm16` 或 `mp3`，数据为 base64。
  - 带 utteranceId 的事件可以携带 `role`（`user` | `assistant`），缺省为 `user`。

#### Scenario: 票据重复使用
- **WHEN** 客户端用已经使用过的票据再次连接
- **THEN** 握手被拒绝（HTTP 401，code `A0453`）

#### Scenario: 一句话的事件顺序
- **WHEN** 用户在级联引擎下说完一句话
- **THEN** 客户端依次收到同一 utteranceId 的若干 `transcript.partial`、一个 `transcript.final`、若干 `translation.delta`、一个 `translation.final`、若干 `audio`（最后一个 last=true）和一个 `metrics`

#### Scenario: 上游中断
- **WHEN** Python 与 S2S 上游的连接意外断开
- **THEN** 客户端收到 `error{code:"C0174", fatal:false}`，系统尝试重建一次上游会话，已完成的转写不丢失

#### Scenario: 非 CHAT 模式忽略打断
- **WHEN** 客户端在 LISTEN 模式下发送 `{type:"interrupt"}`
- **THEN** 该控制帧被忽略，同传继续，不返回错误

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
