## Context

⑤ 已归档，留下了 D0–D6 共 40 次篇章级运行、200 次句子级翻译的原始结果（`evaluation/results/`），以及实验报告 §3.3 的五条发现。本变更针对其中的三个问题（术语锁定、评审无效、默认策略不经济）修改 Agent 行为和默认值，并用同一套测试集和指标重新验证。

当前实现中相关的事实：

- **术语**：`app/doc/analysis.py::align_terms` 在 `confirmTerms=false` 时把全部候选写入 `state["terms"]`。之后 `translate.py` 的提示词术语表、`_rule_issues`（触发修正）和 `_compliance`，以及 `consistency.py` 的 `CheckItem.chosen`，都把这些词当作必须遵循的译法。Spring 的 `DocEventHandler.onAnalysis` 在不确认时把候选存为 `CONFIRMED`。
- **评审**：
  - 短文本由 `app/agent/nodes/llm.py::review` 判定，条件是 `score >= agent_review_threshold`（85）。
  - 文档由 `translate.py` 判定，条件是 `score < threshold or _rule_issues`，最多修正 1 轮。
  - 两者都使用译者模型（`deps.llm`）。
- **模型解析**：Python 的 `LLMRegistry.get(model_config_id)` 只读 `biz.model_config`，不传 id 时使用默认模型。Spring 的 `ModelConfigService` 维护 `is_default` 的唯一性（部分唯一索引加切换逻辑）。
- **默认值**：
  - Spring `CreateDocTaskRequest` 的缺省值为 strategy=serial、confirmTerms=false，`DocOptions.normalized()` 把空字段补为 true。
  - Python `DocPayload` 的缺省值同样是 serial、false 和全部开启。
  - 前端新建对话框默认 serial，confirmTerms=true（已经开启），四项选项全部开启。

## Goals / Non-Goals

**Goals:**

- 未经人工确认的抽取术语不再能把错误译法强制推广到全文，同时尽量保留抽取带来的一致性收益。
- 评审可以使用独立模型，修正与否由明确的严重度规则决定，结果可解释。
- 默认配置采用实验证明更经济的组合：混合策略、人工确认、文档默认不评审。
- 用 I1–I3 实验和句子级重跑量化上述改进，并补上原报告"人工确认效果未量化"的局限。

**Non-Goals:**

- 不做会话上下文与翻译记忆（④），不做领域白名单功能，不写领域专用提示词。
- 不改短文本 auto 模式的路由，不重跑 D0–D6。

## Decisions

### D1 自动采用的抽取术语改为软约束

- **决策**：
  - 任务术语表条目增加 `binding` 字段，取值为 `hard` 或 `soft`。
    - 术语库命中，以及经用户确认（含修改、新增）的术语为 `hard`。
    - `confirmTerms=false` 时自动采用的**抽取**候选为 `soft`。
  - 两类术语的处理方式不同：

    | 环节 | `hard` | `soft` |
    |---|---|---|
    | 分块提示词 | 「术语表（必须使用）」 | 「参考译法（可按领域惯例调整，同一术语全文保持一致）」 |
    | `_rule_issues`（触发修正） | 参与 | 不参与 |
    | `compliance` 遵循判定 | 参与 | 不参与 |
    | 一致性检查 | 以该译法为准 | `chosen=None`，按多数决定，参考译法只作为平票时的优先项 |

  - Spring 把这类术语存为新状态 `AUTO`（V4 放宽 CHECK 约束），前端显示为「参考」。
- **备选方案**：
  - A. 不确认时完全不采用抽取结果：一致性收益全部丢失（D3 的术语一致率提升来自这里）。
  - B. 按置信度过滤候选：模型给出的置信度不可靠，而且锁定的错误译法往往是模型"很确定"的。
  - C. 只把默认值改为人工确认：通过接口或关闭确认的用户仍会遇到锁定。
- **理由**：
  - 锁定的根源是"未经人确认的猜测被当作硬约束全文强制执行"。降为软约束后，模型在每一块仍能参考统一译法，而一致性环节会收敛到译者自己最常用的译法。D2 没有抽取时，Deployment 基本保留英文，说明多数决定的结果更接近领域惯例。
  - 这与"用户提供的术语表是硬约束、系统推测是建议"的主流做法一致（DeepL、Phrase 等的术语表均来自用户）。

### D2 抽取提示词加入通用领域惯例

- **决策**：在 `analyze_messages` 的抽取任务中加入以下规则：
  - 按目标语言在该领域的通行惯例给出译法。
  - 技术文档中作为专有名称使用的产品名、API 或资源类型名、配置项、命令与代码标识符，通常保留原文。典型特征是首字母大写的英文名词或大小写混写的复合词。
  - 只有存在广泛通用的译法时才翻译，拿不准时 target 与 source 相同。

  翻译提示词中的参考译法小节也写明"领域惯例优先"。
- **备选方案**：
  - 写入 Kubernetes 专用规则：对测试集过拟合，不具备一般性。
  - 让模型输出 keep 字段：等价于 target==source，增加解析复杂度。
- **理由**：这条规则通用、零成本，与 D1 互补。D2 降低抽取出错的概率，D1 限制出错后的影响范围。

### D3 默认值调整：hybrid、人工确认、文档默认不评审

- **决策**：
  - Spring `CreateDocTaskRequest` 的缺省值改为 strategy=`hybrid`、confirmTerms=`true`。
  - `DocOptions.normalized()` 中 review 缺省为 `false`，其余三项缺省仍为 `true`。
  - Python `DocPayload` 的缺省值同步修改（只作为防御性默认值，Spring 总是显式传值）。
  - 前端默认值与之一致，并新增「推荐」预设：context + summary + terms、hybrid、不评审。
  - 原 D0–D6 预设保留，作为「实验对照」分组。
- **备选方案**：
  - 只改前端默认值：接口和前端不一致，违背"接口缺省值即推荐值"的约定。
  - 保持评审默认开启：实验显示它使 token 增加约 70%、耗时增加约 83%，而质量没有可测量的收益。
- **理由**：
  - 没有二级标题时，hybrid 退化为单组，效果等同 serial，不会更差。
  - 人工确认是消除锁定最直接的手段。
  - 评审改为按需开启（「质量优先」场景），开启时配合独立评审模型（D4）。

### D4 评审模型：模型配置上的全局唯一标记

- **决策**：
  - `biz.model_config` 新增 `is_review_default boolean NOT NULL DEFAULT false`，并建部分唯一索引 `WHERE is_review_default AND NOT deleted`。
  - 维护规则与 `is_default` 相同：设置时取消原标记；停用或删除时清除标记。
  - 同一个配置可以同时是默认模型和评审模型，这时等同于"评审用译者模型"，管理页给出提示。
- **评审模型的解析顺序**（在 Spring 端完成）：
  1. 请求显式指定的 `reviewModelConfigId`。必须为启用状态，否则返回 `C0130`。
  2. 管理员设置的评审模型。
  3. `null`，表示与译者相同。

  文档任务在**创建时**解析，结果持久化到 `doc_task.review_model_config_id`，继续执行时沿用。短文本在每次请求时解析。解析结果以 `reviewModelConfigId` 透传给 Python。
- **Python 端**：
  - 评审调用通过 `registry.get(reviewModelConfigId)` 取得评审模型。
  - 修正和补译仍使用译者模型。
  - 执行时评审模型已停用或不可用的处理：
    - 文档：记录警告轨迹并退回译者模型，不让任务失败。
    - 短文本：同样退回译者模型，并在 review 事件中标注。
- **备选方案**：
  - A. 新建通用系统设置表：只为一个键引入通用设置机制，过度设计。
  - B. 放在 `params` JSON 中：无法用索引保证唯一。
  - C. 只允许按任务指定：普通用户不了解模型差异，管理员无法统一管理。
- **理由**：复用 `is_default` 的成熟模式，改动集中，管理员一处配置即可全局生效。显式参数保留给实验和高级用户使用。

### D5 按 MQM 严重度决定是否修正

- **决策**：修正条件改为以下三项满足其一：
  - 评审问题中存在 `critical` 或 `major`。
  - 规则检查发现未遵循的 `hard` 术语。
  - 总分低于兜底分 `agent_review_min_score`（默认 75，对应提示词中"存在明显错误"一档）。

  其他规则：
  - `agent_review_threshold` 删除。
  - 评审输出无法解析时视为通过。
  - 修正轮次上限不变：短文本 2 轮，文档 1 轮。
  - 短文本 `Review.passed` 和文档分块判定使用同一个纯函数 `needs_refine(score, issues, rule_issues, min_score)`，放在 `app/agent/review_gate.py`。
  - 文档分块结果和轨迹摘要增加各严重度的问题数（`reviewIssues: {critical, major, minor}`），供实验统计触发原因。
- **备选方案**：
  - A. 把阈值提高到 90：自评分本身偏高且不稳定，只调阈值是在噪声上切分，会让只有 minor 问题的译文也被修正，徒增成本。
  - B. GEMBA 加权罚分（critical 25 / major 5 / minor 1）加阈值：需要额外标定，现有数据不足以确定阈值。
- **理由**：MQM 实践中，影响发布的是 major 及以上的错误。按严重度决定，结果可解释（"因为某个 major 误译而修正"），也与独立评审模型配合，把修正集中在真正有问题的块上。

### D6 改进验证实验

- **配置**：均不使用术语库，目标语言为中文，译者为 model_config_id=2。

  | 组 | contextWindow | globalSummary | termExtraction | review | 策略 | confirmTerms | 说明 |
  |---|---|---|---|---|---|---|---|
  | I1 | ✓ | ✓ | ✓ | ✗ | hybrid | ✗（软约束） | 改进后的自动流程 |
  | I2 | ✓ | ✓ | ✓ | ✓ | hybrid | ✗ | I1 + 独立评审（`reviewModelConfigId=3`，gpt-6-luna）+ 严重度规则 |
  | I3 | ✓ | ✓ | ✓ | ✗ | hybrid | ✓（模拟人工） | 见下方模拟人工确认 |

- **规模**：每组 5 篇 × 2 轮，共 30 次运行，沿用执行器的断点续跑和失败重试。
- **模拟人工确认**：任务进入待确认状态后，执行器读取候选：
  - 源词在金标术语表中（不区分大小写）的，改为金标译法。
  - 其余候选原样接受。
  - 然后调用确认接口。

  这模拟一个"只纠正自己确定的词"的用户，确认内容写入结果文件。
- **锁定率**（产出侧统一定义，新旧运行都按此重新计算）：
  - 对金标中"译法与源词相同"的术语，在原文出现 ≥3 次（区分大小写）的前提下，统计对应译文段中保留源词的比例。
  - 比例低于 20% 记为该运行发生锁定。
  - 同时报告原报告基于任务术语表的计数（10/25）作为对照。
- **句子级**：FLORES 100 句用标准路径重跑，带 `reviewModelConfigId=3` 和新规则。与旧的标准路径对比修正触发率、chrF 和 token。
- **对比基线**：
  - I1 对比 D3 和 D6。
  - I2 对比 D4 和 D6。
  - I3 对比 I1，用来量化人工确认的效果。

  MQM 评审仍使用 gpt-6-luna 并沿用缓存。
- **输出**：
  - 汇总脚本生成 `results/improve_summary.csv`，以及 `figures/improve_lockin.png`、`figures/improve_quality_cost.png`。
  - 实验报告新增 §9「基于实验的改进与验证」。
  - 原 §3.4 改进建议的每条标注落实情况。

### D7 接口契约

**Spring 对外接口：**

| 接口 | 变化 |
|---|---|
| `PUT /api/admin/model-configs/{id}/review-default` | 新增：设为评审模型。不存在返回 `A0404`，已停用返回 `C0130` |
| `DELETE /api/admin/model-configs/{id}/review-default` | 新增：取消评审模型标记（幂等） |
| `GET /api/admin/model-configs`，`GET /{id}` | VO 新增 `isReviewDefault` |
| `GET /api/model-configs/options` | 每项新增 `isReviewDefault` |
| `POST /api/doc-tasks`（JSON 与 multipart settings） | 新增可选 `reviewModelConfigId`，不可用时返回 `C0130`。缺省值改为 strategy=hybrid、confirmTerms=true、options.review=false |
| `GET /api/doc-tasks/{id}` | 新增 `reviewModelConfigId`（解析后的值，可能为 null） |
| `GET /api/doc-tasks/{id}/terms` | `status` 新增取值 `AUTO` |
| `POST /api/translate/stream` | 新增可选 `reviewModelConfigId`（解析规则同上） |

**Spring → Python 内部接口：**

- `POST /internal/translate/stream` 的请求体和文档任务的 `start`/`retry` 命令 payload 新增 `reviewModelConfigId`（int 或 null）。
- 文档 `resume` 命令中的确认术语一律为 `hard`，格式不变。

**事件：**

- 短文本 `review` 事件新增 `reviewer` 字段（模型显示名）和 `fallback`（bool）。
- 文档 `chunk_done` 和轨迹摘要新增 `reviewIssues`。
- 均为新增字段，旧客户端忽略即可。

## UI/UX

**信息架构：**

- **模型配置页**（管理端，主从布局沿用现状）：
  - 列表行增加「评审」徽标，与「默认」徽标并列，使用不同色调。
  - 行操作菜单新增「设为评审模型 / 取消评审模型」。
  - 页面顶部的提示条在"未设置评审模型"或"评审模型与默认模型相同"时说明影响，可关闭。
- **新建任务对话框**（三步结构不变）：
  - 第 ② 步的策略卡片默认选中「混合」，卡片上带「推荐」角标。
  - 「实验选项」折叠区内的预设列表分为两组：「推荐」与「实验对照 D0–D6」。
  - 打开「评审修正」开关时，下方展开一行说明：「评审模型：xxx」，或「与译者相同（管理员未设置评审模型）」。
  - 第 ③ 步的摘要中显示评审状态与评审模型。
- **工作区**：
  - 「概览」标签页显示评审模型。
  - 「术语」标签页按状态分组。`AUTO` 显示为「参考」徽标，悬停提示「未经确认，仅供模型参考，不强制」，与「已确认」「术语库」区分。

**关键交互流程：**

1. 管理员在模型配置页把 gpt-6-luna 设为评审模型：先出现确认弹窗，成功后徽标出现在该行，原评审模型的徽标消失。
2. 用户新建任务：默认值已是推荐配置，用户可以直接下一步。如果手动打开评审，可以看到将使用的评审模型。
3. 用户在工作区查看术语：自动采用的术语带「参考」标识，用户能理解这些词并未被强制使用。

**动效清单**（motion，尊重 `prefers-reduced-motion`）：

- 评审徽标的出现和消失：缩放加淡入，150ms。徽标跨行切换使用 `layoutId`，从旧行滑向新行。
- 评审说明行的展开和收起：高度过渡加淡入，200ms，与现有折叠区一致。
- 「推荐」角标随策略卡片的选中态切换，沿用现有的 `layoutId="doc-strategy-active"` 高亮滑块。
- 术语分组的标题吸顶，展开分组时列表项依次淡入，间隔 30ms。

## Risks / Trade-offs

- [软约束导致一致性下降] → 一致性检查仍对多数译法做定向统一，I1 与 D3 的一致率对比会直接量化这一点。如果显著下降，可以在报告中讨论"自动 + 人工确认"组合（I3）。
- [I2 的评审模型与 MQM 评审同为 gpt-6-luna，存在自我偏好] → I2 以 chrF 和金标术语准确率（有参考的指标）为主要结论，MQM 只作辅助，并在报告中列为局限。
- [与旧 D 系列相隔数日，中转站上的模型可能漂移] → 报告中列为局限。I1 与 D3/D6 的差异小于 D4 重复运行的波动（|Δ| chrF 3.3）时，不做显著性结论。每组跑 2 轮以估计波动。
- [接口缺省值变化影响已有调用方] → 评测工程已显式传入全部参数。前端由本变更同步修改。接口文档（springdoc）的缺省说明同步更新。
- [严重度规则下触发率可能更低] → 这本身是预期结果（只修正真正有问题的块）。I2 与 D4 的触发原因分布（`reviewIssues`）会说明评审是否"抓得到"问题。

## Migration Plan

1. Flyway `V4__review_model.sql`：
   - 给 `model_config` 加 `is_review_default` 列和部分唯一索引。
   - 给 `doc_task` 加 `review_model_config_id bigint NULL`。
   - 放宽 `doc_task_term.status` 的 CHECK 约束，加入 `AUTO`。
   - 存量数据不变：旧任务的自动采用术语保持 `CONFIRMED`。
2. Python 配置项 `agent_review_threshold` 替换为 `agent_review_min_score`。`.env.example` 若有相关项则同步。
3. 依次部署 Spring、Python 和前端。旧 Python 收到新字段会忽略（CamelModel `extra="ignore"`），新 Python 收到不含新字段的旧命令按 null 处理。
4. 回滚：V4 的改动都是兼容性的加列和放宽约束，回滚代码即可。要撤销数据库改动，需要另写 V5，不修改已执行的迁移。

## Open Questions

（无。评审规则中的兜底分 75 可以按 I2 的结果在报告中讨论，不阻塞实现。）
