## Why

题目要求"完成主要功能测试和性能验证"，而论文最核心的问题——"Agent 相比直接调用大模型到底带来了什么"——必须用实验数据回答。①②③ 已经交付了全部功能，③ 还内置了 D0–D5 消融开关与逐块数据采集，但目前还没有测试集、指标计算、实验执行器和性能压测工具，也没有汇总的测试报告。本 change 补齐"评测与验证"这一环，产出论文实验章节与测试章节可以直接使用的数据、图表和报告。

## What Changes

- **评测工程 `evaluation/`**：独立的 uv 工程（Python 3.12），以黑盒方式通过 Spring 对外接口驱动平台，与业务代码解耦
- **测试集构建**：
  - 篇章级：从 Kubernetes 官方文档（kubernetes/website）选取 5 篇英文原文及其官方简体中文译文，清洗 front matter、Hugo 短代码和英文原文注释，得到源文档与参考译文；每篇附人工整理的金标术语与专名表（含常见变体）
  - 句子级：FLORES-200 devtest 中 eng_Latn→zho_Hans 的 100 句
  - 语种识别：从 FLORES-200 中抽取 15 种支持语种的单词、词组、整句三档短文本
- **翻译质量指标**：d-chrF 与 d-BLEU（sacrebleu，中文按字切分）、GEMBA-MQM 风格的无参考 LLM 评审（使用与译者不同的模型）、金标术语准确率、术语一致率、专名一致率、成本（token、逐块耗时之和、墙钟时间）
- **消融实验执行器**：对每篇文档按 D0–D5 六组配置创建文档任务，等待完成后取回段落计算指标；D4 重复一次以估计随机波动；句子级比较快速路径与标准路径（评审修正）；结果写入 JSONL/CSV，可断点续跑
- **语种识别对比实验**：lingua（高精度 / 低精度模式）、fastText lid.176、langdetect、LLM 批量识别，在三档长度上比较准确率与吞吐
- **性能测试**：OpenAI 兼容的 mock LLM 服务（流式与 JSON 模式、可配置延迟）；Locust 压测脚本覆盖 REST 查询、短文本流式翻译（首事件时间、总耗时）与文档任务吞吐；不同并发档位的 RPS、p50/p95/p99、错误率
- **测试覆盖率与测试报告**：Spring JaCoCo、Python pytest-cov、Web vitest coverage；汇总各模块测试数、覆盖率与规格场景对照，生成 `docs/test/测试报告.md`
- **实验报告**：`docs/experiments/` 下的结果数据、matplotlib 图表（中文字体）与 `实验报告.md`（实验设置、结果表、图、分析与局限）

## Capabilities

### New Capabilities

- `evaluation-dataset`：篇章级与句子级测试集、金标术语表、语种识别数据的获取、清洗、格式与版本固定
- `translation-metrics`：d-chrF / d-BLEU、LLM 评审（MQM）、术语准确率与一致率、专名一致率、成本统计
- `ablation-experiments`：D0–D5 实验执行器、句子级对比、断点续跑、结果汇总与图表
- `lid-benchmark`：语种识别器对比实验
- `performance-benchmark`：mock LLM 服务、压测脚本与压测报告
- `test-report`：三端覆盖率采集与汇总测试报告

### Modified Capabilities

（无。评测以黑盒方式调用既有接口，不改变平台需求。）

## 非目标

- 不做人工评测（人工 MQM 标注、偏好打分）；以自动指标与 LLM 评审为主，并在报告中说明其局限
- 不计算 COMET（需要下载约 2 GB 模型，本机网络不稳定）；保留扩展接口
- 不做平台内的评估看板页面（论文需要的是图表与报告）
- 不调整平台的翻译策略与阈值（实验只观察、不调参；调参建议写进报告）
- 不做分布式压测与生产环境压测（只做单机本地基准）
- 不实现路线图 ④（会话上下文与翻译记忆）

## 依赖关系（对照 docs/总体设计.md 路线图）

- 依赖 ①②③ 的全部对外接口：认证、`/api/translate/stream`、`/api/doc-tasks/*`、模型配置
- 依赖 ③ 的实验开关（`options`、`strategy`）与逐块 trace 数据
- 独立于 ④；④ 完成后可复用本工程追加会话与翻译记忆的实验

## Impact

- **新增工程** `evaluation/`：依赖 httpx、sacrebleu、openai、lingua-language-detector、fasttext-wheel、langdetect、locust、matplotlib、pandas、pytest
- **springboot-backend**：pom 增加 jacoco-maven-plugin（只用于生成报告，不设置门槛）
- **python-backend**：开发依赖增加 pytest-cov
- **web**：开发依赖增加 @vitest/coverage-v8，新增 `test:coverage` 脚本
- **docs**：新增 `docs/experiments/`、`docs/test/测试报告.md`；测试数据放在 `evaluation/data/`（原始下载内容不入库，只提交清洗后的版本与校验和）
