## Context

- ①② 已归档，基线规格见 `openspec/specs/`（11 个能力）。可复用：LLM 适配层（重试、JSON 模式与容错解析）、语种识别、术语库与 `GlossaryMatcher`、评审提示词、SSE 解析器 `web/src/lib/sse.ts`、设计系统与动效组件
- 短文本链路是"同步 SSE、一次请求跑完"；文档任务可能持续数分钟，期间允许用户离开页面、在中途确认术语、在失败后继续，因此必须改成**异步任务 + 可恢复执行**
- 测试用 LLM 延迟 3–60 秒且偶发 TLS 失败。一篇 2 万字的文档约 10–20 个分块，每块含评审 2–3 次调用，总耗时可达 5–15 分钟，这就要求逐块可恢复
- 开发机内存紧张：worker 跑在 FastAPI 进程内，不新增独立进程
- 前端必须遵守总体设计 8.1 的 UI/UX 标准

## Goals / Non-Goals

**Goals:**

- 一篇 1 万字的 Markdown 文档在默认设置下能稳定完成，术语与专名全文一致，Markdown 结构（标题、列表、表格、代码块）原样保留
- 任意时刻重启 Python 或 Spring，任务都能继续，已完成的分块不重复调用 LLM
- 术语确认时真正暂停（不占用 worker），确认后从中断点继续
- 实验开关与三种策略可以组合，逐块数据完整，可供 ⑤ 直接统计

**Non-Goals:**

- 见 proposal「非目标」

## Decisions

### D1. 总体数据流：两条持久化 Redis Stream

```
浏览器 ──POST /api/doc-tasks──► Spring ──写 doc_task(PENDING)──► PG(biz)
                                  │
                                  └─XADD tl:doc-tasks {cmd:start, taskId, payload}
                                                │  消费组 ai-worker
                                                ▼
                               Python worker ──LangGraph(thread_id=taskId)──► PG(ai: checkpoints, doc_chunk_result)
                                                │
                                  XADD tl:doc-events {taskId, type, data}
                                                │  消费组 spring
                                                ▼
浏览器 ◄──SSE /api/doc-tasks/{id}/events── Spring(SseHub) ◄── 消费、落库 doc_task / doc_segment / doc_task_term / doc_task_trace
```

- **决策**：任务和事件都使用 Redis Stream 加消费组，处理成功后才 XACK。**备选**：Pub/Sub 推进度、HTTP 回调。**理由**：Stream 持久化，消费者重启后可以从 pending 列表补处理（XAUTOCLAIM），满足"任何一端重启不丢消息"；Pub/Sub 在 Spring 重启期间会丢消息
- **决策**：Spring 仍是 biz 数据的唯一写入方，Python 只写 ai schema 和事件流（延续总体设计 3.1）
- **决策**：worker 以 asyncio 后台任务的形式运行在 FastAPI 进程内（lifespan 启动、关闭），并发上限默认 2（`doc_worker_concurrency`）。**备选**：独立 worker 进程。**理由**：开发机内存紧张；消费组本身支持日后拆成多个进程横向扩展
- 任务负载（原文、参数）随 `start` 命令写入流，Python 不读 biz 的文档表，所以**不需要扩大 tl_ai 的权限**

### D2. 流消息契约

所有流消息的字段值都是字符串；`data` 是单行 JSON。

**`tl:doc-tasks`（Spring → Python，消费组 `ai-worker`）**

| cmd | 其他字段 | 说明 |
|---|---|---|
| `start` | `taskId`, `traceId`, `payload` | payload 见下表 |
| `resume` | `taskId`, `traceId`, `data={terms:[{source,target}]}` | 术语确认后继续 |
| `retry` | `taskId`, `traceId`, `payload` | 失败或中断后从检查点继续（payload 与 start 相同，防止检查点丢失时无法重建） |
| `cancel` | `taskId`，可选 `purge="true"` | 取消任务；任何状态下执行端都回报 `cancelled`。删除任务时带 `purge`，执行端立即清理检查点、分块缓存与 eventSeq 计数；普通取消保留检查点以便 retry |

```
payload = {userId, title, format:"md"|"txt", text, sourceLang:"auto"|code, targetLang, style, domain?, glossaryIds[],
           modelConfigId?, strategy:"serial"|"parallel"|"hybrid", confirmTerms:bool,
           options:{contextWindow:bool, globalSummary:bool, termExtraction:bool, review:bool}}
```

**`tl:doc-events`（Python → Spring，消费组 `spring`）**

| type | data | Spring 的处理 |
|---|---|---|
| `phase` | `{phase:"parsing"\|"analyzing"\|"awaiting_confirm"\|"translating"\|"consistency"\|"assembling"}` | 更新任务状态 |
| `parsed` | `{segments:[Segment], chunks:[{index, segSeqs:[..], group}], detectedLang, confidence}` | 批量插入 doc_segment，写入 progress_total |
| `analysis` | `{summary, domain, genre, candidates:[{source, target, origin:"glossary"\|"extracted", frequency}]}` | 保存摘要与领域，插入 doc_task_term |
| `awaiting_confirm` | `{candidates:[...]}` | 状态设为 AWAITING_CONFIRM |
| `chunk_done` | `{chunk, segments:[{seq, target, reviewScore, reviewRounds, compliance}], usage, latencyMs, cached:bool}` | 更新段落译文，progress_done 增加 |
| `consistency` | `{issues:[{term, variants:[..], chosen, fixedSegs:[..], unresolvedSegs:[..]}], segments:[{seq, target}], protectionFailures?:[{seq, problem}]}` | 写一致性报告（含 protectionFailures）并更新被修正的段落 |
| `trace` | `{seq, node, status, summary, chunk?, latencyMs?, usage?}` | 插入 doc_task_trace |
| `completed` | `{usage, latencyMs, stats:{chunks, cachedChunks, refined, compliance:{ok,total}}}` | 状态设为 COMPLETED |
| `failed` | `{code, message, retryable:bool}` | 状态设为 FAILED |
| `cancelled` | `{}` | 状态设为 CANCELLED |

```
Segment = {seq, blockType:"heading"|"paragraph"|"list_item"|"blockquote"|"table_row"|"code"|"html"|"blank"|"hr",
           prefix, source, suffix, translatable:bool, level?}
```

- eventSeq 由 Redis 计数键 `tl:doc-seq:{taskId}` 生成（INCR 与 XADD 在同一 Lua 脚本中原子执行），跨 retry 与进程重启不回退；每条命令产生的事件携带该命令的 traceId
- 消费幂等：事件里带 `eventSeq`（每个任务内单调递增），Spring 记录每个任务已处理的最大 eventSeq，重复投递的事件直接 XACK 跳过
- 共享样例：`docs/contracts/doc-stream-sample.md`（任务 1.2）

### D3. 结构化解析与内容保护

- **Markdown**：用 markdown-it-py 解析出块级 token 及其源码行号范围，再按行号切回原文。每个块拆成 `prefix`（标记，如 `## `、`- `、`> `、`1. `、表格的 `| `）、`source`（需要翻译的正文）、`suffix`（行尾和块间换行）三部分，保证 `prefix + source + suffix` 逐字节拼回原文
  - fenced / indented 代码块、HTML 块、分隔线、空行标记为 `translatable=false`
  - 表格按行切分，单元格之间用 `|` 保留在 prefix/suffix 里，表头分隔行不翻译
- **TXT**：按空行切分段落，段内换行保留在 source 中
- **行内保护**：source 中的行内代码 `` `x` ``、URL、Markdown 链接目标 `](url)`、图片、HTML 标签、`{name}` / `%s` / `{{var}}` 占位符，在发给 LLM 前替换为 `⟦0⟧`、`⟦1⟧` 等标记，译后再还原。还原失败（标记丢失或重复）时，该段视为失败并单独重译一次，仍然失败则保留原文并在一致性报告中标出
- **决策**：组装（P6）由 Spring 按 `prefix + (target ?? source) + suffix` 拼接完成。**理由**：导出与后编辑都在 Spring，拼接规则简单且可以单元测试；Python 只需保证切分可逆

### D4. 分块

- 按段落累积，估算 token 达到目标值（默认 1800，上限 3000）时切块；**不跨一级、二级标题**，不拆开单个段落（超长段落单独成块）
- token 估算：中日韩字符按 1 计，其余按每 4 个字符 1 计（只用于分块，不需要精确）
- `group`：用于混合策略，取所属的二级标题章节编号（没有标题时都为 0）
- 只含不可翻译段落的块不调用 LLM，直接标记完成

### D5. 篇章图

```
START → parse → analyze → align_terms ─┬─ confirmTerms=false ─────────────┐
                                        └─ confirm_terms (interrupt) ──────┤
                                                                          ▼
                                                        plan_chunks → translate_groups (Send ×N) → consistency → finalize → END
```

| 节点 | 职责 | LLM |
|---|---|---|
| parse | D3 解析、语种识别（复用 ② 的 detector，取正文前 2000 字）、D4 分块；发出 `parsed` | 识别兜底时 |
| analyze | **全文摘要**：正文不超过 12k token 时一次调用，否则分章摘要再汇总（map-reduce）；同时判定领域和文体，并做**候选术语/专名抽取**（LLM 返回 JSON：源词、建议译法、类型、出现次数）。`options.globalSummary=false` 时跳过摘要，`options.termExtraction=false` 时跳过抽取 | 是 |
| align_terms | 合并候选：术语库命中（`GlossaryMatcher` 全文匹配）优先于抽取结果；同一源词保留术语库译法；过滤出现 1 次且非专名的候选；发出 `analysis` | 否 |
| confirm_terms | `interrupt({candidates})`；worker 发出 `awaiting_confirm` 后释放并发槽；收到 resume 时以用户确认的列表作为**任务术语表** | 否 |
| plan_chunks | 按策略把块编排成组：serial 为 1 组（全部块），parallel 为每块 1 组，hybrid 为每章 1 组 | 否 |
| translate_groups | 每组一个 `Send`，组内按顺序逐块执行：检查 `doc_chunk_result` 缓存 → 组装上下文 → 翻译（JSON 输出，按段 id 返回）→ 规则术语检查 → 评审（`options.review`）→ 最多 1 轮修正 → 更新滚动专名表 → 写缓存 → 发出 `chunk_done` 与 `trace`。组间并发受 `doc_chunk_concurrency` 限制（默认 3） | 是 |
| consistency | 对任务术语表和抽取出的专名，统计各段译文中实际使用的译法；同一源词出现多种译法时，以任务术语表的译法为准（没有则取多数），对不一致的段落做**定向修正**（只改该词，LLM 调用带上原文和当前译文）；发出 `consistency` | 仅修正时 |
| finalize | 汇总 usage、耗时、遵循率；发出 `completed` | 否 |

**分块翻译的上下文包**（复用 ② 的 TranslationContext，填充 doc_memory）：

```
system：角色 + 风格 + 领域 + 任务术语表（Markdown 表格） + 硬性规则（逐段对应、保留 ⟦n⟧、只输出 JSON）
user：  [全文摘要]（globalSummary）
        [已知专名译法]（滚动专名表，最多 40 条）
        [上文] 前一块的原文与译文的最后 2 段（contextWindow，且仅在组内串行时可用）
        [待译段落] JSON：{"segments":[{"id":seq,"text":"..."}]}
输出：  {"segments":[{"id":seq,"text":"..."}]}
```

- 输出的 id 集合与输入不一致时：对缺失的段落逐段补译；仍然失败则该块标记为失败，任务进入 FAILED（可以 retry）
- 段落之间的 JSON 结构不允许合并或拆分段落，以保证与原文逐段对齐（工作台的对照视图依赖这一点）

### D6. 断点续译：两级恢复

| 层级 | 机制 | 解决的问题 |
|---|---|---|
| 阶段级 | LangGraph `AsyncPostgresSaver`（schema `ai`，`thread_id=taskId`）；每个节点结束后保存检查点 | 术语确认的 interrupt / resume；重启后从最近完成的阶段继续 |
| 分块级 | `ai.doc_chunk_result(task_id, chunk_index, result jsonb, usage jsonb, created_at, PRIMARY KEY(task_id, chunk_index))`，每块完成后由 Python 写入 | translate_groups 是一个超步，检查点只在全部组结束后才保存；中途崩溃时依靠分块缓存跳过已完成的块，不重复调用 LLM |

- **恢复入口**：worker 启动时先 XAUTOCLAIM 认领闲置超过 60 秒的 pending 消息并重新执行；`retry` 命令同样调用 `graph.ainvoke(None, thread)` 继续执行。缓存命中的块仍会发出 `chunk_done`（`cached=true`），Spring 按 eventSeq 去重
- **决策**：逐块结果缓存放在 ai schema 中由 Python 写入，而不是让 Python 读 biz.doc_segment。**理由**：不扩大 tl_ai 的权限，同时与 LangGraph 状态解耦，便于在论文里清楚说明"两级恢复"
- 任务被删除时，Spring 发送 `cancel` 命令；Python 在任务终结后删除该任务的检查点和分块缓存（`purge`）

### D7. 取消与并发

- **取消**：Spring 把任务置为 CANCELLING，然后 XADD `cancel`；worker 维护 `taskId → asyncio.Task` 的映射，收到后取消对应协程（在途的 LLM 调用随之关闭），并发出 `cancelled`。任务如果正处于 AWAITING_CONFIRM（没有运行中的协程），直接发出 `cancelled`
- **并发**：Spring 在创建任务和 retry 时检查该用户 PENDING / 运行中状态的任务数 < 2（A0213）；worker 用信号量控制全局并发，AWAITING_CONFIRM 的任务不占用槽位
- 超过 30 分钟没有任何事件的运行中任务，由 Spring 定时任务标记为 FAILED（retryable），防止 worker 异常后任务永远停留在运行中

### D8. 一致性检查

- 检查对象：任务术语表（确认后的）加上滚动专名表中出现 2 次以上的专名
- 检测：对每个源词，找出原文含该词的所有段落，检查对应译文是否包含选定的译法；包含其他候选译法的视为"不一致"
- 修正：按段落批量调用 LLM 改写（每次最多 8 段，指令为"仅把 X 的译法统一为 Y，其他内容保持不变"），改写结果需要通过规则检查（包含 Y），否则保留原译文并在报告中标为"未能自动修正"
- 报告：`{term, variants:[{text, count}], chosen, fixedSegs, unresolvedSegs}`，前端在「一致性」标签页展示

### D9. 数据模型（Flyway V3）

```sql
biz.doc_task(id, user_id, title varchar(200), format varchar(8), source_text text, char_count int,
             source_lang, detected_lang, target_lang, style, domain, genre varchar(32), glossary_ids bigint[],
             model_config_id, strategy varchar(16), confirm_terms boolean, options jsonb,
             status varchar(24), phase varchar(24), progress_done int, progress_total int,
             summary text, consistency_report jsonb, stats jsonb, error_code varchar(8), error_message varchar(500),
             retryable boolean, last_event_seq int, last_event_at timestamptz,
             prompt_tokens int, completion_tokens int, latency_ms int,
             deleted, created_at, started_at, finished_at)
biz.doc_segment(id, task_id, seq int, block_type varchar(16), prefix text, source_text text, suffix text,
                translatable boolean, chunk_index int, target_text text, status varchar(16),
                review_score int, review_rounds int, compliance jsonb, edited boolean, updated_at,
                UNIQUE(task_id, seq))
biz.doc_task_term(id, task_id, source_term, target_term, origin varchar(16), frequency int,
                  status varchar(16) /* PENDING|CONFIRMED|REJECTED */, UNIQUE(task_id, lower(source_term)))
biz.doc_task_trace(id, task_id, seq int, node varchar(32), chunk_index int, status varchar(16), summary text,
                   latency_ms int, prompt_tokens int, completion_tokens int, created_at)
ai.doc_chunk_result(task_id bigint, chunk_index int, result jsonb, usage jsonb, created_at, PRIMARY KEY(task_id, chunk_index))
```

- 任务状态：`PENDING → PARSING → ANALYZING → (AWAITING_CONFIRM) → TRANSLATING → CONSISTENCY → COMPLETED`；任意阶段都可能进入 `FAILED`；`CANCELLING → CANCELLED`
- `ai.doc_chunk_result` 由 Spring Flyway 建表（DDL 唯一来源），tl_ai 对 ai schema 有完整权限

### D10. 对外接口（Spring）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/doc-tasks | multipart（`file` + `settings` JSON）或 JSON（`{title, text, format, ...settings}`）；校验 ≤ 5 万字符、格式、语种、术语库权限、并发数 |
| GET | /api/doc-tasks | 分页：`status?`、`keyword?`（标题） |
| GET | /api/doc-tasks/{id} | `DocTaskVO`（不含原文） |
| GET | /api/doc-tasks/{id}/segments | 返回全部段落（单篇上限约 3000 段，无需分页） |
| GET | /api/doc-tasks/{id}/events | SSE：先发 `snapshot`（`DocTaskVO`），再推送实时事件（phase / chunk_done / awaiting_confirm / consistency / completed / failed / cancelled，与流事件同名，data 为前端所需的精简形式）；每 15 秒心跳；任务终结后关闭 |
| GET | /api/doc-tasks/{id}/terms | 候选/确认的术语 |
| POST | /api/doc-tasks/{id}/terms/confirm | `{terms:[{source, target, status}]}`，仅在 AWAITING_CONFIRM 时允许（否则 A0431） |
| POST | /api/doc-tasks/{id}/cancel | 运行中或待确认时允许 |
| POST | /api/doc-tasks/{id}/retry | 仅 FAILED（retryable）或 CANCELLED 允许 |
| PUT | /api/doc-tasks/{id}/segments/{seq} | 后编辑 `{target}`，置 `edited=true` |
| POST | /api/doc-tasks/{id}/segments/{seq}/retranslate | 同步调用 Python 重译单段，返回新译文（不自动保存，前端确认后再 PUT） |
| GET | /api/doc-tasks/{id}/export | `format=md\|bilingual\|txt`；文件名为 UTF-8 编码 |
| DELETE | /api/doc-tasks/{id} | 逻辑删除；运行中的任务先取消 |

**新增错误码**：A0213 同时运行的文档任务过多（429）、A0430 文档为空、过大或格式不支持（400）、A0431 当前任务状态不允许该操作（409）、C0150 文档任务执行失败（502）

### D11. 单段重译（内部同步接口）

`POST /internal/doc/segment/retranslate {taskId, seq, source, prevSource?, prevTarget?, nextSource?, summary?, terms[], targetLang, style, domain, modelConfigId?, instruction?}` 返回 `{target, usage, latencyMs}`。由 Spring 从 doc_task / doc_segment / doc_task_term 组装上下文，Python 无状态执行。`instruction` 允许用户补充一句要求（如"更口语化"）。

### D12. 实验选项与策略（服务 ⑤）

| 消融组 | contextWindow | globalSummary | termExtraction | review | strategy |
|---|---|---|---|---|---|
| D0 逐段独立 | ✗ | ✗ | ✗ | ✗ | parallel |
| D1 + 前块上下文 | ✓ | ✗ | ✗ | ✗ | serial |
| D2 + 全文摘要 | ✓ | ✓ | ✗ | ✗ | serial |
| D3 + 术语抽取（自动确认） | ✓ | ✓ | ✓ | ✗ | serial |
| D4 + 评审修正 | ✓ | ✓ | ✓ | ✓ | serial |
| D5 并行 | ✓ | ✓ | ✓ | ✓ | parallel |

- 新建任务对话框中有可折叠的「实验选项」区，默认全部开启、策略为 serial；任务详情和列表显示所用配置，以便在 ⑤ 中按组统计
- D0 的"逐段独立"指块内仍按 JSON 批量翻译，但不带任何篇章上下文

### D13. 对外 DTO 与浏览器 SSE 事件契约（Spring ↔ Web）

字段一律 camelCase，时间为带时区偏移的 ISO-8601 字符串，状态枚举为大写字符串（见 D9）。

```
DocTaskVO    = {id, title, format, charCount, sourceLang, detectedLang, targetLang, style, domain, genre, glossaryIds,
                modelConfigId, strategy, confirmTerms, options:{contextWindow, globalSummary, termExtraction, review},
                status, phase, progressDone, progressTotal, summary, consistencyReport, stats,
                errorCode, errorMessage, retryable, promptTokens, completionTokens, latencyMs,
                createdAt, startedAt, finishedAt}
DocTaskSummaryVO = DocTaskVO 去掉 summary、consistencyReport、stats（列表用）
DocSegmentVO = {seq, blockType, level, prefix, source, suffix, translatable, chunkIndex, target, status,
                reviewScore, reviewRounds, compliance:[{source, target, compliant}], edited}
DocTermVO    = {id, source, target, origin:"glossary"|"extracted", frequency, status:"PENDING"|"CONFIRMED"|"REJECTED"}
ConsistencyReport = {issues:[{term, variants:[{text, count}], chosen, fixedSegs:[seq], unresolvedSegs:[seq]}]}
```

| 请求 | 结构 |
|---|---|
| 创建（JSON） | `{title?, text, format:"md"\|"txt", sourceLang, targetLang, style, domain?, glossaryIds?, modelConfigId?, strategy, confirmTerms, options?}` |
| 创建（multipart） | `file` + `settings`（上面除 text、format 外各字段的 JSON 字符串；format 由扩展名判定） |
| 术语确认 | `{terms:[{id?, source, target, status:"CONFIRMED"\|"REJECTED"}]}`（id 为空表示用户新增的术语） |
| 后编辑 | `PUT {target}` → `DocSegmentVO` |
| 单段重译 | `POST {instruction?}` → `{target, usage:{promptTokens, completionTokens}, latencyMs}` |

**浏览器 SSE（`GET /api/doc-tasks/{id}/events`）**：`event:` 为事件名，`data:` 为单行 JSON。

| event | data |
|---|---|
| `snapshot` | `DocTaskVO` |
| `phase` | `{status, phase}` |
| `parsed` | `{progressTotal, detectedLang}`（前端收到后重新拉取 segments） |
| `analysis` | `{summary, domain, genre}` |
| `awaiting_confirm` | `{terms:[DocTermVO]}` |
| `chunk_done` | `{chunk, progressDone, progressTotal, cached, segments:[{seq, target, reviewScore, reviewRounds, compliance}]}` |
| `consistency` | `{report: ConsistencyReport, segments:[{seq, target}]}` |
| `completed` | `DocTaskVO` |
| `failed` | `{code, message, retryable}` |
| `cancelled` | `{}` |
| 注释 `:ping` | 每 15 秒一次心跳 |

## UI/UX

### 信息架构

```
/documents  任务中心
┌─────────────────────────────────────────────────────────────────────┐
│ 标题区：文档翻译 · [+ 新建任务]          工具条：状态分段控件 · 搜索      │
├─────────────────────────────────────────────────────────────────────┤
│ 任务卡片网格（StaggerList 进场）：                                      │
│  ┌ 进度环 72% ┐ 标题 · en→zh · 串行 · 1.2 万字                         │
│  │ 状态徽标（翻译中，带脉冲）│ 阶段 4/6 · 预计剩余 · 更新时间               │
│  └───────────┘ 操作：打开 · 取消/继续 · 删除（⋯ 菜单）                    │
│ 空状态：插画 + "上传第一篇文档"                                          │
└─────────────────────────────────────────────────────────────────────┘
新建任务：三步对话框 ① 上传/粘贴（拖拽区、字数统计、格式识别）
                   ② 翻译设置（语种、风格、领域、术语库、策略卡片、确认术语开关、可折叠「实验选项」）
                   ③ 确认（摘要卡片 + 预估分块数与耗时）

/documents/[id]  任务工作区
┌──────────────────────────────────────────────────────────────────────────────────┐
│ 顶栏：← 标题 · 语言对 · 策略徽标      阶段步进条：解析 ▸ 分析 ▸ 术语 ▸ 翻译 ▸ 一致性 ▸ 完成   │
│        进度条（分块 7/12，带过渡动画） · 用量 · [导出 ▾] [取消/继续]                       │
├──────────────────────────────────────────────────────┬───────────────────────────┤
│ 双栏对照虚拟列表（原文 | 译文，按段对齐）                   │ 侧栏（标签页，可收起）：      │
│ · 标题/列表/代码块按 Markdown 语义渲染样式                  │  概览 | 术语 | 一致性 | 轨迹   │
│ · 翻译中的块：骨架微光；完成的块：淡入 + 左侧色条             │ 选中段落时切换为「段落详情」：  │
│ · 术语高亮、未遵循标红、已编辑徽标                         │  评审分、遵循情况、            │
│ · 悬停段落显示 [编辑] [重译]，编辑为行内编辑器              │  重译（可附加要求）、历史      │
└──────────────────────────────────────────────────────┴───────────────────────────┘
AWAITING_CONFIRM：侧栏自动切到「术语」，以可编辑表格展示候选（来源徽标、频次、建议译法），
                 批量接受/拒绝；底部固定「确认并继续翻译」；顶栏出现呼吸提示
```

### 动效清单

| 场景 | 动效 |
|---|---|
| 阶段步进条 | 当前阶段脉冲光环，完成时打勾并填充连接线（layout 动画） |
| 进度 | 进度条与进度环平滑过渡，数字滚动（NumberTicker） |
| 分块完成 | 对应段落的译文淡入，左侧色条从灰变为品牌色，自动滚动跟随可开关 |
| 术语确认 | 侧栏切换为滑入动画，候选行逐行进场 |
| 一致性修正 | 被修正的段落闪烁高亮一次，悬停显示"已统一为 X" |
| 新建对话框 | 步骤之间横向滑动切换（与 ② 的导入对话框一致） |
| 状态徽标 | 运行中呼吸、完成/失败颜色过渡 |

所有动效复用 `src/components/motion/` 并尊重 reduced-motion。

## Risks / Trade-offs

- [LLM 未按段返回 JSON（合并、漏段、改写标记）] → 校验 id 集合与 ⟦n⟧ 标记，缺失时逐段补译；分块不超过 3000 token 以降低出错率；单测覆盖各种畸形输出
- [长任务受上游抖动影响] → 适配层已有重试；块级缓存保证失败后 retry 只补未完成的块；任务失败默认可重试
- [事件重复投递导致进度错乱] → eventSeq 幂等；落库与 XACK 顺序为"先落库后确认"
- [并行策略下的专名漂移] → 并行时只有全局摘要和任务术语表，不共享滚动专名表；这正是 D5 实验要量化的现象，再由一致性阶段兜底修正
- [Markdown 切分不可逆导致导出走样] → 解析器单测断言 `拼接(全部段) == 原文`（逐字节），覆盖标题、嵌套列表、表格、代码块、HTML、CRLF
- [SSE 订阅晚于事件] → 订阅时先发送 snapshot，前端以 snapshot 加增量事件合成状态；断线重连时重新获取 snapshot
- [单篇 3000 段的前端渲染] → @tanstack/react-virtual 虚拟列表，按段落高度动态测量

## Migration Plan

- Flyway V3 只新增表；Redis 消费组在 Spring 和 Python 启动时幂等创建（`XGROUP CREATE ... MKSTREAM`，已存在时忽略 BUSYGROUP 错误）
- LangGraph checkpointer 首次启动时执行 `setup()`，在 ai schema 中建表
- 回滚：删除新表与两条 Stream 即可，不影响 ①②

## Open Questions

- 分块目标 token（1800）、并发（3）、评审修正轮次（1）是经验值，⑤ 的实验可能调整，都放进 settings
- 后编辑结果写入翻译记忆留到 ④；本次仅在 doc_segment 中标记 `edited`
