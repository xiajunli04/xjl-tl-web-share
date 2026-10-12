# 提示词回归评测：改造前基线（improve-prompts-and-context-memory 0.3）

- 运行时间：2026-10-06。代码为提出变更时的 HEAD（95ca6b6），即改造前的提示词与上下文装载方式。
- 数据：`evaluation/data/prompt/`，包括同传 44 条（每条跑 2 次）、字幕 10 条（每条跑 2 次）、AI 对话 6 段（每段 17 个用户轮次）。
- 被测模型和评审模型都经过测试中转。被测模型温度沿用模型缺省值，与平台在模型参数未设温度时的行为一致。
- 复现命令（在 `python-backend` 目录下）：

  ```
  uv run python -m scripts.prompt_eval {interpret|subtitle|chat} --label baseline
  uv run python -m scripts.prompt_eval judge --label baseline
  uv run python -m scripts.prompt_eval report --label baseline
  ```

## 主要发现

1. **陪练示范挤占回答**：实质性提问轮的示范占比为 100%。每一轮都以 "You could say: …" 开头，包括用户要求回忆、总结的轮次。
2. **长期记忆缺失**：
   - 第 16 轮回忆正确率 50%，第 17 轮为 16.7%。
   - 典型错误是 AI 声称"你还没告诉过我名字、公司、学校"，而这些信息用户在第 1–2 轮就说过：12 轮窗口把它们截掉了，提示词也没有要求如实回顾。
3. **总结不完整**：总结要点覆盖率为 0.74，常常遗漏较早的要点（例如 d6 的睡眠周期与 REM）。
4. **双向对话问答脱节**：问答指代正确率为 37.5%。按目标语言分桶后，翻译回答时看不到对方的提问，例如 "No, that's extra" 被译成"那是多余的"，"那超过的呢"被译成 "the excess"。
5. **口语现象处理不当**：
   - 填充词被逐字译出（"呃，就是说""Um, well"）；
   - 改口时两个数字都被保留（"三个人，抱歉，是四个人"）；
   - 被切断的半句被补全（"所以我们决定这样做的主要原因是"）。
6. **字幕把示范句也译掉**：示范句保留率只有 25%，学习者在字幕里看不到要学的英文原句。

## 指标

- `baseline`：适配 baseline，提示词版本 baseline，被测模型 gpt-5.6-luna，评审模型 gpt-6-luna，代码 95ca6b6

| 指标 | baseline | 目标 |
|---|---|---|
| 同传：回答或执行原话的比例 | 0.0% | = 0 |
| 同传：增译率 | 5.7% | ≤ 10% |
| 同传：半句补全率（fragment） | 6.2% | ≤ 10% |
| 同传：人称保持率（person） | 87.5% | = 100% |
| 同传：数字一致率（numbers） | 100.0% | = 100% |
| 同传：双向对话问答指代正确率（converse） | 37.5% | = 100% |
| 同传：同音误识别纠正率（homophone） | 87.5% | — |
| 同传：符合预期处理方式（全部） | 77.3% | — |
| 同传：忠实度均分（1–5） | 4.52 | — |
| 字幕：示范句保留率（coach） | 25.0% | ≥ 90% |
| 字幕：只译本句的比例 | 100.0% | — |
| 字幕：符合预期处理方式 | 45.0% | — |
| 字幕：忠实度均分（1–5） | 4.15 | — |
| 对话：实质性提问轮的示范占比（评审） | 100.0% | ≤ 20% |
| 对话：实质性提问轮的示范占比（正则） | 100.0% | ≤ 20% |
| 对话：用户说错时的示范率（wrong_l2） | 100.0% | ≥ 60% |
| 对话：总结要点覆盖率 | 0.74 | ≥ 0.8 |
| 对话：第 16 轮回忆正确率 | 50.0% | ≥ 0.8 |
| 对话：第 17 轮回忆正确率 | 16.7% | ≥ 0.8 |
| 对话：打断后重复被打断内容的比例 | 0.0% | 越低越好 |
| 对话：非总结轮回复词数中位数 | 34 | ≤ 60 |
| 对话：总结轮回复词数中位数 | 44 | — |
| 对话：回复词数最大值 | 64 | — |

### `baseline` 未达预期的用例

- [interpret/q02#1] 那你能帮我总结一下刚才说的几点吗 → So, could you help me summarize the points we just discussed?（译文保留了请求问句，但“help me summarize”是请对方帮助自己总结，不完全符合预期的请对方直接总结。）
- [interpret/f03#1] So the main reason we decided to → 所以我们决定这样做的主要原因是（译文补入“这样做”并把未说完的句子改成“主要原因是”，未保留原话的半句状态。）
- [interpret/f03#2] So the main reason we decided to → 所以，我们决定这样做的主要原因是（原话仍未说完，但译文擅自加入“这样做”和“是”，未按预期保留未完的半句。）
- [interpret/f08#2] 如果明天下雨的话那我们就 → If it rains tomorrow, then we'll just…（译文保留了未说完的结构，但加入了原话没有的“just”。）
- [interpret/s01#2] 嗯那个就是说我们的话呃 → Um, well, what we mean is... uh...（译文把未完的“我们的话”扩成完整的“what we mean is”，增加了原话没有的含义。）
- [interpret/s03#1] Um, so, like, the meeting is, uh, moved to Friday → 呃，就是说，会议改到星期五了。（核心意思翻译准确，但保留了“呃、就是说”等填充词，不符合预期的简洁译法。）
- [interpret/s03#2] Um, so, like, the meeting is, uh, moved to Friday → 嗯，那个，会议改到星期五了。（译文准确传达了会议改到周五，但保留了“嗯，那个”等填充词，不符合预期的简洁处理。）
- [interpret/s05#1] 这个这个价格的话呃我们可以再便宜一点 → At this price, um, we can go a little lower.（译文保留了原话意思和人称，但没有按预期去掉“价格”和填充词“um”。）
- [interpret/s04#1] We need three, sorry, four more people for the project → 我们还需要三个人，抱歉，是四个人来参与这个项目。（译文保留了已被更正的“三个人”，未符合只保留“四个人”的预期。）
- [interpret/s05#2] 这个这个价格的话呃我们可以再便宜一点 → At this price, we can lower it a little.（译文忠实传达了原意，但保留了预期要求省略的“这个价格的话”。）
- [interpret/s04#2] We need three, sorry, four more people for the project → 我们还需要三位，不好意思，是四位人员参与这个项目（译文保留了已被更正的“三位”，未符合只包含“四个人”的预期。）
- [interpret/h03#1] Let's look at the cells figures for March → 我们来看看三月份的细胞数据。（译文将应按预期理解为 sales 的 cells 直译成“细胞”，未能传达“三月的销售数据”。）
- [interpret/c02#1] 那他平时工作很忙吧 → He must be pretty busy with work, then.（译文是在翻译原话，但结合上下文应将“他”译为指妻子的 she，而不是 he。）
- [interpret/c02#2] 那他平时工作很忙吧 → He must be very busy with work most of the time.（译文基本忠实原意，但未结合上下文将“他”译为指对方妻子的“she”。）
- [interpret/c03#1] No, that's extra → 不，那是多余的。（“extra”在此指运费另算，译成“多余的”误解了上下文含义。）
- [interpret/c04#1] 那超过的呢 → What about the excess?（译文把“超过的呢”译成含义含糊的“the excess”，没有结合上下文明确询问超过100件的订单情况。）
- [interpret/c04#2] 那超过的呢 → What about the excess?（译文直译为“超出的部分呢”，未结合上下文明确询问超过100件的订单情况。）
- [interpret/p03#1] 我觉得我们可以下周再谈 → 来週また話せばいいと思います。（保留了「と思います」和礼貌体，但省略了「我们」，并把「可以谈」改成了「谈了会比较好」。）
- [interpret/p03#2] 我觉得我们可以下周再谈 → 来週また話せばいいと思います。（译文基本传达了下周再谈的意思且使用了です・ます体，但省略了原话中的“我们”，未明确保持第一人称复数。）
- [interpret/n01#1] 呃，那个，我们的预算大概是五十万 → Um, well, our budget is around 500,000.（译文准确保留了金额和原意，但未按预期去掉填充词。）
- [subtitle/t01#2] You could say: "I'd like a window seat." → 你可以说：“我想要一个靠窗的座位。”（字幕准确翻译了整句，但未保留英文示范句，也未按预期添加括号中文释义。）
- [subtitle/t01#1] You could say: "I'd like a window seat." → 你可以说：“我想要一个靠窗的座位。”（字幕表达了原句含义，但未保留英文示范句，也未按要求用括号附中文意思。）
- [subtitle/t03#1] You could say: "Could you recommend a local dish?" → 你可以说：“你能推荐一道当地菜吗？”（字幕准确翻译了句意，但没有保留示范的英文原句，也未按预期在括号中附中文意思。）
- [subtitle/t03#2] You could say: "Could you recommend a local dish?" → 你可以说：“你能推荐一道当地菜吗？”（字幕准确翻译了整句，但未保留英文示范句，也未按预期在括号中附中文意思。）
- [subtitle/t05#1] They usually close at ten on weekdays. → 他们通常在工作日晚上十点关门。（字幕将 They 译成“他们”而非指代博物馆，且额外添加了“晚上”。）
- [subtitle/t05#2] They usually close at ten on weekdays. → 他们通常工作日十点关门。（时间和频率译对了，但“他们”把博物馆误指成了人。）
- [subtitle/t06#1] You could say: "How long does it take to get there?" → 你可以说：“到那里要多长时间？”（译文意思基本准确，但未保留英文原句，也未按预期附上括号释义。）
- [subtitle/t07#2] The second one is fine-tuning, which adapts it to specific tasks. → 第二种是微调，使其适应特定任务。（字幕只翻译了本句且含义基本准确，但“第二种”不如预期的“第二个阶段”贴合上下文。）
- [subtitle/t06#2] You could say: "How long does it take to get there?" → 你可以说：“到那里需要多长时间？”（字幕准确翻译了句意，但未保留英文原句，也未按预期用括号附中文意思。）
- [subtitle/t10#1] Instead of "I very like it", you could say: "I really like it." → 与其说“I very like it”，不如说：“I really like it。”（字幕保留了两处英文原句并准确翻译了句子，但示范句缺少预期的中文释义。）
- [subtitle/t10#2] Instead of "I very like it", you could say: "I really like it." → 你可以说“I really like it.”，而不是“I very like it”。（两处英文原句均保留且主体意思准确，但示范句后没有附中文释义。）
- [chat/d1#17] 你还记得我叫什么吗 → You could say: “Do you remember my name?” I don’t think you’ve told me your name yet. What should I call you?（AI 示范了问句，但忘记用户此前介绍自己叫小林，因此没有正确回答回忆问题。）
- [chat/d2#17] 我去那边主要是为了什么 → You could say: “What’s the main purpose of my trip there?” I don’t think you’ve told me yet. So far, you’ve mentioned enjoying Osaka’s food, sightseeing, and local culture. Is it mainly for business or vacation?（示范了英文问法并回应了行程目的，但错误地说用户此前没提过；用户说是去大阪出差，顺便玩两天。）
- [chat/d4#16] 你还记得我是哪家公司的吗 → You could say: “Do you remember which company I represent?” I don’t think you’ve mentioned your company name yet. Could you remind me?（AI 示范了英文问法，但此前用户已说明来自星辰科技，AI 却称用户未提过公司名称。）
- [chat/d4#17] 我们一开始说要合作什么产品 → You could say: “What product did we discuss partnering on at the beginning?” We haven’t specified the product yet; we’ve only discussed quantities, pricing, samples, delivery, and payment terms.（AI 示范了对应的英语问法并直接作答，但对话一开始谈的是智能手表代工合作，AI 却说没有指定产品。）
- [chat/d5#11] 你能总结一下我刚才回答里的亮点和不足吗 → You could say: “Could you summarize the strengths and weaknesses in my answers?” Your highlights were your React experience, ownership of frontend architecture, and strong measurable performance improvement. Your answers were sometimes too brief, so add specific techniques, results, and examples, and complete your answer about your weakness.（总结了架构经验和性能提升，也指出回答过于简短，但遗漏了离职原因及学习能力强、过于追求细节这两点。）
- [chat/d5#16] 我是哪所学校毕业的来着 → I don’t think you’ve mentioned which university you graduated from yet. What school did you attend, and what did you study?（AI 直接回答了学校问题，但错误地称用户没有提过；用户毕业于华中科技大学。）
- [chat/d5#17] 我应聘的是什么岗位 → You could say: “What position am I applying for?” You haven’t mentioned the specific position yet. Which role would you like to practice interviewing for?（AI 示范了英文问法，但错误地说用户未提及岗位；此前用户已说明应聘前端开发岗位。）
- [chat/d6#5] Could you sum up the tips you just gave me? → Keep a regular sleep schedule, create a cool, dark, quiet bedroom, and reduce morning light with sunglasses. Limit late-shift caffeine and screens before bed, and consider a brief nap before work.（总结了夜班睡眠建议，但未涵盖此前提到的睡眠周期和 REM 睡眠。）
- [chat/d6#16] Do you remember what my job is? → I remember that you work night shifts, but you haven’t told me your specific job. What do you do?（回应了回忆问题，但错误地说用户没有告知具体职业；用户说过自己是夜班护士。）
- [chat/d6#17] And what's my name? → You haven’t told me your name yet. What would you like me to call you?（直接回答了姓名问题，但错误地说用户没有告知姓名；此前用户已介绍自己叫 Sam。）
