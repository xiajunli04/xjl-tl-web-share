# ablation-experiments Specification

## Purpose
TBD - created by archiving change add-evaluation-and-testing. Update Purpose after archive.
## Requirements
### Requirement: 篇章级消融实验
评测工程 SHALL 通过平台对外接口，对每篇篇章级测试文档按 D0–D5 六组配置（另加 D6 混合策略）创建文档任务（不使用术语库、不确认术语、目标语言中文、指定译者模型），等待完成后取回段落与执行轨迹，保存为结果文件。D4 SHALL 重复运行一次以估计随机波动。任务失败时 SHALL 自动重试（最多 2 次），仍失败则记录失败原因。

#### Scenario: 配置正确
- **WHEN** 执行 D2 组
- **THEN** 创建的任务 options 为 contextWindow=true、globalSummary=true、termExtraction=false、review=false，strategy=serial

#### Scenario: 失败重试
- **WHEN** 某任务因 LLM 超时失败
- **THEN** 执行器调用继续接口，任务从断点完成，结果文件中记录了重试次数

### Requirement: 断点续跑与可追溯
实验执行器 SHALL 跳过已有结果文件的（文档、配置、轮次）组合，使中断后可以继续。每个结果文件 MUST 记录任务配置、译者模型、git commit、开始与结束时间、平台任务 id。

#### Scenario: 中断后继续
- **WHEN** 执行器在完成 20 个组合后被中断，然后重新启动
- **THEN** 只执行剩余的组合

### Requirement: 句子级对比
评测工程 SHALL 对 FLORES 100 句分别用快速路径和标准路径（含评审修正）调用短文本流式翻译接口，计算语料级 chrF / BLEU，并统计评审修正触发率、平均评审分与 token 成本。

#### Scenario: 记录修正触发
- **WHEN** 标准路径下某句评审未通过并修正了 1 轮
- **THEN** 结果中该句的 reviewRounds=1，汇总的修正触发率计入该句

### Requirement: 汇总与图表
评测工程 SHALL 由结果文件计算全部指标，输出每组 × 每篇的明细表和每组均值表（CSV），并生成图表：消融柱状图（各指标）、质量与成本的散点图、策略对比图。图中中文 MUST 正常显示。

#### Scenario: 生成报告素材
- **WHEN** 全部组合完成后执行汇总脚本
- **THEN** 生成 `results/doc_metrics.csv`、`results/doc_summary.csv` 以及 `docs/experiments/figures/` 下的 PNG 图

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

### Requirement: 翻译记忆留一法实验
评测工程 SHALL 为每篇篇章级测试文档执行留一法实验：使用专用评测用户（翻译记忆按用户隔离），先由该用户按 I3 配置把 5 篇各翻译一次作为记忆来源，再对每篇清空其翻译记忆、写入其余 4 篇来源任务的全部段落译文，然后按 I1 配置分别以 translationMemory 关闭与开启翻译该篇（各 1 轮），保存结果并统计 chrF、术语准确率、术语一致率、每块平均记忆命中数与 token。

#### Scenario: 记忆来自其余文档
- **WHEN** 执行 pods 文档的留一法实验
- **THEN** 评测用户的记忆中只包含 configmap、deployment、service、volumes 四篇的译文，不包含 pods 的任何段落

### Requirement: 会话上下文实验
评测工程 SHALL 使用自建的多轮对话测试集（12 段、每段 5 轮，每轮标注需要上下文才能正确翻译的片段及正确译法），分别以无会话（每轮独立请求）和有会话（同一会话逐轮请求）两种方式翻译，由评审模型逐项判定标注片段是否译对（现象准确率），并对两组整段译文做不知来源的成对偏好比较。结果 SHALL 输出每组的现象准确率、偏好胜率与 token。

#### Scenario: 现象判定
- **WHEN** 某轮标注"it → 耳机"，有会话组译为"它（耳机）已经无法使用"、无会话组译为"它坏了"且无法判断所指
- **THEN** 评审结果中有会话组该项判定为正确，无会话组判定为错误

### Requirement: 歧义检测实验
评测工程 SHALL 使用自建的 20 句有歧义（标注歧义片段）与 20 句无歧义句子，在允许追问的会话中以标准路径提交，统计追问触发的精确率、召回率与歧义片段命中率，以及 plan 节点的平均耗时；实验结束时 SHALL 放弃全部待回答追问。

#### Scenario: 统计检测结果
- **WHEN** 20 句歧义句中 16 句触发追问、20 句无歧义句中 2 句触发追问
- **THEN** 报告召回率 0.80、精确率 16/18≈0.89

