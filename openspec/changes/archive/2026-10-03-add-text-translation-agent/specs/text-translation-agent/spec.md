## ADDED Requirements

### Requirement: 翻译参数
翻译请求 SHALL 包含：原文（1–5000 字符）、源语言（`auto` 或支持语种）、目标语言、模式（`auto`/`fast`/`standard`）、风格（`faithful` 忠实 / `fluent` 流畅 / `creative` 创意）、可选领域、可选术语库 id 列表和可选模型配置 id。原文超长时 MUST 返回 `A0410` 并提示使用文档翻译。源语言与目标语言相同时 MUST 返回 `A0410`。所选术语库 MUST 是用户可访问的，否则返回 `A0404`。

#### Scenario: 原文超长
- **WHEN** 用户提交 6000 字符的原文
- **THEN** 系统返回 HTTP 400、code `A0410`，提示"长文本请使用文档翻译"

#### Scenario: 未指定模型
- **WHEN** 请求不带 modelConfigId
- **THEN** 使用默认模型；没有默认模型时返回 `C0130`

### Requirement: Agent 编排
AI 服务 SHALL 以状态图执行翻译，节点依次为 analyze、plan、retrieve、translate、review、refine、finalize。plan 节点 SHALL 按以下规则选择路径：模式为 `fast` 或 `standard` 时直接采用；模式为 `auto` 时，若原文不超过 80 字符、没有术语命中且风格为 `faithful`，走快速路径，否则走标准路径。快速路径 MUST 跳过 retrieve、review、refine，标准路径执行全部节点。每个节点的开始与结束 MUST 作为事件推送，并附带中文摘要、耗时和 token 用量。

#### Scenario: 短句走快速路径
- **WHEN** 模式为 auto，原文为 "Good morning"，未选择术语库
- **THEN** plan 事件为 `path=fast`，retrieve、review、refine 以 `skipped` 状态推送，最终得到译文

#### Scenario: 有术语命中走标准路径
- **WHEN** 模式为 auto，原文包含所选术语库中的术语
- **THEN** plan 事件为 `path=standard`，reason 说明"命中 N 条术语"

#### Scenario: 领域自动判定
- **WHEN** 走标准路径且请求未指定领域
- **THEN** plan 节点给出领域判定（例如"医学"），并写入上下文包的 domain_hint

### Requirement: 上下文包与提示词
AI 服务 SHALL 把命中术语、领域和风格组装成 TranslationContext，并据此生成翻译提示词。提示词 MUST 要求模型只输出译文，保留原文中的代码、URL、占位符（如 `{name}`、`%s`）和数字，命中术语 MUST 使用给定译法。TranslationContext 中 SHALL 预留 tm_examples、doc_memory、session_ctx 字段（本 change 为空）。

#### Scenario: 保留占位符
- **WHEN** 原文为 "Hello {name}, you have %d new messages"
- **THEN** 译文中保留 `{name}` 和 `%d`

#### Scenario: 风格差异
- **WHEN** 同一段原文分别以 faithful 和 creative 风格翻译
- **THEN** 两次请求的提示词中风格指令不同，且分别记录在翻译记录中

### Requirement: 评审与修正
标准路径中，review 节点 SHALL 让 LLM 按准确性、流畅性、术语、风格四个维度评审译文，返回 0–100 分和问题列表（含维度、严重度、片段和建议），并合并规则化术语检查发现的问题。分数达到阈值（默认 85）时通过；未通过且修正轮次少于上限（默认 2）时进入 refine，带着问题列表重写译文后再次评审。评审输出无法解析时 MUST 视为通过并记录警告，MUST NOT 中断翻译。

#### Scenario: 一轮修正后通过
- **WHEN** 首译评审得 70 分，修正后评审得 90 分
- **THEN** 依次推送 review(round=0, passed=false)、refine 节点、delta(round=1)、review(round=1, passed=true)，最终译文为第 1 轮修正结果

#### Scenario: 达到修正上限
- **WHEN** 连续 3 次评审都低于阈值
- **THEN** 执行 2 轮修正后停止，以最后一轮译文作为结果，记录中 `reviewRounds=2`

#### Scenario: 评审输出损坏
- **WHEN** LLM 返回的评审内容不是合法 JSON
- **THEN** 本轮视为通过，日志中记录警告，翻译正常完成

### Requirement: 术语遵循校验
finalize 节点 SHALL 对每条命中术语检查其目标译法是否出现在最终译文中（匹配规则与术语匹配一致），给出逐条的遵循结果。

#### Scenario: 术语未遵循
- **WHEN** 原文命中术语 "GPU → 图形处理器"，但最终译文中写的是 "显卡"
- **THEN** final 事件的 compliance 中该项为 `compliant=false`，工作台将其标红

### Requirement: 翻译工作台
系统 SHALL 提供翻译工作台：左右分栏的原文与译文区、语种选择与互换、「翻译设置」弹层（风格分段控件、领域、术语库多选、模型选择）、模式选择、可收起的 Agent 面板（时间线 / 评审 / 术语三个标签页）。翻译过程中 SHALL 可以停止；译文中命中的术语 SHALL 高亮，悬停显示原术语；完成后显示评审分、耗时和 token 用量，可以复制和收藏。快捷键 Ctrl+Enter 触发翻译。

#### Scenario: 实时观察 Agent
- **WHEN** 用户点击翻译
- **THEN** Agent 面板自动展开，时间线随 node 事件逐个点亮，plan 节点显示所选路径和理由，译文随 delta 事件逐字出现

#### Scenario: 停止翻译
- **WHEN** 用户在翻译进行中点击「停止」
- **THEN** 前端中断请求，时间线显示"已停止"，该次翻译不写入历史

#### Scenario: 语种互换
- **WHEN** 用户点击互换按钮，且已有译文
- **THEN** 源语言和目标语言互换，译文移入原文区
