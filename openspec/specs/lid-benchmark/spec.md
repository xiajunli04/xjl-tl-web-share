# lid-benchmark Specification

## Purpose
TBD - created by archiving change add-evaluation-and-testing. Update Purpose after archive.
## Requirements
### Requirement: 语种识别器对比
评测工程 SHALL 在语种识别样本上比较 lingua（高精度与低精度模式，限定 15 种语种）、fastText lid.176、langdetect 与 LLM 批量识别（每次 25 条、JSON 输出；每档每语种抽 10 条），按长度档位和语种计算准确率，统计吞吐（条/秒），LLM 另报告平均延迟。识别器的输出 MUST 映射到 15 种语种的代码，范围外的预测计为错误。

#### Scenario: 分档结果
- **WHEN** 执行语种识别对比
- **THEN** 输出每个识别器在单词、词组、整句三档上的准确率，以及最常被混淆的语种对

#### Scenario: 识别器不可用
- **WHEN** fastText 模型文件下载失败
- **THEN** 跳过该识别器继续执行其余识别器，并在结果中注明

