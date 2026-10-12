## Why

② 交付了短文本翻译，但题目的核心诉求是"提升复杂翻译任务的自动化程度和**译文一致性**"，而一致性问题只有在长文档里才真正出现：术语前后译法不一、专名漂移、跨段指代断裂、风格不统一。总体设计确定了"篇章上下文为主"，本 change 交付平台最能体现 Agent 规划、记忆与人机协同能力的部分：**长文档篇章级翻译**。同时把篇章翻译的各项能力做成可开关的实验选项，为 ⑤ 的消融实验提供直接可用的执行入口。

## What Changes

- **文档翻译任务**：上传或粘贴 Markdown / TXT（≤ 5 万字符）创建任务；任务有完整状态机（排队 → 解析 → 分析 → 待确认术语 → 翻译 → 一致性检查 → 完成 / 失败 / 已取消），支持取消、失败后继续、删除
- **异步执行链路**：Spring 把任务写入 Redis Stream，Python 内置 worker（消费组）执行；执行事件写入另一条 Redis Stream，由 Spring 消费、落库并通过 SSE 推送进度。两条都是持久化的流，任何一端重启都不丢消息
- **篇章 Agent（LangGraph）**：结构化解析（标题/段落/列表/引用/表格/代码块，代码与 URL 等受保护内容不翻译）→ 全文分析（摘要、领域、文体、候选术语与专名抽取）→ 术语对齐（与术语库合并，可选**人工确认**，使用 LangGraph interrupt）→ 结构化分块 → 带篇章记忆逐块翻译（全文摘要 + 任务术语表 + 前块原文译文 + 滚动专名表），逐块评审与修正 → 全文一致性检查与定向修正 → 按原结构组装
- **三种分块执行策略**：串行（带前块上下文）、并行（只依赖全局记忆）、混合（章间并行、章内串行）
- **断点续译**：两级恢复——LangGraph Postgres checkpointer 保存阶段状态与术语确认中断；逐块结果写入 `ai.doc_chunk_result`，恢复时跳过已完成的块
- **实验选项**：任务可单独关闭前块上下文、全文摘要、术语抽取、评审修正，对应总体设计中的消融组 D0–D5
- **文档工作台（web）**：任务列表（进度环、状态、筛选）、新建任务的分步对话框（上传 → 翻译设置 → 确认）、任务工作区（阶段步进条、进度、原文译文按段对齐的虚拟列表、段落详情侧栏、术语确认面板、一致性报告、执行轨迹）、段落后编辑与单段重译、导出（译文 Markdown / 双语对照 Markdown / 纯文本）
- **并发控制**：每个用户最多同时运行 2 个任务；worker 全局并发可配置

## Capabilities

### New Capabilities

- `document-task`：文档任务的创建、校验、状态机、列表与详情、取消/继续/删除、并发限制、进度事件订阅
- `document-agent`：篇章 Agent 的各阶段（解析、全文分析、术语对齐与确认、分块、带记忆翻译、评审修正、一致性检查、组装）、分块策略、实验选项、断点续译
- `document-pipeline`：Spring 与 Python 之间的任务流 / 事件流契约、消费组与确认、重启恢复、取消传播
- `document-workspace`：文档工作台的任务列表、新建任务对话框、任务工作区、术语确认、段落后编辑与单段重译、导出

### Modified Capabilities

（无。翻译记录、历史属于短文本能力，文档任务使用独立的数据模型；SSE 解析与设计系统直接复用，不改变既有需求。）

## 非目标

- 不支持 docx / PDF / HTML 等格式（docx 段落级导入留作后续增强）
- 不做翻译记忆（TM）与向量检索：后编辑结果暂不写入 TM（属于 ④）
- 不做会话上下文与歧义追问（属于 ④）
- 不做评测指标计算与消融实验脚本（属于 ⑤）；本次只提供实验开关与逐块的原始数据
- 不做多人协作编辑、审校分配、版本对比
- 不做分布式多 worker 调度（单进程内置 worker 加消费组即可，结构上支持横向扩展）

## 依赖关系（对照 docs/总体设计.md 路线图）

- 依赖 ①：认证与 RBAC、`Result<T>` 与错误码、模型配置与 LLM 适配层、traceId
- 依赖 ②：语种识别、术语库与术语匹配、评审提示词与 JSON 解析容错、设计系统与动效、SSE 解析器、AiServiceClient
- 为 ④ 提供：后编辑过的段落（TM 的来源）、ContextMemory 的篇章策略实现
- 为 ⑤ 提供：实验选项（D0–D5）、逐块的耗时 / token / 评审分 / 术语遵循数据、三种分块策略

## Impact

- **python-backend**：新增依赖 langgraph-checkpoint-postgres、redis、markdown-it-py；新增 `app/doc/`（解析、保护、分块、记忆、图、一致性）、`app/worker/`（Redis Stream 消费）、`/internal/doc/segment/retranslate`
- **springboot-backend**：Flyway V3（doc_task、doc_segment、doc_task_term、doc_task_trace，以及 ai.doc_chunk_result）；新增 `module/document`（任务、事件消费、SSE 推送、导出）；Spring Data Redis Streams
- **web**：新增 `/documents`、`/documents/[id]`；新增依赖 @tanstack/react-virtual；`sse.ts` 增加 GET 订阅
- **Redis**：新增 Stream `tl:doc-tasks`、`tl:doc-events`，消费组 `ai-worker`、`spring`
- **对外 API**：`/api/doc-tasks/*`
- **内部 API**：`/internal/doc/segment/retranslate`
