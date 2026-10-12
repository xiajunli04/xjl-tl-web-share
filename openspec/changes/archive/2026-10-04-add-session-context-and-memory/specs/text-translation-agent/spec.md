## MODIFIED Requirements

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

### Requirement: 翻译工作台
系统 SHALL 提供翻译工作台：左右分栏的原文与译文区、语种选择与互换、「翻译设置」弹层（风格分段控件、领域、术语库多选、模型选择）、模式选择、可收起的 Agent 面板（时间线 / 评审 / 术语 / 记忆四个标签页）。工作台 SHALL 提供「单次 / 会话」切换：会话模式下显示可收起的会话列表抽屉、原文区下方的对话线程（每轮的原文、采用的译文、版本条、修订要求与追问问答）、作用于选中轮次的修订输入框（含快捷要求）以及等待回答时的追问卡片。翻译过程中 SHALL 可以停止；译文中命中的术语 SHALL 高亮，悬停显示原术语；完成后显示评审分、耗时和 token 用量，可以复制、收藏和存入翻译记忆。快捷键 Ctrl+Enter 触发翻译。

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
