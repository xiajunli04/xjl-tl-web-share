# 语音延迟基线（improve-speech-playback-latency 0.2）

- 测量时间：2026-10-06，代码版本 `e0851a5`（改动前），本机 Python AI 服务（`python -m app`，无 reload），网络为本机宽带
- 默认 TTS：edge-tts（MP3）；对话/翻译模型：`evaluation/config.toml` 中 `mt_model_config_id = 7`
- 起点口径：
  - `e2eMs`（服务端）：VAD 判定句末 → 首段译音下发
  - `playMs`（客户端，新增）：`e2eMs` + 首个 audio 到首个“可开始播放”分包的等待（旧协议下 mp3 需等整句 `last=true`）
  - `replyFirst*Ms`（客户端，新增）：测试音频最后一帧送出 → AI 回复首包 / 首个可播放分包（含 VAD 静音等待）

## 1. 级联同传收听（E4 cascade_full，40 句 × 3 遍）

命令：`uv run python -m eval.multimodal.e4_interpret run --groups cascade_full --out results/speech-latency/baseline-<i>`

| 指标（ms） | 第 1 遍 P50 | 第 2 遍 P50 | 第 3 遍 P50 | **中位数** | 第 3 遍 P90 |
|---|---|---|---|---|---|
| asrMs | 1001 | 807 | 854 | **854** | 1168 |
| mtFirstMs | 1527 | 1489 | 1502 | **1502** | 2063 |
| mtMs | 1610 | 1583 | 1578 | **1583** | 2117 |
| ttsFirstMs | 929 | 884 | 905 | **905** | 1843 |
| e2eMs | 3650 | 3555 | 3511 | **3555** | 4470 |
| playMs | 3849 | 3686 | 3687 | **3687** | 4829 |

识别错误率 4.5%，chrF 60–64，术语准确率 100%（与 E4 结论一致）。

## 2. AI 对话（级联，`chat_smoke --wav zh-03.wav --runs 3`）

| 指标（ms） | 中位数 |
|---|---|
| replyFirstAudioMs（说完 → 回复首包） | **5510** |
| replyFirstPlayableMs（说完 → 首个可播放音频） | **6930** |
| reply.mtFirstMs（对话模型首字） | 1833 |
| reply.ttsFirstMs | 1957 |
| reply.e2eMs | 5980 |

## 3. 观察

1. **AI 对话**：首包到可播放还要多等约 1.4 s。原因是整条回复（多句）共用一条 MP3 track，前端要等 `last=true` 才解码；设计 D3/D5 的逐句成段直接针对这一点。
2. **同传短句**：串行等待（等译文全文 + MP3 整句缓冲 + 扣包）合计只占约 0.2 s（`mtMs − mtFirstMs` ≈ 80 ms，`playMs − e2eMs` ≈ 130 ms）。e2e 主要由三部分构成：
   - 模型首字约 1.5 s；
   - 识别约 0.85 s；
   - Edge 首包约 0.9 s。

   因此仅靠流水线改造，同传达不到“e2e 下降 35%”的目标，需要追加以下措施：
   - **识别**：SenseVoice 单独解码 4.1 s 音频只要约 0.4 s，服务内却是 0.85 s。原因是句末定稿时，正好和进行中的 partial 识别（每 700 ms 对整段重识别一次）争 CPU。优化办法：尾部静音开始后不再发起新的 partial。
   - **模型首字**：取决于所选模型和中转网关，属于配置层面（向导中提示选择快速模型）。
3. **测量注意**：Windows 上，Python 客户端用 `localhost` 连接只绑定 IPv4 的 uvicorn 时，每个新连接多约 2 s（IPv6 回落）。评测脚本是长连接，只影响建连，不影响逐句指标；单次 HTTP 测量要用 `127.0.0.1`。
