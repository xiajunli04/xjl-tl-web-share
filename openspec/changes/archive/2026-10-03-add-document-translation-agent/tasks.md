## 1. infra：契约基线

- [x] 1.1 准备测试文档 `docs/contracts/fixtures/`：`k8s-guide.md`（约 3100 字符、按二级标题切分为 4 个块，含二级标题、嵌套列表、表格、fenced 代码块、行内代码、链接、HTML 块、CRLF 段落）与 `short-note.txt`（3 段纯文本），供三端测试共用（验证：人工检查覆盖 design D3 中列出的全部元素）
- [x] 1.2 编写 `docs/contracts/doc-stream-sample.md`：两条流的消息样例（start / resume / retry / cancel 命令；以及一次开启术语确认的完整事件序列：phase → parsed → analysis → awaiting_confirm → phase → chunk_done×N（含 1 个 cached）→ trace → consistency → completed，外加 failed、cancelled 示例），字段严格遵循 design D2，所有 JSON 可解析（验证：脚本解析全部 JSON 通过）

## 2. python-backend：解析、保护与分块

- [x] 2.1 安装 langgraph-checkpoint-postgres、redis、markdown-it-py（下载失败时使用镜像，见 README）；在 settings 中加入文档相关配置（分块目标 1800 / 上限 3000、块并发 3、worker 并发 2、修正轮次 1、XAUTOCLAIM 闲置 60 秒、Redis 连接）（验证：`uv run --no-sync pytest` 原有 115 个用例通过）
- [x] 2.2 实现 `app/doc/parser.py`：Markdown（markdown-it-py，按行号切回原文，拆分为 prefix / source / suffix，表格按行，代码/HTML/分隔线/空行不可翻译）与 TXT 解析（验证：对 1.1 的两份夹具以及 CRLF、嵌套列表、表格、空文档等用例断言拼接结果与原文逐字节相同，块类型正确）
- [x] 2.3 实现 `app/doc/protect.py`：行内代码、URL、链接目标、图片、HTML 标签、占位符替换为 ⟦n⟧ 并还原，还原时校验标记的缺失与重复（验证：pytest 覆盖 document-agent「行内内容保护」场景及标记异常）
- [x] 2.4 实现 `app/doc/chunker.py`：token 估算、按目标/上限分块、不跨一二级标题、超长段落独立成块、group 编号、纯不可翻译块标记（验证：pytest 覆盖「结构化分块」场景，以及 1.1 夹具的分块结果）

## 3. python-backend：篇章图

- [x] 3.1 实现 `app/doc/prompts.py`（全文摘要与分章汇总、领域文体判定、候选术语抽取、分块翻译、分块评审、定向一致性修正、单段重译）与 `app/doc/memory.py`（任务术语表、滚动专名表、前块上下文的组装，按实验选项裁剪）（验证：提示词快照测试；对 contextWindow / globalSummary / review 开关逐一断言上下文中有无对应内容）
- [x] 3.2 实现 parse / analyze / align_terms 节点（map-reduce 摘要、抽取 JSON 容错、术语库优先合并、低频过滤）（验证：用假 LLM 覆盖「全文分析与术语对齐」两个场景及超长文档走 map-reduce）
- [x] 3.3 实现 confirm_terms（LangGraph interrupt）与 plan_chunks（三种策略的分组）（验证：pytest 断言中断后状态可序列化，resume 后的任务术语表反映用户的修改与拒绝；三种策略的分组正确）
- [x] 3.4 实现 translate_groups：Send 分组、组内顺序执行、块并发信号量、JSON 按段输出与 id 校验、漏段逐段补译、标记还原失败时单段重译、规则术语检查、评审与 1 轮修正、滚动专名表更新、`ai.doc_chunk_result` 缓存读写（验证：用假 LLM 覆盖「带篇章记忆的分块翻译」三个场景、「分块执行策略」中的混合策略，以及缓存命中时不调用 LLM）
- [x] 3.5 实现 consistency 与 finalize 节点（多译法检测、选定规则、按批定向修正与规则校验、报告结构、统计）（验证：pytest 覆盖「全文一致性检查」场景及"未能自动修正"分支）
- [x] 3.6 组装 `app/doc/graph.py`：AsyncPostgresSaver（ai schema，tl_ai，启动时 setup）、thread_id=taskId、事件发射器（eventSeq 单调递增）（验证：在测试库中跑通 1.1 夹具的完整图（假 LLM），事件序列与 `doc-stream-sample.md` 的结构一致）

## 4. python-backend：worker 与内部接口

- [x] 4.1 实现 `app/worker/doc_worker.py`：lifespan 启停、XGROUP 幂等创建、XREADGROUP 循环、全局并发信号量（中断等待时释放）、start / resume / retry / cancel 命令处理、taskId 到协程的映射与取消、处理完成后才 XACK、启动时 XAUTOCLAIM、任务终结后 purge 检查点与缓存（验证：pytest 使用真实 Redis（compose，独立的 db 与流名前缀）覆盖排队、取消、术语确认中断期间释放并发、重复命令幂等）
- [x] 4.2 断点续译端到端：用假 LLM 跑到第 3 块时强制终止 worker 协程，重启 worker 后任务完成，前 2 块以 cached 上报（验证：pytest 断言 LLM 调用次数与 cached 标记）
- [x] 4.3 实现 `POST /internal/doc/segment/retranslate`（无状态，含保护与可选要求）（验证：pytest 覆盖「单段重译」场景）
- [x] 4.4 用真实测试模型对 `k8s-guide.md` 跑一次 serial + 术语确认的完整流程（经由 Redis 命令驱动），保存事件日志到 `python-backend/tests/fixtures/real-doc-run.events.jsonl`（验证：最终 completed，拼接后的译文 Markdown 结构完整）

## 5. springboot-backend：数据与任务

- [x] 5.1 编写 Flyway `V3__document.sql`：doc_task、doc_segment、doc_task_term、doc_task_trace、ai.doc_chunk_result 及索引；新增错误码 A0213、A0430、A0431、C0150（验证：迁移测试通过；以 tl_ai 身份可读写 ai.doc_chunk_result，不能读 biz.doc_task）
- [x] 5.2 实现任务创建（multipart 与 JSON 两种方式；格式、编码、长度、语种、术语库权限、并发数校验；标题默认值；XADD start）（验证：集成测试覆盖 document-task「创建文档任务」的 4 个场景与「并发限制」）
- [x] 5.3 实现列表、详情、段落、术语查询，以及取消、继续、删除（状态校验 A0431、XADD cancel / retry）（验证：集成测试覆盖「任务列表与详情」「取消、继续与删除」的场景）
- [x] 5.4 实现术语确认接口（仅 AWAITING_CONFIRM 允许，保存确认结果，XADD resume）（验证：集成测试覆盖状态不符时返回 A0431 与正常确认）

## 6. springboot-backend：事件消费、推送与导出

- [x] 6.1 实现事件消费：StreamMessageListenerContainer、消费组幂等创建、按事件类型落库（状态机、批量插入段落、术语、轨迹、进度、一致性报告、统计）、eventSeq 幂等、落库成功后 XACK、启动时认领 pending 消息（验证：集成测试用 Testcontainers Redis 投递 `doc-stream-sample.md` 中的事件序列，断言数据库终态；重复投递不重复计数；模拟停机期间积压的事件在重启后被补处理）
- [x] 6.2 实现 `SseHub` 与 `GET /api/doc-tasks/{id}/events`（snapshot 加实时事件、15 秒心跳、终结后关闭、用户隔离）（验证：集成测试断言中途订阅时先收到 snapshot，再收到后续事件）
- [x] 6.3 实现失联任务检测定时任务（30 分钟无事件则标记为 FAILED，retryable）（验证：通过可配置的短阈值做集成测试）
- [x] 6.4 实现段落后编辑、单段重译（组装上下文，同步调用 Python）、导出（md / bilingual / txt，按 prefix + 译文 + suffix 拼接）（验证：集成测试中对 1.1 夹具解析后的段落，用"译文=原文"导出时与原文逐字节一致；双语格式正确；重译接口用 MockAiServer 模拟上游）

## 7. web：任务中心与新建对话框

- [x] 7.1 新增 `src/lib/api/documents.ts`（类型与 design D10 一致）；`sse.ts` 支持 GET 订阅与断线重连（重新获取 snapshot）；`useDocTask(id)` 用 snapshot 加增量事件合成状态（验证：vitest 用 `doc-stream-sample.md` 驱动，断言状态合成正确，重连后不重复计数）
- [x] 7.2 实现任务中心 `/documents`：卡片网格（进度环、状态徽标、阶段、操作菜单）、状态分段筛选、搜索、空状态、运行中任务实时刷新；侧边栏新增「文档翻译」（验证：亮色与暗色截图；运行中任务的进度环随事件增长）
- [x] 7.3 实现新建任务三步对话框（拖拽上传、格式识别、字数统计与上限、翻译设置、策略卡片、确认术语开关、默认折叠的实验选项、确认页预估分块数），完成后跳转工作区（验证：截图覆盖三步；超过上限时无法进入下一步）

## 8. web：任务工作区

- [x] 8.1 实现工作区顶栏：阶段步进条（动效）、分块进度与用量（NumberTicker）、导出菜单、取消或继续（验证：截图覆盖翻译中、待确认、已完成、失败四种状态）
- [x] 8.2 实现双栏对照虚拟列表（@tanstack/react-virtual，动态测量高度）：Markdown 语义样式、不可翻译段样式、术语高亮、骨架占位与完成时淡入、已编辑徽标、自动跟随开关（验证：2000 段的 mock 文档滚动流畅；截图）
- [x] 8.3 实现侧栏标签页：概览（摘要、领域、配置、统计）、术语（确认面板：可编辑表格、批量操作、底部固定「确认并继续翻译」，待确认时自动切换）、一致性报告（点击段落编号定位并闪烁）、轨迹（验证：截图覆盖待确认时的术语确认流程与一致性定位）
- [x] 8.4 实现段落交互：选中后显示段落详情、行内编辑并保存、带要求的重译（采用或放弃）（验证：截图与交互走查）

## 9. 联调与交付

- [x] 9.1 三端联调：用真实测试模型对 `k8s-guide.md` 分别跑 serial（开启术语确认）、parallel、hybrid；在翻译过程中重启 Python，验证续译且已完成的块以 cached 上报；在翻译过程中取消；在 Spring 停机期间产生的事件于重启后被补处理（验证：结果与截图写入 `docs/test/document-translation-smoke/README.md`）
- [x] 9.2 UI/UX 验收：任务中心、新建对话框、工作区（各状态）、术语确认、一致性报告，分别截取亮色与暗色截图，并做 reduced-motion 对比；逐页核对没有整页平铺（验证：截图存档）
- [x] 9.3 三端自动化测试全部通过，执行 `openspec validate add-document-translation-agent --strict`，并逐条核对规格场景都有测试或手动验证记录（验证：命令全部通过，核对清单附在冒烟测试记录中）
