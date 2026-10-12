## ADDED Requirements

### Requirement: 覆盖率采集
三端 SHALL 能生成测试覆盖率报告：Spring 在 verify 阶段由 JaCoCo 生成 CSV 与 HTML 报告；Python 通过 pytest-cov 生成 XML 报告；Web 通过 vitest 的 v8 覆盖率统计 `src/lib` 与 `src/hooks`。覆盖率 MUST NOT 设置构建门槛。

#### Scenario: 生成报告
- **WHEN** 分别执行三端带覆盖率的测试命令
- **THEN** 得到 `jacoco.csv`、`coverage.xml` 和 vitest 的覆盖率摘要

### Requirement: 汇总测试报告
评测工程 SHALL 解析三端的测试结果与覆盖率，生成 `docs/test/测试报告.md`，内容包括测试环境、各工程测试数与通过率、按模块的行覆盖率、规格能力与测试的对照表（链接到各阶段的冒烟测试记录）以及已知局限。

#### Scenario: 报告内容
- **WHEN** 执行报告生成脚本
- **THEN** 报告中列出 Spring、Python、Web 各自的测试总数、通过数与总体行覆盖率，以及至少 15 个规格能力的测试对照
