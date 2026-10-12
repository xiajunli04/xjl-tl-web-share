# 同传评测数据集（自建，E4）

用于 add-speech-and-image-translation 的 E4 实验（实验报告第 11 节）。

## 组成

- `sentences.jsonl`：40 句口语化句子，中文、英语、日语、韩语各 10 句。
  - 每种语言分两个场景，每个场景 5 句连续对话（`scene` + `order`），后句的代词或省略依赖前句。
  - 方向：中文 → 英语，英语 / 日语 / 韩语 → 中文。
  - `reference`：本人逐句校对的参考译文。
  - `context`：需要前文才能译对的观察点（5 句），用于"带 / 不带上下文"对照。
  - `terms`：句中出现的术语（来自 `glossary.json`，6 条），用于"带 / 不带术语"对照与术语准确率。
- `glossary.json`：评测用术语表（灰度发布 → canary release、大模型 → LLM、매출 → 销售额 等）。
- `audio/{id}.wav`：16 kHz、单声道、PCM16 的合成音频，单句 2–6 秒。

## 生成方式

```bash
cd evaluation
uv run python -m eval.multimodal.speech_dataset synth   # 用 edge-tts 合成缺失的音频（--force 全部重做）
uv run python -m eval.multimodal.speech_dataset check   # 校验 40 条记录与音频齐全
```

合成音色：中文 `zh-CN-YunxiNeural`、英语 `en-US-GuyNeural`、日语 `ja-JP-KeitaNeural`、韩语 `ko-KR-InJoonNeural`（均为男声；平台播报默认用女声，避免"同一音色合成又识别"）。

## 局限

- **合成语音不是真人语音**：发音标准、无口音、无背景噪声、语速均匀，识别难度明显低于真实会议场景，E4 的识别错误率应视为乐观下界。
- 句子短（单句），不覆盖长句断句、多人重叠说话、语种中途切换等难点。
- 规模小（40 句），延迟与质量结论只作参考；百分位数在样本少时波动较大。
- 参考译文为单一参考，chrF 对合理的同义改写会扣分。
