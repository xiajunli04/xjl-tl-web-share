## ADDED Requirements

### Requirement: SSE 事件协议
翻译接口 SHALL 以 `text/event-stream` 返回事件流。事件名限定为 `start`、`node`、`detect`、`terms`、`plan`、`delta`、`review`、`final`、`error`，每个事件的 data MUST 是单行 JSON。一次翻译的事件流 MUST 以 `final` 或 `error` 作为最后一个事件结束。

#### Scenario: 正常流程的事件顺序
- **WHEN** 一次快速路径翻译成功完成
- **THEN** 客户端依次收到 start、若干 node/detect/plan/delta 事件，最后是 final，然后连接关闭

#### Scenario: 译文包含换行和前导空格
- **WHEN** 译文增量为 `"\n  world"`
- **THEN** 客户端解析 delta 事件的 JSON 后得到完全相同的字符串

### Requirement: 两跳转发与落库
Spring SHALL 把 Python 的事件流原样转发给浏览器，并在收到 `final` 时同步写入翻译记录和 Agent 轨迹，然后在转发的 final 事件中补充 `recordId`。转发链路的任何一跳都 MUST NOT 缓冲事件：Spring 响应 MUST 设置 `Cache-Control: no-cache` 和 `X-Accel-Buffering: no`。

#### Scenario: 首个事件及时到达
- **WHEN** 在 LLM 被 mock 的集成测试中发起翻译
- **THEN** 浏览器端在 1 秒内收到 start 事件

#### Scenario: final 带 recordId
- **WHEN** 翻译成功完成
- **THEN** 浏览器收到的 final 事件包含 recordId，且该记录在历史列表中可以查到

### Requirement: 心跳与超时
事件流 SHALL 每 15 秒发送一次 SSE 注释心跳。一次翻译的总时长超过 180 秒时，系统 MUST 发送 `error` 事件（code `C0141`）并结束流。

#### Scenario: 长时间无增量
- **WHEN** 上游 LLM 30 秒没有返回内容
- **THEN** 客户端在这期间至少收到一次心跳，连接保持不断开

### Requirement: 取消传播
浏览器中断请求时，系统 SHALL 逐级取消：Spring 断开与 Python 的连接，Python 取消正在执行的 Agent 和 LLM 调用。被取消的翻译 MUST NOT 写入翻译记录。

#### Scenario: 用户停止
- **WHEN** 用户在 translate 节点执行期间中断请求
- **THEN** Python 日志记录该请求已取消，数据库中没有新增翻译记录

### Requirement: 错误事件
流建立后发生的错误 SHALL 以 `error` 事件 `{code, message}` 返回，code 沿用统一错误码（如 LLM 鉴权失败 `C0121`、AI 服务不可用 `C0110`、Agent 执行失败 `C0140`）。流建立之前的错误（参数校验、限流、鉴权）SHALL 以普通 JSON 响应返回，HTTP 状态码按错误码约定。

#### Scenario: 上游 LLM 鉴权失败
- **WHEN** 默认模型的 API Key 已失效
- **THEN** 客户端收到 `error` 事件，code 为 `C0121`，流随即结束

#### Scenario: AI 服务未启动
- **WHEN** Python 服务不可达时发起翻译
- **THEN** 客户端收到 `error` 事件，code 为 `C0110`

### Requirement: 翻译调用限流
系统 SHALL 限制每个用户每分钟最多发起 20 次翻译（可配置）。超限的请求 MUST 在建立事件流之前被拒绝，返回 HTTP 429、code `A0212`。

#### Scenario: 超过限流
- **WHEN** 同一用户在 1 分钟内发起第 21 次翻译
- **THEN** 系统返回 HTTP 429、code `A0212`，不调用 AI 服务
