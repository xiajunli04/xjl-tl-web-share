## ADDED Requirements

### Requirement: 改进验证实验
评测工程 SHALL 对每篇篇章级测试文档按 I1–I3 三组配置各运行 2 轮（不使用术语库、目标语言中文、指定译者模型，策略 hybrid，contextWindow、globalSummary、termExtraction 开启）：I1 不确认术语、不评审；I2 不确认术语、开启评审并指定独立评审模型；I3 不评审、开启人工确认并由执行器模拟用户确认——源词在金标术语表中（不区分大小写）的候选改为金标译法，其余原样接受，确认内容记录到结果文件。断点续跑、失败重试与可追溯要求与 D 系列相同。

#### Scenario: 模拟人工确认
- **WHEN** I3 组任务进入待确认状态，候选包含 "Deployment → 部署"（金标为 "Deployment"）与 "rollout → 滚动更新"（不在金标中）
- **THEN** 执行器提交的确认术语为 "Deployment → Deployment" 与 "rollout → 滚动更新"，任务继续执行至完成

#### Scenario: 指定独立评审模型
- **WHEN** 执行 I2 组
- **THEN** 创建的任务 reviewModelConfigId 为配置中的评审模型 id，options.review=true，strategy=hybrid

### Requirement: 锁定率与改进对比
评测工程 SHALL 用统一的产出侧定义统计每次运行是否发生术语锁定：对金标中译法与源词相同、且在原文中出现至少 3 次（区分大小写）的术语，若对应译文段中保留源词的比例低于 20%，则该运行发生锁定。汇总 SHALL 对 D 系列与 I 系列同时计算锁定率，输出 I 系列与基线（D3、D4、D6）的指标对比表 `results/improve_summary.csv`，并生成锁定率对比图与质量—成本对比图。评测工程 SHALL 用新的评审规则与独立评审模型重跑句子级标准路径，统计修正触发率、chrF、BLEU 与 token 成本，与旧结果并列输出。

#### Scenario: 识别锁定运行
- **WHEN** 某运行的原文中 "Deployment" 出现 10 次，译文中只有 1 段保留了 "Deployment"
- **THEN** 该运行被记为发生锁定，锁定的术语列表包含 Deployment

#### Scenario: 生成对比素材
- **WHEN** I 系列全部完成后执行汇总脚本
- **THEN** 生成 `results/improve_summary.csv`、`docs/experiments/figures/improve_lockin.png` 与 `docs/experiments/figures/improve_quality_cost.png`
