## MODIFIED Requirements

### Requirement: 本地模型下载
系统 SHALL 提供命令 `uv run python -m app.speech.download`，把以下模型下载到 `SPEECH_MODEL_DIR`（默认 `.cache/speech/`，不入库）：
- SenseVoice int8 模型；
- silero_vad.onnx；
- 断句判定模型 Smart Turn v3 int8 ONNX，来自 HuggingFace `pipecat-ai/smart-turn-v3`。

镜像：
- GitHub 资源支持通过 `SPEECH_MODEL_MIRROR` 指定镜像；
- HuggingFace 资源支持通过 `SPEECH_HF_MIRROR` 指定镜像（如 `https://hf-mirror.com`）。

已存在且校验通过的文件 MUST 跳过。Smart Turn 模型下载失败时 MUST 只给出警告，不影响其他模型与命令的退出码；该模型缺失时断句退化为文本规则（见 speech-endpointing）。

#### Scenario: 重复执行
- **WHEN** 模型已下载完整后再次执行下载命令
- **THEN** 命令提示已存在并直接退出，不重复下载

#### Scenario: 断句模型下载失败
- **WHEN** 无法访问 HuggingFace 且未配置镜像，执行下载命令
- **THEN** SenseVoice 与 VAD 照常下载，命令提示 Smart Turn 模型下载失败及镜像配置方法，退出码为 0
