# multimodal-evaluation Specification

## Purpose
TBD - created by archiving change add-speech-and-image-translation. Update Purpose after archive.
## Requirements
### Requirement: 同传评测数据集
系统 SHALL 提供 `evaluation/data/speech/` 数据集：zh、en、ja、ko 各 10 句，共 40 句口语化句子，每句带人工校对的参考译文（zh↔en，ja/ko→zh）。数据集 SHALL 附有生成脚本，用 edge-tts 合成音频，合成音色与播报音色不同，并在 README 中说明合成音频的局限。

#### Scenario: 数据集完整
- **WHEN** 运行数据集校验
- **THEN** 40 条记录都有原文、语种、参考译文和对应的 16 kHz WAV 文件

### Requirement: E4 同传评测
系统 SHALL 提供 E4 评测脚本：把数据集音频按实时速度（40 ms 一帧）推入 Python 同传端点，统计以下指标：
- 识别字错率（中日韩用 CER，英文用 WER）；
- 语音翻译 chrF，并与"参考原文直接走文本快速路径"的 chrF 作为上界对比；
- 分段延迟（asr、mtFirst、mt、ttsFirst、e2e）的 p50/p90。

E4 SHALL 包含"带术语与上下文 / 不带"的对照组，以及级联与百炼 S2S 引擎的同场对比。没有密钥的可选 S2S 引擎，对应组 MUST 标记为跳过，并在报告中说明。

#### Scenario: 生成汇总
- **WHEN** 运行 E4 脚本完成级联引擎评测
- **THEN** 输出 `results/multimodal/e4_summary.csv` 和延迟分布图，包含上述全部指标

### Requirement: E5 图片翻译评测
系统 SHALL 提供 `evaluation/data/image/` 数据集：至少 30 张由脚本渲染的合成图片，覆盖告示、菜单和商品标签三类场景，以及中、英、日三种源语言。合成图片使用不同字体、颜色、背景和小角度倾斜，每张图带真值文本块（文本与 bbox）和参考译文。E5 脚本 SHALL 统计：
- OCR 字符准确率；
- 文本块召回（IoU ≥ 0.5）；
- 译文 chrF；
- 术语准确率；
- 耗时与 token。

E5 SHALL 对比"两步法（OCR → 平台翻译）"与"单次视觉翻译"两组。

#### Scenario: 两组对比
- **WHEN** 运行 E5 脚本
- **THEN** 输出 `results/multimodal/e5_summary.csv`，两组在相同图片上的各项指标并列

### Requirement: 实验报告第 11 节
实验报告 SHALL 新增第 11 节"语音与图片翻译实验"，内容包括：
- E4/E5 的设置、结果表与图；
- 结论与局限（合成数据、中转站无语音模型、S2S 引擎未联调时引用厂商公布指标并注明来源）。

报告中的每个数字 MUST 能在结果文件中找到对应。

#### Scenario: 数据可追溯
- **WHEN** 读者核对第 11 节中的级联 e2e 延迟 p50
- **THEN** 能在 e4_summary.csv 中找到相同的数值

