## 1. python-backend：断句组件

- [x] 1.1 新增 `app/speech/endpointing.py`：
  - `CONTINUATION_WORDS`（zh/en/ja/ko 延续词，含中文"的"结尾的例外表）、`is_filler_only`、`meaningful`；
  - `TurnJudge`（文本强规则 → Smart Turn → 退化）。

  验证：`uv run pytest tests/speech/test_endpointing_rules.py`。用例覆盖探针中的半句（"请问去。""Let's move on to the."）、例外（"挺好的。""好的。"）、纯语气词与单字回答。
- [x] 1.2 实现 Smart Turn v3 推理 `app/speech/smart_turn.py`：
  - numpy 版 Whisper log-mel（80 mel，8 s，波形归一化）；
  - 独立 onnxruntime 会话（1 线程），`asyncio.to_thread` 调用；
  - 文件缺失或加载失败时 `available=False` 并记录一次日志。
  - pyproject 显式声明 `onnxruntime`。

  验证：特征与参考 `tests/fixtures/whisper_mel_ref.npy` 误差 < 1e-4；单句推理耗时打印 < 100 ms。
- [x] 1.3 下载命令支持 Smart Turn：
  - `models.py` 增加路径与 HuggingFace 地址，`download.py` 下载并校验；
  - 新增配置 `SPEECH_HF_MIRROR`；失败只告警且退出码为 0。

  验证：`uv run python -m app.speech.download` 两次执行（第二次跳过）；断网或错误镜像时提示并返回 0。
- [x] 1.4 实现 `Endpointer`：
  - 状态机 IDLE / SPEAKING / JUDGING / HOLDING；
  - 拼接音频重新识别（段间插入 120 ms 静音）；
  - 音频时钟计时加墙钟兜底的续说等待；
  - 强制定稿条件（flush / 强制切段 / 合并上限）；
  - 输出 Partial / Hold / Commit(holdMs, startedMs, endedMs) / Discard 判定；
  - 提供 `current_audio()` 供 partial 使用。

  验证：`tests/speech/test_endpointer.py` 用假 ASR 与假判定器覆盖：停顿合并、超时定稿、flush、合并上限、强制切段、停顿中的语气词、噪声丢弃、续说等待为 0 时退化。
- [x] 1.5 配置项写入 `core/config.py`：
  - 续说等待：同传 / 极速 / 对话 / 对话极速；
  - 合并上限；
  - `endpoint_smart_turn`、阈值；
  - 让位恢复时长；
  - `realtime_chat_silence_ms`、`realtime_chat_openai_eagerness`。

  验证：`uv run pytest tests/core` 通过，`.env.example` 同步注释。

## 2. python-backend：引擎接入

- [x] 2.1 `cascade.py` 改用 `Endpointer`：
  - 按 mode 与 latencyMode 选择档位；
  - partial 基于合并音频并带 `hold`；
  - Discard 时发 `transcript.discard`；
  - `metrics` 增加 holdMs；
  - 被丢弃的语句不进入 `_recent`。

  验证：`uv run pytest tests/interpret` 全绿，新增"停顿合并只翻译一次""纯语气词撤回"两个用例。
- [x] 2.2 `chat.py` 回复让位：
  - `interrupt{yield:true}` → 取消回复，发 `transcript.discard{role:assistant}`；
  - 从 DialogMemory 移除或不写入该回复；
  - 记录待恢复轮次；
  - 恢复计时到期或续说被丢弃时重新回复；
  - 纯语气词用户句不触发回复。

  验证：`tests/interpret/test_chat_yield.py` 覆盖"让位后合并回应"（检查发给 LLM 的消息中两句用户话合并为一轮）与"让位后噪声恢复回复"。
- [x] 2.3 `realtime_chat.py` 适配器断句参数：
  - 百炼 server_vad 800 ms，`qwen3.5-omni*` 使用 semantic_vad；
  - OpenAI 使用 semantic_vad + eagerness；
  - `extra.turnDetection` 覆盖。

  验证：单测断言各分支 session.update 的 turn_detection 内容；有百炼密钥时用 `chat_smoke.py --engine realtime-chat` 跑一轮。
- [x] 2.4 `engine.py` / mock：
  - 内部 WS 测试替身（mock 上游）补充 discard、hold 事件；
  - `UtteranceMetrics.to_event` 输出 holdMs。

  验证：`uv run pytest` 全量通过，`uv run ruff check app tests` 无告警。

## 3. springboot-backend：撤回事件

- [x] 3.1 `RoomRegistry` 处理 `transcript.discard`：
  - 照常广播；
  - 调用 `RecentUtterances.remove(uid)`，AI 撤回同样适用；
  - 调用 `SegmentWriter.discard(sessionId, uid)`：移除待合并段，已写出则删除该行。

  验证：`./mvnw test -Dtest=InterpretStreamTest,SegmentWriterTest`，新增用例"partial → discard 后历史中没有该句""AI 回复定稿后被 discard，历史中没有该回复"。
- [x] 3.2 `MockInterpretServer` 支持脚本化发出 discard 与 hold；metrics 落库保留 holdMs 字段。

  验证：`./mvnw test` 全量通过；会话详情接口返回的指标 JSON 含 holdMs。

## 4. web：协议与归并

- [x] 4.1 `protocol.ts` 增加：
  - `transcript.discard` 事件；
  - partial 的 `hold`；
  - metrics 的 `holdMs`；
  - 控制帧 `interrupt.yield`；
  - KNOWN 集合同步更新。

  验证：`pnpm test src/lib/interpret` 中解析用例通过。
- [x] 4.2 `reducer.ts`：
  - discard 移除；
  - 按发言流序号插入（只查末尾 50 条，无法解析时追加）；
  - 过期收尾；
  - `hold` / `updatedAt` 字段；
  - 派生函数 `visibleText`、`isDisplayable`、`isActive`。

  验证：reducer 单测覆盖"partial→discard 无残留""迟到用户转写排在 AI 回复前""过期收尾移除空句、冻结有译文的句子"。
- [x] 4.3 `interpret-store.ts` 增加 `applyMany`；`InterpretRuntime.onEvent` 文本事件按 rAF 合并（页面隐藏时改为 50 ms），读取最新状态前调用 `flushPending()`。

  验证：单测模拟 100 个 delta，store 订阅回调次数 ≤ 帧数；打断、让位用例仍通过。
- [x] 4.4 `lib/interpret/setup.ts`：新增 `isMeaningfulSpeech`（语气词表与后端一致）；`shouldAutoInterrupt` 增加有效语音条件。

  验证：单测覆盖"嗯""um""好的""OK"。

## 5. web：播报与让位

- [x] 5.1 `AudioQueue` 开播门：
  - `setStartGate(canStart, maxDeferMs)`，开始新句前检查，100 ms 复查，超过 4 s 强制开播；
  - 已开始的句子与重播不受影响。

  验证：`pnpm test src/lib/audio` 新增用例（推迟、4 s 上限、门打开后立即开播）。
- [x] 5.2 `use-interpret-socket.ts`：
  - 本机说话检测：电平阈值持续 120 ms 加 600 ms 挂起；
  - 本机未定稿语句检测；
  - 按模式接入开播门（半双工 LISTEN / CONVERSE、CHAT）；
  - 门控关闭且本机有 hold 语句时发 `flush`。

  验证：hooks 单测加 mock 模式手测（`?mic=real`），双向对话中说话时译文推迟开播。
- [x] 5.3 让位：
  - CHAT 收到本人有效 partial，且最近 AI 回复未开始播放时，丢弃其排队音频、本地隐藏，并发送 `interrupt{yield:true}`；
  - 收到 discard 后彻底移除。

  验证：hooks 单测；mock 同传 socket 脚本演示"抢答 → 让位 → 合并回应"。

## 6. web：实时字幕组件与视图

- [x] 6.1 新增 `components/interpret/streaming-text.tsx`：
  - 公共前缀稳定，尾部以浅色淡入；
  - 光标只在 active 时显示；
  - hold 时显示呼吸点；
  - reduced-motion 下降级。

  验证：组件单测（前缀计算、拉丁语按词边界回退）；Storybook 式演示页或 mock 截图。
- [x] 6.2 新增 `listening-indicator.tsx`：
  - 声波条复用电平 motion value；
  - "正在听…"；会议室显示"某某正在说话…"。

  新增 `hooks/use-stick-to-bottom.ts`（96 px 阈值、ResizeObserver、新消息胶囊计数）。

  验证：hook 单测（上翻后不跟随、点击胶囊回到底部）。
- [x] 6.3 改造 `room-view.tsx`：
  - 只渲染可显示语句，使用 StreamingText 与分组气泡（60 s 内同一发言人）；
  - 接入正在听或正在说话指示、跟随滚动与新消息胶囊；
  - Message 改为 memo。

  验证：mock 模式截图，确认无空白气泡、分组生效、上翻不被抢回。
- [x] 6.4 改造 `listen-stage.tsx`：
  - 原文行无文字时显示"正在听"，不再出现孤立光标；
  - partial 使用 StreamingText；
  - 历史字幕跟随滚动。

  验证：mock 截图。
- [x] 6.5 改造 `converse-view.tsx` 与 `chat-view.tsx`：
  - StreamingText；
  - 正在听胶囊；
  - 用户侧连续气泡分组；
  - 让位或撤回的 AI 气泡执行退出动画；
  - 数字人状态说明在 hold 时显示"等你说完…"；
  - 跟随滚动。

  验证：mock 截图（桌面与移动 390 px 宽）。
- [x] 6.6 mock 同传 socket（`lib/mock/interpret`）补充场景：停顿续说（hold → 合并）、噪声撤回、AI 抢答让位、迟到用户转写。

  验证：`NEXT_PUBLIC_MOCK_API=1 pnpm dev` 下四个场景可复现。
- [x] 6.7 UI/UX 验收：
  - 用 Playwright 对四个视图在亮色、暗色与移动端截图，核对没有整页平铺、没有空白气泡或孤立光标；
  - 开启 reduced-motion 截图，确认动画降级；
  - `pnpm lint && pnpm typecheck && pnpm test` 全绿。

## 7. infra：评测、联调与文档

- [x] 7.1 E6 数据生成（实现为 `python-backend/scripts/endpoint_eval data`，需直接驱动断句组件，与 prompt_eval 同处）：V0–V3，切点只由原音频决定，生成 `data/speech_pause/` 与清单。

  验证：重复生成后清单与音频长度一致。
- [x] 7.2 E6 离线断句评测（`scripts/endpoint_eval run/summary`，作图 `evaluation/eval/multimodal/e6_plot.py`）：
  - baseline / rules / smart 三组 × 三档；
  - 输出 `e6_runs.jsonl`、`e6_summary.csv`、`e6_latency.png`。

  验证：先在改造前（续说等待为 0）跑出 baseline，再跑新组；模型缺失时 smart 组标记为跳过。
- [x] 7.3 根据 E6 标定参数：
  - Smart Turn 阈值；
  - 均衡档候选静音 500 / 300 ms 二选一；
  - 按达标线决定 `endpoint_smart_turn` 的缺省值，回写配置与 spec 数值。

  验证：summary 中达标线判定结果写入报告。
- [x] 7.4 端到端抽检：E4 推流方式跑 V0 / V1 各 10 句（级联同传与级联 AI 对话），统计 e2eMs、holdMs、整句 chrF。

  验证：输出 `e6_e2e.csv`。
- [ ] 7.5 三端联调：
  - 启动 Python、Spring、web（`pnpm dev:lan`）；
  - 在浏览器与手机上真实说话，验证停顿续说、语气词不成句、AI 抢答让位、半双工推迟开播、会议室无空白气泡；
  - 记录到 `docs/test/endpointing/manual.md`，附截图。

  验证：清单逐项勾选。
- [x] 7.6 文档：
  - `docs/contracts/speech-image-api.md` 更新事件与控制帧；
  - `docs/总体设计.md` 新增路线图 ⑧.5、风险清单条目；
  - `docs/test/endpointing/report.md` 写入 E6 前后对比、局限（合成语音）与真人抽检结果（如有）。

  验证：文档链接与数字和 summary 一致。
