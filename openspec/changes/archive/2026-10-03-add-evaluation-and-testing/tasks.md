## 1. infra：评测工程骨架与覆盖率配置

- [x] 1.1 创建 `evaluation/` uv 工程（Python 3.12），预先加入全部依赖（httpx、sacrebleu、openai、lingua-language-detector、fasttext-wheel、langdetect、locust、matplotlib、pandas、fastapi、uvicorn、pytest、ruff），建立 design D1 的目录骨架与 `eval/config.py`（读取根目录 .env 与 `evaluation/config.toml`）（验证：`uv run --no-sync pytest` 能运行；`uv run --no-sync python -c "import sacrebleu, lingua, fasttext, locust"` 成功）
- [x] 1.2 实现 `eval/client.py`：登录与令牌刷新、创建文档任务、轮询、取段落与轨迹、继续、短文本 SSE 翻译（复用平台事件格式）、模型配置的查询与切换默认（验证：对运行中的平台执行一次登录与列出模型配置）
- [x] 1.3 三端覆盖率配置：Spring 加 jacoco-maven-plugin（verify 阶段生成报告）；Python 开发依赖加 pytest-cov；Web 加 @vitest/coverage-v8 与 `test:coverage` 脚本（只统计 src/lib 与 src/hooks）（验证：三条命令分别生成 jacoco.csv、coverage.xml 和 vitest 覆盖率摘要）

## 2. 测试集

- [x] 2.1 实现 `eval/dataset/k8s.py`：按固定 commit 下载 5 篇中英文文档，按 design D2 规则清洗与截取，写入 `data/k8s/{doc}.en.md`、`{doc}.zh.md` 与 manifest（验证：单元测试覆盖短代码、注释、front matter 的清洗；人工抽查每篇中英文的二级标题一一对应，英文不超过 8000 字符）
- [x] 2.2 整理 `data/k8s/terms.json`：每篇 10–20 条金标术语与专名（含变体），依据参考译文的实际用法（验证：脚本校验每条术语在英文原文中至少出现 2 次，且金标译法在参考译文中出现）
- [x] 2.3 实现 `eval/dataset/flores.py`：下载并校验 FLORES-200，抽取 en-zh 100 句与 15 种语种三档 LID 样本（固定随机种子），写入 `data/flores/`、`data/lid/`（验证：两次生成结果完全相同；每种语种每档 100 条）

## 3. 指标

- [x] 3.1 实现 `eval/metrics/chrf_bleu.py`（d-chrF、d-BLEU、语料级 chrF / BLEU）（验证：单元测试覆盖完全一致为 100，以及与 sacrebleu 命令行结果一致）
- [x] 3.2 实现 `eval/metrics/terminology.py`（按出现次数的术语准确率、术语一致率、专名一致率；词边界、大小写、跳过行内代码）（验证：单元测试覆盖 translation-metrics 规格中"不被子串误导"与"一致率"两个场景，以及跨段落统计）
- [x] 3.3 实现 `eval/metrics/mqm_judge.py`（GEMBA-MQM 提示词、JSON 容错与一次重试、罚分与每千源词归一化、按内容哈希缓存）（验证：用假 LLM 测试罚分计算、解析失败重试、缓存命中不调用模型）
- [x] 3.4 实现 `eval/metrics/cost.py`（token、逐块耗时之和、墙钟时间）（验证：单元测试覆盖"排除等待时间"场景）

## 4. 消融实验执行器

- [x] 4.1 实现 `eval/ablation/runner.py`：D0–D6 配置表、篇章级执行（并发 2、失败自动 retry 最多 2 次、断点续跑、结果文件记录配置/模型/git commit/时间/任务 id）、句子级 fast 与 standard 对比（验证：用假平台客户端测试配置映射、跳过已完成组合、重试逻辑）
- [x] 4.2 实现 `eval/ablation/aggregate.py`（读取结果文件，调用各指标，输出 `doc_metrics.csv`、`doc_summary.csv`、`sentence_metrics.csv`；MQM 评审批量执行并缓存）与 `eval/ablation/plots.py`（消融柱状图、质量-成本散点图、策略对比图，中文字体）（验证：用构造的结果文件生成表格与 PNG，人工检查中文显示）

## 5. 语种识别对比

- [x] 5.1 实现 `eval/lid/benchmark.py`：lingua 高/低精度、fastText lid.176（下载校验与语种映射）、langdetect、LLM 批量识别；分档与分语种准确率、混淆对、吞吐（验证：单元测试覆盖语种映射与范围外预测计为错误；在 LID 样本上完整运行）
- [x] 5.2 运行语种识别对比，输出 `results/lid_metrics.csv` 与热力图、分档柱状图（验证：结果文件与图生成，LLM 部分记录调用次数与延迟）

## 6. 性能测试工具

- [x] 6.1 实现 `mock_llm/server.py`：OpenAI 兼容流式与非流式接口，JSON 模式下按请求内容返回评审 / 分块翻译 / 术语抽取 JSON，延迟可配置（验证：单元测试覆盖三种 JSON 形态与流式格式；用 openai SDK 调用通过）
- [x] 6.2 实现 `eval/perf/`：压测账号批量准备、mock 模型配置的注册/设为默认/恢复（含异常退出时恢复）、Locust 三个场景（REST、短文本流式含 TTFE、文档任务吞吐）、按档位执行与汇总（验证：在主控提供的运行中平台上用 10 并发跑 15 秒冒烟，确认三个场景都有数据且默认模型被恢复）

## 7. 执行实验与报告（主控）

- [x] 7.1 执行篇章级消融实验（5 篇 × D0–D6，D4 重复 1 次）与句子级对比，完成 MQM 评审与汇总，生成图表（验证：结果文件齐全，失败组合有记录）
- [x] 7.2 执行性能测试（10 / 50 / 100 并发与文档吞吐），汇总结果（验证：结果 CSV 与汇总表生成，默认模型已恢复）
- [x] 7.3 生成覆盖率并实现 `eval/report_tests.py`，产出 `docs/test/测试报告.md`（验证：报告包含三端测试数、通过率、覆盖率与规格对照）
- [x] 7.4 撰写 `docs/experiments/实验报告.md`（设置、结果表、图、分析、局限），并运行 `openspec validate add-evaluation-and-testing --strict`（验证：报告中的数字与结果 CSV 一致；validate 通过）
