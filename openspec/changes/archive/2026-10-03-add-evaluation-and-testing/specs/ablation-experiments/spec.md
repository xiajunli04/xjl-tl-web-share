## ADDED Requirements

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
