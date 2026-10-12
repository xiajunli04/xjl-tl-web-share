## 1. infra / 数据库

- [x] 1.1 新增 Flyway `V5__session_memory.sql`，完成以下改动并补全注释：
  - 新建 `biz.translation_session`，字段见 design D1。
  - `biz.translation_record` 加列 `session_id`、`revision_of`、`revise_instruction`、`adopted`（默认 true）、`clarification` jsonb，并建索引 `(session_id, created_at)`。
  - 新建 `ai.translation_memory`：唯一键 `(user_id, source_lang, target_lang, source_hash)`，`embedding` 上建 HNSW `vector_cosine_ops`，`source_norm` 上建 gin `public.gin_trgm_ops`，`GRANT ALL ... TO ${ai_role}`。

  验证：Testcontainers 迁移测试通过；`tl_ai` 角色可以对 `ai.translation_memory` 执行 insert/select/delete；`tl_app` 不能写该表。
- [x] 1.2 `.env.example` 增加 `TM_ENABLED`、`TM_EMBEDDING_MODEL`、`HF_ENDPOINT`（可选）和 `TM_MODEL_CACHE_DIR`，并写好说明。`.gitignore` 加入 `python-backend/.cache/`。验证：`git check-ignore python-backend/.cache/models/x` 命中。

## 2. python-backend

- [x] 2.1 `app/memory/embedding.py`：
  - 实现 `EmbeddingProvider` 抽象与 `LocalEmbedding`（fastembed `paraphrase-multilingual-MiniLM-L12-v2`，384 维），懒加载，启动时后台预热，提供 `available` 状态，加载失败后降级。
  - `pyproject` 加入 fastembed。
  - 测试使用假 provider。

  验证：单测覆盖维度、降级；用真实模型手动编码一次，输出 384 维。
- [x] 2.2 `app/memory/tm.py`：
  - 规范化与 hash。
  - `upsert`：批量最多 200 条，冲突时覆盖。
  - `search`：向量与三元组两路召回，合并后计算 difflib fuzzy 与 semantic，按入选规则排序取前 k 条，并更新 hit_count。
  - `list` 与 `delete`：校验 user_id。

  验证：在 PG 测试库上单测覆盖"重复写入覆盖""用户隔离""字面近似命中""语义改写命中"（用确定性的假向量构造）、"模型不可用时检索为空"。
- [x] 2.3 新增内部接口 `/internal/tm/entries`（POST、GET）、`/internal/tm/entries/{id}`（DELETE）和 `/internal/tm/search`。模型不可用时写入返回 `C0160`。验证：API 测试覆盖鉴权（X-Internal-Token）、参数校验、C0160。
- [x] 2.4 `TranslateRequest` 增加 `session` 与 `revise` 字段，`mode` 增加 `revise`。
  - `context_sections` 新增「会话上下文」「会话专名表」「翻译记忆」三个小节的渲染，并按 design 截断（每轮 500 字符，总量 4000 字符）。
  - retrieve 节点检索翻译记忆，节点事件附带 `tmHits`。

  验证：提示词快照测试；retrieve 节点测试覆盖"注入翻译记忆"和"模型不可用"。
- [x] 2.5 修订路径：plan 识别 `mode=revise` 后走 `path=revise`，跳过 retrieve/review/refine；translate 使用修订提示词；final 带 `revisionOf`。验证：图测试覆盖"修订路径"场景和事件顺序。
- [x] 2.6 歧义检测：
  - plan 在会话请求、标准路径、`clarifyEnabled` 且原文不超过 500 字符时，把领域判定与歧义检查合并为一次 JSON 调用；用户已指定领域时只做歧义检查。
  - 新增 `clarify` 节点调用 `interrupt`。

  验证：单测覆盖触发、不触发（无额外调用）、关闭追问、快速路径与修订不追问。
- [x] 2.7 检查点与恢复：
  - 编译 `graph_hitl`：AsyncPostgresSaver，`JsonPlusSerializer` 配置 msgpack 白名单，`thread_id = "turn:{requestId}"`。
  - 中断时推送 `clarify` 事件并结束事件流。
  - 新增 `/internal/translate/resume`（以 `Command(resume)` 继续，SSE）和 `DELETE /internal/translate/threads/{id}`。
  - 完成后删除 thread；每小时清理超过 24 小时的 `turn:*` thread。

  验证：检查点往返测试（每个状态 dataclass）；端到端测试覆盖"追问后继续"（同一 thread 恢复、轨迹连续）和"放弃后删除"。
- [x] 2.8 memorize 节点：满足压缩条件时，一次 LLM 调用更新摘要与实体表，推送 `memory` 事件；失败只记警告。验证：单测覆盖"触发压缩""压缩失败""修订不压缩"。
- [x] 2.9 文档分块检索翻译记忆：
  - `DocOptionsModel` 增加 `translationMemory`（缺省 true）。
  - 每块按段检索，入选阈值 0.7 / 0.75，全块最多 8 条，写入「翻译记忆参考」小节。
  - chunk_result 和轨迹记录 `tmHits`；检索失败时降级。

  验证：文档图测试覆盖"段落命中记忆""关闭记忆""记忆服务不可用"。
- [x] 2.10 全量 `pytest` 与 `ruff` 通过，覆盖率不低于 95%。真实冒烟：下载模型并写入、检索一次；用真实 LLM 跑一次会话追问与恢复。

## 3. springboot-backend

- [x] 3.1 会话模块 `module/session`：实体与 Mapper，`POST/GET/PUT/DELETE /api/translate/sessions`，详情按轮次组装版本链与采用版本。用户隔离，他人资源返回 A0404。验证：集成测试覆盖 CRUD、隔离、删除后记录保留。
- [x] 3.2 `TranslateRequest` 增加 `sessionId`：
  - 合并会话默认参数；组装 `session` 载荷（窗口、截断、采用版本）。
  - 有 pending 时放弃追问：清空 pending 并调用 Python 删除 thread。
  - 会话级 Redis 锁，冲突返回 `A0214`。
  - 记录写入 `session_id`；收到 `memory` 事件时写回会话记忆；更新 `turn_count` 和标题。

  验证：集成测试覆盖"会话默认参数""指代借助前文"（断言上游载荷）、"会话并发请求"。
- [x] 3.3 修订与采用：
  - `POST /api/translate/sessions/{id}/revise`（SSE，校验记录归属）：写入新记录（revision_of、mode=revise、修订要求），并把同分支其余版本的 adopted 置为 false。
  - `PUT .../records/{recordId}/adopt`。

  验证：集成测试覆盖"修订后切回旧版本"、记录不属于该会话返回 A0404。
- [x] 3.4 追问：
  - 收到 `clarify` 事件后写入 pending，不写记录。
  - `POST /api/translate/sessions/{id}/clarify`（SSE）：校验 threadId 后转发 resume；成功后写入记录（clarification），中断前后的轨迹合并；清空 pending。
  - threadId 不一致返回 `A0440`。

  验证：集成测试（假上游）覆盖"追问后继续""追问失效"。
- [x] 3.5 翻译记忆模块 `module/memory`：
  - `GET /api/tm`、`DELETE /api/tm/{id}`、`POST /api/tm/from-record/{recordId}`、`POST /api/tm/search`，转发到 Python 内部接口并带上 userId。
  - 新增错误码 `C0160`、`A0440`、`A0214`。

  验证：集成测试覆盖转发、记录归属校验、C0160 透传。
- [x] 3.6 文档：
  - `DocOptions` 增加 `translationMemory`（缺省 true，持久化，写入 payload）。
  - `editSegment` 事务提交后异步写入翻译记忆。
  - `POST /api/doc-tasks/{id}/memory`：只允许 COMPLETED，分批 200 条，返回 written。

  验证：集成测试覆盖"缺省开启记忆""编辑段落写入记忆"（断言异步调用）、"写入全部译文"和非 COMPLETED 返回 A0431。
- [x] 3.7 历史接口返回会话标记、修订要求与追问问答，详情带 sessionId。验证：集成测试。全量 `mvn verify` 通过，JaCoCo 行覆盖率不低于 92%。

## 4. web

- [x] 4.1 类型与 API 封装：sessions、revise/clarify 流、adopt、tm、doc memory。扩展 SSE 客户端以支持 `clarify` 终止事件与 `memory` 事件。验证：`tsc --noEmit` 通过；vitest 覆盖 SSE 解析新事件。
- [x] 4.2 工作台会话模式：
  - 「单次 / 会话」切换。
  - 会话抽屉：新建、搜索、分组、重命名、删除，带滑入动效。
  - 对话线程卡片：版本条使用 `layoutId`，版本切换交叉淡化。
  - 修订输入框与快捷要求芯片。

  验证：vitest 覆盖线程与版本链的组装纯函数；截图核对布局没有整页平铺。
- [x] 4.3 追问卡片：歧义片段高亮带一次脉冲，选项按钮与"其他…"输入；回答后高度收起并继续展示时间线。验证：mock 流下截图，以及 reduced-motion 降级。
- [x] 4.4 Agent 面板「记忆」标签页：匹配度徽章带计数动画，原文与记忆原文的逐字差异高亮，显示来源。译文区新增「存入记忆」按钮，带弹跳动效。验证：vitest 覆盖差异高亮函数；截图。
- [x] 4.5 翻译记忆页 `/memory`：主从布局，语言对筛选与检索的虚拟列表，详情与来源跳转，删除时列表项收起，有骨架、空状态和错误状态。侧边导航新增入口。验证：截图核对。
- [x] 4.6 文档工作区：段落详情的"翻译记忆"区块；「更多」菜单的「写入翻译记忆」（确认弹窗显示段数）；新建对话框实验选项中的"翻译记忆"开关。历史详情显示会话、修订与追问，并提供「打开会话」。验证：截图核对。
- [x] 4.7 mock 数据补充会话、追问和记忆。`lint`、`test`、`build` 全部通过。

## 5. evaluation

- [x] 5.1 测试集：
  - `data/session/dialogues.jsonl`：12 段 × 5 轮，每轮标注需上下文的片段与正确译法。
  - `data/session/ambiguity.jsonl`：20 句有歧义（标注片段）+ 20 句无歧义。
  - 在 `data/session/README.md` 中写明构造原则。

  验证：校验脚本检查字段完整、标注片段在原文中出现。
- [x] 5.2 客户端扩展（sessions、revise、clarify、tm、doc memory）及 E1 执行器：使用专用评测用户，先按 I3 配置生成 5 篇来源译文，每篇执行"清空记忆 → 写入其余 4 篇来源译文 → TM 关和开各跑 1 轮"，结果文件名为 `{doc}__TM0/TM1__run1.json`。验证：离线单测覆盖留一法的记忆构成与分组配置。
- [x] 5.3 E2 执行器与评审：逐轮翻译（无会话 / 有会话）；评审模型逐项判定现象，并做两组整段的成对偏好比较（随机交换顺序以消除位置偏差）；结果写入缓存。验证：离线单测覆盖判定解析与位置交换。
- [x] 5.4 E3 执行器：在会话中逐句提交，记录是否追问、追问片段与 plan 耗时，结束时放弃全部 pending；计算精确率、召回率与片段命中率。验证：离线单测覆盖指标计算。
- [x] 5.5 运行 E1（10 次）、E2（120 轮 × 2）、E3（40 句），汇总生成 `results/context_summary.csv` 与 `figures/context_experiments.png`。验证：失败为 0，或记录了失败原因；图中中文显示正常。

## 6. 文档与收尾

- [x] 6.1 实验报告新增第 10 节「会话上下文与翻译记忆」，内容包括设置、结果表、分析与局限（自建测试集、评审同源）。验证：报告中的数字与 CSV 一致。
- [x] 6.2 更新三份文档：
  - `docs/总体设计.md` 的 §4.3 与 §4.4，写明会话记忆和翻译记忆的实际实现，并更新路线图状态。
  - `docs/contracts/` 补充 clarify、memory 事件和 resume 接口的样例。
  - 重新生成 `docs/test/测试报告.md`，并在 report_tests 的能力证据映射中加入 translation-session 与 translation-memory。

  验证：文档链接有效。
- [x] 6.3 冒烟记录 `docs/test/session-memory-smoke/`：真实后端下完成"会话三轮 + 修订 + 追问 + 记忆命中"，并截图。`openspec validate --strict` 通过。按阶段提交，提交前检查没有 .env 或密钥进入暂存区。
