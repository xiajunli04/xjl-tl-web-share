## ADDED Requirements

### Requirement: 备选译法与关键表达
系统 SHALL 提供 `POST /api/translations/insights`，请求体为 `{source, translation, sourceLang, targetLang, recordId?}`。接口用默认对话模型返回：
- 2–3 个与当前译文不同的备选译法 `alternatives[{text, register, note}]`，其中 register 为正式/中性/口语等语体，note 用中文说明适用场景；
- 至多 5 个关键表达 `expressions[{source, target, meaning, note}]`；
- 一句话总结 `summary`。

原文超过 2000 字符时 MUST 返回 `A0410`。

#### Scenario: 习语的备选译法
- **WHEN** 用户对 "It's raining cats and dogs." → "下着倾盆大雨。" 请求解读
- **THEN** 返回 2–3 个不同的中文备选译法，每个带语体和中文说明；expressions 中包含 "raining cats and dogs" 的含义说明

#### Scenario: 原文过长
- **WHEN** 原文为 3000 字符
- **THEN** 系统返回 HTTP 400、code `A0410`

### Requirement: 针对译文追问
系统 SHALL 提供 `POST /api/translations/insights/ask`，请求体为 `{source, translation, sourceLang, targetLang, question, history}`，其中 history 至多 6 轮。接口以 SSE 流式返回 `delta`、`done` 和 `error`，答案使用中文，只解答问题，MUST NOT 修改记录中的译文。问答不落库。

#### Scenario: 流式回答
- **WHEN** 用户提问"为什么不直译？"
- **THEN** 回答以 delta 事件逐段返回，最后是 done

### Requirement: 解读标签页
翻译工作台的 Agent 面板 SHALL 新增「解读」标签页，含三个可折叠分区：
- 「备选译法」：卡片标注语体徽章，带「采用」按钮；
- 「关键表达」；
- 「问一问」：聊天气泡、输入框和快捷问题。

译文生成完成后才可请求解读，加载时显示骨架屏。点击「采用」MUST 用该备选替换译文区内容，并标记"已采用备选"（可恢复原译）；此后的复制和存入翻译记忆 MUST 使用替换后的译文，收藏作用于该次翻译记录本身（历史中保留原译文）。

#### Scenario: 采用备选
- **WHEN** 用户在「备选译法」中点击第二个备选的「采用」
- **THEN** 译文区内容替换为该备选并带过渡动效，标签提示"已采用备选"

#### Scenario: 无译文时
- **WHEN** 尚未翻译时用户打开「解读」标签页
- **THEN** 显示空状态"翻译完成后可查看解读"
