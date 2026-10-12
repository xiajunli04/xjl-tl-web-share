## MODIFIED Requirements

### Requirement: 翻译参数
翻译请求 SHALL 包含：原文（1–5000 字符）、源语言（`auto` 或支持语种）、目标语言、模式（`auto`/`fast`/`standard`）、风格（`faithful` 忠实 / `fluent` 流畅 / `creative` 创意）、可选领域、可选术语库 id 列表、可选模型配置 id 和可选评审模型配置 id。原文超长时 MUST 返回 `A0410` 并提示使用文档翻译。源语言与目标语言相同时 MUST 返回 `A0410`。所选术语库 MUST 是用户可访问的，否则返回 `A0404`。显式指定的评审模型 MUST 为启用状态，否则返回 `C0130`；未指定时使用管理员设置的评审模型，仍没有则评审使用译者模型。

#### Scenario: 原文超长
- **WHEN** 用户提交 6000 字符的原文
- **THEN** 系统返回 HTTP 400、code `A0410`，提示"长文本请使用文档翻译"

#### Scenario: 未指定模型
- **WHEN** 请求不带 modelConfigId
- **THEN** 使用默认模型；没有默认模型时返回 `C0130`

#### Scenario: 使用管理员设置的评审模型
- **WHEN** 请求不带 reviewModelConfigId，管理员已把 gpt-6-luna 设为评审模型
- **THEN** 转发给 AI 服务的请求中 reviewModelConfigId 为 gpt-6-luna 的配置 id

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
