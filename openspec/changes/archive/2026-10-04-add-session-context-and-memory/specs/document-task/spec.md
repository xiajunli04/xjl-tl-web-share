## ADDED Requirements

### Requirement: 翻译记忆选项与写入
文档任务的实验选项 SHALL 新增 translationMemory（缺省开启），随任务持久化并写入 start 与 retry 命令。段落后编辑保存成功后，系统 SHALL 异步把该段（去除行内标记的原文与新译文）写入任务所属用户的翻译记忆，写入失败只记录日志。系统 SHALL 提供把已完成任务的全部译文写入翻译记忆的接口，只写入可翻译且已有译文的段落，返回写入条数；任务不是 COMPLETED 时 MUST 返回 `A0431`。

#### Scenario: 缺省开启记忆
- **WHEN** 请求未给出 options.translationMemory
- **THEN** 任务的 options.translationMemory=true，start 命令的 payload 中同样为 true

#### Scenario: 编辑段落写入记忆
- **WHEN** 用户保存第 3 段的修改
- **THEN** 接口立即返回成功，随后翻译记忆中出现该段，来源引用为 "taskId:3"

#### Scenario: 写入全部译文
- **WHEN** 用户对已完成任务调用写入接口，任务有 30 个可翻译段、其中 2 段没有译文
- **THEN** 返回 written=28
