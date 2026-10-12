## ADDED Requirements

### Requirement: 翻译记忆存储
系统 SHALL 为每个用户维护独立的翻译记忆库，条目包含语言对、原文、译文、规范化原文、384 维语义向量、来源（workbench / document）、来源引用、命中次数与最近命中时间。同一用户、同一语言对、规范化后相同的原文 MUST 只保留一条，再次写入时以最新译文覆盖。用户只能查看和删除自己的条目。

#### Scenario: 重复写入覆盖
- **WHEN** 用户先后把 "Restart the Pod." 的两个不同译文存入记忆
- **THEN** 记忆库中只有一条该原文的条目，译文为后一次的译文

#### Scenario: 用户隔离
- **WHEN** 用户 A 检索与用户 B 记忆中完全相同的原文
- **THEN** 不返回用户 B 的条目

### Requirement: 翻译记忆写入
系统 SHALL 支持三种写入来源：在工作台把一条翻译记录存入记忆（记录 MUST 属于当前用户）；文档段落后编辑保存后自动写入该段（异步执行，写入失败 MUST NOT 影响编辑结果，原文使用去除行内标记的纯文本）；把已完成文档任务中所有已有译文的可翻译段批量写入并返回写入条数（任务不是 COMPLETED 时返回 `A0431`）。单次批量写入 MUST 不超过 200 条，超出部分分批执行。

#### Scenario: 后编辑自动写入
- **WHEN** 用户把文档第 5 段的译文改为"重启该 Pod"并保存
- **THEN** 保存立即成功，稍后翻译记忆中出现该段原文与"重启该 Pod"，来源为 document，来源引用为 "taskId:5"

#### Scenario: 一键写入
- **WHEN** 用户对一个有 40 个可翻译段的已完成任务执行"写入翻译记忆"
- **THEN** 系统返回 written=40，记忆库中新增或更新 40 条

#### Scenario: 未完成任务
- **WHEN** 用户对翻译中的任务执行"写入翻译记忆"
- **THEN** 系统返回 HTTP 409、code `A0431`

### Requirement: 混合检索与匹配度
AI 服务 SHALL 以语义向量（余弦距离最近的 20 条）与字面三元组相似度（相似度大于 0.3 的前 20 条）两路召回同用户、同语言对的候选，合并去重后计算字符级模糊匹配度（fuzzy，0–1）与语义相似度（semantic，0–1）。fuzzy 不低于 0.6 或 semantic 不低于 0.65 的候选入选（阈值可配置；0.65 依据所用本地模型对同义改写的实测相似度约 0.66 确定），按 max(fuzzy, 0.9 × semantic) 降序返回，并标记 fuzzy=1 的条目为 100% 匹配；被返回的条目 SHALL 增加命中次数。语义模型使用本地多语种模型，模型不可用时检索 MUST 返回空结果，写入 MUST 返回 `C0160`，翻译功能 MUST NOT 受影响。

#### Scenario: 字面近似命中
- **WHEN** 记忆中有 "Restart the Pod after updating the ConfigMap."，检索 "Restart the Pod after updating the Secret."
- **THEN** 返回该条，fuzzy 约 0.8，排在第一位

#### Scenario: 语义改写命中
- **WHEN** 记忆中有 "How do I get a refund?"，检索 "What is the process for getting my money back?"
- **THEN** 该条以 semantic 不低于 0.65 入选，fuzzy 低于 0.6

#### Scenario: 模型不可用
- **WHEN** embedding 模型加载失败后发起一次标准路径翻译
- **THEN** 翻译正常完成，retrieve 节点摘要说明翻译记忆不可用

### Requirement: 翻译记忆管理
系统 SHALL 提供翻译记忆管理页：按语言对筛选、按原文或译文关键词检索的分页列表，条目详情（原文、译文、来源及跳转链接、命中次数、最近命中时间）和删除操作。列表为空时 SHALL 显示引导说明。页面 SHALL 采用主从布局，并有加载骨架、空状态与错误状态。

#### Scenario: 删除条目
- **WHEN** 用户在记忆页删除一条条目
- **THEN** 该条从列表中收起消失，之后的检索不再返回它

#### Scenario: 来源跳转
- **WHEN** 用户查看一条来源为 document 的条目并点击来源链接
- **THEN** 跳转到对应文档任务的工作区并定位到该段落
