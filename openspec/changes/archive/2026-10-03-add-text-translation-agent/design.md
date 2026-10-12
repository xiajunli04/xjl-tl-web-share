## Context

- ① 已归档，基线规格见 `openspec/specs/`。现有能力：JWT/RBAC、`Result<T>` 与错误码、traceId、模型配置与 LLM 适配层（OpenAI 兼容 / Anthropic，同步与流式，默认重试 2 次）、Spring `AiServiceClient`（基于 RestClient，同步）
- 前端：Next.js 16.3 + shadcn（base-nova 风格，底层 @base-ui/react）+ Tailwind v4；目前没有动效，日志、个人中心等页面偏平铺
- 测试用 LLM 中转站网络有抖动：单次延迟 3–60 秒，偶发 TLS 握手失败。这直接影响流式体验和超时设计
- 约束：单人开发；所有前端改动都要遵守 docs/总体设计.md 8.1 的 UI/UX 标准

## Goals / Non-Goals

**Goals:**

- 用户在工作台输入文本后，3 秒内看到 Agent 的第一个节点事件，译文逐字流式出现
- Agent 每个节点的输入摘要、输出、耗时、token 都可以回放，为 ⑤ 的实验提供原始数据
- 术语库命中的术语在译文中 100% 被校验，不遵循的会标出来
- 建立一套能在 ③ ④ 中直接复用的设计系统和动效组件

**Non-Goals:**

- 见 proposal「非目标」：不做长文档、checkpointer、会话上下文、翻译记忆、评测脚本

## Decisions

### D1. Agent 图结构：确定性路由的工作流图

```
START → analyze → plan ─┬─ fast ────────────────────────► translate ─┐
                        │                                            │
                        └─ standard → retrieve → translate → review ─┤
                                         ▲                    │      │
                                         └──── refine ◄───────┘      │
                                          (score < 85 且轮次 < 2)     ▼
                                                                 finalize → END
```

| 节点 | 职责 | 是否调用 LLM |
|---|---|---|
| analyze | 语种识别（lingua，用户指定源语言时跳过）、术语匹配、文本长度与是否含代码/URL/占位符 | 否（低置信度时语种识别会调 LLM 兜底） |
| plan | 选路径：`mode=auto` 时，文本 ≤ 80 字符、无术语命中且风格为默认则走 fast，否则走 standard；确定领域（用户指定，或 standard 路径下由 LLM 用一句话判定） | 仅 standard + 领域为 auto 时 |
| retrieve | 组装 TranslationContext：terms（命中术语）、domain_hint、style；为 ④ 预留 tm_examples、session_ctx | 否 |
| translate | 按上下文包生成译文，流式输出 | 是 |
| review | LLM 评审，返回 JSON `{score, issues[]}`，issues 按 MQM 维度分类（accuracy / fluency / terminology / style），并附带规则化术语检查的结果 | 是 |
| refine | 带上评审意见改写译文，流式输出 | 是 |
| finalize | 规则化术语遵循校验（逐条检查目标术语是否出现在译文中）、汇总 usage 和耗时 | 否 |

- 评审通过阈值为 85 分，最多修正 2 轮（总体设计风险清单中的成本控制）
- fast 路径不评审，但 finalize 仍做术语校验
- **决策**：路由由条件边上的确定性规则完成，不用 LLM supervisor。**备选**：supervisor 模式由 LLM 决定下一步。**理由**：可复现、成本可控、便于测试；"Agent 的规划能力"体现在 plan 节点对路径和领域的判断上，在论文里能讲清楚
- **决策**：② 不使用 checkpointer，图在内存中执行一次。**理由**：短文本没有中断恢复的需求；③ 引入 checkpointer 时，这张图不需要改动

### D2. Agent 状态与 TranslationContext

```python
class TranslationState(TypedDict):
    request: TranslateRequest            # text, source_lang, target_lang, mode, style, domain, glossary_ids, model_config_id
    detected_lang: str | None; detect_confidence: float | None
    term_hits: list[TermHit]             # {source, target, glossary_id, spans:[(start,end)]}
    path: Literal["fast", "standard"]
    context: TranslationContext          # terms / tm_examples / domain_hint / style / doc_memory / session_ctx
    draft: str; round: int               # round：修正轮次，0 表示首译
    reviews: list[Review]                # {round, score, passed, issues:[{category, severity, span, suggestion}]}
    final: str | None
    compliance: list[TermCompliance]     # {source, target, compliant}
    usage: Usage; node_traces: list[NodeTrace]
```

TranslationContext 序列化成提示词（`app/agent/prompts.py`）：系统提示词由角色、风格、领域、术语表（Markdown 表格）和硬性规则（只输出译文、保留占位符/代码/URL、术语必须使用给定译法）组成。Qwen-MT 映射为原生 `translation_options` 的工作留到需要时再做，这里只保留接口（通过 ChatRequest.extra 透传）。

### D3. 语种识别

- **决策**：lingua-py，构建一个限定为 15 种支持语种的检测器（进程内单例，启动时预热）；最高置信度 < 0.5 或文本 < 4 个字符时调用 LLM 兜底（返回 ISO 代码）。**备选**：fastText lid.176。**理由**：lingua 在短文本上更准，有 Windows wheel；fastText 放到 ⑤ 作为对比实验
- 支持语种：`zh` 中文、`en` 英语、`ja` 日语、`ko` 韩语、`fr` 法语、`de` 德语、`es` 西班牙语、`ru` 俄语、`pt` 葡萄牙语、`it` 意大利语、`ar` 阿拉伯语、`th` 泰语、`vi` 越南语、`id` 印尼语、`tr` 土耳其语。语种清单由 Spring 维护常量，通过接口下发给前端；Python 维护同一份映射
- 识别结果为 `{lang, confidence, method: "lingua"|"llm", candidates:[{lang, confidence}]}`（候选取前 3 个）

### D4. 术语匹配

- **决策**：Python 侧 `GlossaryMatcher`，从 `biz.glossary_term` 只读加载所选术语库（按 `glossary_id + updated_at` 缓存），按源术语长度降序做最长匹配，已覆盖的区间不再重复匹配
  - 拉丁、西里尔文字：不区分大小写（除非术语标记了 `case_sensitive`），并要求词边界（`\b`）
  - 中日韩、泰文：直接子串匹配
- 术语库只能匹配与本次翻译语言对一致的术语库（`source_lang`/`target_lang` 相符），其余会被跳过，并在事件中提示
- 遵循校验（finalize）：目标术语在译文中出现即视为遵循（大小写和边界规则同上）；不遵循的项写入 `compliance` 并在 UI 中标红
- **备选**：Aho-Corasick 自动机。**理由**：单次翻译的术语库规模是百到千级，排序后的正则匹配足够，实现简单；后续规模变大再替换

### D5. 流式链路：两跳 SSE + JSON 事件

```
浏览器 ──POST fetch(stream)──► Spring /api/translate/stream ──WebClient SSE──► Python /internal/translate/stream
       ◄── text/event-stream ──                             ◄── text/event-stream ──
```

**事件协议**（`event:` 为事件名，`data:` 一律是单行 JSON，避免换行和前导空格丢失）：

| event | data | 说明 |
|---|---|---|
| `start` | `{requestId, path?}` | Python 收到请求 |
| `node` | `{seq, node, status: "started"\|"completed"\|"skipped", summary?, latencyMs?, usage?}` | 节点开始或结束 |
| `detect` | `{lang, confidence, method}` | analyze 得到识别结果 |
| `terms` | `{hits:[{source, target, glossaryId}], skippedGlossaries:[id]}` | 术语命中 |
| `plan` | `{path, domain, reason}` | 规划结果，reason 为中文说明 |
| `delta` | `{round, text}` | 译文增量；round 增加时前端清空当前译文，重新开始流式显示 |
| `review` | `{round, score, passed, issues:[...]}` | 评审结果 |
| `final` | `{translation, sourceLang, targetLang, path, domain, compliance:[...], usage:{promptTokens, completionTokens}, latencyMs, recordId?}` | Spring 落库后补上 recordId 再转发 |
| `error` | `{code, message}` | 出错后流结束 |
| （注释行）`: ping` | — | 每 15 秒一次心跳 |

- **Python 侧**：FastAPI 内置的 `EventSourceResponse`；在 LangGraph 中用 `astream(stream_mode=["custom","updates"])` 加 `get_stream_writer()` 产出 node / delta / review 等自定义事件
- **Spring 侧**：
  - 引入 `spring-webflux`，只用 WebClient；控制器返回 `Flux<ServerSentEvent<String>>`（Spring MVC 支持 Reactor 返回类型）
  - 转发时原样透传事件；收到 `final` 后同步写入 `translation_record` 和 `agent_trace`，并在 data 中补上 `recordId`
  - 若上游出错或超时，Spring 生成 `error` 事件（C0110 / C0140）
  - 合并一个 15 秒间隔的 ping 流作为心跳
- **取消**：浏览器 abort → Spring 的 Flux 被取消 → WebClient 断开连接 → FastAPI 检测到断开 → 取消 LangGraph 任务 → SDK 请求被关闭。被取消的请求不落库
- **超时**：整次翻译的上限为 180 秒（考虑到上游最坏 60 秒 × 评审修正多轮）；单次 LLM 调用沿用模型配置里的 timeoutSeconds 和 maxRetries
- **前端**：自己实现基于 fetch + ReadableStream 的 SSE 解析器（`src/lib/sse.ts`，约 80 行），复用 `http.ts` 的 Bearer 和刷新逻辑：发起请求前如果访问令牌即将过期，先刷新。**备选**：`@microsoft/fetch-event-source`。**理由**：这个库已经多年未维护，自己实现更方便和现有的令牌刷新逻辑整合
- **决策**：落库由 Spring 完成，Python 只在事件里携带轨迹数据。**理由**：保持"Spring 是业务数据唯一写入方"的边界（总体设计 3.1）

### D6. 持久化模型（Flyway V2）

```sql
biz.glossary(id, owner_id → sys_user, name varchar(64), description varchar(255),
             source_lang varchar(8), target_lang varchar(8), domain varchar(32),
             scope varchar(16) CHECK (scope IN ('PRIVATE','PUBLIC')), term_count int DEFAULT 0,
             deleted, created_at, updated_at)
biz.glossary_term(id, glossary_id → glossary, source_term varchar(200), target_term varchar(200),
                  note varchar(255), case_sensitive boolean DEFAULT false, created_at, updated_at,
                  UNIQUE (glossary_id, lower(source_term)))          -- 物理删除
biz.translation_record(id, user_id, source_text text, target_text text,
                       source_lang, detected_lang, target_lang, path varchar(16), mode varchar(16),
                       style varchar(16), domain varchar(32), glossary_ids bigint[], model_config_id,
                       review_score int, review_rounds int, compliance jsonb, term_hits jsonb,
                       prompt_tokens int, completion_tokens int, latency_ms int,
                       favorite boolean DEFAULT false, deleted, created_at)
biz.agent_trace(id, record_id → translation_record, seq int, node varchar(32), status varchar(16),
                summary text, detail jsonb, latency_ms int, prompt_tokens int, completion_tokens int,
                created_at)
GRANT SELECT ON biz.glossary, biz.glossary_term TO ${ai_role};
```

- 索引：`translation_record(user_id, created_at desc)`，以及 `source_text` 上的 pg_trgm GIN 索引用于关键词检索（需要 `CREATE EXTENSION IF NOT EXISTS pg_trgm`，与 vector 一样在初始化脚本中由超级用户预先创建）
- `term_count` 在增删术语时由 Spring 维护，用于列表展示
- 原文上限 5000 字符，超过时返回 A0410，并提示"长文本请使用文档翻译（即将推出）"

### D7. 接口契约

**对外（Spring）**

| 方法 | 路径 | 请求 | data |
|---|---|---|---|
| GET | /api/translate/languages | — | `[{code, name, nativeName}]` |
| POST | /api/translate/detect | `{text}` | `{lang, confidence, method, candidates}` |
| POST | /api/translate/stream | `TranslateRequest` | SSE（D5） |
| GET | /api/model-configs/options | — | `[{id, name, provider, isDefault}]`，只含已启用的配置 |
| GET | /api/glossaries | `pageNum, pageSize, keyword?, scope?, sourceLang?, targetLang?` | `PageResult<GlossaryVO>`：返回自己的和公共的 |
| POST/PUT/DELETE | /api/glossaries[/{id}] | `{name, description?, sourceLang, targetLang, domain?, scope?}` | `GlossaryVO`。scope=PUBLIC 仅 ADMIN 可设；只能修改自己的，公共的只有 ADMIN 能改 |
| GET | /api/glossaries/{id}/terms | `pageNum, pageSize, keyword?` | `PageResult<TermVO>` |
| POST/PUT/DELETE | /api/glossaries/{id}/terms[/{termId}] | `{sourceTerm, targetTerm, note?, caseSensitive?}` | `TermVO`；源术语重复返回 A0112 |
| POST | /api/glossaries/{id}/terms/import/preview | multipart `file`（CSV，UTF-8，列：source,target,note） | `{total, valid, newCount, updateCount, errors:[{line, message}], sample:[...]}` |
| POST | /api/glossaries/{id}/terms/import | multipart `file`, `strategy: "skip"\|"overwrite"` | `{inserted, updated, skipped, failed}` |
| GET | /api/glossaries/{id}/terms/export | — | `text/csv` 文件 |
| GET | /api/translations | `pageNum, pageSize, keyword?, sourceLang?, targetLang?, favorite?, startTime?, endTime?` | `PageResult<TranslationSummaryVO>` |
| GET | /api/translations/{id} | — | `TranslationDetailVO`（含 `traces[]`） |
| PUT | /api/translations/{id}/favorite | `{favorite}` | null |
| DELETE | /api/translations/{id} | — | null（逻辑删除） |

```
TranslateRequest   = {text, sourceLang: "auto"|code, targetLang, mode: "auto"|"fast"|"standard",
                      style: "faithful"|"fluent"|"creative", domain?: string, glossaryIds?: number[], modelConfigId?: number}
GlossaryVO         = {id, name, description, sourceLang, targetLang, domain, scope, termCount, ownerId, ownerName, editable, createdAt, updatedAt}
TermVO             = {id, sourceTerm, targetTerm, note, caseSensitive, updatedAt}
TranslationSummaryVO = {id, sourcePreview, targetPreview, sourceLang, targetLang, path, reviewScore, favorite, latencyMs, createdAt}
TranslationDetailVO  = {..., sourceText, targetText, detectedLang, mode, style, domain, glossaryIds, modelConfigId,
                        reviewRounds, compliance, termHits, promptTokens, completionTokens,
                        traces:[{seq, node, status, summary, detail, latencyMs, promptTokens, completionTokens}]}
```

**内部（Python）**：`POST /internal/lang/detect {text}`，返回与对外接口相同的 data；`POST /internal/translate/stream`，请求体为 TranslateRequest 加上 `userId`，返回 SSE。Spring 在转发前校验 glossaryIds 的访问权限，Python 不再校验权限。

**新增错误码**

| 码 | 含义 | HTTP |
|---|---|---|
| A0112 | 术语已存在 | 409 |
| A0212 | 翻译请求过于频繁 | 429 |
| A0420 | 不支持的语种 | 400 |
| A0421 | 导入文件格式错误 | 400 |
| C0140 | Agent 执行失败 | 502 |
| C0141 | 翻译超时 | 504 |

### D8. 限流

- **决策**：Redis 固定窗口计数器 `rate:translate:{userId}:{epochMinute}`，每分钟 20 次（可配置），超限时在建立流之前返回 429 + A0212。识别接口每分钟 120 次。**理由**：实现简单，对单机毕设足够
- **备选**：令牌桶或 Bucket4j

### D9. 前端 SSE 状态管理

工作台用一个 `useTranslationRun()` hook，把事件归约为一个状态对象：`{status, nodes[], detect, terms, plan, rounds:[{round, text, review?}], final, error}`。时间线组件和译文区都由这个状态驱动。使用 zustand 局部 store，不进入 react-query 缓存；完成后让历史列表查询失效以刷新。

## UI/UX

### 设计系统

- **令牌**：在 `globals.css` 中用 Tailwind v4 的 `@theme` 定义 CSS 变量
  - 中性色：zinc 色阶
  - 品牌色：靛蓝到紫的渐变（`--brand-from: indigo-500`、`--brand-to: violet-500`），只用在主按钮、Agent 激活态和焦点环
  - 语义色：success / warning / danger / info
  - 圆角：`--radius: 0.75rem`
  - 三级阴影（卡片 / 浮层 / 模态）、8pt 间距体系
  - 字体：Inter + 系统中文字体
- **暗色模式**：用 next-themes 的 class 策略；顶栏提供切换（亮 / 暗 / 跟随系统），切换时有过渡
- **动效规范**（`src/components/motion/`，基于 motion/react）

  | 场景 | 组件 | 参数 |
  |---|---|---|
  | 路由切换 | `PageTransition`（`template.tsx`） | 透明度 0→1，y 方向 8px→0，220ms，缓动 `[0.22,1,0.36,1]` |
  | 列表 / 卡片进场 | `StaggerList` / `StaggerItem` | 每项间隔 40ms，最多 12 项 |
  | 浮层 / 抽屉 | 侧滑 Sheet | spring 动画，stiffness 380，damping 34 |
  | 数值变化 | `NumberTicker` | 400ms |
  | 状态切换（徽标 / 开关） | `layout` 动画 + 颜色过渡 | 150ms |
  | Agent 时间线 | 节点脉冲光环、连接线随进度填充、完成时打勾 | — |
  | 流式译文 | 闪烁光标 + 新文字淡入 | — |
  | 加载 | `Skeleton`（微光扫过） | — |

  所有动效都读取 `useReducedMotion()`，开启"减少动效"时只保留透明度过渡
- **反馈组件**（`src/components/feedback/`）：`EmptyState`（插画 + 说明 + 主操作）、`ErrorState`（附带 traceId，可复制）、`LoadingSkeleton` 系列、`ConfirmDialog`

### 信息架构（禁止整页平铺）

```
应用外壳：可折叠图标侧边栏（工作台 / 历史 / 术语库 | 管理：用户 / 模型 / 日志 / 系统） + 顶栏（面包屑 · 主题 · 用户菜单）

/translate  翻译工作台（默认首页）
┌───────────────────────────────────────────────────────────────┬──────────────┐
│ 工具条：[自动识别: 中文 ▾] ⇄ [英语 ▾]   [⚙ 翻译设置]  [模式 ▾]    │  Agent 面板   │
├──────────────────────────────┬────────────────────────────────┤  (可收起)     │
│ 原文编辑区                    │ 译文区（流式，术语高亮）          │ [时间线|评审|术语] │
│ 字数 1234/5000               │ 复制 · 收藏 · 评分徽标            │              │
└──────────────────────────────┴────────────────────────────────┴──────────────┘
「翻译设置」放在弹层（Popover）中：风格分段控件、领域、术语库多选、模型选择

/glossaries  主从布局：左侧术语库列表卡片（个人/公共分组）→ 右侧术语表（搜索、行内编辑）
             导入用分步对话框：① 上传 → ② 预览与冲突 → ③ 选择策略并确认
/history     列表（筛选放在工具条弹层中）→ 点击行打开侧滑详情（标签页：对照 / Agent 轨迹回放 / 术语命中）
/admin/users           表格 + 侧滑详情（基本信息 / 角色 / 安全操作 三个分区）
/admin/model-configs   卡片网格（提供方图标、状态灯、默认标记）+ 侧滑编辑表单 + 连通性测试结果动画
/admin/logs            一个页面两个标签页（登录日志 / 操作日志），参数详情用侧滑面板查看
/admin/system          状态卡片（呼吸灯）+ 自动刷新倒计时
/profile               标签页（基本资料 / 安全设置）
```

### 关键交互流程

1. 输入文本，停顿 600ms 后自动识别语种；源语言选择器显示"自动识别：中文 (98%)"，数值有过渡动画
2. 点击翻译（或 Ctrl+Enter）：Agent 面板自动展开，时间线逐个点亮节点；`plan` 节点显示选择的路径和理由
3. 译文流式出现；进入修正轮时，译文区显示"第 2 轮修正"标签，旧译文淡出、新译文流入
4. 完成后，评审分以徽标显示（带数字滚动动效），命中的术语在译文中高亮，悬停可以看到原术语；未遵循的术语标红并在"术语"标签页中列出
5. 翻译过程中可以随时点击"停止"，前端中断请求，上游随之取消
6. 出错时，译文区显示 ErrorState，附带错误码和 traceId，可以一键重试

## Risks / Trade-offs

- [上游 LLM 延迟大，评审修正轮次多时总耗时可能超过 1 分钟] → fast 路径兜底；评审 max_tokens 限制在 512；最多 2 轮；前端持续显示节点进度，用户可以随时停止
- [两跳 SSE 在 Next dev、Spring、代理任一环节被缓冲] → 浏览器直连 Spring（① D4）；Spring 响应头设置 `X-Accel-Buffering: no`、`Cache-Control: no-cache`；Python 每个事件发出后立即刷新；集成测试断言首个事件在 1 秒内到达（使用 mock LLM）
- [LLM 评审输出的 JSON 不合法] → 用 response_format 指定 json_object（OpenAI 兼容），Anthropic 用"只输出 JSON"的提示加解析容错；解析失败视为通过并记录警告，不阻断翻译
- [lingua 首次加载慢（几百 MB 内存、数秒）] → 只加载 15 种语种，启动时预热；低精度模式作为备选开关
- [前端重做范围大，可能拖慢进度] → 先做设计系统和外壳，再按"工作台 > 术语库 > 历史 > 管理页"的优先级推进；管理页改造只调整布局和交互，不改业务逻辑
- [取消传播存在一次在途调用的延迟] → Spring 用 JDK HttpClient 关闭上游连接时是优雅关闭（FIN），uvicorn 要到下一次写入（事件或 15 秒心跳）才感知断开。因此用户停止后，**正在进行中的那一次 LLM 调用**可能继续执行完，但后续节点一定不会执行（响应对象层兜底取消后台任务）。流式输出阶段事件频繁，几乎即时生效；非流式的评审/领域判定调用期间最多延迟一次调用的时长。实测：在 review 阶段停止，Python 在约 1.5 秒后结束，不再执行 refine
- [Spring MVC 和 WebFlux 依赖共存] → 只引入 `spring-webflux`（不引入 starter-webflux），保持 Servlet 栈；集成测试确认没有切换成 Netty 服务器

## Migration Plan

- Flyway V2 只新增表，不修改 V1；初始化脚本补充 `CREATE EXTENSION IF NOT EXISTS pg_trgm`。已有的开发库需要用超级用户手动执行一次（README 中说明），或由 V2 在拥有权限时创建
- 前端改造是界面层面的替换，接口不变；回滚即回退 web 目录的提交

## Open Questions

- 评审阈值 85 分和最多 2 轮是经验值，⑤ 的实验可能会调整，所以做成可配置项（Python 的 settings）
- 公共术语库要不要允许普通用户"复制为个人库"：暂不做，记为后续增强
