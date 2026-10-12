## MODIFIED Requirements

### Requirement: 全文分析与术语对齐
AI 服务 SHALL 在翻译前生成全文摘要（超长文档采用分章摘要后汇总）、判定领域与文体，并抽取候选术语与专名（源词、建议译法、类型、出现次数）。抽取 SHALL 遵循目标语言在该领域的通行惯例：作为专有名称使用的产品名、API 或资源类型名、配置项、命令与代码标识符通常保留原文，只有存在广泛通用译法时才翻译，拿不准时建议译法与源词相同。候选 SHALL 与所选术语库的命中合并：同一源词以术语库译法为准；只出现 1 次且不是专名的抽取候选 MUST 被过滤。实验选项 globalSummary 或 termExtraction 关闭时，对应步骤 MUST 跳过。

#### Scenario: 术语库优先
- **WHEN** 术语库规定 "GPU → 图形处理器"，而抽取结果建议 "GPU → 显卡"
- **THEN** 合并后的候选为 "GPU → 图形处理器"，来源为 glossary

#### Scenario: 关闭摘要
- **WHEN** 任务的 globalSummary=false
- **THEN** 不调用摘要，分块翻译的上下文中不包含全文摘要

#### Scenario: 抽取提示词包含领域惯例
- **WHEN** 对一篇英文技术文档执行术语抽取
- **THEN** 发给 LLM 的抽取任务说明中包含"专有名称、资源类型与代码标识符通常保留原文、拿不准时译法与源词相同"的规则

### Requirement: 术语人工确认
任务开启人工确认时，AI 服务 SHALL 在术语对齐后中断执行，上报候选列表，并在不占用执行并发的情况下等待。用户确认后 SHALL 从中断点继续，并以用户确认的术语（含修改后的译法，排除被拒绝项）作为任务术语表，这些术语全部为硬约束（binding=hard）。未开启时自动采用全部候选，其中来自术语库的为硬约束，来自抽取的为软约束（binding=soft）。

#### Scenario: 修改后确认
- **WHEN** 任务处于待确认状态，用户把 "epoch" 的译法改为"训练轮次"、拒绝了 "batch"，然后确认
- **THEN** 执行从中断点继续，所有分块的提示词中 "epoch" 以必须使用的术语出现并译为"训练轮次"，且不包含 "batch"

#### Scenario: 等待期间不占并发
- **WHEN** worker 并发为 2，一个任务处于待确认状态
- **THEN** 仍可以同时执行另外 2 个任务

#### Scenario: 未确认时的约束强度
- **WHEN** 任务未开启人工确认，术语库命中 "GPU → 图形处理器"，抽取得到 "Deployment → 部署"
- **THEN** 任务术语表中 GPU 为 hard、Deployment 为 soft

### Requirement: 带篇章记忆的分块翻译
AI 服务 SHALL 逐块翻译，上下文包含：任务术语表（硬约束列为必须使用的术语，软约束列为可按领域惯例调整的参考译法）、全文摘要（globalSummary）、滚动专名表、上一块的最后两段原文与译文（contextWindow，仅组内串行时可用）。LLM MUST 以 JSON 按段落 id 返回译文，返回的 id 集合与输入不一致时 MUST 对缺失段落逐段补译。每块完成后 SHALL 只针对硬约束术语执行规则术语检查与遵循判定；开启评审时 SHALL 使用任务的评审模型（未指定或不可用时使用译者模型，并记录警告轨迹）进行评审，并且仅当评审问题中存在 critical 或 major、存在未遵循的硬约束术语、或总分低于兜底分（默认 75）时才修正，最多修正 1 轮；修正由译者模型完成。每块 SHALL 上报各段的译文、评审分、各严重度问题数与术语遵循情况。

#### Scenario: 前块上下文
- **WHEN** 串行策略且 contextWindow=true，翻译第 3 块
- **THEN** 提示词中包含第 2 块最后两段的原文与译文

#### Scenario: 漏段补译
- **WHEN** LLM 对 6 段的输入只返回了 5 段
- **THEN** 缺失的那段被单独补译，最终 6 段都有译文

#### Scenario: 关闭评审
- **WHEN** 任务的 review=false
- **THEN** 各块不调用评审，评审分为空

#### Scenario: 只有轻微问题不修正
- **WHEN** 评审得 82 分，问题列表只有 2 个 minor，且硬约束术语全部遵循
- **THEN** 该块不进入修正，reviewRounds=0

#### Scenario: major 问题触发修正
- **WHEN** 评审得 92 分，但问题列表包含 1 个 major 误译
- **THEN** 该块修正 1 轮后再次评审

#### Scenario: 软约束术语不触发修正
- **WHEN** 软约束 "Deployment → 部署" 的译文保留了 "Deployment"，评审没有 critical 或 major 问题且总分不低于 75
- **THEN** 该块不进入修正，遵循结果中不包含 Deployment

#### Scenario: 使用独立评审模型
- **WHEN** 任务的 reviewModelConfigId 指向 gpt-6-luna，译者为 gpt-5.6-luna
- **THEN** 评审调用发往 gpt-6-luna，修正调用发往 gpt-5.6-luna

### Requirement: 全文一致性检查
AI 服务 SHALL 在翻译结束后，对任务术语表和出现 2 次以上的专名检查各段译文所用的译法。同一源词出现多种译法时，以硬约束术语的译法为准；软约束术语和未列入术语表的专名取多数（平票时软约束的参考译法优先），对不一致的段落做定向修正（只统一该词的译法），修正后仍不包含选定译法的段落标记为未解决。系统 SHALL 输出一致性报告（源词、各译法及次数、选定译法、已修正段落、未解决段落）。

#### Scenario: 统一专名
- **WHEN** 专名 "Kubernetes" 在 5 段中被译为"Kubernetes"、在 1 段中被译为"库伯内特斯"，且任务术语表没有规定
- **THEN** 选定"Kubernetes"，修正那 1 段，报告中 fixedSegs 包含该段

#### Scenario: 软约束按多数统一
- **WHEN** 软约束 "Deployment → 部署"，译文中 6 段保留 "Deployment"、2 段写作"部署"
- **THEN** 选定 "Deployment"，修正那 2 段
