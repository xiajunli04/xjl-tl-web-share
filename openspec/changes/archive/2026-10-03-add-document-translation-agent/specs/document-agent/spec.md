## ADDED Requirements

### Requirement: 结构化解析
AI 服务 SHALL 把 Markdown 解析为段落序列，每段由 prefix（结构标记）、source（正文）、suffix（行尾与块间空白）组成，并标注块类型与是否可翻译。所有段的 `prefix + source + suffix` 依次拼接 MUST 与原文逐字节相同。代码块、HTML 块、分隔线和空行 MUST 标记为不可翻译。纯文本按空行切分段落。

#### Scenario: 可逆切分
- **WHEN** 解析一篇包含二级标题、嵌套列表、表格、fenced 代码块、HTML 块和 CRLF 换行的 Markdown
- **THEN** 把所有段按顺序拼接后与原文完全相同，代码块和 HTML 块被标记为不可翻译

#### Scenario: 表格
- **WHEN** 解析一个三列表格
- **THEN** 每个数据行作为一个可翻译段，单元格分隔符保留在 prefix/suffix 中，表头分隔行不可翻译

### Requirement: 行内内容保护
发给 LLM 之前，AI 服务 SHALL 把段落中的行内代码、URL、链接目标、图片、HTML 标签和占位符（`{name}`、`%s`、`{{var}}`）替换为编号标记，译后按编号还原。标记缺失或重复时 MUST 对该段单独重译一次；仍然失败则保留原文，并在一致性报告中标出。

#### Scenario: 链接与行内代码
- **WHEN** 段落为 "Run `npm install` and see [the docs](https://example.com/docs)."
- **THEN** 译文中 `` `npm install` `` 与 `https://example.com/docs` 保持原样，链接文字被翻译

### Requirement: 全文分析与术语对齐
AI 服务 SHALL 在翻译前生成全文摘要（超长文档采用分章摘要后汇总）、判定领域与文体，并抽取候选术语与专名（源词、建议译法、类型、出现次数）。候选 SHALL 与所选术语库的命中合并：同一源词以术语库译法为准；只出现 1 次且不是专名的抽取候选 MUST 被过滤。实验选项 globalSummary 或 termExtraction 关闭时，对应步骤 MUST 跳过。

#### Scenario: 术语库优先
- **WHEN** 术语库规定 "GPU → 图形处理器"，而抽取结果建议 "GPU → 显卡"
- **THEN** 合并后的候选为 "GPU → 图形处理器"，来源为 glossary

#### Scenario: 关闭摘要
- **WHEN** 任务的 globalSummary=false
- **THEN** 不调用摘要，分块翻译的上下文中不包含全文摘要

### Requirement: 术语人工确认
任务开启人工确认时，AI 服务 SHALL 在术语对齐后中断执行，上报候选列表，并在不占用执行并发的情况下等待。用户确认后 SHALL 从中断点继续，并以用户确认的术语（含修改后的译法，排除被拒绝项）作为任务术语表；未开启时自动采用全部候选。

#### Scenario: 修改后确认
- **WHEN** 任务处于待确认状态，用户把 "epoch" 的译法改为"训练轮次"、拒绝了 "batch"，然后确认
- **THEN** 执行从中断点继续，所有分块的提示词中 "epoch" 译为"训练轮次"，且不包含 "batch"

#### Scenario: 等待期间不占并发
- **WHEN** worker 并发为 2，一个任务处于待确认状态
- **THEN** 仍可以同时执行另外 2 个任务

### Requirement: 结构化分块
AI 服务 SHALL 按段落累积估算的 token 数进行分块（默认目标 1800，上限 3000），MUST NOT 跨越一级或二级标题，MUST NOT 拆开单个段落。只含不可翻译段落的块不调用 LLM。

#### Scenario: 不跨章节
- **WHEN** 文档有两个二级标题章节，每章约 1000 token
- **THEN** 产生至少 2 个块，且没有任何一个块同时包含两章的段落

### Requirement: 带篇章记忆的分块翻译
AI 服务 SHALL 逐块翻译，上下文包含：任务术语表、全文摘要（globalSummary）、滚动专名表、上一块的最后两段原文与译文（contextWindow，仅组内串行时可用）。LLM MUST 以 JSON 按段落 id 返回译文，返回的 id 集合与输入不一致时 MUST 对缺失段落逐段补译。每块完成后 SHALL 执行规则术语检查，开启评审时进行评审，不达标时最多修正 1 轮，并上报该块各段的译文、评审分与术语遵循情况。

#### Scenario: 前块上下文
- **WHEN** 串行策略且 contextWindow=true，翻译第 3 块
- **THEN** 提示词中包含第 2 块最后两段的原文与译文

#### Scenario: 漏段补译
- **WHEN** LLM 对 6 段的输入只返回了 5 段
- **THEN** 缺失的那段被单独补译，最终 6 段都有译文

#### Scenario: 关闭评审
- **WHEN** 任务的 review=false
- **THEN** 各块不调用评审，评审分为空

### Requirement: 分块执行策略
AI 服务 SHALL 支持三种策略：serial（全部块在一个组内按顺序执行）、parallel（每块一组，组间并发，默认并发 3）、hybrid（每个二级标题章节一组，章间并发、章内顺序）。parallel 下各块之间不共享前块上下文和滚动专名表。

#### Scenario: 混合策略
- **WHEN** 文档有 3 个章节、共 9 块，策略为 hybrid
- **THEN** 3 个章节同时执行，每章内部的块按顺序执行，并带有本章前一块的上下文

### Requirement: 全文一致性检查
AI 服务 SHALL 在翻译结束后，对任务术语表和出现 2 次以上的专名检查各段译文所用的译法。同一源词出现多种译法时，以任务术语表的译法为准（没有则取多数），对不一致的段落做定向修正（只统一该词的译法），修正后仍不包含选定译法的段落标记为未解决。系统 SHALL 输出一致性报告（源词、各译法及次数、选定译法、已修正段落、未解决段落）。

#### Scenario: 统一专名
- **WHEN** 专名 "Kubernetes" 在 5 段中被译为"Kubernetes"、在 1 段中被译为"库伯内特斯"，且任务术语表没有规定
- **THEN** 选定"Kubernetes"，修正那 1 段，报告中 fixedSegs 包含该段

### Requirement: 断点续译
AI 服务 SHALL 在每个阶段结束后保存执行检查点，并在每块完成后保存分块结果。执行中断（进程重启、失败后继续）后 MUST 从最近的检查点恢复，已有分块结果的块 MUST NOT 再调用 LLM（以 cached 方式上报）。

#### Scenario: 进程重启
- **WHEN** Python 进程在 12 块中的第 6 块执行时被终止，随后重新启动
- **THEN** 未确认的任务消息被重新认领，任务继续执行，第 1–5 块以 cached 上报，从第 6 块开始调用 LLM，最终完成

### Requirement: 单段重译
AI 服务 SHALL 提供无状态的单段重译：根据给定的段落原文、前后段、全文摘要、术语和可选的一句用户要求生成新译文，并遵守行内内容保护。

#### Scenario: 附加要求
- **WHEN** 调用单段重译并附加要求"更正式"
- **THEN** 返回新的译文与用量，原文中的占位符被保留
