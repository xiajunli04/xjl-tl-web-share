# text-translation-agent Specification

## Purpose
TBD - created by archiving change add-text-translation-agent. Update Purpose after archive.
## Requirements
### Requirement: 翻译参数
翻译请求 SHALL 包含：原文（1–5000 字符）、源语言（`auto` 或支持语种）、目标语言、模式（`auto`/`fast`/`standard`）、风格（`faithful` 忠实 / `fluent` 流畅 / `creative` 创意）、可选领域、可选术语库 id 列表、可选模型配置 id、可选评审模型配置 id 和可选会话 id。原文超长时 MUST 返回 `A0410` 并提示使用文档翻译。源语言与目标语言相同时 MUST 返回 `A0410`。所选术语库 MUST 是用户可访问的，否则返回 `A0404`。显式指定的评审模型 MUST 为启用状态，否则返回 `C0130`；未指定时使用管理员设置的评审模型，仍没有则评审使用译者模型。带会话 id 时，未显式给出的参数 SHALL 取会话的默认参数，会话 MUST 属于当前用户，否则返回 `A0404`。

#### Scenario: 原文超长
- **WHEN** 用户提交 6000 字符的原文
- **THEN** 系统返回 HTTP 400、code `A0410`，提示"长文本请使用文档翻译"

#### Scenario: 未指定模型
- **WHEN** 请求不带 modelConfigId
- **THEN** 使用默认模型；没有默认模型时返回 `C0130`

#### Scenario: 使用管理员设置的评审模型
- **WHEN** 请求不带 reviewModelConfigId，管理员已把 gpt-6-luna 设为评审模型
- **THEN** 转发给 AI 服务的请求中 reviewModelConfigId 为 gpt-6-luna 的配置 id

#### Scenario: 会话默认参数
- **WHEN** 会话的风格为 fluent，请求带 sessionId 且未指定风格
- **THEN** 本次翻译以 fluent 风格执行

### Requirement: Agent 编排
AI 服务 SHALL 以状态图执行翻译，节点依次为 analyze、plan、（clarify）、retrieve、translate、review、refine、finalize、（memorize）。plan 节点 SHALL 按以下规则选择路径：模式为 `revise` 时走修订路径；模式为 `fast` 或 `standard` 时直接采用；模式为 `auto` 时，若原文不超过 80 字符、没有术语命中、风格为 `faithful` 且不是允许歧义追问的会话请求，走快速路径，否则走标准路径。快速路径 MUST 跳过 retrieve、review、refine；修订路径 MUST 跳过 retrieve、review、refine 并使用修订提示词；标准路径执行全部节点。clarify 节点只在会话歧义追问触发时执行，memorize 节点只在会话记忆需要压缩时执行。每个节点的开始与结束 MUST 作为事件推送，并附带中文摘要、耗时和 token 用量。

#### Scenario: 短句走快速路径
- **WHEN** 模式为 auto，原文为 "Good morning"，未选择术语库
- **THEN** plan 事件为 `path=fast`，retrieve、review、refine 以 `skipped` 状态推送，最终得到译文

#### Scenario: 有术语命中走标准路径
- **WHEN** 模式为 auto，原文包含所选术语库中的术语
- **THEN** plan 事件为 `path=standard`，reason 说明"命中 N 条术语"

#### Scenario: 领域自动判定
- **WHEN** 走标准路径且请求未指定领域
- **THEN** plan 节点给出领域判定（例如"医学"），并写入上下文包的 domain_hint

#### Scenario: 允许追问的会话走标准路径
- **WHEN** 模式为 auto，会话允许歧义追问，原文为 "Send it to the bank."
- **THEN** plan 事件为 `path=standard`，reason 说明"会话允许歧义追问"

#### Scenario: 修订路径
- **WHEN** 模式为 revise
- **THEN** plan 事件为 `path=revise`，retrieve、review、refine 以 skipped 推送，translate 使用修订提示词

### Requirement: 上下文包与提示词
AI 服务 SHALL 把命中术语、领域、风格、翻译记忆命中（tm_examples）和会话上下文（session_ctx：最近轮次、早期摘要、会话专名表）组装成 TranslationContext，并据此生成翻译提示词。提示词 MUST 要求模型只输出译文，保留原文中的代码、URL、占位符（如 `{name}`、`%s`）和数字，命中术语 MUST 使用给定译法；翻译记忆 SHALL 作为参考译法与风格的示例呈现，MUST NOT 要求模型照抄。标准路径的 retrieve 节点 SHALL 检索翻译记忆，并在节点事件中给出命中明细（原文、译文、匹配度、来源）；快速路径不检索翻译记忆。doc_memory 字段由文档翻译使用。

#### Scenario: 保留占位符
- **WHEN** 原文为 "Hello {name}, you have %d new messages"
- **THEN** 译文中保留 `{name}` 和 `%d`

#### Scenario: 风格差异
- **WHEN** 同一段原文分别以 faithful 和 creative 风格翻译
- **THEN** 两次请求的提示词中风格指令不同，且分别记录在翻译记录中

#### Scenario: 注入翻译记忆
- **WHEN** 用户记忆中有与原文匹配度 92% 的条目，走标准路径翻译
- **THEN** 提示词中包含「翻译记忆」小节与该条目，retrieve 节点事件的 tmHits 含该条目且 fuzzy 约 0.92

### Requirement: 评审与修正
标准路径中，review 节点 SHALL 使用评审模型（未指定或不可用时使用译者模型）让 LLM 按准确性、流畅性、术语、风格四个维度评审译文，返回 0–100 分和问题列表（含维度、严重度、片段和建议），并合并规则化术语检查发现的问题。评审问题中存在 critical 或 major、存在未遵循的术语、或总分低于兜底分（默认 75）时判定为未通过，否则通过。未通过且修正轮次少于上限（默认 2）时进入 refine，由译者模型带着问题列表重写译文后再次评审。review 事件 SHALL 包含评审模型名称以及是否退回译者模型。评审输出无法解析时 MUST 视为通过并记录警告，MUST NOT 中断翻译。

#### Scenario: 一轮修正后通过
- **WHEN** 首译评审发现 1 个 major 误译，修正后评审只有 minor 问题且得 90 分
- **THEN** 依次推送 review(round=0, passed=false)、refine 节点、delta(round=1)、review(round=1, passed=true)，最终译文为第 1 轮修正结果

#### Scenario: 达到修正上限
- **WHEN** 连续 3 次评审都包含 major 问题
- **THEN** 执行 2 轮修正后停止，以最后一轮译文作为结果，记录中 `reviewRounds=2`

#### Scenario: 只有轻微问题
- **WHEN** 首译评审得 80 分，问题列表只有 minor
- **THEN** review(round=0, passed=true)，不进入 refine

#### Scenario: 评审输出损坏
- **WHEN** LLM 返回的评审内容不是合法 JSON
- **THEN** 本轮视为通过，日志中记录警告，翻译正常完成

#### Scenario: 评审模型不可用
- **WHEN** 请求指定的评审模型在执行时已被停用
- **THEN** 评审退回译者模型，review 事件中 fallback=true，翻译正常完成

### Requirement: 术语遵循校验
finalize 节点 SHALL 对每条命中术语检查其目标译法是否出现在最终译文中（匹配规则与术语匹配一致），给出逐条的遵循结果。

#### Scenario: 术语未遵循
- **WHEN** 原文命中术语 "GPU → 图形处理器"，但最终译文中写的是 "显卡"
- **THEN** final 事件的 compliance 中该项为 `compliant=false`，工作台将其标红

### Requirement: 翻译工作台
系统 SHALL 提供翻译工作台，包含以下部分：
- 左右分栏的原文区与译文区；
- 语种选择与互换；
- 「翻译设置」弹层：风格分段控件、领域、术语库多选、模型选择；
- 模式选择；
- 可收起的 Agent 面板，含时间线 / 评审 / 术语 / 记忆 / 解读五个标签页。

工作台 SHALL 提供「单次 / 会话」切换。会话模式下显示：
- 可收起的会话列表抽屉；
- 原文区下方的对话线程：每轮的原文、采用的译文、版本条、修订要求与追问问答；
- 作用于选中轮次的修订输入框，含快捷要求；
- 等待回答时的追问卡片。

翻译过程中 SHALL 可以停止。译文中命中的术语 SHALL 高亮，悬停显示原术语。完成后显示评审分、耗时和 token 用量，可以复制、收藏和存入翻译记忆。快捷键 Ctrl+Enter 触发翻译。

语音相关：
- 原文区 SHALL 提供语音输入按钮：录音时显示实时电平，结束后上传识别，识别文本写入原文框并设置识别出的源语言。
- 原文区与译文区 SHALL 各提供朗读按钮：使用服务端合成，失败时改用浏览器朗读；播放中可以停止。

#### Scenario: 实时观察 Agent
- **WHEN** 用户点击翻译
- **THEN** Agent 面板自动展开，时间线随 node 事件逐个点亮，plan 节点显示所选路径和理由，译文随 delta 事件逐字出现

#### Scenario: 停止翻译
- **WHEN** 用户在翻译进行中点击「停止」
- **THEN** 前端中断请求，时间线显示"已停止"，该次翻译不写入历史

#### Scenario: 语种互换
- **WHEN** 用户点击互换按钮，且已有译文
- **THEN** 源语言和目标语言互换，译文移入原文区

#### Scenario: 回答追问
- **WHEN** 会话模式下翻译以 clarify 事件结束
- **THEN** 译文区顶部出现追问卡片，高亮歧义片段并列出选项；用户点击选项后卡片收起，时间线继续点亮直至完成

#### Scenario: 查看记忆命中
- **WHEN** 标准路径翻译命中 2 条翻译记忆
- **THEN** 「记忆」标签页列出 2 条命中，显示匹配度徽章与原文差异高亮

#### Scenario: 语音输入
- **WHEN** 用户点击原文区麦克风说一句日语后再次点击结束
- **THEN** 按钮进入"识别中"状态，随后原文框填入识别文本，源语言设为日语

#### Scenario: 朗读译文
- **WHEN** 用户点击译文区朗读按钮
- **THEN** 播放译文语音，按钮显示声波动画，再次点击停止播放

#### Scenario: 麦克风不可用
- **WHEN** 浏览器拒绝麦克风权限
- **THEN** 语音输入按钮显示提示"麦克风不可用"，不影响文本输入

### Requirement: 译文朗读体验
翻译工作台的译文朗读 SHALL 满足以下要求：

- **常驻可见**：
  - 单次模式的译文区，在有目标语言时 MUST 始终显示朗读按钮；翻译进行中按钮为禁用态，提示“译文完成后可朗读”。
  - 会话模式中每一轮译文的朗读按钮 MUST 固定可见，不依赖悬停。
- **流式播放**：朗读使用流式朗读接口，收到首个音频分块即开始播放。
- **三种状态**：按钮 SHALL 有三种状态：
  - 加载：首包未到，显示加载环；
  - 播放：显示随电平变化的声波；
  - 空闲。

  播放中再次点击停止。同一时刻只播放一段，开始新的朗读时 MUST 停止当前朗读。
- **朗读设置**：按钮附带设置弹层，可选音色（女声 / 男声）与语速（0.8× / 1.0× / 1.2×）。
- **自动朗读**：「翻译设置」中提供“完成后自动朗读”开关，缺省关闭；开启后，单次翻译完成或会话最新一轮完成时自动朗读译文。
- **偏好持久化**：音色、语速与自动朗读偏好 SHALL 保存在本地，刷新后保留。
- **降级**：服务端朗读失败时改用浏览器朗读，并以 toast 提示。

动效 MUST 尊重 `prefers-reduced-motion`。

#### Scenario: 翻译中可见朗读入口
- **WHEN** 用户在单次模式点击翻译，译文正在流式输出
- **THEN** 译文区显示禁用的朗读按钮，悬停提示“译文完成后可朗读”；翻译完成后按钮变为可用

#### Scenario: 会话模式历史轮次朗读
- **WHEN** 会话模式下已有 3 轮翻译，用户在触屏设备上查看第 1 轮
- **THEN** 第 1 轮译文下方的朗读按钮无需悬停即可见，点击后播放该轮译文

#### Scenario: 首包即播
- **WHEN** 用户点击朗读一段 200 字的英文译文
- **THEN** 按钮先显示加载环，收到首个音频分块后切换为声波并开始出声，不等整段合成完成

#### Scenario: 选择男声与语速
- **WHEN** 用户在朗读设置中选择男声和 1.2×，然后点击朗读
- **THEN** 请求携带 gender=male、rate=1.2，播放男声的 1.2 倍语速语音；刷新页面后该设置仍然保留

#### Scenario: 完成后自动朗读
- **WHEN** 用户开启“完成后自动朗读”后翻译一段文本
- **THEN** 译文完成时自动开始朗读，无需点击

#### Scenario: 切换朗读
- **WHEN** 原文正在朗读时，用户点击译文的朗读按钮
- **THEN** 原文朗读停止，开始朗读译文

#### Scenario: 服务端朗读失败
- **WHEN** 朗读接口返回 `C0172`
- **THEN** 前端用浏览器朗读该译文，并提示“已改用浏览器朗读”

