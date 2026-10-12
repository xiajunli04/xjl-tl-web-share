# 提示词与上下文记忆：三端联调记录（improve-prompts-and-context-memory 7.1）

- 时间：2026-10-06
- 代码：改造后的 Python（`8289d5e`）与 Spring（`af847d4`）
- 脚本：`evaluation/eval/multimodal/chat_resume_smoke.py`
- 原始记录：`evaluation/results/prompt/manual/`

## 环境

开发机上已有一套旧代码实例在运行（Spring 18080、Python 8000）。为了不影响它们，另起了一套新代码实例：

| 服务 | 端口 | 启动方式 |
|---|---|---|
| Python | 8010 | `DOC_WORKER_ENABLED=false CHAT_WINDOW_TURNS=2 CHAT_MEMORY_BATCH_TURNS=1 uv run python -m app --port 8010` |
| Spring | 18090 | `./mvnw spring-boot:run -Dspring-boot.run.arguments="--server.port=18090 --app.ai.base-url=http://localhost:8010 --app.doc.consumer-enabled=false"`（环境变量取自根目录 `.env`） |

说明：

- 两个新实例都关闭了文档任务的 worker 和消费者，避免与正在运行的实例争抢任务。
- 联调实例把对话窗口调小为 2 轮、每批压缩 1 轮，这样几句话之内就能触发真实的记忆压缩。缺省配置下要 16 轮才会触发，这部分由离线评测覆盖。
- 回复模型使用测试中转（`modelConfigId=2`，gpt-5.6-luna）。语音由 edge-tts 合成（`zh-CN-XiaoxiaoNeural` / `en-US-JennyNeural`），按实时速度推流，每帧 40 ms。

## 场景一：刷新页面后继续 AI 对话

步骤与浏览器的行为一致，只是用脚本代替了浏览器：

1. 登录，`POST /api/interpret/sessions` 创建 CHAT 会话（free 场景，zh → en）。
2. 以 `/ws/interpret?ticket=…` 建立 WS，首帧音频触发开场白。
3. 依次说 3 句：
   - "我叫小林，下个月要去大阪出差。"
   - "大阪有什么好吃的推荐吗？"
   - "那里的地铁方便吗？"
4. 直接关闭 WS（相当于刷新页面）。2 s 后用 `POST /api/interpret/sessions/{id}/ticket` 重取票据，在宽限期内重连。
5. 问："你还记得我叫什么、下个月要去哪个城市吗？"

结果（会话 44）：

| 轮次 | 识别 | AI 回复 |
|---|---|---|
| 开场白 | — | Hi, I'm Lumi. What would you like to talk about today? |
| 1 | 我叫小林，下个月要去大阪出差。 | You could say: "My name is Xiaolin, and I'm going to Osaka on a business trip next month." That sounds exciting—have you been to Osaka before? |
| 2 | 大阪有什么好吃的推荐吗？ | Osaka is famous for takoyaki, okonomiyaki, and kushikatsu. …（直接回答，未做示范） |
| 3 | 那里的地铁方便吗？ | Yes, Osaka's subway is very convenient … （直接回答，未做示范） |
| 重连后 | 你还记得我叫什么？下个月要去哪个城市吗？ | Yes, your name is Xiaolin, and you're going to Osaka next month for a business trip. |

| 检查项 | 结果 |
|---|---|
| 重连后没有再次说开场白 | ✅ |
| 记得名字（小林） | ✅ |
| 记得城市（大阪） | ✅ |
| 浏览器没有收到 `memory` 事件 | ✅（两条连接合计 0 条） |
| 按需示范：陈述句（第 1 轮）示范，提问（第 2、3 轮）不示范 | ✅ |

Python 日志（8010）：

```
13:30:36 app.interpret.chat   - AI 对话开始 stream=s-44-p1 prompt=chat-v2 restored=0 memory=False
13:31:43 app.interpret.memory - 对话记忆已压缩 stream=s-44-p1 turns=1 chars=137 remaining=4
13:31:44 app.interpret.chat   - AI 对话开始 stream=s-44-p1 prompt=chat-v2 restored=7 memory=True
13:32:12 app.interpret.memory - 对话记忆已压缩 stream=s-44-p1 turns=1 chars=156 remaining=6
```

日志说明：

- 第 3 轮之后触发了真实的压缩，摘要经 `memory` 事件交给 Spring 暂存。
- 重连后，新发言流从 config 恢复了 7 条消息（开场白和 3 轮问答），以及记忆摘要（`memory=True`）。

已知的副作用：

- Spring 回灌的 `history` 是成员最近的定稿语句，其中包括已经并入摘要的轮次。因此重连后的新发言流会把这些轮次再压缩一次（上面最后一行日志）。
- 摘要提示词要求"合并重复的内容"，结果不受影响，只是多一次调用和少量 token，已记入 design 的 Risks。

## 场景二：双向对话的问答指代

1. 创建 CONVERSE 会话（zh / en，自动路由）。
2. A 说："这个报价包含运费吗？"
3. B 说："No, that's extra."

结果（会话 45）：

| 句子 | 识别 | 译文 |
|---|---|---|
| A（zh → en） | 这个报价包含运费吗？ | Does this quote include shipping? |
| B（en → zh） | No, that's extra. | 不，那是额外收费的。 |

- B 的译文结合了 A 的提问，"extra"译为"额外收费"。
- 改造前的基线里，同一句被译成"不，那是多余的"（离线评测用例 c03）。原因是当时上下文按目标语言分桶，翻译 B 的回答时看不到 A 的提问。

## Spring 侧的自动化覆盖

浏览器断线、Python 断线重建、`memory` 不转发这几条路径，另有 `InterpretStreamTest` 的 3 个用例覆盖（真实 Tomcat + 模拟 Python）：

- `chatKeepsMemoryPrivateAndRestoresHistoryWhenPythonRebuilds`
- `chatRestoresHistoryAfterBrowserReconnectsWithinGrace`
- `listenRebuildCarriesRecentUtterancesWithTranslations`
