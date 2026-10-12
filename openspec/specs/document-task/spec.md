# document-task Specification

## Purpose
TBD - created by archiving change add-document-translation-agent. Update Purpose after archive.
## Requirements
### Requirement: 创建文档任务
系统 SHALL 允许已登录用户上传文件或粘贴文本来创建文档翻译任务。格式 MUST 为 Markdown 或纯文本（按扩展名 `.md` / `.markdown` / `.txt`，或请求中声明的 format 判定），文本 MUST 为 UTF-8（兼容 BOM），去除空白后不能为空，且不超过 50000 字符。任务参数包括：标题（默认取文件名或首个标题）、源语言（`auto` 或支持语种）、目标语言、风格、领域、术语库、模型、可选评审模型、分块策略（`serial` / `parallel` / `hybrid`，默认 `hybrid`）、是否人工确认术语（默认开启），以及实验选项（contextWindow、globalSummary、termExtraction 默认开启，review 默认关闭）。评审模型按"请求显式指定 → 管理员设置的评审模型 → 空（与译者相同）"在创建时解析并记录到任务上，继续执行时沿用；显式指定的评审模型不可用时 MUST 返回 `C0130`。创建成功后任务状态为 PENDING，并进入执行队列。

#### Scenario: 上传 Markdown 创建任务
- **WHEN** 用户上传 8000 字符的 `guide.md`，目标语言为中文，策略为串行
- **THEN** 系统返回任务详情，状态为 PENDING，标题为 "guide"，并向任务流写入 start 命令

#### Scenario: 文档过大
- **WHEN** 用户提交 60000 字符的文本
- **THEN** 系统返回 HTTP 400、code `A0430`，不创建任务

#### Scenario: 不支持的格式
- **WHEN** 用户上传 `report.docx`
- **THEN** 系统返回 HTTP 400、code `A0430`

#### Scenario: 无权访问的术语库
- **WHEN** 用户在参数中选择了他人的私有术语库
- **THEN** 系统返回 HTTP 404、code `A0404`

#### Scenario: 缺省参数
- **WHEN** 请求只包含原文与目标语言
- **THEN** 任务的 strategy 为 hybrid、confirmTerms 为 true，options 为 contextWindow=true、globalSummary=true、termExtraction=true、review=false

#### Scenario: 记录评审模型
- **WHEN** 管理员已把配置 3 设为评审模型，用户创建 review=true 的任务且未指定评审模型
- **THEN** 任务详情中 reviewModelConfigId=3，start 命令的 payload 中 reviewModelConfigId=3

#### Scenario: 指定的评审模型已停用
- **WHEN** 请求的 reviewModelConfigId 指向已停用的配置
- **THEN** 系统返回 HTTP 400、code `C0130`，不创建任务

### Requirement: 并发限制
系统 SHALL 限制每个用户同时处于 PENDING、PARSING、ANALYZING、TRANSLATING、CONSISTENCY 状态的任务最多 2 个（可配置）。AWAITING_CONFIRM 状态的任务不计入。超出时 MUST 拒绝创建或重试，返回 HTTP 429、code `A0213`。

#### Scenario: 超出并发
- **WHEN** 用户已有 2 个翻译中的任务，又创建第 3 个
- **THEN** 系统返回 HTTP 429、code `A0213`

### Requirement: 任务状态机
文档任务 SHALL 遵循状态机：PENDING → PARSING → ANALYZING →（可选 AWAITING_CONFIRM）→ TRANSLATING → CONSISTENCY → COMPLETED；任意执行阶段都可能转为 FAILED；取消时经 CANCELLING 转为 CANCELLED。状态变化 MUST 只由执行事件或用户操作驱动，并记录开始和结束时间。超过 30 分钟没有任何执行事件的运行中任务 MUST 被标记为 FAILED（可重试）。

#### Scenario: 正常完成
- **WHEN** 执行端依次上报 parsing、analyzing、translating、consistency 阶段以及 completed 事件
- **THEN** 任务状态依次变化并最终为 COMPLETED，`finishedAt` 被写入

#### Scenario: 执行端失联
- **WHEN** 一个 TRANSLATING 状态的任务 30 分钟内没有收到任何事件
- **THEN** 任务被标记为 FAILED，`retryable=true`，错误码为 `C0150`

### Requirement: 任务列表与详情
系统 SHALL 允许用户分页查询自己的文档任务（按状态、标题关键词筛选，按创建时间倒序），并查看任务详情（参数、状态、阶段、进度、摘要、一致性报告、统计、用量，不含原文全文）和全部段落。用户 MUST 只能访问自己的任务，否则返回 A0404。

#### Scenario: 查看段落
- **WHEN** 用户请求一个已完成任务的全部段落
- **THEN** 系统按 seq 顺序返回全部段落，包含 prefix、原文、suffix、译文、是否可翻译、评审分和是否已编辑

### Requirement: 取消、继续与删除
系统 SHALL 允许用户取消运行中或待确认术语的任务，对 FAILED（可重试）或 CANCELLED 的任务发起继续，以及删除任务（逻辑删除，运行中的任务先取消）。状态不允许时 MUST 返回 HTTP 409、code `A0431`。继续执行 MUST 从断点恢复，已完成的分块不重新翻译。

#### Scenario: 取消运行中任务
- **WHEN** 用户取消一个 TRANSLATING 状态的任务
- **THEN** 任务先变为 CANCELLING，执行端停止后变为 CANCELLED

#### Scenario: 对已完成任务发起继续
- **WHEN** 用户对 COMPLETED 状态的任务调用继续
- **THEN** 系统返回 HTTP 409、code `A0431`

#### Scenario: 失败后继续
- **WHEN** 一个 12 块的任务在第 8 块失败，用户点击继续
- **THEN** 任务重新进入执行，前 7 块不再调用 LLM（以 cached 方式上报），从第 8 块开始翻译

### Requirement: 进度事件订阅
系统 SHALL 提供任务进度的 SSE 订阅：建立连接后先发送 `snapshot`（任务当前详情），随后推送实时事件（phase、chunk_done、awaiting_confirm、consistency、completed、failed、cancelled），每 15 秒发送心跳；任务处于终结状态时发送 snapshot 后关闭连接。

#### Scenario: 中途打开页面
- **WHEN** 用户在任务翻译到 5/12 块时打开工作区
- **THEN** 首先收到进度为 5/12 的 snapshot，之后收到第 6 块起的 chunk_done 事件

### Requirement: 段落后编辑与导出
系统 SHALL 允许用户修改任意可翻译段落的译文（标记为已编辑），对单个段落发起带上下文的重译（可附加一句要求，返回新译文供用户确认），并导出译文 Markdown、双语对照 Markdown 或纯文本。导出 MUST 按 `prefix + 译文 + suffix` 拼接，没有译文的段落使用原文，从而保持原文的 Markdown 结构。

#### Scenario: 结构保持
- **WHEN** 用户导出一篇含标题、嵌套列表、表格和代码块的文档的译文 Markdown
- **THEN** 导出文件的标题层级、列表缩进、表格分隔符和代码块内容与原文一致，只有正文被替换为译文

#### Scenario: 带要求重译
- **WHEN** 用户对某段发起重译并附加要求"更口语化"
- **THEN** 系统返回新译文和用量，该段在用户确认保存前保持不变

### Requirement: 自动采用术语的状态
未开启人工确认的任务中，系统 SHALL 把来自抽取的候选术语记录为 `AUTO` 状态（软约束，仅供参考），把来自术语库的候选记录为 `CONFIRMED`；开启人工确认时候选仍为 `PENDING`，确认后为 `CONFIRMED` 或 `REJECTED`。任务术语查询 SHALL 返回该状态。

#### Scenario: 不确认时的术语状态
- **WHEN** confirmTerms=false 的任务完成分析，候选包含 1 条术语库命中与 3 条抽取结果
- **THEN** 任务术语列表中 1 条为 CONFIRMED、3 条为 AUTO

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

