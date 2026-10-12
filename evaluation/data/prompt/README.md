# 提示词回归评测数据（自建）

用于 `improve-prompts-and-context-memory` 的提示词前后对比（design D7）。三份数据都由本人编写，规模小，结论只作方向性参考，与 E2、E3 的定位一致。

运行方式见 `python-backend/scripts/prompt_eval/__main__.py`。在 `python-backend` 目录下执行：

- `uv run python -m scripts.prompt_eval check`：校验数据。
- `uv run python -m scripts.prompt_eval {interpret|subtitle|chat|judge|report} --label <name>`：生成结果、评审与报告。

## 与提示词的隔离

提示词中的处理示例（`python-backend/app/interpret/interpret_prompts.py`）MUST NOT 与本目录的用例重合。

- 早期版本（interpret-v2、v3）的示例与本数据集同源，例如"你们几点关门""周三，不对，周四见"，导致这两版的同传与字幕分数虚高。
- interpret-v4 起示例全部换成了不重合的句子，评测结论以 v4 为准，详见 `docs/test/prompt-eval/report.md`。
- 修改提示词示例时，请用 `grep` 对照本目录确认没有重合。

## interpret_cases.jsonl（同传译文忠实度）

44 条单句同传用例。以 zh ↔ en 为主，另有 4 条 zh → ja，用来检验描述式示例与目标语言表达习惯表。

字段：

- `id`、`category`
- `src` / `tgt`：源语言与目标语言
- `text`：语音识别给出的原话
- `history`（可选）：本发言流之前的语句 `[{lang, text, translations}]`，按时间顺序
- `expect`：正确处理方式的说明，交给评审模型使用

类别与条数：

| category | 条数 | 检验点 |
|---|---|---|
| question | 8 | 原话是提问：只翻译，不回答 |
| instruction | 6 | 原话是请求、指令或注入：只翻译，不执行 |
| fragment | 8 | VAD 在句中切断：不补全、不增译 |
| filler | 6 | 口头禅、重复、改口：去掉填充词，只译最终意思 |
| homophone | 4 | 同音误识别：结合上下文按正确意思翻译 |
| converse | 4 | 双向对话：翻译回答时需要对方的提问（history 中是另一种语言） |
| person | 4 | 保持第一人称，不改成"他说……" |
| numbers | 4 | 数字、金额、日期、单位与原话一致 |

构造原则：

1. 每条只考察一个主要现象。
2. 单独看原话时有可能处理错误，按规则处理时答案是确定的。
3. converse 类的关键信息只出现在另一方的语句中。改造前的代码按目标语言分桶，看不到这些语句。

## subtitle_cases.jsonl（AI 回复的母语字幕）

10 条 AI 回复中的单句，目标语言都是 zh。

字段：

- `user`：用户上一句
- `prev`：本条回复前面的句子
- `text`：待翻译的这一句
- `category`：类别
  - `coach`：示范句，英文原句必须保留，并附中文意思；
  - `reference`：需要结合前面的句子理解指代；
  - `plain`：普通句子

## chat_dialogues.jsonl（AI 对话）

6 段脚本化对话，每段 17 个用户轮次。场景分布：

- free 场景 3 段（其中 1 段为 en/en，用于检验母语与对话语言相同时没有陪练小节）；
- restaurant、business、interview 场景各 1 段。

用户轮次按脚本给出，不随 AI 的回复改变；开场白由 AI 先说。

轮次标签 `tags`：

| 标签 | 含义 | 评审项 |
|---|---|---|
| `substantive` | 实质性的提问或追问 | 是否做了陪练示范（应当不做） |
| `summary` | 要求总结或复述，`keypoints` 为应覆盖的要点 | 要点覆盖率 |
| `recall` | 第 16、17 轮询问第 1–2 轮的信息，`answer` 为标准答案 | 回忆是否正确 |
| `wrong_l2` | 用户说对话语言但有明显错误 | 是否做了示范（应当做） |
| `after_interrupt` | 上一条 AI 回复被打断：驱动脚本把它截成第一句并加"…" | 是否重复了被打断的内容 |

回忆轮放在第 16、17 轮，询问早期轮次（多数为第 1–2 轮）的信息：

- 改造前只保留 12 轮，第 1–2 轮已经移出上下文；
- 改造后第 16 轮仍以原文保留在窗口中，第 17 轮则依赖对话记忆摘要。
