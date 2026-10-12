## Context

- 仓库是全新的，只有 `web/`、`springboot-bakcend/`（拼写错误）、`python-backend/` 三个空目录
- 总体架构、服务边界与路线图见 `docs/总体设计.md`。本 change 是路线图的 ①，为后续 ② ~ ⑤ 提供地基
- 约束：单人开发；开发机是 Windows 11（Docker Desktop）；作为毕业设计，需要交付"数据库脚本、接口规范、异常处理、测试材料"
- 版本基线（2026-10 均处于社区支持期内）：Java 25 LTS、Spring Boot 4.1、MyBatis-Plus 3.5.17、Next.js 16.3（Active LTS）、React 19.2、Python 3.12+、PostgreSQL 17 + pgvector、Redis 7

## Goals / Non-Goals

**Goals:**

- 三端工程可以一条命令启动依赖、各自独立运行，并跑通"浏览器 → Spring → Python → LLM"整条链路（以模型连通性测试为演示点）
- 建立后续所有 change 共用的约定：统一响应、错误码、异常处理、traceId、分页、鉴权、操作日志
- 安全基线：BCrypt 密码、JWT + 可吊销的刷新令牌、模型密钥加密存储、Python 内部接口鉴权、数据库最小权限

**Non-Goals:**

- 任何翻译业务能力、Redis Stream 异步链路、LangGraph、翻译记忆表（见 proposal「非目标」）
- 应用容器化和生产部署：本次 docker compose 只编排 PostgreSQL 和 Redis

## Decisions

### D1. 工程结构与命名

**决策**：monorepo，三个子工程各自独立构建。Spring 用 Maven，groupId 为 `com.xjl`，基础包名 `com.xjl.tl`。Python 用 uv。Web 用 pnpm。目录 `springboot-bakcend/` 通过 `git mv` 更名为 `springboot-backend/`。

```
xjl-tl-web/
├─ docker-compose.yml          # postgres(pgvector) + redis
├─ docker/postgres/init/       # 01-roles.sql：建库、建角色
├─ .env.example
├─ web/src/
│  ├─ app/(auth)/{login,register}/
│  ├─ app/(main)/{layout.tsx,page.tsx,profile/,admin/{users,model-configs,logs,system}/}
│  ├─ lib/{http.ts,api/}       # fetch 封装、Result 解包、令牌刷新
│  ├─ stores/auth.ts           # zustand
│  └─ components/{ui/,layout/}
├─ springboot-backend/src/main/java/com/xjl/tl/
│  ├─ common/                  # Result、ErrorCode、BizException、GlobalExceptionHandler、PageResult、TraceIdFilter
│  ├─ security/                # SecurityConfig、JWT 签发/校验、令牌吊销、CurrentUser
│  ├─ module/{auth,user,model,log,system}/   # controller/service/mapper/entity/dto
│  └─ infra/ai/                # AiServiceClient
│  └─ resources/db/migration/  # Flyway V1__init_schema.sql ...
└─ python-backend/app/
   ├─ main.py
   ├─ core/{config.py,security.py,db.py,crypto.py,errors.py,logging.py}
   ├─ llm/{base.py,openai_compat.py,anthropic_client.py,registry.py}
   ├─ repositories/model_config.py
   └─ api/internal/{health.py,llm.py}
```

**备选方案**：多仓库；Gradle。
**理由**：毕设单人维护，monorepo 便于统一提交和答辩展示；国内 Spring 项目主流用 Maven，资料更多。

### D2. 统一响应与错误码

**决策**：Spring 对外、Python 对内的接口都使用同一个响应信封：

```json
{ "code": "00000", "message": "成功", "data": { }, "traceId": "a1b2c3d4e5f6" }
```

错误码参照《阿里巴巴 Java 开发手册》：字符串类型，共 5 位，由"来源 + 4 位编号"组成。`A` 表示用户端错误，`B` 表示系统错误，`C` 表示第三方服务（AI 服务 / LLM）错误。

| 码 | 含义 | HTTP |
|---|---|---|
| 00000 | 成功 | 200 |
| A0111 | 用户名已存在 | 409 |
| A0201 | 用户名或密码错误（不区分"账号不存在"，防止枚举用户） | 401 |
| A0202 | 账号已禁用 | 403 |
| A0211 | 登录失败次数过多，请稍后再试 | 429 |
| A0230 | 访问令牌已过期 | 401 |
| A0231 | 访问令牌无效或已吊销 | 401 |
| A0232 | 刷新令牌无效或已过期 | 401 |
| A0240 | 原密码错误 | 400 |
| A0301 | 无访问权限 | 403 |
| A0404 | 资源不存在 | 404 |
| A0410 | 请求参数校验失败（data 为 `[{field,message}]`） | 400 |
| B0001 | 系统执行出错 | 500 |
| B0100 | 内部服务鉴权失败 | 401 |
| C0110 | AI 服务不可用 | 503 |
| C0120 | LLM 调用失败 | 502 |
| C0121 | LLM 鉴权失败（API Key 无效） | 502 |
| C0122 | LLM 调用超时 | 504 |
| C0123 | LLM 限流 | 502 |
| C0130 | 模型配置不存在或已停用 | 400 |

**备选方案**：HTTP 一律返回 200，只看 body 里的 code。
**理由**：保留 HTTP 语义状态码，网关、日志和浏览器开发者工具都能直观识别错误；body 里的 code 用于前端精确分支处理。两者同时使用是常见做法。

### D3. 认证方案：JWT 访问令牌 + 可吊销的刷新令牌

**决策**：

- **访问令牌**：JWT，HS256，有效期 2 小时。claims 包含 `sub`(userId)、`username`、`roles`、`jti`、`iat`。用 Spring Security OAuth2 Resource Server 自带的 `NimbusJwtEncoder/Decoder` 签发和校验
- **刷新令牌**：32 字节随机串（不是 JWT），存 Redis：`auth:refresh:{token} → userId`，TTL 7 天；每次刷新都轮换（删除旧串、签发新串），并维护集合 `auth:user-refresh:{userId}`
- **退出**：删除刷新令牌；把访问令牌的 `jti` 写入 `auth:blacklist:{jti}`，TTL 为该令牌的剩余有效期
- **强制下线**（禁用用户、重置密码、修改角色时触发）：写入 `auth:revoked-before:{userId} = 当前时间戳`，并删除该用户的全部刷新令牌。自定义 `OAuth2TokenValidator` 会拒绝 `iat` 早于该时间戳的令牌，以及 `jti` 在黑名单中的令牌
- **登录限流**：`auth:login-fail:{username}`，15 分钟内失败 5 次即锁定，返回 A0211
- **前端**：令牌放在 zustand（持久化到 localStorage），请求头带 `Authorization: Bearer`。`http.ts` 收到 A0230 时以 single-flight 方式刷新一次后重试；刷新失败则清空状态并跳转登录页

**备选方案**：
1. 引入 jjwt 自建过滤器。Spring Boot 4 默认用 Jackson 3，而 jjwt-jackson 依赖 Jackson 2，会造成依赖重复；Spring 官方组件已经能覆盖签发和校验
2. 刷新令牌放 HttpOnly Cookie。更能防 XSS，但需要处理跨域 Cookie 和 CSRF，而且 ② 的 SSE 要用 POST 发请求，Bearer 方案更统一
3. Session + Redis。有状态，不利于以后 Python 侧校验和水平扩展

**理由**：用官方组件、少依赖；刷新令牌放在服务端，可以真正吊销；"强制下线"一个机制就覆盖了禁用、改密、改角色三种场景。localStorage 的 XSS 风险通过 React 默认转义 + CSP 缓解，并在论文的安全设计一节说明这个取舍。

### D4. 前端调用方式：浏览器直连 Spring + CORS

**决策**：前端通过 `NEXT_PUBLIC_API_BASE_URL` 直接请求 Spring（默认 `http://localhost:8080`），Spring 配置 CORS 白名单，允许 web 的源访问。受保护页面在客户端渲染，路由守卫放在 `(main)/layout.tsx` 中，管理员页面再加一层角色检查。不使用 `proxy.ts`。

**备选方案**：用 Next.js rewrites 反向代理 `/api/*`，做到同源。
**理由**：鉴权用的是 Bearer 头，不依赖同源 Cookie；而且多一层 Next 代理，可能导致 ② 的 SSE 流被缓冲或压缩，失去逐字输出的效果。直连可以从根上避免这个风险。

### D5. 主键与持久层

**决策**：MyBatis-Plus；主键用 `bigint GENERATED ALWAYS AS IDENTITY` 配合 `IdType.AUTO`；时间字段用 `timestamptz`；用户表用逻辑删除（`deleted` 加部分唯一索引 `WHERE deleted = false`）。
**备选方案**：MyBatis-Plus 默认的雪花 ID（ASSIGN_ID）；Spring Data JPA。
**理由**：雪花 ID 超出 JS Number 的安全精度，需要全局改成字符串序列化，容易踩坑；自增 ID 简单直观。MyBatis-Plus 是国内毕设和企业项目的主流选择，SQL 可控，便于论文展示。

### D6. 数据库 schema、角色与最小权限

**决策**：

- docker 初始化脚本创建两个角色：`tl_app`（Spring 使用，拥有两个 schema）和 `tl_ai`（Python 使用）
- Flyway（以 `tl_app` 身份运行）负责：创建 `biz`、`ai` 两个 schema；`CREATE EXTENSION vector`；创建本次的表；授权 `tl_ai` 对 `biz.model_config` 只读、对 `ai` schema 全部权限
- 本次建的表（均在 `biz`）：`sys_user`、`sys_role`、`sys_user_role`、`model_config`、`login_log`、`operation_log`。预置角色 `ADMIN`、`USER`

`model_config` 关键字段：

| 字段 | 说明 |
|---|---|
| name | 显示名 |
| provider | `OPENAI_COMPATIBLE` / `ANTHROPIC` |
| base_url | 例如 `https://api.deepseek.com/v1` |
| model_name | 例如 `deepseek-chat` |
| api_key_cipher | AES-GCM 密文（见 D7） |
| api_key_mask | 例如 `sk-****abcd`，仅用于展示 |
| params | jsonb：temperature、max_tokens、timeout_seconds |
| is_default | 部分唯一索引 `WHERE is_default AND deleted = false`，保证只有一个默认模型 |
| enabled / deleted / created_at / updated_at | |

**备选方案**：Python 直接用超级用户连库；Python 通过 Spring 接口获取模型配置。
**理由**：数据库层就落实了"Spring 写、Python 只读"的边界（对应总体设计 3.1）；后续 ② 只需追加对术语表的 SELECT 授权。

### D7. 模型密钥加密（跨语言）

**决策**：AES-256-GCM，密钥来自环境变量 `MODEL_KEY_SECRET`（base64 编码的 32 字节）。存储格式为 `v1:` + base64(iv[12] ‖ ciphertext ‖ tag[16])。Java（`javax.crypto` GCM）和 Python（`cryptography` 的 AESGCM）原生输出的都是 ciphertext‖tag，格式天然一致。接口永远不返回明文或密文，只返回掩码；更新时 apiKey 留空表示保持原值。
**备选方案**：明文存储；只把 Key 放在 Python 的 .env 里。
**理由**：管理员需要在后台录入 Key（和 Dify、One-API 等主流平台一致），因此必须加密存储。双方测试套件里放同一组测试向量（相同的明文、密钥、密文），保证两边兼容。

### D8. Python LLM 适配层：基于官方 SDK 的薄封装

**决策**：

```python
class ChatRequest:   messages: list[ChatMessage]; temperature; max_tokens; timeout; extra: dict  # extra 用于传 Qwen-MT 的 translation_options 等厂商参数
class ChatResult:    content: str; model: str; usage: Usage; latency_ms: int
class LLMClient(Protocol):
    async def chat(self, req: ChatRequest) -> ChatResult
    def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]   # 最后一个 chunk 带 usage
```

- 实现类：`OpenAICompatibleClient`（`AsyncOpenAI(base_url=...)`，覆盖 DeepSeek、Qwen、豆包、OpenAI）和 `AnthropicClient`（`AsyncAnthropic`）
- `LLMRegistry.get(model_config_id | None)`：从 `biz.model_config` 读配置并解密；按 `(id, updated_at)` 缓存客户端；传 None 时使用默认模型
- 统一异常 `LLMError(kind)`，kind 包括 AUTH / TIMEOUT / RATE_LIMIT / BAD_REQUEST / UNAVAILABLE，分别映射到 C0121 / C0122 / C0123 / C0120 / C0120

**备选方案**：LangChain 的 `init_chat_model`。
**理由**：LangGraph 不强制使用 LangChain 的模型类；薄封装更方便精确采集 usage 和延迟（② 的 agent_trace 需要），更方便透传 Qwen-MT 的 `extra_body`，抽象层次少，论文里也更容易讲清楚。

### D9. 内部接口契约（Spring → Python）

通用约定：Python 服务只监听内网；所有 `/internal/*` 接口必须带请求头 `X-Internal-Token`（与环境变量 `INTERNAL_TOKEN` 比对，使用常量时间比较），否则返回 HTTP 401 + `B0100`。`X-Trace-Id` 由 Spring 透传，Python 写入日志上下文。响应使用 D2 的信封。

**`GET /internal/health`**

```json
// 200
{ "code": "00000", "data": { "status": "UP", "version": "0.1.0", "db": "UP" }, "traceId": "..." }
```

**`POST /internal/llm/test`**

```json
// 请求
{ "modelConfigId": 3 }
// 200，连通成功
{ "code": "00000", "data": { "ok": true, "model": "deepseek-chat", "latencyMs": 812, "reply": "pong", "usage": { "promptTokens": 9, "completionTokens": 2 } } }
// 200，连通失败也算一个有效的测试结果
{ "code": "00000", "data": { "ok": false, "latencyMs": 30012, "errorCode": "C0122", "errorMessage": "LLM 调用超时" } }
// 400，配置不存在或已停用
{ "code": "C0130", "message": "模型配置不存在或已停用" }
```

Spring 侧 `AiServiceClient` 基于 `RestClient`：连接超时 3 秒，读超时 60 秒；连接失败或返回 5xx 时抛出 `BizException(C0110)`。② 引入流式调用时再增加基于 WebClient 的流式客户端。

### D10. 对外接口清单（Spring）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| POST | /api/auth/register | 匿名 | 注册，默认 USER 角色 |
| POST | /api/auth/login | 匿名 | 返回 `{accessToken, refreshToken, expiresIn, user}` |
| POST | /api/auth/refresh | 匿名 | 用 refreshToken 换新的一对令牌 |
| POST | /api/auth/logout | 登录 | 吊销当前令牌 |
| GET | /api/auth/me | 登录 | 当前用户及角色 |
| PUT | /api/users/me | 登录 | 修改昵称、邮箱 |
| PUT | /api/users/me/password | 登录 | 修改密码（校验原密码），完成后强制下线 |
| GET | /api/admin/users | ADMIN | 分页查询，支持按用户名、状态、角色过滤 |
| POST | /api/admin/users | ADMIN | 创建用户 |
| PUT | /api/admin/users/{id}/status | ADMIN | 启用 / 禁用（禁用即强制下线） |
| PUT | /api/admin/users/{id}/roles | ADMIN | 分配角色 |
| PUT | /api/admin/users/{id}/password | ADMIN | 重置密码 |
| DELETE | /api/admin/users/{id} | ADMIN | 逻辑删除（不能删除自己） |
| GET/POST/PUT/DELETE | /api/admin/model-configs[/{id}] | ADMIN | 模型配置 CRUD |
| PUT | /api/admin/model-configs/{id}/default | ADMIN | 设为默认模型 |
| POST | /api/admin/model-configs/{id}/test | ADMIN | 连通性测试（经由 D9） |
| GET | /api/admin/logs/login | ADMIN | 登录日志分页 |
| GET | /api/admin/logs/operation | ADMIN | 操作日志分页 |
| GET | /api/admin/system/status | ADMIN | Spring / DB / Redis / AI 服务健康状态 |

分页参数：`pageNum`（从 1 开始）、`pageSize`（默认 10，最大 100）。分页响应为 `PageResult{records,total,pageNum,pageSize}`。

### D11. traceId 与操作日志

**决策**：`TraceIdFilter` 优先使用请求头里的 `X-Trace-Id`，没有则生成一个；写入 MDC 和响应头，同时填入 `Result.traceId`，调用 Python 时继续透传。操作日志用 `@OperationLog(module, action)` 注解加 AOP 实现，作用于管理员的写操作；记录用户、路径、脱敏后截断的参数、结果码、耗时、traceId，异步写库。前端错误提示里显示 traceId，便于排查问题。

### D12. 测试策略

- Spring：JUnit 5 + MockMvc + Testcontainers（PostgreSQL、Redis），覆盖登录、刷新、退出、吊销、限流、权限、参数校验、模型配置加密
- Python：pytest + httpx `AsyncClient`；用 `respx` 模拟 LLM HTTP 响应，验证错误映射；用跨语言测试向量验证解密
- Web：`pnpm lint`、`pnpm typecheck`、`pnpm build`；登录流程的 E2E 留到 ⑤

### D13. DTO 字段契约（Spring ↔ Web，Spring ↔ Python 共用）

JSON 字段一律 camelCase；时间为 ISO-8601 带时区偏移的字符串；id 为 number（D5 保证不超出 JS 安全整数）。

**认证**

| 接口 | 请求体 | data |
|---|---|---|
| POST /api/auth/register | `{username, password, nickname?, email?}` | `UserInfo` |
| POST /api/auth/login | `{username, password}` | `{accessToken, refreshToken, expiresIn(秒), user: UserInfo}` |
| POST /api/auth/refresh | `{refreshToken}` | 同 login |
| POST /api/auth/logout | `{refreshToken?}` | null |
| GET /api/auth/me | — | `UserInfo` |

`UserInfo = {id, username, nickname, email, status: "ENABLED"|"DISABLED", roles: ("ADMIN"|"USER")[], lastLoginAt, createdAt}`

**用户**

| 接口 | 请求 | data |
|---|---|---|
| PUT /api/users/me | `{nickname?, email?}` | `UserInfo` |
| PUT /api/users/me/password | `{oldPassword, newPassword}` | null |
| GET /api/admin/users | query：`pageNum, pageSize, username?, status?, role?` | `PageResult<UserInfo>` |
| POST /api/admin/users | `{username, password, nickname?, email?, roles}` | `UserInfo` |
| PUT /api/admin/users/{id}/status | `{status}` | null |
| PUT /api/admin/users/{id}/roles | `{roles}` | null |
| PUT /api/admin/users/{id}/password | `{password}` | null |
| DELETE /api/admin/users/{id} | — | null |

**模型配置**

`ModelConfigVO = {id, name, provider: "OPENAI_COMPATIBLE"|"ANTHROPIC", baseUrl, modelName, apiKeyMask, params: {temperature?, maxTokens?, timeoutSeconds?, maxRetries?}, isDefault, enabled, remark, createdAt, updatedAt}`

| 接口 | 请求 | data |
|---|---|---|
| GET /api/admin/model-configs | query：`pageNum, pageSize, keyword?` | `PageResult<ModelConfigVO>` |
| GET /api/admin/model-configs/{id} | — | `ModelConfigVO` |
| POST /api/admin/model-configs | `{name, provider, baseUrl, modelName, apiKey, params?, remark?, enabled?}` | `ModelConfigVO` |
| PUT /api/admin/model-configs/{id} | 同上，`apiKey` 为空或缺省表示保持原值 | `ModelConfigVO` |
| DELETE /api/admin/model-configs/{id} | — | null |
| PUT /api/admin/model-configs/{id}/default | — | null |
| PUT /api/admin/model-configs/{id}/enabled | `{enabled}` | null |
| POST /api/admin/model-configs/{id}/test | — | `ModelTestResult` |

`ModelTestResult = {ok, model?, latencyMs, reply?, usage?: {promptTokens, completionTokens}, errorCode?, errorMessage?}`（与 Python `/internal/llm/test` 的 data 完全相同，Spring 原样透传）

**日志与系统**

| 接口 | query | data |
|---|---|---|
| GET /api/admin/logs/login | `pageNum, pageSize, username?, success?, startTime?, endTime?` | `PageResult<{id, userId, username, ip, userAgent, success, failReason, createdAt}>` |
| GET /api/admin/logs/operation | `pageNum, pageSize, username?, module?, startTime?, endTime?` | `PageResult<{id, userId, username, module, action, method, path, params, resultCode, durationMs, ip, traceId, createdAt}>` |
| GET /api/admin/system/status | — | `{items: [{name: "spring"|"postgres"|"redis"|"ai-service", status: "UP"|"DOWN", detail?}]}` |

**`biz.model_config` DDL（Spring Flyway 建表，Python 只读）**

```sql
CREATE TABLE biz.model_config (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           varchar(64)  NOT NULL,
  provider       varchar(32)  NOT NULL CHECK (provider IN ('OPENAI_COMPATIBLE','ANTHROPIC')),
  base_url       varchar(255) NOT NULL,
  model_name     varchar(128) NOT NULL,
  api_key_cipher text         NOT NULL,
  api_key_mask   varchar(32)  NOT NULL,
  params         jsonb        NOT NULL DEFAULT '{}'::jsonb,  -- {"temperature":0.3,"maxTokens":1024,"timeoutSeconds":30,"maxRetries":2}
  is_default     boolean      NOT NULL DEFAULT false,
  enabled        boolean      NOT NULL DEFAULT true,
  remark         varchar(255),
  deleted        boolean      NOT NULL DEFAULT false,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uk_model_config_default ON biz.model_config (is_default) WHERE is_default AND NOT deleted;
```

## Risks / Trade-offs

- [Spring Boot 4 / Jackson 3 生态兼容性（springdoc 等）] → 搭建脚手架时第一步就锁定并验证版本组合（springdoc-openapi 3.x 对应 Boot 4）；不兼容的组件替换或暂时去掉，并记录在 tasks 中
- [localStorage 存令牌有 XSS 风险] → React 默认转义、不使用 `dangerouslySetInnerHTML`、配置 CSP；访问令牌有效期短，刷新令牌可吊销
- [Java 和 Python 两边的密钥格式不一致] → 双方测试里放同一组测试向量，CI 和本地都会验证
- [Python 直连 biz 表，形成跨服务耦合] → 只授予 SELECT 权限，且只开放到具体表；Python 侧通过 repository 层集中访问，表结构变更时只需改一处
- [Windows 开发环境的差异（路径、换行符、Docker 卷）] → 加 `.gitattributes` 统一换行符；docker 卷使用命名卷，不用绑定挂载

## Migration Plan

全新项目，没有数据迁移。唯一的破坏性变更是目录更名：用 `git mv springboot-bakcend springboot-backend` 保留历史。回滚时删除该 change 的提交即可。

## Open Questions

- groupId / 基础包名暂定 `com.xjl` / `com.xjl.tl`；如果学校对命名有要求，在脚手架阶段替换
- 是否开放自助注册：暂定开放（默认 USER 角色）；如果演示环境需要关闭，后续再加一个系统配置开关
