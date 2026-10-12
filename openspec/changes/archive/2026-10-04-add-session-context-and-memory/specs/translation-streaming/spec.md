## MODIFIED Requirements

### Requirement: SSE 事件协议
翻译接口（含会话修订与追问恢复接口）SHALL 以 `text/event-stream` 返回事件流。事件名限定为 `start`、`node`、`detect`、`terms`、`plan`、`delta`、`review`、`memory`、`clarify`、`final`、`error`，每个事件的 data MUST 是单行 JSON。一次事件流 MUST 以 `final`、`error` 或 `clarify` 作为最后一个事件结束；以 `clarify` 结束表示等待用户回答，不产生翻译记录。`memory` 事件（会话记忆更新）只在执行了记忆压缩时出现，位于 `final` 之前。

#### Scenario: 正常流程的事件顺序
- **WHEN** 一次快速路径翻译成功完成
- **THEN** 客户端依次收到 start、若干 node/detect/plan/delta 事件，最后是 final，然后连接关闭

#### Scenario: 译文包含换行和前导空格
- **WHEN** 译文增量为 `"\n  world"`
- **THEN** 客户端解析 delta 事件的 JSON 后得到完全相同的字符串

#### Scenario: 以追问结束
- **WHEN** 会话翻译触发歧义追问
- **THEN** 事件流最后一个事件为 clarify，data 含 threadId、question、options、span，然后连接关闭，不写入翻译记录

#### Scenario: 追问恢复的事件流
- **WHEN** 用户回答追问后系统恢复执行
- **THEN** 新的事件流以 start 开始，从 clarify 之后的节点继续推送 node 与 delta 事件，最后是 final
