## Why

仓库目前只有三个空目录，后续所有翻译能力（短文本 Agent、篇章 Agent、会话上下文）都依赖统一的工程骨架、用户体系、接口规范以及"Spring → Python → LLM"这条调用链路。先把地基打好，并作为第一个可独立演示的版本，这样后面每个 change 都只需关注业务能力本身。

## What Changes

- 搭建 monorepo 三端工程骨架：`web/`（Next.js 16.3）、`springboot-backend/`（Spring Boot 4.1 + Java 25）、`python-backend/`（FastAPI + uv）
- **BREAKING**：目录 `springboot-bakcend/` 更名为 `springboot-backend/`（修正拼写，与 CLAUDE.md 保持一致）
- 提供 docker compose 本地依赖环境：PostgreSQL 17 + pgvector、Redis 7；Flyway 建立 `biz`、`ai` 两个 schema 和初始表
- 用户认证：注册、登录、JWT 访问令牌 + 刷新令牌（轮换）、退出、当前用户信息、登录日志、登录失败限流
- 用户与角色管理：RBAC（ADMIN / USER）；管理员可查询、启停用户、重置密码、分配角色；用户可修改个人资料和密码；首次启动根据环境变量初始化管理员
- 接口规范与异常处理：统一响应 `Result<T>`、业务错误码体系、全局异常处理、参数校验、分页规范、traceId 贯穿、操作日志、OpenAPI 文档
- 模型配置管理：管理员维护 LLM 提供方配置（OpenAI 兼容 / Anthropic），API Key 使用 AES-GCM 加密存储，可设置默认模型，支持一键连通性测试
- AI 服务基础：FastAPI 服务骨架、内部接口鉴权（X-Internal-Token）、健康检查、统一 LLM 适配层（同步调用与流式调用接口）、Spring 侧 AI 服务客户端
- 前端外壳：登录/注册页、主布局与导航、路由守卫、按角色显示菜单、个人中心、管理后台（用户管理、模型配置、登录日志、操作日志）

## Capabilities

### New Capabilities

- `user-auth`：用户注册、登录、令牌签发/刷新/吊销、退出、当前用户信息、登录日志与失败限流、前端路由守卫
- `user-management`：RBAC 角色模型、管理员用户管理、个人资料与密码修改、初始管理员引导
- `api-conventions`：统一响应结构、错误码、全局异常处理、参数校验、分页、traceId、操作日志、OpenAPI 文档
- `model-config`：LLM 模型配置的增删改查、密钥加密存储、默认模型、启停、连通性测试
- `ai-service-foundation`：Python AI 服务骨架、内部鉴权、健康检查、统一 LLM 适配层（OpenAI 兼容 / Anthropic，同步与流式）、Spring → Python 调用客户端

### Modified Capabilities

（无，`openspec/specs/` 目前为空）

## 非目标

- 不实现任何翻译功能：语种识别、术语库、Agent 编排、翻译任务、历史记录都留到后续 change
- 不引入 Redis Stream 异步任务链路和 LangGraph checkpointer（属于 ③）
- 不建立 pgvector 翻译记忆表（属于 ④）；本次只启用 `vector` 扩展，验证镜像可用
- 不做第三方登录、短信/邮箱验证码、找回密码
- 不做细粒度权限点（按钮级），只做 ADMIN / USER 两种角色
- 不做生产部署（K8s、CI/CD），只提供本地 docker compose

## 依赖关系（对照 docs/总体设计.md 路线图）

- 本 change 是路线图的 **①**，不依赖其他 change
- **② add-text-translation-agent** 依赖本 change 的：用户认证、`Result<T>` 与错误码、模型配置、LLM 适配层、Spring → Python 客户端、前端布局
- **③ ④ ⑤** 间接依赖本 change 的全部基础设施

## Impact

- **目录结构**：重命名 `springboot-bakcend/` → `springboot-backend/`；三个子工程首次填充代码
- **新增依赖**：
  - Spring：spring-boot-starter-web / security / validation / data-redis、mybatis-plus-spring-boot4-starter、flyway-core + flyway-database-postgresql、postgresql、jjwt、springdoc-openapi
  - Python：fastapi、uvicorn、pydantic-settings、openai、anthropic、psycopg[binary]、cryptography、httpx、pytest
  - Web：next、react、tailwindcss、shadcn/ui、@tanstack/react-query、zustand、zod、react-hook-form
- **基础设施**：docker compose（pgvector/pgvector:pg17、redis:7），根目录 `.env.example`
- **对外 API**：`/api/auth/*`、`/api/users/*`、`/api/admin/users/*`、`/api/admin/model-configs/*`、`/api/admin/logs/*`
- **内部 API**（Python，不对外暴露）：`/internal/health`、`/internal/llm/test`
