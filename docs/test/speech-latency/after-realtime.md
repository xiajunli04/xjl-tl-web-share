# 实时语音模型引擎联调（improve-speech-playback-latency 4.6）

- 测量时间：2026-10-06，代码版本 `b32e940`，新代码实例 `127.0.0.1:8001`
- 模型配置：REALTIME_CHAT + DASHSCOPE，`qwen3-omni-flash-realtime`，音色 Cherry；母语字幕用 7 号 qwen-turbo
- 命令：`uv run python -m eval.multimodal.chat_smoke --engine realtime-chat --runs 3 --wav data/speech/audio/zh-03.wav --ws ws://127.0.0.1:8001/internal/interpret/stream`
- 协议事件序列：`python-backend/tests/fixtures/interpret/omni_realtime_events.jsonl`

| 指标（ms，中位数，3 遍） | 级联（改造前） | 级联（改造后） | **实时语音模型** |
|---|---|---|---|
| replyFirstAudioMs（说完 → 回复首包） | 5510 | 3260 | **530** |
| replyFirstPlayableMs（说完 → 首个可播放音频） | 6930 | 3460 | **530**（pcm16 首包即可播） |
| reply.mtFirstMs（回复首字） | 1833 | 1647 | 117 |
| reply.ttsFirstMs（回复创建 → 首个音频） | 1957 | 820 | 286 |
| reply.e2eMs（服务端句末 → 首段音频） | 5980 | 3664 | **400** |

**结论**：达到“实时语音模型 p50 ≤ 1.2 s”的目标。3 遍均正常完成，包括：
- 场景开场白（服务员身份）；
- 用户转写；
- “You could say: …”纠正示范；
- 中文字幕逐句翻译（`translation.final` 正常）。

**说明**：
- `replyFirst*` 以测试音频最后一帧送出为起点，含服务端 VAD 判句末的时间（静音阈值 500 ms），因此与 e2eMs 的口径不同。
- 实时语音模型按音频时长计费，比级联贵。默认引擎仍为平台级联，向导中由用户选择是否使用。
