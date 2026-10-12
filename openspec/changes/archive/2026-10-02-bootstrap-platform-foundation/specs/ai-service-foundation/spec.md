## ADDED Requirements

### Requirement: 内部接口鉴权
Python AI 服务的所有 `/internal/*` 接口 SHALL 校验请求头 `X-Internal-Token`，并与环境变量 `INTERNAL_TOKEN` 做常量时间比较。缺失或不匹配时 MUST 返回 HTTP 401、code `B0100`。Python 服务 MUST NOT 被浏览器直接访问：Web 前端只与 Spring 通信。

#### Scenario: 缺少内部令牌
- **WHEN** 请求 `POST /internal/llm/test` 时未带 `X-Internal-Token`
- **THEN** 返回 HTTP 401、code `B0100`，不执行任何业务逻辑

#### Scenario: Spring 正常调用
- **WHEN** Spring 的 AI 服务客户端带上正确的内部令牌调用健康检查
- **THEN** 返回 code `00000`

### Requirement: 健康检查
Python AI 服务 SHALL 提供 `GET /internal/health`，返回服务状态、版本号和数据库连通状态。Spring SHALL 汇总自身、PostgreSQL、Redis 和 AI 服务的健康状态，供管理后台查看。

#### Scenario: 管理后台查看系统状态
- **WHEN** 管理员打开"系统状态"页面
- **THEN** 页面分别显示 Spring、PostgreSQL、Redis、AI 服务四项的状态（UP 或 DOWN）

#### Scenario: AI 服务数据库断开
- **WHEN** Python 服务运行中但数据库不可达
- **THEN** 健康检查返回 `status=UP`、`db=DOWN`

### Requirement: 统一 LLM 适配层
Python AI 服务 SHALL 提供统一的 LLM 调用抽象，同时支持一次性调用和流式调用，并至少实现两种提供方：OpenAI 兼容协议（覆盖 DeepSeek、Qwen、OpenAI 等）和 Anthropic。每次调用结果 MUST 包含回复内容、实际模型名、token 用量（输入/输出）和耗时（毫秒）。调用方 SHALL 能透传厂商特有参数（如 Qwen-MT 的 `translation_options`）。

#### Scenario: 按配置 id 获取客户端
- **WHEN** 调用方按模型配置 id 获取 LLM 客户端
- **THEN** 适配层从 `biz.model_config` 读取并解密配置，返回对应提供方的客户端；配置的 `updated_at` 未变化时复用缓存实例

#### Scenario: 使用默认模型
- **WHEN** 调用方没有指定模型配置 id
- **THEN** 适配层使用当前默认模型；如果没有默认模型，抛出可映射为 `C0130` 的错误

#### Scenario: 流式调用
- **WHEN** 调用方发起流式调用
- **THEN** 适配层逐段产出文本增量，最后一段带上 token 用量和总耗时

### Requirement: LLM 错误归类
LLM 适配层 SHALL 把各提供方的异常归为统一类别，并映射到错误码：鉴权失败 → `C0121`，超时 → `C0122`，限流 → `C0123`，其他调用失败 → `C0120`。错误信息中 MUST NOT 包含 API Key。

#### Scenario: 上游返回 401
- **WHEN** LLM 提供方返回鉴权失败
- **THEN** 适配层抛出鉴权类错误，最终映射为 `C0121`

#### Scenario: 请求超时
- **WHEN** LLM 调用超过配置的 timeout_seconds 仍未返回
- **THEN** 适配层中止请求并抛出超时类错误，映射为 `C0122`

### Requirement: Spring 侧 AI 服务客户端
Spring SHALL 提供统一的 AI 服务客户端：自动附加内部令牌和 traceId，解包 Python 返回的响应信封。连接失败或 Python 返回 5xx 时 MUST 抛出 code 为 `C0110` 的业务异常；Python 返回的业务错误码 MUST 原样传递给前端。

#### Scenario: Python 返回业务错误
- **WHEN** Python 对连通性测试返回 code `C0130`
- **THEN** Spring 向前端返回 code `C0130` 和相同的提示文案

### Requirement: 数据库最小权限
Python AI 服务 SHALL 使用独立的数据库角色 `tl_ai` 连接 PostgreSQL。该角色对 `biz` schema MUST 只有被显式授予的表的 SELECT 权限（本 change 只有 `biz.model_config`），对 `ai` schema 拥有完整权限。

#### Scenario: 越权写入被拒绝
- **WHEN** 以 `tl_ai` 角色执行 `UPDATE biz.model_config ...`
- **THEN** 数据库拒绝执行（permission denied）
