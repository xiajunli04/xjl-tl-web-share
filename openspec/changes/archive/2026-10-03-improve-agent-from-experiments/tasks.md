## 1. infra / 数据库

- [x] 1.1 新增 Flyway `V4__review_model.sql`，包含三项改动：
  - `model_config.is_review_default` 列和部分唯一索引 `uk_model_config_review_default`
  - `doc_task.review_model_config_id`
  - `doc_task_term.status` 的 CHECK 约束加入 `AUTO`
  - 补充列注释

  验证：Testcontainers 迁移测试通过，`\d biz.model_config` 能看到新索引。

## 2. springboot-backend

- [x] 2.1 ModelConfig 实体、VO 和选项 VO 增加 `isReviewDefault`：
  - `ModelConfigService` 新增 `setReviewDefault` / `clearReviewDefault`，切换逻辑与 `setDefault` 相同
  - 停用或删除时清除评审标记
  - 新增 `reviewModelId()`，返回启用的评审模型 id 或 null

  验证：服务层单测覆盖切换、停用和删除清除、设置已停用配置返回 C0130、取消接口幂等。
- [x] 2.2 `ModelConfigController` 新增 `PUT/DELETE /api/admin/model-configs/{id}/review-default`，带 `@OperationLog`，权限仅限 ADMIN。验证：MockMvc 或集成测试覆盖 200、A0404、C0130 和 USER 角色 403。
- [x] 2.3 文档任务创建参数调整：
  - `CreateDocTaskRequest` 新增 `reviewModelConfigId`
  - 缺省值改为 strategy=hybrid、confirmTerms=true，`DocOptions.normalized()` 中 review 缺省为 false
  - 创建时按"显式 → 评审模型 → null"解析评审模型，并持久化到 `doc_task.review_model_config_id`
  - 详情 VO 返回该字段，start 和 retry 命令的 payload 携带 `reviewModelConfigId`
  - springdoc 中的缺省值说明同步更新

  验证：集成测试覆盖缺省参数、记录评审模型、指定的评审模型已停用返回 C0130、retry 沿用。
- [x] 2.4 `DocEventHandler.onAnalysis`：未开启确认时，origin=extracted 的候选存为 `AUTO`，origin=glossary 的存为 `CONFIRMED`。检查依赖 CONFIRMED 的查询（导出、术语高亮、确认流程）是否需要同时包含 AUTO。验证：单测或集成测试覆盖"不确认时的术语状态"场景。
- [x] 2.5 短文本翻译：
  - `TranslateRequest` 新增 `reviewModelConfigId`
  - `TranslateService` 按同样规则解析
  - `UpstreamTranslateRequest` 透传给 Python

  验证：单测断言上游请求体包含解析后的 id，显式指定已停用的配置时返回 C0130。
- [x] 2.6 全量 `mvn verify` 通过，JaCoCo 行覆盖率不低于原值（92%）。

## 3. python-backend

- [x] 3.1 新增 `app/agent/review_gate.py::needs_refine(score, issues, rule_issues, min_score)`：
  - `config.py` 中的 `agent_review_threshold` 替换为 `agent_review_min_score=75`
  - 短文本 `review` 节点的 `passed` 改用该函数

  验证：单测覆盖 minor 不触发、major 触发、低于兜底分触发、规则问题触发、解析失败通过；更新现有图测试的预期。
- [x] 3.2 评审模型解析：
  - `TranslateRequest` 和 `DocPayload` 增加 `review_model_config_id`
  - 短文本与文档的评审调用通过 registry 取得评审模型，取不到或不可用时退回译者模型并记录警告
  - 短文本 review 事件增加 `reviewer`、`fallback`

  验证：单测用两个假 LLM，断言评审调用和修正调用分别发往不同的客户端，并覆盖退回场景。
- [x] 3.3 文档分块评审：
  - 改用 `needs_refine`，`_rule_issues` 只检查 hard 术语
  - chunk_result、`chunk_done` 和轨迹摘要增加 `reviewIssues: {critical, major, minor}`

  验证：`translate.py` 单测覆盖"只有轻微问题不修正""major 问题触发修正""软约束术语不触发修正"。
- [x] 3.4 术语约束强度：
  - `term_entry` 增加 `binding`；`align_terms` 未确认时，glossary 来源设为 hard、extracted 来源设为 soft；`confirm_terms` 的结果全部为 hard
  - `term_hits` 和 TermHit 携带 binding；`compliance` 只统计 hard
  - 旧检查点中缺少 binding 的条目按 hard 处理

  验证：单测覆盖"未确认时的约束强度""修改后确认"。
- [x] 3.5 提示词：
  - 分块翻译提示词把术语分为「术语表（必须使用）」与「参考译法（可按领域惯例调整，同一术语全文保持一致）」两节
  - 抽取提示词加入通用领域惯例规则（D2）

  验证：提示词单测断言两节按 binding 分开、抽取说明中包含惯例规则。
- [x] 3.6 一致性检查：软约束术语 `chosen=None`，按多数决定，平票时参考译法优先，同时作为变体参与检查。验证：单测覆盖"软约束按多数统一"，硬约束的原有用例不变。
- [x] 3.7 全量 `pytest` 与 `ruff` 通过，覆盖率不低于 95%。使用真实 LLM 冒烟一次短文本标准路径，评审模型为 gpt-6-luna，确认 review 事件的 reviewer 字段。

## 4. web

- [x] 4.1 类型与 API：
  - ModelConfig 和选项增加 `isReviewDefault`，新增 `setReviewDefault` / `clearReviewDefault`
  - DocTask 增加 `reviewModelConfigId`
  - DocTerm 状态增加 `AUTO`

  验证：`tsc --noEmit` 通过。
- [x] 4.2 模型配置页：
  - 「评审」徽标，徽标切换使用 `layoutId` 动效
  - 行菜单新增设置和取消评审模型，带确认弹窗
  - 顶部提示条在"未设置或与默认模型相同"时出现，可关闭

  验证：vitest 覆盖提示条逻辑；Playwright 截图核对徽标切换与提示条。
- [x] 4.3 新建任务对话框与 `meta.ts`：
  - 默认值改为 hybrid、人工确认、评审关闭；策略卡片带「推荐」角标
  - 预设分为「推荐」和「实验对照 D0–D6」两组
  - 开启评审时展开显示评审模型；第 ③ 步摘要显示评审状态
  - 同步更新 `estimateSeconds`

  验证：vitest 覆盖 `presetOf` 和默认值；截图核对三步结构未被平铺，展开动效生效。
- [x] 4.4 工作区：
  - 术语标签页按状态分组，AUTO 显示「参考」徽标并带悬停说明，分组标题吸顶，列表项依次淡入
  - 概览标签页显示评审模型

  验证：截图核对；在 DevTools 中开启 reduced-motion 后动效降级为无位移。
- [x] 4.5 `npm run lint`、`npm run test` 和 `npm run build` 全部通过。

## 5. evaluation

- [x] 5.1 `config.toml` 新增 `[improve]` 配置（评审模型 id=3、轮次 2）；`eval/client.py` 新增 `confirm_doc_terms`，`create_doc_task` 支持 `review_model_config_id`。验证：`tests/test_client.py` 新增用例。
- [x] 5.2 `eval/ablation/runner.py` 新增 I1–I3 分组：
  - I3 由执行器轮询到 AWAITING_CONFIRM 后，按金标术语表纠正候选并确认
  - 确认内容写入结果文件
  - 沿用断点续跑和失败重试

  验证：离线单测覆盖分组配置和模拟确认的纠正逻辑。
- [x] 5.3 `eval/metrics/terminology.py` 新增产出侧锁定判定（≥3 次、保留比例 <20%），返回锁定术语列表。验证：单测覆盖"识别锁定运行"；对旧 D 系列结果重算锁定率，并与原报告的 10/25 交叉核对、说明差异。
- [x] 5.4 运行 I1–I3 共 30 次（Spring、Python、Redis 和 PG 都需要在运行，评审模型已在后台设置）。验证：`results/doc/I*.json` 共 30 个，失败为 0（或记录了失败原因）。
- [x] 5.5 用新规则和评审模型重跑句子级标准路径（FLORES 100 句），输出到新文件，不覆盖旧结果。验证：结果文件包含 100 句，以及 reviewer 和 reviewIssues 字段。
- [x] 5.6 汇总：
  - 生成 `results/improve_summary.csv`、`figures/improve_lockin.png`、`figures/improve_quality_cost.png`
  - 补充 I 系列的 MQM 评审，沿用缓存

  验证：图中中文显示正常，CSV 包含 I1–I3 与 D3/D4/D6 的对照行。

## 6. 文档与收尾

- [x] 6.1 实验报告：
  - 新增 §9「基于实验的改进与验证」，包含锁定率对比、I1/I2/I3 结论、句子级评审对比、局限（模型漂移、评审与 MQM 评审同源）
  - §3.4 的每条建议标注落实情况，§7 的局限 6 更新

  验证：报告中的数字与 CSV 一致。
- [x] 6.2 更新 `docs/总体设计.md`：§9 路线图加入本变更，§4.2 和 §4.3 说明术语约束强度与评审模型。重新生成 `docs/test/测试报告.md`。
- [x] 6.3 `openspec validate --strict` 通过。按阶段提交（数据库与后端、Python、web、实验与报告），提交前检查暂存区中没有 `.env` 和密钥。
