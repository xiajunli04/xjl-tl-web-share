## 0. infra：评测脚手架与基线（只新增文件，不改行为）

- [x] 0.1 编写评测数据 `evaluation/data/prompt/`，并在 `README.md` 中说明构造原则与标注字段：
  - `interpret_cases.jsonl`：约 44 条，字段 `{id, src, tgt, text, history?, category, expect}`，覆盖提问与请求、指令与注入、被切断的半句、口头禅与自我修正、同音误识别、双向对话问答指代、人称保持、数字与单位，其中含 4 条 zh → ja；
  - `subtitle_cases.jsonl`：约 10 条，字段 `{id, text, prev, user, expect}`，包括示范句和回复中间的指代句；
  - `chat_dialogues.jsonl`：6 段对话，每段 14–18 个用户轮次，含 1 段 restaurant 场景；用户轮次标注 `substantive`、`summary`（附要点清单）、`recall`（附标准答案，位于第 15 轮以后）、`wrong_l2`（用户说对话语言但有错误）、`after_interrupt`（上一条回复以"…"结尾）。

  验证：用一个小脚本校验 jsonl 能逐行解析、必填字段齐全，统计每类条数，结果符合 D7 的配比
- [x] 0.2 新增 `python-backend/scripts/prompt_eval/`（`__main__.py`、`adapters.py`、`client.py`、`judge.py`、`report.py`）：
  - `client.py` 读取根目录 `.env` 的 `TEST_LLM_*`，开启重试，超时 90 s；
  - `adapters.py` 封装"构造同传消息""构造字幕消息"和"驱动一段对话"，基线版本调用现有的 `interpret_messages` 与 `build_messages`（基线的字幕与同传使用同一个提示词）；
  - `judge.py` 使用 `evaluation/config.toml` [judge] 段的模型输出 JSON 判定；
  - 结果写入 `evaluation/results/prompt/{label}/`，已存在的条目跳过，支持续跑。

  验证：`cd python-backend && uv run python -m scripts.prompt_eval interpret --label smoke --limit 3` 跑通，并生成结果文件
- [x] 0.3 在当前代码上跑基线：依次跑 `interpret`、`subtitle`、`chat`、`judge`，均使用 `--label baseline`。验证：`report --label baseline` 输出各项指标（回答率、增译率、半句补全率、人称保持率、数字一致率、示范句保留率、示范占比、总结覆盖率、远期回忆正确率、打断后重复率、回复词数），写入 `docs/test/prompt-eval/baseline.md`，并提交 commit

## 1. python-backend：同声传译提示词（D1）

- [x] 1.1 `app/agent/prompts.py` 拆出 `term_sections(ctx)`（领域、硬术语表、软术语表），`_context_sections` 改为调用它。验证：`uv run pytest tests/test_agent.py tests/test_improve_agent.py tests/test_session.py` 通过，`tests/snapshots/translate_system_*.txt` 快照不变
- [x] 1.2 新增 `app/interpret/lang_notes.py`：`LANG_NOTES`（15 种语言的表达习惯，按 D0 表格）、`FILLERS`、`COACH_PHRASES`，以及取值函数（未收录的语言返回空或描述式兜底）。验证：单测断言 `languages.CODES` 中每种语言都有 `LANG_NOTES`
- [x] 1.3 新增 `app/interpret/interpret_prompts.py`：
  - `PROMPT_VERSION`，以及 `interpret_system_prompt` / `interpret_messages(ctx, recent, text, source, target)`；
  - 内容按 D0、D1 的分层排列：角色 → 传译规则 → 处理示例（zh ↔ en 用具体示例，其他语言对用描述式示例）→ 目标语言表达习惯 → 术语小节 → 最近的发言 → 末尾提醒；
  - 删除 `cascade.py` 中的 `INTERPRET_NOTE` 与旧的 `interpret_messages`，并更新所有引用（包括 `realtime_chat.py`）；
  - 引擎启动日志打印提示词版本。

  验证：新增单测，断言以下内容：
  - 提示词包含"只译不答""保持人称""不要猜测补全"和示例小节，不包含"占位符""段落与换行"；
  - zh → ja 时示例中不含英文译文，并包含日语表达习惯；
  - 末尾一行是提醒；
  - 没有术语时省略术语小节。

  新增快照 `tests/snapshots/interpret_zh_en.txt`、`interpret_zh_ja.txt`
- [x] 1.4 新增 `LeadingCleaner`（流式过滤开头的"译文：""Translation:"等标签与包裹引号）和 `clean_final(text, source)`；在 `cascade._translate` 中，先用它们处理 `translation.delta` 与 `on_delta`，再下发和送去合成。验证：单测覆盖以下情况：
  - 标签被拆在多个 delta 中；
  - 没有标签时输出原样透传，且只缓冲到开头 16 个字符；
  - 原话本身带引号时保留引号；
  - 流结束时缓冲被完整冲出
- [x] 1.5 `app/core/config.py` 新增 `interpret_mt_temperature=0.3`，级联翻译与对话字幕使用它，为空时沿用模型参数。验证：`tests/test_interpret_cascade.py` 中用 fake LLM 断言 `ChatRequest.temperature == 0.3`；配置为 None 时取模型参数

## 2. python-backend：同传上下文按发言流统一（D2）

- [x] 2.1 `cascade.py`：
  - `_history` 改为发言流级的 `_recent: deque[Utterance]`，句子在 `transcript.final` 时入队，`_translate_one` 完成后回填译文；
  - 新增配置 `interpret_ctx_max_chars=1500`，`interpret_ctx_sentences` 由 3 改为 6；
  - 上下文渲染函数放在 `interpret_prompts.py` 中（按 D2 规则）。

  验证：单测覆盖以下情况：
  - 双向对话中，B 的回答的提示词包含 A 的提问；
  - 第 9 句只带第 3–8 句；
  - 超出字符上限时丢弃最早的句子；
  - 当前句不出现在自己的上下文中；
  - 原话本身就是目标语言时不显示译文
- [x] 2.2 字幕提示词与上下文（D1.1）：
  - `interpret_prompts.py` 新增 `subtitle_messages(recent, text, source, target, persona)`；
  - `chat.py` 的 `_Reply` 记录已切出的段，`_subtitles` 改为调用字幕提示词，并把"用户上一句 + 本回复前面的段"作为上下文传入；
  - `realtime_chat.py` 的 `_translate` 同样改为字幕提示词，带上用户上一句。

  验证：在 `tests/test_interpret_chat.py` 与 `tests/test_interpret_realtime_chat.py` 中，断言以下内容：
  - 第 2 段字幕请求的提示词包含用户句和第 1 段；
  - 提示词包含"示范的说法保留原文"规则。

  新增快照 `tests/snapshots/subtitle_en_zh.txt`
- [x] 2.3 回归：`uv run pytest tests -k interpret` 全部通过；`uv run ruff check app tests scripts` 无报错

## 3. python-backend：AI 对话提示词重写（D3）

- [x] 3.1 `chat_prompts.py`：
  - `PROMPT_VERSION`；`system_prompt(scenario, my, ai, persona, memory=None)` 按 D3 草案重写为分节结构，加入表达习惯和示范句式；
  - `Scenario` 扩展为 `(label, role, flow, register, opener)`，五个场景按 D3 表格填写；开场白统一追加"第一句简短"；
  - `REPLY_MAX_TOKENS` 由 220 改为 480。

  验证：单测断言以下内容：
  - my == ai 时没有「语言陪练」小节；
  - 有 memory 时出现「对话记忆」小节（且位于末尾），没有时不出现；
  - 包含"上一轮已经示范过时，这一轮不再示范""最多 6 句"以及被打断回复的规则；
  - ai=ja 时示范句式为日语。

  新增快照 `tests/snapshots/chat_free_zh_en.txt`、`chat_restaurant_zh_en_memory.txt`
- [x] 3.2 `build_messages` 规范化消息序列：首条非系统消息为 assistant 时补 `user:（对话开始）`，相邻的同角色消息用换行合并。验证：单测覆盖以下情况：
  - 以开场白开头的历史；
  - 打断后用户连说两句；
  - 空历史（生成开场白）。

  另外，`tests/test_llm_clients.py` 用 Anthropic fake 断言首条消息为 user
- [x] 3.3 `realtime_chat.py` 的 `_instructions` 改为基于新的 `system_prompt`（带 memory），断线重连时附上最近的对话。验证：`tests/test_interpret_realtime_chat.py` 中，断言重连时的 `session.update` instructions 同时包含摘要和最近对话

## 4. python-backend：AI 对话长期记忆（D4）

- [x] 4.1 新增 `app/interpret/dialog_memory.py`：
  - `DialogMemory`（`append`、`history`、`due`、`commit`、`seed`），以及 `memory_messages()` 压缩提示词（按 D4 的四节格式），并定义 `PROMPT_VERSION`；新增快照 `tests/snapshots/memory_restaurant.txt`；
  - 在 `config.py` 中新增 `chat_window_turns`、`chat_memory_*` 等配置（见 D8）。

  验证：纯单元测试覆盖以下情况：
  - 15 轮时 `due` 为 None，16 轮时返回最早 4 轮；
  - 字符超限时提前触发；
  - `commit` 只移除这一批，不影响压缩期间新追加的消息；
  - 超过 24 轮时丢弃最早的消息并记录警告；
  - 开场白按半轮计
- [x] 4.2 `chat.py` 接入 `DialogMemory`：
  - 替换 `_dialog` deque，每轮回复结束后检查 `due()`；
  - 在后台 `_spawn` 压缩任务，同时最多一个；
  - 压缩成功后 `commit` 并发 `memory{summary, turns}` 事件，失败时记录警告；
  - `build_messages` 传入 `memory.summary`。

  验证：`tests/test_interpret_chat.py` 用 fake LLM 跑 17 轮，断言以下内容：
  - 压缩请求是单独的一次调用，第 17 轮回复不等待它；
  - 压缩返回前，第 17 轮的提示词仍包含第 1 轮原文；
  - 压缩成功后，提示词包含摘要、不再包含第 1–4 轮，并且发出了 `memory` 事件；
  - 压缩失败时回复正常、记忆不变
- [x] 4.3 `realtime_chat.py` 接入 `DialogMemory`：
  - 用 `registry.get(None)` 尽力解析压缩模型，失败时只记日志、不压缩；
  - `_remember` 改为写入 `DialogMemory`。

  验证：单测分别覆盖"有模型时触发压缩并发 `memory` 事件"和"无模型时保留最近 24 轮"
- [x] 4.4 回归：`uv run pytest` 全部通过；`uv run ruff check app tests scripts` 无报错

## 5. python-backend：从 config 恢复上下文（D5，Python 侧）

- [x] 5.1 `engine.py`：
  - `StreamConfig` 新增 `history: list[HistoryItem]`（None 视为空，超过 24 条时只保留最新的，text 截断到 500 字符，丢弃没有 text 的条目）；
  - `ChatConfig` 新增 `memory: str | None`（截断到 2000 字符）。

  验证：`tests/test_interpret_engine.py` 新增解析用例，覆盖缺省、超长、缺少 text、camelCase 字段
- [x] 5.2 三种引擎在 `start` 时恢复上下文：
  - 级联同传：把 role=user 的条目写入 `_recent`；
  - 级联对话：`DialogMemory.seed`；
  - 实时语音对话：写入历史，`greet=false` 时首次 `_connect` 就带历史与摘要。

  验证：单测断言恢复后第一句的提示词包含历史，并且 greet=false 时不发开场白；`tests/test_interpret_ws.py` 中，带 history 的 config 能正常建流

## 6. springboot-backend：上下文暂存与下发、会话窗口（D5 / D6）

- [x] 6.1 `Member` 新增 `recent`（按 utteranceId 去重的 LinkedHashMap，最多 24 条）和 `chatMemory`。`RoomRegistry.onPythonEvent` 中处理：
  - `transcript.final`：插入或更新，AI 回复的 role 为 assistant；
  - `translation.final`：回填译文；
  - `reply.interrupted` 且 text 非空：改为"已生成部分 + …"；
  - `memory`：暂存摘要后直接 return，不广播。

  验证：在 `InterpretStreamTest` 中新增用例：模拟 Python 发出 `memory` 事件，断言浏览器没有收到
- [x] 6.2 `streamConfig` 下发 `history`（时间顺序，text 截断到 500 字符）和 `chat.memory`。验证：在 `InterpretStreamTest` 中新增以下用例：
  - CHAT 会话产生 2 轮对话和 1 次 `memory` 后，模拟 Python 断开、触发重建，断言第二次 config 的 `history` 含 4 条（role 正确）、`chat.memory` 等于摘要、`chat.greet=false`；
  - 浏览器断线后在宽限期内重连，结果同上；
  - 首次建流时 `history` 为空数组；
  - LISTEN 模式重建后，`history` 带有 translations
- [x] 6.3 `SessionTurns.recentTurns` 增加 `memorizedUntil` 参数，按 D6 计算窗口（至少 6 轮、最多 8 轮，4000 字符上限不变），并同步更新调用方 `SessionService`。验证：`SessionTurnsTest` 新增以下用例：
  - 第 9 轮、从未压缩时带第 1–8 轮；
  - memorizedUntil=3 时第 10 轮带第 4–9 轮；
  - 修订第 2 轮（memorizedUntil=6）时带第 1 轮；
  - 超过字符上限时丢弃最早的轮次。

  `./mvnw test -Dtest='SessionTurnsTest,SessionStreamTest,SessionApiTest'` 通过（JDK 使用 `G:\JDK\jdk-25.0.4`）
- [x] 6.4 python-backend 的 `session_window_turns` 由 6 改为 8。验证：`tests/test_session.py` 新增用例：传入 8 轮时全部保留
- [x] 6.5 回归：`./mvnw test` 全部通过

## 7. 联调、评测与文档

- [x] 7.1 本地三端联调（docker compose 依赖 + Spring + Python + web）：
  - 用级联 AI 对话（zh/en，free）按 spec 场景"刷新页面后继续对话"手动验证；
  - 用双向对话验证问答指代；
  - Python 日志中能看到压缩日志与 `memory` 事件，浏览器开发者工具中看不到 `memory` 事件。

  验证：在 `docs/test/prompt-eval/manual.md` 记录操作步骤与结果（附关键日志片段）
- [x] 7.2 改进版评测：`adapters.py` 切换到新的 API，依次跑 `interpret`、`subtitle`、`chat`、`judge`，均使用 `--label v2`。验证：`report --compare baseline v2` 生成 `docs/test/prompt-eval/report.md`，并对照 design Goals 逐项给出是否达标。不达标的项按以下方式处理：
  - "回答率 > 0"时启用 D1 备选方案 B（标签包裹）；
  - "示范占比 > 20%"或"说错时示范率 < 60%"时启用 D3 后备方案 B（代码层控制）；

  调整后重跑，并记录在报告中
- [x] 7.3 延迟回归：用 `evaluation` 的 `uv run python -m eval.multimodal.e4_interpret run --groups cascade_full` 和 `uv run python -m eval.multimodal.chat_smoke` 各跑 3 遍，对比 `mtFirstMs` 与 AI 回复首个 audio 时间的中位数。验证：mtFirstMs 增量 ≤ 100 ms、AI 回复首声没有变慢，结果写入 `report.md` 的延迟小节；超出时按 Risks 中的预案把 `interpret_ctx_sentences` 降到 4 并重测
- [x] 7.4 文档：
  - `docs/总体设计.md` 路线图补 ⑧.4 `improve-prompts-and-context-memory` 一行，并在 4.4 节补充语音对话的记忆策略（短期窗口 + 滚动摘要 + 重建恢复）；
  - 第 11 节风险清单补"提示词效果随模型变化"及其应对措施。

  验证：文档中的链接与表格渲染正常，内容与实现一致
