# api-conventions Specification

## Purpose
TBD - created by archiving change bootstrap-platform-foundation. Update Purpose after archive.
## Requirements
### Requirement: 统一响应结构
Spring 对外接口和 Python 内部接口 SHALL 都返回统一的 JSON 信封 `{code, message, data, traceId}`。成功时 `code` MUST 为 `"00000"`；失败时 `code` MUST 为 5 位字符串错误码，首字母 `A` 表示用户端错误，`B` 表示系统错误，`C` 表示第三方服务错误。

#### Scenario: 成功响应
- **WHEN** 任意接口处理成功
- **THEN** 响应体 `code` 为 `"00000"`，`data` 为业务数据，`traceId` 非空

#### Scenario: 业务异常
- **WHEN** 业务代码抛出带错误码的业务异常
- **THEN** 响应体 `code` 为该错误码，`message` 为对应的中文提示，HTTP 状态码按错误码约定的映射返回

### Requirement: 全局异常处理
系统 SHALL 通过全局异常处理器捕获所有未处理异常。未预期的异常 MUST 返回 HTTP 500、code `B0001`，响应中 MUST NOT 暴露堆栈或内部细节；完整堆栈 MUST 连同 traceId 写入服务端日志。

#### Scenario: 未预期异常
- **WHEN** 接口内部发生空指针等未预期的异常
- **THEN** 客户端收到 HTTP 500、code `B0001`、通用提示文案和 traceId；服务端日志中可以按该 traceId 查到完整堆栈

#### Scenario: 资源不存在
- **WHEN** 请求的资源 id 不存在或已被逻辑删除
- **THEN** 系统返回 HTTP 404、code `A0404`

### Requirement: 参数校验
系统 SHALL 使用声明式校验检查请求参数。校验失败时 MUST 返回 HTTP 400、code `A0410`，`data` 为 `[{field, message}]`，列出所有不合法的字段。

#### Scenario: 多字段校验失败
- **WHEN** 请求体中有两个字段同时不合法
- **THEN** 响应 `data` 中包含这两个字段各自的错误信息

### Requirement: 分页规范
所有列表接口 SHALL 接收 `pageNum`（从 1 开始，默认 1）和 `pageSize`（默认 10，最大 100）参数，并返回 `PageResult{records, total, pageNum, pageSize}`。`pageSize` 超过 100 时 MUST 按 100 处理。

#### Scenario: 超大分页参数
- **WHEN** 客户端请求 `pageSize=1000`
- **THEN** 返回结果中 `pageSize` 为 100，`records` 最多 100 条

### Requirement: 链路追踪标识
系统 SHALL 为每个请求确定一个 traceId：如果请求头带有 `X-Trace-Id` 则沿用，否则生成新的。traceId MUST 出现在响应头 `X-Trace-Id`、响应体 `traceId` 字段和该请求的全部日志中，并在 Spring 调用 Python 时透传。

#### Scenario: 跨服务追踪
- **WHEN** 管理员触发模型连通性测试
- **THEN** Spring 日志、Python 日志和最终响应体中的 traceId 相同

### Requirement: 操作日志
系统 SHALL 记录管理员的全部写操作，内容包括操作人、模块、动作、请求路径、脱敏后的参数、结果码、耗时、IP 和 traceId。参数中的密码、API Key 等敏感字段 MUST 脱敏。管理员 SHALL 可以分页查询操作日志和登录日志。

#### Scenario: 记录并脱敏
- **WHEN** 管理员新建一条包含 API Key 的模型配置
- **THEN** 操作日志中记录这次操作，参数里的 apiKey 显示为脱敏值

#### Scenario: 查询日志
- **WHEN** 管理员按时间范围和用户名查询操作日志
- **THEN** 系统返回符合条件的分页结果，按时间倒序

### Requirement: 接口文档
Spring 服务 SHALL 在非生产环境提供 OpenAPI 文档和 Swagger UI，并为接口和 DTO 字段提供中文说明。

#### Scenario: 访问接口文档
- **WHEN** 开发者在本地访问 Swagger UI
- **THEN** 可以看到本 change 的全部对外接口，并能用 Bearer 令牌在线调试

