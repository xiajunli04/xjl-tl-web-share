## MODIFIED Requirements

### Requirement: 翻译记录持久化
系统 SHALL 为每次成功完成的翻译保存一条记录：原文、译文、源语言、识别出的语种、目标语言、模式、实际路径、风格、领域、所用术语库与模型、评审分与修正轮次、术语命中与遵循结果、token 用量、总耗时和创建时间；会话内的翻译还 SHALL 保存所属会话、修订来源记录、修订要求、是否为采用版本以及追问问答。同时 SHALL 按执行顺序保存每个 Agent 节点的轨迹：节点名、状态、中文摘要、详情（JSON）、耗时和 token 用量；经过追问恢复的翻译，中断前与恢复后的轨迹 SHALL 合并保存在同一条记录下。

#### Scenario: 标准路径记录完整轨迹
- **WHEN** 一次经过 1 轮修正的标准路径翻译完成
- **THEN** 记录的 `reviewRounds=1`，轨迹按 seq 顺序包含 analyze、plan、retrieve、translate、review、refine、review、finalize

#### Scenario: 失败的翻译不入库
- **WHEN** 翻译以 error 事件结束
- **THEN** 不产生翻译记录

#### Scenario: 修订记录
- **WHEN** 用户对会话中的记录 12 提出修订并成功
- **THEN** 新记录的 session_id 与记录 12 相同，revision_of=12，mode=revise，保存了修订要求，且为采用版本

#### Scenario: 追问恢复后的轨迹
- **WHEN** 一次翻译在 plan 后中断追问，用户回答后完成
- **THEN** 只产生一条记录，轨迹依次包含 analyze、plan、clarify、retrieve、translate、review、finalize，clarification 保存问题与回答

### Requirement: 历史详情与轨迹回放
历史页面 SHALL 以列表展示记录（原文/译文预览、语言对、评审分、收藏、时间，会话内的记录带会话标记），点击后在侧滑面板中以标签页展示：原文译文对照、Agent 轨迹回放（时间线按节点顺序动画重放，可查看每个节点的耗时、token 和详情）、术语命中与遵循情况；会话内的记录 SHALL 显示所属会话、修订要求与追问问答，并可跳转到该会话。用户 SHALL 可以从详情中"在工作台中打开"，把原文和设置带回工作台。

#### Scenario: 回放轨迹
- **WHEN** 用户在详情中切换到「Agent 轨迹」标签页并点击回放
- **THEN** 时间线按记录的节点顺序依次点亮，每个节点显示耗时和 token

#### Scenario: 在工作台中打开
- **WHEN** 用户在详情中点击「在工作台中打开」
- **THEN** 跳转到工作台，原文、语言对、风格、领域和术语库都已按该记录填好

#### Scenario: 跳转到会话
- **WHEN** 用户查看一条会话内记录的详情并点击「打开会话」
- **THEN** 工作台切换到会话模式并打开该会话，选中对应轮次
