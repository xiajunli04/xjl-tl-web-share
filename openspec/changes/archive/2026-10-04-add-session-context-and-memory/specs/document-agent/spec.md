## ADDED Requirements

### Requirement: 分块翻译参考翻译记忆
任务的实验选项 translationMemory 开启时（缺省开启），AI 服务 SHALL 在每块翻译前，以任务所属用户的翻译记忆为每个可翻译段检索最佳 1 条候选，fuzzy 不低于 0.7 或 semantic 不低于 0.75 的候选入选，全块最多 8 条，按得分排序写入分块提示词的「翻译记忆参考」小节，作为参考而非必须遵循的译法。每块 SHALL 在结果与轨迹摘要中记录命中（段落序号、匹配度、来源）。检索失败或模型不可用时 MUST 按无命中处理，MUST NOT 使任务失败。translationMemory 关闭时 MUST 不检索。

#### Scenario: 段落命中记忆
- **WHEN** 用户记忆中有与第 7 段原文 fuzzy=0.95 的条目，translationMemory=true
- **THEN** 第 7 段所在块的提示词包含该条目，该块的 tmHits 含 {seq: 7, fuzzy: 0.95}，轨迹摘要说明命中 1 条记忆

#### Scenario: 关闭记忆
- **WHEN** 任务的 translationMemory=false
- **THEN** 各块不检索翻译记忆，提示词中没有「翻译记忆参考」小节

#### Scenario: 记忆服务不可用
- **WHEN** embedding 模型不可用时执行文档任务
- **THEN** 任务正常完成，各块 tmHits 为空
