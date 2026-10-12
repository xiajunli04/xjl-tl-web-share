## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: 自动采用术语的状态
未开启人工确认的任务中，系统 SHALL 把来自抽取的候选术语记录为 `AUTO` 状态（软约束，仅供参考），把来自术语库的候选记录为 `CONFIRMED`；开启人工确认时候选仍为 `PENDING`，确认后为 `CONFIRMED` 或 `REJECTED`。任务术语查询 SHALL 返回该状态。

#### Scenario: 不确认时的术语状态
- **WHEN** confirmTerms=false 的任务完成分析，候选包含 1 条术语库命中与 3 条抽取结果
- **THEN** 任务术语列表中 1 条为 CONFIRMED、3 条为 AUTO
