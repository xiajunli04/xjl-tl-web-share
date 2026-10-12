## ADDED Requirements

### Requirement: 参考指标
评测工程 SHALL 计算整篇译文相对整篇参考译文的 d-chrF（字符 6-gram）和 d-BLEU（中文按字切分），句子级实验 SHALL 计算语料级 chrF 与 BLEU。

#### Scenario: 完全一致
- **WHEN** 译文与参考完全相同
- **THEN** chrF 与 BLEU 都为 100

### Requirement: LLM 评审（MQM）
评测工程 SHALL 使用与译者不同的评审模型，逐块对（原文段落，译文段落）做无参考的 MQM 风格评审，输出错误的类别（accuracy / fluency / terminology / style / locale）、严重度（critical / major / minor）与片段，按 25 / 5 / 1 加权计算罚分，并报告每千源词罚分。评审 MUST 使用 temperature 0 与 JSON 输出，解析失败时重试一次，仍失败则记录为缺失（不计 0 分）。评审结果 SHALL 按（文档、配置、块、译文内容哈希）缓存。

#### Scenario: 罚分计算
- **WHEN** 某篇 1000 源词的译文被评出 1 个 major、3 个 minor 错误
- **THEN** 该篇的 MQM 罚分为 8.0（每千源词）

#### Scenario: 缓存命中
- **WHEN** 对同一份译文重复执行评审
- **THEN** 不再调用评审模型，直接使用缓存结果

### Requirement: 术语与专名指标
评测工程 SHALL 基于金标表与段落对齐关系计算：术语准确率（对每条术语在原文段落中的每次出现，检查对应译文段落中金标译法的出现次数，按出现次数加权）、术语一致率（每条术语最常用译法次数占识别出的译法总次数之比的平均）、专名一致率（仅统计专名条目）。匹配 MUST 遵守词边界与大小写规则，并跳过行内代码。指标 MUST 按出现次数比对，而不是只判断是否出现。

#### Scenario: 不被子串误导
- **WHEN** 原文段落 "a Deployment creates Pods; the smallest deployable unit" 中 Deployment 出现 1 次，译文为"Deployment 会创建 Pod；最小的可部署单元"，金标译法为"部署"
- **THEN** 该次出现计为未遵循（译文中的"部署"出现在"可部署"中，不计入），术语准确率为 0

#### Scenario: 一致率
- **WHEN** 术语 node 在 4 个段落中分别被译为"节点""节点""节点""结点"
- **THEN** 该术语的一致率为 0.75

### Requirement: 成本统计
评测工程 SHALL 为每次运行统计 prompt / completion token、逐块耗时之和（来自执行轨迹，排除排队与等待）以及墙钟时间。

#### Scenario: 排除等待时间
- **WHEN** 一个任务在执行中失败，过了 10 分钟后被重试并完成
- **THEN** 逐块耗时之和只包含各块实际执行的时间，不包含这 10 分钟
