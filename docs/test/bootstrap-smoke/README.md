# 冒烟测试记录：bootstrap-platform-foundation

- 日期：2026-10-02
- 环境：Windows 11；docker compose（pgvector/pgvector:pg17、redis:7-alpine）；Spring Boot 4.1.1 / JDK 25（端口 18080）；Python 3.12 FastAPI（端口 8000）；Next.js 16.3.8（端口 3000）
- 测试用 LLM：OpenAI 兼容中转 `gpt-5.6-luna`、Anthropic 协议 `gpt-6-luna`

## 端到端步骤

| # | 步骤 | 预期 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | 访客注册 `smoke_user` | 注册成功并跳转登录页 | ✅ | 01-register.png |
| 2 | 管理员登录 | 进入工作台，可见「管理后台」菜单 | ✅ | 02-admin-home.png |
| 3 | 新建 OpenAI 兼容与 Anthropic 两条配置，设为默认，测试连通性 | 页面显示连接成功、耗时、token 用量与回复 | ✅ 回复 `pong`，约 3–5 s | 03-model-test-ok.png |
| 4 | 禁用 `smoke_user`（二次确认） | 提示将被强制下线 | ✅ | 04-disable-confirm.png、05-user-disabled.png |
| 5 | 用 `smoke_user` 的旧访问令牌请求 `/api/auth/me` | `A0231` | ✅ `A0231 访问令牌无效或已吊销` | curl |
| 6 | `smoke_user` 重新登录 | `A0202` | ✅ `A0202 账号已禁用` | curl |
| 7 | 查看操作日志 | 记录禁用、测试连通性等写操作，参数脱敏 | ✅ apiKey 记录为 `******` | 06-operation-log.png |
| 8 | 查看系统状态 | 四项均为 UP | ✅ | 07-system-status.png |

## 异常路径（接口验证）

| 场景 | 预期 | 结果 |
|---|---|---|
| 无效 API Key 测试连通性 | `00000` + `ok=false` + `C0121` | ✅ |
| 停止 Python 后查看系统状态 | 仅 ai-service 为 DOWN，Spring `/actuator/health` 仍为 UP | ✅ |
| 停止 Python 后测试连通性 | HTTP 503 + `C0110` | ✅ |
| 跨服务 traceId | 请求头 `X-Trace-Id: smoke-trace-001` 出现在响应体、响应头、Python 日志与操作日志 | ✅ |
| 数据库密钥存储 | `api_key_cipher` 以 `v1:` 开头，无明文 | ✅ |

## 自动化测试

| 工程 | 命令 | 结果 |
|---|---|---|
| springboot-backend | `./mvnw verify`（Testcontainers） | 74 通过 / 0 失败 |
| python-backend | `uv run ruff check . && uv run pytest` | 43 通过 / 0 失败 |
| web | `pnpm lint && pnpm typecheck && pnpm build` | 通过 |

## 冒烟中发现并修复的问题

1. **AI 服务故障拖垮 Spring 健康检查**：AI 健康检查最初注册为 actuator HealthIndicator，Python 停机时 `/actuator/health` 变为 503。已改为仅在「系统状态」中汇总（`AiServiceHealthChecker`）。
2. **上游网络抖动导致偶发失败**：中转站偶发 TLS 握手失败、延迟 3–60 s，而 SDK 自动重试被关闭。已改为默认重试 2 次（连接错误 / 429 / 5xx），可用模型参数 `maxRetries` 覆盖。
3. **本地 JVM 启动内存不足**：JVM 默认按物理内存 1/4 预留堆，开发机提交内存不足。已在 `spring-boot:run` 中限制为 `-Xmx768m`。
