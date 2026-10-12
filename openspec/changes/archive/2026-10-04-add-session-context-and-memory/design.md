## Context

### 已有基础

- **短文本**：
  - 七节点图（analyze → plan → retrieve → translate → review ⇄ refine → finalize），编译时**没有**检查点。
  - Spring 两跳转发 SSE，翻译成功后写入 `biz.translation_record`。
  - plan 节点在标准路径、用户未指定领域时会调用一次 LLM 判定领域（`_judge_domain`）。
- **上下文包**：`TranslationContext` 已预留 `tm_examples`、`session_ctx`。`app/agent/prompts.py` 中已经有 `tm_examples` 的渲染分支，但从未被填充。
- **文档**：
  - 段落后编辑接口 `PUT /api/doc-tasks/{id}/segments/{seq}`。
  - 篇章图使用 AsyncPostgresSaver（ai schema），状态全部是普通 dict，规避了自定义类型的序列化问题。
- **数据库**：
  - `vector`、`pg_trgm` 扩展已经安装。
  - Flyway 是全部 DDL 的唯一来源，ai schema 的业务表也在 Flyway 中，通过 `${ai_role}` 占位符授权。
  - Python（tl_ai）读写 ai schema，Spring（tl_app）只写 biz。
- **LLM**：测试中转站只提供对话模型（`/v1/models` 中没有 embedding 模型）。

### 约束

- 单人开发，周期有限。
- 本机内存紧张：JVM 和 Node 都已限制堆大小。
- 能访问 HuggingFace 镜像。

## Goals / Non-Goals

**Goals:**

- 会话中的多轮翻译能利用前文，修订和追问都在同一套事件协议与工作台中完成，演示直观。
- 翻译记忆能沉淀用户确认过的译法，并在短文本和文档翻译中以 few-shot 方式复用，命中情况可观测。
- 会话记忆与篇章记忆在概念上共用 ContextMemory 抽象（短期窗口、长期摘要、实体表），论文中可以统一论述。
- 用三组小实验给出可写进论文的数据。

**Non-Goals:**

- 不做会话 A（双人对话模拟）、TM 100% 匹配直接复用、TMX 导入导出、共享翻译记忆、外部 embedding API。
- 不在快速路径和非会话请求中做歧义追问。

## Decisions

### D1 会话的数据归属：Spring 持有会话与记忆，Python 无状态计算

- **决策**：
  - 新建 `biz.translation_session`，字段如下：

    | 字段 | 说明 |
    |---|---|
    | id、user_id、title | 基本信息 |
    | source_lang、target_lang、style、domain、glossary_ids、model_config_id | 会话级默认翻译参数 |
    | clarify_enabled | 是否允许歧义追问 |
    | memory_summary | 早期轮次的摘要 |
    | memory_entities | 实体表，jsonb |
    | memorized_until | 已压缩到第几轮 |
    | pending | jsonb，等待回答的追问 |
    | turn_count、created_at、updated_at、deleted | 统计与通用字段 |

  - 每一轮就是一条 `translation_record`，新增 `session_id` 和 `revision_of`（修订来源记录）两列。只有成功完成的轮次才写记录，这一点不变。
  - 发起会话内翻译时，Spring 组装 `session` 载荷交给 Python：

    ```
    {recentTurns: [{source, target, instruction?}], summary, entities: [{source, target, note}]}
    ```

    其中 recentTurns 取最近 6 轮已完成的翻译，修订轮只取每个分支的最终版本。
  - Python 返回的 `memory` 事件携带更新后的摘要和实体表，由 Spring 写回会话。
- **备选方案**：
  - A. 会话状态全部放在 LangGraph 检查点里，thread 为会话：查询和删除都要穿透检查点，Spring 无法管理会话列表，也违背"Spring 是业务数据唯一写入方"。
  - B. Python 直接读 biz 表组装上下文：扩大 tl_ai 的读权限，耦合加重。
- **理由**：沿用已有分工（Spring 管业务数据，Python 做计算），Python 保持无状态，便于测试和水平扩展；会话的列表、删除和权限都在 Spring 一侧完成。

### D2 会话记忆：滑动窗口 + 增量压缩 + 实体表（ContextMemory 的会话策略）

- **决策**：
  - **短期窗口**：最近 6 轮原文与译文全量进入提示词（「会话上下文」小节）。
  - **长期摘要与实体表**：
    - 已完成轮数超过窗口，并且距上次压缩新增了 ≥3 轮时，finalize 之后执行一个 `memorize` 节点。
    - 该节点用一次 LLM 调用，把滑出窗口的轮次并入摘要（不超过 300 字），同时更新实体表。实体包括人名、称谓、产品名及其已用译法，最多 30 条。
    - 结果通过 `memory` 事件返回。
  - 修订轮不触发压缩。
  - `memorize` 失败只记警告，不影响本轮结果。
  - 实体表在提示词中作为"会话专名表（沿用已有译法）"，与篇章路径的滚动专名表同构。
- **备选方案**：
  - 每轮都压缩：成本翻倍。
  - 只用窗口：长会话丢失早期称谓。
  - 向量检索历史轮次：对短会话收益小，增加复杂度。
- **理由**：这正是总体设计 §4.4 的"最近 N 轮 + 早期摘要 + 实体表"。按批次压缩的做法与篇章的滚动摘要一致，成本可控（每 3 轮最多一次额外调用）。

### D3 迭代修订：同一张图上的 `revise` 路径

- **决策**：
  - 新增修订接口：

    ```
    POST /api/translate/sessions/{id}/revise
    body: {recordId, instruction}
    ```

    以 SSE 返回。Spring 校验 recordId 属于该会话，把原文、当前译文、修订要求和会话载荷一起转发。
  - Python 请求体中 `mode=revise`：
    - plan 选择 `path=revise`，跳过 analyze 的语种识别（沿用原记录的语种）、retrieve 和 review。
    - translate 节点改用修订提示词：原文、当前译文、修订要求、会话上下文、术语。
  - 成功后写一条新记录：`revision_of=recordId`，`mode=revise`，`instruction` 存入新增列 `revise_instruction`。
  - 工作台按 `revision_of` 把同一轮的多个版本显示为版本条（v1 → v2 → v3），可以切换"当前采用"。
  - 采用状态由会话的 recentTurns 组装逻辑决定：每个分支取最新版本，或用户切换后指定的版本。为此 record 增加 `adopted` 列，同一分支只有一条为 true。
- **备选方案**：
  - 单独新建一张修订图：事件协议和时间线组件都要重写一份。
  - 修订时重新走完整标准路径：成本高，而且会丢失"只改用户指出的部分"这一语义。
- **理由**：复用节点事件、轨迹落库和前端时间线，修订在 UI 上与普通翻译一致可观测；版本链用一个外键就能表达。

### D4 歧义追问：plan 合并检测 + LangGraph interrupt + 检查点

- **检测**：
  - 会话请求、标准路径、`clarify_enabled=true` 且原文不超过 500 字符时，plan 节点把领域判定和歧义检查合并为一次 JSON 调用：

    ```
    {domain, ambiguity: {ambiguous, span, question, options[2-4], reason}}
    ```

  - 用户已指定领域时，这次调用只做歧义检查。
  - 提示词要求只报告"不澄清就可能译错、且上下文与会话记忆都无法消解"的歧义，例如多义词、性别或称谓、指代、单复数。这是为了抑制误报。
- **中断**：
  - 判定为歧义时进入 `clarify` 节点，节点调用 `interrupt({question, options, span, reason})`。
  - 图编译时带 AsyncPostgresSaver（与文档共用 ai schema 的检查点表），`thread_id = "turn:{requestId}"`。
  - 仅在可能追问的请求上启用检查点：短文本编译两个变体，`graph`（无检查点）和 `graph_hitl`（有检查点）。不追问的请求零开销。
- **序列化**：短文本状态中含有 `Review`、`TermHit`、`TranslationContext` 等 dataclass。为检查点配置 `JsonPlusSerializer`，把这些类型加入 msgpack 白名单（`allowed_msgpack_modules`），并通过往返测试保证恢复后的类型与字段一致。
- **事件**：
  - 中断后，Python 推送 `clarify` 事件：

    ```
    {threadId, question, options, span, reason}
    ```

    然后结束事件流（不发 `final`）。
  - Spring 把 `{threadId, question, options, span, source}` 写入会话的 `pending`，前端显示追问卡片。
- **恢复**：
  - 回答接口：

    ```
    POST /api/translate/sessions/{id}/clarify
    body: {threadId, answer}
    ```

    以 SSE 返回。answer 可以是选项，也可以是自由文本。
  - Spring 校验 threadId 与 pending 一致后，转发到 `/internal/translate/resume`。
  - Python 以 `Command(resume=answer)` 从断点继续：clarify 节点把"用户澄清：「span」指 answer"写入上下文，然后依次执行 retrieve → translate → review → finalize。
  - 恢复成功后，Spring 清空 pending，并照常写入记录。记录的 `clarification` 列（jsonb）保存问答。
- **放弃与清理**：
  - 用户在 pending 未回答时发起新一轮翻译，视为放弃：Spring 清空 pending，并通知 Python 删除该 thread。
  - Python 每小时清理一次超过 24 小时的 `turn:*` thread。
  - 正常完成后立即删除 thread。
- **备选方案**：
  - A. 无状态两段式（把分析结果作为令牌交给前端，回答时重新进入图）：实现简单，但不是真正的断点续跑，论文中"人机协同（interrupt）"的论证弱，还要防止令牌被篡改。
  - B. 先翻译，再在结果旁边提示歧义：不打断流程，但已经花了翻译成本，而且译错的版本已经展示给用户。
  - C. 单独增加一个歧义检测节点：每次多一次 LLM 调用。
- **理由**：
  - 与文档的术语确认采用同一机制（interrupt + 检查点 + resume），架构统一。
  - 检测并入已有的 plan 调用，不增加调用次数。
  - 检查点只在可能追问的请求上启用，普通请求零开销。

### D5 翻译记忆的存储与写入：Python 持有 ai.translation_memory

- **表结构**（Flyway V5 创建，授权 tl_ai）：

  | 字段 | 说明 |
  |---|---|
  | id | 主键 |
  | user_id | 所属用户 |
  | source_lang、target_lang | 语言对 |
  | source_text、target_text | 原文与译文 |
  | source_norm | 规范化原文：去首尾空白、合并空白、小写化（仅拉丁字母） |
  | source_hash | 规范化原文的 md5 |
  | embedding | vector(384) |
  | origin | workbench / document |
  | origin_ref | 记录 id 或 "taskId:seq" |
  | hit_count、last_hit_at | 命中统计 |
  | created_at、updated_at | 时间 |

  - 唯一键 `(user_id, source_lang, target_lang, source_hash)`：同一原文再次写入时覆盖译文（以最新确认为准）。
  - 索引：
    - `embedding` 上建 HNSW（`vector_cosine_ops`）。
    - `source_norm` 上建 gin（`public.gin_trgm_ops`）。
    - 另建 `(user_id, source_lang, target_lang)`。
- **写入**：只经 Python 内部接口。embedding 在 Python 中计算，Spring 不碰 ai schema。
  - `POST /internal/tm/entries`：批量 upsert，单次最多 200 条，原文 1–5000 字符。
  - `GET /internal/tm/entries`：分页列表与关键词检索。
  - `DELETE /internal/tm/entries/{id}`：删除，必须带 userId 校验归属。
  - `POST /internal/tm/search`：检索，供调试与前端"相似译法"使用。
- **三种来源**：
  1. **工作台「存入记忆」**：`POST /api/tm/from-record/{recordId}`，Spring 校验记录归属后转发。
  2. **文档段落后编辑保存**：Spring 在 `editSegment` 事务提交后**异步**调用写入。失败只记日志，不影响编辑。只写可翻译段，原文使用去掉行内标记的纯文本。
  3. **文档一键写入**：`POST /api/doc-tasks/{id}/memory`，把 COMPLETED 任务中所有已有译文的可翻译段批量写入，返回写入条数。
- **备选方案**：
  - Spring 写表、Python 异步补 embedding：需要补偿队列，而且 Spring 要获得 ai schema 写权限。
  - 放在 biz schema：违背"向量与 Agent 状态在 ai schema"的划分。
- **理由**：写入和检索都需要 embedding，集中在 Python 最简单；Spring 只负责鉴权与转发，与模型连通性测试等现有接口的模式一致。

### D6 Embedding 与混合检索

- **Embedding 选型**：
  - 使用本地 `fastembed`（ONNX Runtime，无需 torch），模型 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`：384 维，支持 50 多种语言，约 220 MB，单句 CPU 推理为毫秒级。
  - 首次使用时下载到 `python-backend/.cache/models`，可以用 `HF_ENDPOINT` 指定镜像。
  - 启动时后台预热，失败时翻译记忆功能降级：检索返回空，写入报 `C0160`（翻译记忆服务不可用），翻译本身不受影响。
  - `EmbeddingProvider` 抽象只实现 `local`，留出 `openai` 的扩展点（使用时必须支持 `dimensions=384`）。
- **检索流程**（一次查询）：
  1. 同时召回两路候选：
     - 向量路：`ORDER BY embedding <=> q LIMIT 20`，同用户、同语言对。
     - 字面路：`similarity(source_norm, q_norm) > 0.3 ORDER BY similarity DESC LIMIT 20`。
  2. 合并去重后，在 Python 中计算 **模糊匹配度** `fuzzy = difflib.SequenceMatcher(None, a_norm, b_norm).ratio()`。这是字符级的，近似 CAT 工具的编辑距离匹配度。
  3. 同时保留语义相似度 `semantic = 1 - cosine_distance`。
  4. 入选规则为 `fuzzy ≥ 0.6` 或 `semantic ≥ 0.65`（实现时实测：该模型对同义改写的相似度约 0.66，原定 0.85 几乎不可达，故下调；阈值可配置）。按 `max(fuzzy, semantic × 0.9)` 降序取前 3 条。
  5. 返回字段：`{id, source, target, fuzzy, semantic, origin}`。完全相同（`fuzzy = 1`）的标记为"100% 匹配"。
  6. 命中的条目更新 `hit_count`。
- **备选方案**：
  - 只用向量：语义相近、字面差异大的句子会被当作高匹配，与译者熟悉的 CAT 匹配度概念不符。
  - 只用 trigram：同义改写召回差。
  - bge-m3（1024 维，2.2 GB）：内存吃紧，下载慢。
  - 外部 embedding API：中转站不提供。
- **理由**：两路召回兼顾字面复用（CAT 场景的主体）和语义改写。匹配度用百分比展示，译者能理解，论文中也容易解释。

### D7 翻译记忆在翻译中的使用

- **短文本**：
  - 标准路径的 retrieve 节点检索后，把结果作为 `tm_examples` 写入提示词，小节标题为「翻译记忆（用户确认过的相似译文，供参考译法与风格）」。
  - 推送 `memory` 类节点摘要："命中 2 条翻译记忆（最高 92%）"，命中明细放在 retrieve 节点事件的 `tmHits` 中。
  - 快速路径不检索，保持低延迟。
- **会话**：同上，会话内的标准路径同样检索。
- **文档**：
  - 新增实验选项 `translationMemory`，默认 true。
  - 每块翻译前，对块内每个可翻译段检索。每段取最高 1 条，`fuzzy ≥ 0.7` 或 `semantic ≥ 0.75` 才入选；全块最多 8 条，按得分排序。结果写入分块提示词的「翻译记忆参考」小节。
  - 命中写入 chunk_result 的 `tmHits: [{seq, fuzzy, origin}]` 和轨迹摘要。
  - 检索失败时降级为空，不让任务失败。
  - 段落详情显示该段的记忆命中。
- **备选方案**：
  - 按块整体检索：块是多段拼接，相似度意义不大。
  - 全部段落都检索 top-3：提示词膨胀。
- **理由**：每段取最佳一条最贴近 CAT 的用法，只放高置信命中，避免干扰。命中可观测，便于在实验中归因。

### D8 评测设计

| 实验 | 设计 | 指标 |
|---|---|---|
| E1 翻译记忆留一法 | 专用评测用户先按 I3 配置把 5 篇各翻译一次作为来源（I3 结果属于管理员，记忆按用户隔离）；对每篇，用其余 4 篇来源的译文写入该用户的记忆库，模拟"已后编辑的历史译文"；然后按 I1 配置翻译该篇，分为 `translationMemory` 关和开两组，各 1 轮，共 10 次 | chrF、术语准确率、术语一致率、每块平均命中数、token |
| E2 会话上下文 | 自建 12 段英文客服对话，每段 5 轮，包含代词指代、省略、称谓与性别、前文专名等现象，每轮标注"需上下文才能正确翻译的片段及正确译法"。逐轮翻译，比较无会话（每轮独立）与有会话两组 | 现象准确率（由 LLM 评审逐项判定标注片段是否译对）；成对偏好（评审模型不知道版本来源，比较整段对话哪组更连贯） |
| E3 歧义检测 | 自建 20 句有歧义的句子（标注歧义片段）和 20 句无歧义句，在会话中以标准路径提交 | 追问触发的精确率、召回率，以及 plan 节点增加的耗时 |

- E2 和 E3 的测试集由本人编写，写明构造原则，作为局限说明。
- 评审模型沿用 gpt-6-luna。
- 结果写入实验报告第 10 节。

### D9 接口契约

**Spring 对外接口（均需登录，资源按用户隔离，他人资源返回 `A0404`）：**

| 接口 | 说明 |
|---|---|
| `POST /api/translate/sessions` | 创建会话，`{title?, sourceLang, targetLang, style?, domain?, glossaryIds?, modelConfigId?, clarifyEnabled?=true}`，返回 SessionVO |
| `GET /api/translate/sessions?pageNum&pageSize&keyword` | 会话列表，按更新时间倒序 |
| `GET /api/translate/sessions/{id}` | 详情，含 turns（按 seq 的记录列表，每轮带版本链）、pending、记忆摘要与实体表 |
| `PUT /api/translate/sessions/{id}` | 修改标题与默认参数 |
| `DELETE /api/translate/sessions/{id}` | 逻辑删除；会话内记录保留在历史中，`session_id` 不变 |
| `POST /api/translate/stream` | 新增可选 `sessionId`：带上时使用会话的默认参数（请求中显式给出的参数优先）并注入会话载荷；会话有 pending 时视为放弃该追问 |
| `POST /api/translate/sessions/{id}/revise` | `{recordId, instruction(1–500)}`，SSE；recordId 不在该会话时返回 `A0404` |
| `POST /api/translate/sessions/{id}/clarify` | `{threadId, answer(1–200)}`，SSE；没有 pending 或 threadId 不一致时返回 `A0440`（追问已失效） |
| `PUT /api/translate/sessions/{id}/records/{recordId}/adopt` | 设为该分支的采用版本 |
| `GET /api/tm?pageNum&pageSize&keyword&sourceLang&targetLang` | 记忆列表 |
| `DELETE /api/tm/{id}` | 删除记忆 |
| `POST /api/tm/from-record/{recordId}` | 把翻译记录写入记忆，返回条目 |
| `POST /api/tm/search` | `{text, sourceLang, targetLang}`，返回命中（供工作台"相似译法"） |
| `POST /api/doc-tasks/{id}/memory` | 把已完成任务的译文写入记忆，返回 `{written}` |

**新增错误码：**
- `A0440` 追问已失效
- `C0160` 翻译记忆服务不可用
- `A0214` 会话中已有进行中的翻译（409）

**Spring → Python 内部接口：**

- `POST /internal/translate/stream` 的请求体新增：

  ```
  session: {sessionId, recentTurns, summary, entities, clarifyEnabled, memorizedUntil, turnCount} | null
  revise:  {baseSource, baseTarget, instruction} | null
  ```

  其中 `mode` 新增取值 `revise`。
- `POST /internal/translate/resume`：`{threadId, answer, userId, session}`，返回 SSE。
- `DELETE /internal/translate/threads/{threadId}`：放弃追问。
- `/internal/tm/*`：见 D5。
- 文档 start/retry 的 `options` 新增 `translationMemory`，payload 中的 `userId` 用于确定记忆库。

**SSE 事件（新增）：**

- `clarify`：

  ```
  {threadId, question, options, span, reason}
  ```

  它是终止事件，之后不再有 `final`。
- `memory`：

  ```
  {summary, entities, memorizedUntil}
  ```

  在 `final` 之前推送，只在执行了压缩时出现。
- `node(retrieve)` 的 data 新增 `tmHits`。
- `final` 新增 `sessionId`、`revisionOf`、`clarification`。

## UI/UX

### 信息架构

- **翻译工作台**（`/translate`），保持左右分栏：
  - **顶栏左侧**：新增「单次 / 会话」分段切换。
  - **会话模式**：
    - 左侧出现可收起的会话列表抽屉：新建会话、搜索、按时间分组（今天 / 更早）、重命名、删除。
    - 原文区下方出现**对话线程**。每轮一张卡片：原文摘要、当前采用的译文、版本条（v1 · v2 · v3），以及可展开的修订要求和追问问答。
    - 线程底部是**修订输入框**，作用于当前选中的轮次，带快捷要求芯片：更口语、更正式、更简洁、保持术语。
  - **追问卡片**：等待回答时，在译文区顶部以醒目卡片显示问题、高亮的歧义片段、选项按钮和"其他…"自由输入；回答后卡片收起，翻译继续。
  - **Agent 面板**：新增「记忆」标签页，显示本次命中的翻译记忆，包括匹配度徽章（100% / 92% / 语义）、原文差异高亮（与当前原文逐字对比）、来源。
  - **译文区操作**：新增「存入记忆」，存入后按钮变为"已存入"。
- **翻译记忆页**（`/memory`，侧边导航"翻译"分组下），主从布局：
  - 左侧是带语言对筛选和关键词检索的虚拟列表。
  - 右侧显示条目详情：原文、译文、来源（链接到历史记录或文档段落）、命中次数和最近命中时间，以及删除操作。
  - 空状态引导："在工作台点击「存入记忆」，或编辑文档段落后自动积累"。
- **文档工作区**：
  - 段落详情新增"翻译记忆"区块。
  - 任务「更多」菜单新增「写入翻译记忆」，确认弹窗中显示将写入的段数。
  - 新建任务对话框的实验选项中新增"翻译记忆"开关。

### 关键交互流程

1. **会话翻译**：用户切到会话模式 → 新建会话 → 连续输入三句客服回复并逐句翻译 → 第二句中的 "it" 正确指代第一句中的产品 → Agent 时间线的 retrieve 节点显示"会话上下文 2 轮"。
2. **修订**：用户选中第 2 轮 → 点"更口语"芯片 → 时间线走 revise 路径 → 线程卡片出现 v2 并自动采用 → 可以点 v1 切回。
3. **追问**：用户输入 "Please send it to the bank." → 时间线 plan 节点后出现"等待澄清"状态 → 追问卡片问「bank 指银行还是河岸/堤岸？」→ 用户点"银行" → 时间线继续，最终译文正确，线程卡片中可以展开问答。
4. **翻译记忆**：用户对一个满意的译文点「存入记忆」→ 之后翻译相似句子 → 「记忆」标签页显示 88% 匹配，原文差异部分高亮 → 译文沿用了记忆中的措辞。

### 动效清单（motion，尊重 `prefers-reduced-motion`）

- 会话抽屉：从左侧滑入加淡入，250ms；列表项新增时高度展开。
- 对话线程：新一轮卡片从下方淡入上移，200ms；版本切换时译文交叉淡化，150ms；版本条的选中滑块使用 `layoutId`。
- 追问卡片：弹簧缩放（0.96 → 1）加淡入；回答后高度收起；歧义片段高亮带一次脉冲。
- 「存入记忆」：图标从书签描边变为实心，伴随一次 scale 弹跳。
- 记忆页：主从切换时详情面板交叉淡化；删除时列表项高度收起。
- 匹配度徽章：数字从 0 计数到目标值，400ms（reduced-motion 下直接显示）。

## Risks / Trade-offs

- **[歧义检测误报打断用户]** → 只在会话加标准路径时启用，会话级开关可关闭；提示词限定"不澄清就可能译错"；E3 测量精确率，误报率高时在报告中讨论阈值。
- **[检查点序列化自定义 dataclass 出错]** → 配置 msgpack 白名单；为每个状态类型写检查点往返测试；中断状态只保存到 clarify 节点为止的字段。
- **[embedding 模型下载失败或内存不足]** → 模型懒加载并后台预热；失败时翻译记忆降级（检索为空、写入返回 C0160），翻译不受影响；模型约 220 MB，ONNX 推理常驻内存约 300 MB，在本机可接受；支持 `HF_ENDPOINT` 镜像。
- **[翻译记忆中有错误译法，被当作参考放大]** → 记忆只来自用户明确确认的来源（存入记忆、后编辑、一键写入）；提示词中明确是"参考"而非"必须"；匹配度过低不注入。与 ⑥ 的软约束思路一致。
- **[会话载荷过大]** → 窗口 6 轮，每轮原文截断到 500 字符，摘要不超过 300 字，实体最多 30 条；总量超过 4000 字符时从最早的轮次开始丢弃。
- **[E2/E3 测试集自建、规模小]** → 写明构造原则与局限；E2 用逐项现象判定加成对偏好两种方式交叉印证。
- **[pending 追问与并发请求冲突]** → 每个会话同一时间只允许一个进行中的流（Spring 端用会话级 Redis 锁，冲突返回 `A0214`（会话中已有进行中的翻译）），新请求会放弃 pending。

## Migration Plan

1. Flyway `V5__session_memory.sql`：
   - 新建 `biz.translation_session`。
   - `biz.translation_record` 加列：`session_id`、`revision_of`、`revise_instruction`、`adopted`（默认 true）、`clarification` jsonb，以及索引 `(session_id, created_at)`。
   - 新建 `ai.translation_memory` 及其索引，并 `GRANT ALL ... TO ${ai_role}`。
   - 存量记录的新列为 null 或默认值，行为不变。
2. Python 新增依赖 `fastembed`，`.env.example` 增加 `TM_EMBEDDING_MODEL`、`HF_ENDPOINT`（可选）、`TM_ENABLED`。
3. 依次部署 Spring、Python 和前端。旧请求不带 `session`/`revise` 字段，Python 按 null 处理。
4. 回滚：V5 都是加表加列。回滚代码后，新表和新列闲置即可。

## Open Questions

（无。歧义检测的误报控制，按 E3 的结果在报告中讨论即可，不阻塞实现。）
