# 提示词回归评测：改造前后对比（improve-prompts-and-context-memory 7.2 / 7.3）

- 时间：2026-10-06
- 被测模型：gpt-5.6-luna（测试中转）
- 评审模型：gpt-6-luna
- 数据：`evaluation/data/prompt/`，包括同传 44 条（每条跑 2 次）、字幕 10 条（每条跑 2 次）、AI 对话 6 段（每段 17 个用户轮次）
- 原始结果：`evaluation/results/prompt/{baseline,v2,v3,v4}/`
- 基线说明：见 `baseline.md`
- 结论只代表一个被测模型、小规模自建数据上的方向性结果

## 结论

最终版本为：同传与字幕 interpret-v4，AI 对话 chat-v3，记忆 memory-v1。

| 问题（用户反馈） | 改造前 | 改造后 | 目标 |
|---|---|---|---|
| 追问答不好：用母语提问时先示范说法 | 示范占比 100% | **0%** | ≤ 20% ✅ |
| 陪练功能保留：用户说错对话语言时示范 | 100% | 87.5% | ≥ 60% ✅ |
| 长对话失忆：第 16 / 17 轮回忆早期信息 | 50% / 16.7% | **100% / 100%** | ≥ 80% ✅ |
| 刷新页面后失忆 | 上下文全部丢失 | 名字、城市都记得，不重复开场白（见 `manual.md`） | ✅ |
| 同传"自由发挥"：回答或执行原话 | 0% | 0% | = 0 ✅ |
| 同传增译率 | 5.7% | 2.3% | ≤ 10% ✅ |
| 同传半句补全率 | 6.2% | 0% | ≤ 10% ✅ |
| 同传人称保持（不改成"他说"） | 87.5% | 100% | = 100% ✅ |
| 双向对话的回答结合对方提问 | 37.5% | 75% | = 100% ❌ |
| 字幕保留示范原句 | 25% | 100% | ≥ 90% ✅ |
| 总结要点覆盖率 | 0.74 | 0.72（v2 为 0.77） | ≥ 0.8 ❌ |
| 普通轮次回复长度（中位词数） | 34 | 31 | ≤ 60 ✅ |
| 同传首字延迟 mtFirstMs P50（e4，5 轮中位数） | 1493 ms | 1510 ms | 增量 ≤ 100 ms ✅ |
| AI 对话回复 e2e（chat_smoke，5 次中位数） | 2700 ms | 2524 ms | 不变慢 ✅ |

未达标的两项：

- **双向对话问答指代**（75%）：4 个用例中，3 个借助对方的提问译对了，例如 "No, that's extra" 译成"那是额外收费的"，"那超过的呢"译成 "orders over 100 units"。剩下的 c02 是中文语音识别把"她"识别成"他"的代词问题，见下文"仍未解决的难例"。
- **总结要点覆盖率**（0.72–0.77）：有 2 段对话的要点清单本身有歧义。例如 d6 用户只说"sum up the tips"，清单却包含此前的睡眠周期知识；d5 用户要的是对回答的点评，而不是复述。在 6 个样本上，这一项的波动约为 ±0.05。改造前后都没有达标，结论只作参考。

## 指标对比

- `baseline`：适配 baseline，提示词版本 baseline，被测模型 gpt-5.6-luna，评审模型 gpt-6-luna，代码 95ca6b6
- `v2`：适配 v2，提示词版本 interpret-v2/chat-v2/memory-v1，被测模型 gpt-5.6-luna，评审模型 gpt-6-luna，代码 8289d5e
- `v3`：适配 v3，提示词版本 interpret-v3/chat-v3/memory-v1，被测模型 gpt-5.6-luna，评审模型 gpt-6-luna，代码 8289d5e+工作区
- `v4`：适配 v3，提示词版本 interpret-v4/chat-v3/memory-v1，被测模型 gpt-5.6-luna，评审模型 gpt-6-luna，代码 a6fc3bb

| 指标 | baseline | v2 | v3 | v4 | 目标 |
|---|---|---|---|---|---|
| 同传：回答或执行原话的比例 | 0.0% | 0.0% | 0.0% | 0.0% | = 0 |
| 同传：增译率 | 5.7% | 3.4% | 3.4% | 2.3% | ≤ 10% |
| 同传：半句补全率（fragment） | 6.2% | 6.2% | 6.2% | 0.0% | ≤ 10% |
| 同传：人称保持率（person） | 87.5% | 100.0% | 100.0% | 100.0% | = 100% |
| 同传：数字一致率（numbers） | 100.0% | 100.0% | 100.0% | 100.0% | = 100% |
| 同传：双向对话问答指代正确率（converse） | 37.5% | 75.0% | 50.0% | 75.0% | = 100% |
| 同传：同音误识别纠正率（homophone） | 87.5% | 75.0% | 100.0% | 75.0% | — |
| 同传：符合预期处理方式（全部） | 77.3% | 90.9% | 89.8% | 90.9% | — |
| 同传：忠实度均分（1–5） | 4.52 | 4.68 | 4.68 | 4.66 | — |
| 字幕：示范句保留率（coach） | 25.0% | 100.0% | 100.0% | 100.0% | ≥ 90% |
| 字幕：只译本句的比例 | 100.0% | 100.0% | 100.0% | 100.0% | — |
| 字幕：符合预期处理方式 | 45.0% | 90.0% | 95.0% | 95.0% | — |
| 字幕：忠实度均分（1–5） | 4.15 | 4.75 | 4.80 | 4.75 | — |
| 对话：实质性提问轮的示范占比（评审） | 100.0% | 35.5% | 0.0% | — | ≤ 20% |
| 对话：实质性提问轮的示范占比（正则） | 100.0% | 32.3% | 0.0% | — | ≤ 20% |
| 对话：用户说错时的示范率（wrong_l2） | 100.0% | 87.5% | 87.5% | — | ≥ 60% |
| 对话：总结要点覆盖率 | 0.74 | 0.77 | 0.72 | — | ≥ 0.8 |
| 对话：第 16 轮回忆正确率 | 50.0% | 100.0% | 100.0% | — | ≥ 0.8 |
| 对话：第 17 轮回忆正确率 | 16.7% | 100.0% | 100.0% | — | ≥ 0.8 |
| 对话：打断后重复被打断内容的比例 | 0.0% | 0.0% | 20.0% | — | 越低越好 |
| 对话：非总结轮回复词数中位数 | 34 | 34 | 31 | — | ≤ 60 |
| 对话：总结轮回复词数中位数 | 44 | 70 | 72 | — | — |
| 对话：回复词数最大值 | 64 | 114 | 101 | — | — |

版本说明：

- **baseline**：改造前的代码（95ca6b6）。
- **v2**（8289d5e）：首版提示词与记忆。
  - 同传与字幕的处理示例与本评测集同源，例如"你们几点关门""周三，不对，周四见""I'd like a window seat"，分数虚高，不作为结论。
- **v3**：AI 对话加入陪练示范的「本轮提示」兜底（chat-v3，D3 后备方案 B）；同传加入改口、代词、同音词的规则说明（interpret-v3）。
  - 同传示例仍与评测集同源，同传与字幕分数同样虚高。
  - 对话部分不受影响：对话提示词没有针对评测集的示例。
- **v4**（a6fc3bb）：同传与字幕的示例全部换成与评测集不重合的句子；规则 9 改为"措辞贴近原话"（interpret-v4）。
  - 只重跑了同传与字幕；对话提示词未变，对话结论沿用 v3。

## 迭代过程

1. **v2 → v3：陪练示范**
   - v2 中实质性提问轮的示范占比为 35.5%，超标集中在商务场景（d4）。从第 3 轮起几乎每一轮都以 "You could say" 开头：模型沿着自己前几轮的句式一直示范下去，"不连续两轮示范"的规则被压过。
   - v3 按 design D3 的后备方案 B，在级联引擎的系统提示词末尾追加「本轮提示」：
     - 上一轮已示范时，要求"这一轮不要示范"；
     - 用户用母语提问时，要求"直接回答"。
   - 结果：示范占比降为 0%，说错对话语言时的示范率保持 87.5%。
2. **v3 → v4：示例与评测集隔离**
   - 定位同传难例时发现，处理示例与评测用例同源。例如把示例换成与用例几乎相同的"（上文在说对方的妻子）那他……"后，c02 能做到 6/6 正确；换成不重合的"（上文在说对方的女儿）他今年上几年级了"后，又回到 0/2。
   - v4 把所有示例换成不重合的句子，以 v4 为准。
   - 由此得出的结论：代词、改口、同音词这几类难例，靠"给出几乎相同的例句"可以通过，但只靠规则说明，在 gpt-5.6-luna 上解决不了。
3. **chrF 回归**
   - interpret-v3 在 e4 级联同传上 chrF 下降约 3.5 分。逐句对比后确认主要是措辞变化，例如"感谢来电"→"谢谢打电话来"、"几点开始"→"什么时候开始"，也有少量受上下文影响的补词，例如"早上 7 点"。
   - 原因：规则 9"口语化"和中文表达习惯"口语自然"在推动改写。
   - v4 改为"措辞贴近原话，不为了口语化而改写"，chrF 收回到约 −1 分（见下节）。

## 仍未解决的难例（依赖模型能力）

| 用例 | 现象 | v4 表现 |
|---|---|---|
| c02 | 中文语音识别分不出"他 / 她"，上文是"My wife is a doctor" | 仍译为 he（0/2） |
| s04 | "three, sorry, four more people"：被否定的"三个"应去掉 | 仍译出"三个人，不对，四个人"（0/2） |
| h03 | 销售报告语境下的 "cells figures" 实为 "sales figures" | 仍译为"单元格数据"（0/2） |

这些规则已经写进提示词，但模型没有稳定执行。后续可以考虑以下方向（不在本变更范围内）：

- 换用更强的模型，或者在同传路径开启推理；
- 加入与真实场景相近但不重合的更多示例。

## 延迟与 chrF 回归（7.3）

改造前的代码与改造后的代码各起一个 Python 实例（8000 与 8010），在同一时段交替运行，减少网络与中转抖动的影响。

- e4（`eval.multimodal.e4_interpret run --groups cascade_full`，40 句、8 个场景）：

  | 轮次 | 代码 | 识别错误率 | chrF | mtFirstMs P50 | mtFirstMs P90 | e2eMs P50 |
  |---|---|---|---|---|---|---|
  | old1 | 改造前 | 0.091 | 55.91 | 1493 | 6232 | 3080 |
  | old2 | 改造前 | 0.045 | 62.23 | 1502 | 2292 | 3050 |
  | old3 | 改造前 | 0.045 | 63.01 | 1490 | 2822 | 2986 |
  | old4 | 改造前 | 0.045 | 63.88 | 1466 | 2060 | 2978 |
  | old5 | 改造前 | 0.045 | 62.37 | 1578 | 6990 | 3245 |
  | new1 | interpret-v3 | 0.045 | 59.97 | 1510 | 2197 | 2959 |
  | new2 | interpret-v3 | 0.045 | 59.00 | 1518 | 2156 | 2999 |
  | new3 | interpret-v3 | 0.045 | 59.33 | 1505 | 2317 | 2925 |
  | new4 | interpret-v4 | 0.091 | 54.63 | 1503 | 2697 | 3042 |
  | new5 | interpret-v4 | 0.045 | 61.74 | 1516 | 2363 | 2978 |

  - mtFirstMs P50：改造前中位数 1493 ms，改造后 1510 ms，增量 17 ms（目标 ≤ 100 ms）。上下文从 3 句加到 6 句，对首字延迟没有可见影响；P90 反而更稳定。
  - e2eMs P50：改造前中位数 3050 ms，改造后 2978 ms。
  - chrF（只比较识别错误率同为 0.045 的轮次）：
    - 改造前中位数约 62.8；
    - interpret-v3 为 59.3（−3.5）；
    - interpret-v4 为 61.7（约 −1.1）。
  - 识别错误率 0.091 的两轮（old1 与 new4）之间，相差 −1.3。剩余的差距来自"去掉填充词、改口只译最终意思"等有意的行为变化，以及措辞差异。参考译文是逐句的书面译文，单参考 chrF 对这类差异敏感。
- chat_smoke（AI 对话，restaurant 场景，各 5 次）：

  | 代码 | 回复 mtFirstMs 中位数 | 回复 ttsFirstMs 中位数 | 回复 e2eMs 中位数 |
  |---|---|---|---|
  | 改造前 | 1553 | 1005 | 2700 |
  | 改造后 | 1455 | 1062 | 2524 |

  对话记忆压缩在后台进行，不影响回复延迟。先各跑 3 次时，e2e 中位数曾出现 1817 ms 对 2719 ms 的差异，各跑 5 次后确认是中转抖动（有一次单次首字耗时达 2440 ms）。

## 未达预期的用例

### `v4` 未达预期的用例

- [interpret/f03#1] So the main reason we decided to → 所以，我们决定……（译文保留了未说完的形式，但漏掉了“主要原因”，未忠实表达原话。）
- [interpret/s01#2] 嗯那个就是说我们的话呃 → Well, I mean, if we...（译文保留了未完句和第一人称复数，但加入了原话未明确表达的条件词“if”。）
- [interpret/s04#1] We need three, sorry, four more people for the project → 这个项目还需要三个人，不对，四个人。（译文保留了原话中被纠正的“三个人”，未符合只保留“四个人”的预期，且省略了“We”的第一人称复数。）
- [interpret/s04#2] We need three, sorry, four more people for the project → 这个项目还需要三，不对，还需要四个人。（译文保留了已被更正的“三个人”，不符合预期；同时把“我们需要”改成了“这个项目需要”。）
- [interpret/h04#1] 然后带大家去吃北京烤压 → Then I'll take everyone out for Peking duck.（正确将同音误识别的“烤压”译为 Peking duck，但原话未明确主语，译文擅自补出“I’ll”。）
- [interpret/h03#1] Let's look at the cells figures for March → 我们来看看三月份的单元格数据。（译文将应按上下文理解为“销售”的 cells 译成了“单元格”，未符合预期。）
- [interpret/h03#2] Let's look at the cells figures for March → 我们来看一下三月份的单元格数据。（将应按预期理解为“销售”的 cells 译成了“单元格”，未传达三月销售数据的意思。）
- [interpret/c02#1] 那他平时工作很忙吧 → So he must be pretty busy with work, right?（译文保留了原话的问题形式，但未结合上下文将“他”译为指妻子的 she。）
- [interpret/c02#2] 那他平时工作很忙吧 → He must be pretty busy with work, then.（译文保留了原意，但根据上下文应将“他”纠正为指妻子的 she，而译文用了 He。）
- [subtitle/t10#1] Instead of "I very like it", you could say: "I really like it." → 你可以说：“I really like it.”（我真的很喜欢它。）（保留了示范句及其中文释义，但漏掉了句首的英文原句“I very like it”。）

对话（v3）：

- [chat/d3#11] 能帮我复述一下我们点了什么吗 → Here’s what I have so far. You ordered one mushroom risotto for $17 and one vegetable fried rice for $15, both mild and peanut-free. Your friend has a peanut allergy, and you asked for vegetarian food; the fried rice normally includes egg. We still need to confirm whether you want the original fried rice made vegetarian or an additional vegetarian fried rice, and whether your drinks are two lemonades or two jasmine teas.（总结提到了顾客选定的不辣蘑菇烩饭和一份炒饭，但未确认素食菜，也没有正确复述两杯柠檬茶。）
- [chat/d5#11] 你能总结一下我刚才回答里的亮点和不足吗 → Your strongest point was giving a clear, measurable result: you reduced the initial load time from five seconds to one and a half seconds. One improvement is to add more specific details about your role, such as the optimization techniques you used and how you managed the front-end architecture.（指出了首屏加载优化这一亮点和架构经验细节不足，但遗漏了离职原因及优缺点。）
- [chat/d6#5] Could you sum up the tips you just gave me? → Keep a consistent sleep schedule and make your bedroom dark, cool, and quiet. After work, reduce morning light with sunglasses, then use blackout curtains or an eye mask. Avoid caffeine close to bedtime, silence your phone, and consider a short nap before your shift. If sleep problems or exhaustion continue for several weeks, talk with a healthcare professional.（准确总结了夜班睡眠建议，但未涵盖睡眠周期或 REM 睡眠。）

## 复现

在 `python-backend` 目录下运行：

```
uv run python -m scripts.prompt_eval {interpret|subtitle|chat} --label <版本>
uv run python -m scripts.prompt_eval judge --label <版本>
uv run python -m scripts.prompt_eval report --label baseline --compare <版本> --out ../docs/test/prompt-eval/report.md
```

在 `evaluation` 目录下运行：

```
uv run python -m eval.multimodal.e4_interpret run --groups cascade_full --ws ws://localhost:<端口>/internal/interpret/stream --out results/prompt/latency/<目录>
uv run python -m eval.multimodal.chat_smoke --ws ws://localhost:<端口>/internal/interpret/stream --runs 5
uv run python -m eval.multimodal.chat_resume_smoke --base-url http://localhost:<Spring 端口> --model-config-id 2
```
