## 1. infra：仓库与本地依赖环境

- [x] 1.1 `git mv springboot-bakcend springboot-backend`，同步检查 CLAUDE.md 与 .gitignore 中的路径（验证：`git status` 显示 rename，旧目录不存在）
- [x] 1.2 新增 `.gitattributes`（统一 LF，`*.cmd`/`*.bat` 用 CRLF）和根目录 `.env.example`，列出 POSTGRES_*、REDIS_*、JWT_SECRET、MODEL_KEY_SECRET、INTERNAL_TOKEN、ADMIN_USERNAME、ADMIN_PASSWORD、AI_SERVICE_URL、NEXT_PUBLIC_API_BASE_URL，每项附中文注释（验证：人工核对与 design D3/D7/D9 一致）
- [x] 1.3 编写 `docker-compose.yml`（pgvector/pgvector:pg17、redis:7，命名卷，带 healthcheck）和 `docker/postgres/init/01-roles.sh`（改用 shell 以读取环境变量中的角色密码；Redis 映射到宿主 6380，避开本机原生 redis 占用的 6379），创建数据库及 `tl_app`、`tl_ai` 角色（验证：`docker compose up -d` 后两个服务都是 healthy；`psql -U tl_app` 和 `psql -U tl_ai` 都能连上）

## 2. springboot-backend：工程骨架与通用约定

- [x] 2.1 生成 Spring Boot 4.1 / Java 25 / Maven 工程（groupId `com.xjl`，包名 `com.xjl.tl`），引入 web、security、oauth2-resource-server、validation、data-redis、actuator、mybatis-plus-spring-boot4-starter、flyway、postgresql、springdoc-openapi；第一步锁定并验证这套版本组合能一起工作（验证：`./mvnw verify` 通过，应用能启动，`/actuator/health` 返回 UP）
- [x] 2.2 实现 `Result<T>`、`ErrorCode` 枚举（覆盖 design D2 全表及 HTTP 映射）、`BizException`、`PageQuery`/`PageResult`（验证：单元测试覆盖序列化格式和 pageSize 上限 100）
- [x] 2.3 实现 `GlobalExceptionHandler`（业务异常、参数校验 A0410 带字段列表、404、未预期异常 B0001 且不泄露堆栈）（验证：MockMvc 测试覆盖 api-conventions 中"全局异常处理"和"参数校验"的全部场景）
- [x] 2.4 实现 `TraceIdFilter`（沿用或生成 traceId，写入 MDC、响应头和 Result），配置 logback 输出 traceId（验证：MockMvc 断言响应头与响应体的 traceId 一致；带 `X-Trace-Id` 请求时原样沿用）
- [x] 2.5 编写 Flyway `V1__init_schema.sql`：biz/ai 两个 schema、`CREATE EXTENSION vector`、sys_user/sys_role/sys_user_role/model_config/login_log/operation_log、部分唯一索引、预置 ADMIN/USER 角色、对 `tl_ai` 的授权（验证：Testcontainers 中迁移成功；以 `tl_ai` 身份 UPDATE biz.model_config 被拒绝、SELECT 成功）
- [x] 2.6 配置 MyBatis-Plus（IdType.AUTO、逻辑删除、分页插件、created_at/updated_at 自动填充）和 springdoc（Bearer 鉴权、仅非 prod 环境启用）（验证：Swagger UI 能打开；分页查询返回正确的 total）
- [x] 2.7 搭建 Testcontainers 测试基类（PostgreSQL + Redis 共享容器）（验证：一个空的集成测试能在本机 Docker 上跑通）

## 3. springboot-backend：认证

- [x] 3.1 实现 JWT 签发与校验配置（NimbusJwtEncoder/Decoder、HS256、2 小时有效、claims 含 roles/jti/iat），自定义 AuthenticationEntryPoint/AccessDeniedHandler，输出 A0230/A0231/A0301 的 Result JSON（验证：MockMvc 测试覆盖过期令牌、签名错误、缺失令牌、角色不足四种情况）
- [x] 3.2 实现令牌吊销：自定义 `OAuth2TokenValidator`（检查 jti 黑名单和 `revoked-before`），并提供 `TokenRevocationService`，包含 revokeAccess 和 revokeAllForUser（验证：集成测试中，调用 revokeAllForUser 后旧令牌返回 A0231）
- [x] 3.3 实现注册接口（校验用户名和密码规则、BCrypt 存储、默认 USER 角色、用户名冲突返回 A0111）（验证：集成测试覆盖 user-auth"用户注册"的三个场景）
- [x] 3.4 实现登录接口（统一返回 A0201、禁用账号返回 A0202、Redis 失败计数限流返回 A0211、成功时清零计数、写登录日志、更新 last_login_at）（验证：集成测试覆盖"用户登录与令牌签发"和"登录失败限流"的全部场景）
- [x] 3.5 实现刷新接口（Redis 存储不透明令牌、轮换、维护 user-refresh 集合）、退出接口和 `GET /api/auth/me`（验证：集成测试覆盖刷新成功、刷新令牌重复使用返回 A0232、退出后旧令牌返回 A0231）

## 4. springboot-backend：用户与角色管理

- [x] 4.1 实现 `AdminBootstrapRunner`：没有 ADMIN 用户时按环境变量创建；环境变量缺失时记录 warn 日志（验证：集成测试中启动两次只创建一个管理员）
- [x] 4.2 实现管理员用户接口：分页查询（用户名、状态、角色过滤）、创建、启停、分配角色、重置密码、逻辑删除；禁止对自己执行危险操作；启停、改角色、重置密码后触发强制下线（验证：集成测试覆盖 user-management"管理员用户管理"的全部场景）
- [x] 4.3 实现个人资料修改和密码修改（校验原密码，错误返回 A0240，成功后强制下线）（验证：集成测试覆盖"个人资料与密码修改"的两个场景）

## 5. springboot-backend：操作日志、模型配置

- [x] 5.1 实现 `@OperationLog` 注解 + AOP（异步写库，对 password/apiKey 等字段脱敏，记录 traceId 和耗时），以及登录日志、操作日志的分页查询接口（验证：集成测试断言新建模型配置后，日志中 apiKey 已脱敏；按时间范围过滤结果正确）
- [x] 5.2 实现 `AesGcmCipher`（`v1:` + base64(iv‖ct‖tag)），并在 `src/test/resources/crypto-vectors.json` 生成跨语言测试向量（验证：单元测试中加解密往返一致，能解开测试向量）
- [x] 5.3 实现模型配置 CRUD（apiKey 加密、只返回掩码、留空表示保持原值）、设为默认（事务内切换）、停用或删除时取消默认（验证：集成测试覆盖 model-config"模型配置管理""密钥加密存储""默认模型"的场景，并直接查库断言字段为密文）

## 6. python-backend：AI 服务基础

- [x] 6.1 用 uv 初始化工程（Python 3.12+），引入 fastapi、uvicorn、pydantic-settings、openai、anthropic、psycopg[binary,pool]、cryptography、httpx，开发依赖 pytest、pytest-asyncio、respx、ruff；建立 design D1 中的目录结构（验证：`uv run ruff check .` 和 `uv run pytest` 通过，`uv run uvicorn app.main:app` 能启动）
- [x] 6.2 实现 `core/config.py`（pydantic-settings 读取根目录 .env）、`core/errors.py`（响应信封与错误码，和 Spring 保持一致）、`core/logging.py`（traceId 写入 contextvar 和日志），以及全局异常处理（验证：pytest 断言未预期异常返回 B0001，且不包含堆栈）
- [x] 6.3 实现 `core/security.py`：`X-Internal-Token` 依赖项，使用 `hmac.compare_digest`（验证：pytest 覆盖缺失令牌和错误令牌都返回 401 + B0100）
- [x] 6.4 实现 `core/db.py`（psycopg 异步连接池，使用 tl_ai 角色）和 `core/crypto.py`（AES-GCM 解密）；把 Spring 生成的 `crypto-vectors.json` 复制到 `tests/fixtures/`（验证：pytest 能用这组测试向量解密成功）
- [x] 6.5 实现 `llm/base.py`（ChatRequest/ChatResult/ChatChunk/Usage/LLMError）、`openai_compat.py`、`anthropic_client.py`，包含 chat 与 stream、extra 参数透传、异常归类（验证：用 respx 模拟 200、401、429、超时，断言分别得到正常结果、AUTH、RATE_LIMIT、TIMEOUT；流式调用的最后一个 chunk 带 usage）
- [x] 6.6 实现 `repositories/model_config.py` 和 `llm/registry.py`（按 id 获取或使用默认模型、按 updated_at 缓存、配置不存在或停用时报 C0130）（验证：pytest 用测试数据库覆盖按 id、默认、缓存命中、配置缺失四种情况）
- [x] 6.7 实现 `GET /internal/health`（包含 db 状态）和 `POST /internal/llm/test`（连通失败时返回 ok=false 和 errorCode，不当作异常）（验证：pytest 覆盖成功、密钥错误返回 C0121、配置不存在返回 C0130；用 curl 带内部令牌手动调用一次真实的 DeepSeek）

## 7. springboot-backend：对接 AI 服务

- [x] 7.1 实现 `AiServiceClient`（RestClient，连接超时 3 秒、读超时 60 秒，附加内部令牌和 traceId，解包信封，连接失败或 5xx 时抛 C0110，业务码原样透传）（验证：用 MockWebServer 测试覆盖正常、业务错误透传、服务不可达三种情况）
- [x] 7.2 实现 `POST /api/admin/model-configs/{id}/test`（验证：Spring 和 Python 都启动后，用 Swagger 调用，Spring 与 Python 日志中的 traceId 相同）
- [x] 7.3 实现 AI 服务健康探测（AiServiceHealthChecker；刻意不注册为 actuator HealthIndicator，避免 AI 故障拖垮 Spring 自身探针） 和 `GET /api/admin/system/status`，汇总 Spring/DB/Redis/AI 四项状态（验证：停掉 Python 后，接口中 AI 一项显示 DOWN，其余仍为 UP）

## 8. web：前端外壳

- [x] 8.1 用 pnpm 初始化 Next.js 16.3（App Router、TypeScript、Tailwind v4、ESLint），接入 shadcn/ui、TanStack Query、zustand、react-hook-form、zod、sonner；添加 `typecheck` 脚本（验证：`pnpm lint && pnpm typecheck && pnpm build` 通过）
- [x] 8.2 实现 `lib/http.ts`：拼接 base URL、附加 Bearer、解包 Result、抛出 `ApiError(code, message, traceId)`、收到 A0230 时 single-flight 刷新后重试、刷新失败时登出；`stores/auth.ts` 持久化令牌和用户信息（验证：在浏览器中把访问令牌改成已过期的值后操作页面，请求自动续期，用户无感知）
- [x] 8.3 实现 `(auth)/login` 和 `(auth)/register` 页面（zod 校验规则与后端一致，错误提示显示 message，B/C 类错误附带 traceId）（验证：手动完成注册 → 登录；连续输错 5 次后看到限流提示）
- [x] 8.4 实现 `(main)/layout.tsx`：侧边栏和顶栏布局、路由守卫（未登录跳转 `/login?redirect=`）、按角色显示菜单、用户下拉菜单（个人中心 / 退出）、首页占位（为 ② 的翻译工作台预留）（验证：未登录访问 `/profile` 被重定向，登录后回到原页面；USER 角色看不到管理菜单）
- [x] 8.5 实现个人中心页面（修改资料、修改密码，成功后跳转登录页）（验证：手动修改密码后旧会话失效）
- [x] 8.6 实现管理后台用户管理页面（表格分页、过滤、新建、启停、分配角色、重置密码、删除，危险操作需二次确认）和无权限页面（验证：手动走一遍 user-management 的全部场景）
- [x] 8.7 实现模型配置页面（列表、新建/编辑表单、密钥只显示掩码、设为默认、启停、"测试连通性"按钮显示耗时和回复片段或错误提示；没有默认模型时提示）（验证：用真实 DeepSeek Key 测试成功；改成错误 Key 后显示"API Key 无效"）
- [x] 8.8 实现登录日志、操作日志、系统状态三个页面（验证：执行一些管理操作后，日志页可以按时间和用户名过滤；系统状态页显示四项状态）

## 9. infra：联调与交付

- [x] 9.1 编写根目录 `README.md`：环境要求、`docker compose up -d`、三端启动命令、默认端口（3000/8080/8000）、环境变量说明、常见问题（Windows 下的 Docker、uv、pnpm）（验证：按 README 在一个干净的目录中从零启动成功）
- [x] 9.2 端到端冒烟：注册 → 管理员登录 → 新建并测试 DeepSeek 配置 → 禁用测试用户 → 该用户被强制下线 → 查看操作日志与系统状态（验证：全部步骤符合预期，并将截图存档到 `docs/test/bootstrap-smoke/`，作为测试材料）
- [x] 9.3 运行 `openspec validate bootstrap-platform-foundation`，逐条核对 specs 中每个 Scenario 都有对应的测试或手动验证记录（验证：validate 通过，核对清单附在 PR 或 commit 说明中）
