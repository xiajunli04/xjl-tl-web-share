# 译桥 · LinguaBridge

让语言相通，让理解发生。

基于 Agent 的多语言翻译平台。

本科毕业设计。总体设计与路线图见 [docs/总体设计.md](docs/总体设计.md)，需求规格见 `openspec/`。

| 目录 | 说明 | 技术栈 |
|---|---|---|
| `web/` | 前端 | Next.js 16.3 · React 19.2 · Tailwind v4 · shadcn/ui |
| `springboot-backend/` | 管理平台 / 业务中枢 | Java 25 · Spring Boot 4.1 · MyBatis-Plus · Flyway |
| `python-backend/` | AI 能力服务（内部） | Python 3.12 · FastAPI · OpenAI / Anthropic SDK |
| `docker-compose.yml` | 本地依赖 | PostgreSQL 17 + pgvector · Redis 7 |

## 环境要求

- Docker Desktop
- JDK 25（无需改全局 `JAVA_HOME`，启动时临时指定即可）
- Python 3.12+ 与 [uv](https://docs.astral.sh/uv/)
- Node.js 22+ 与 pnpm 10

## 快速启动

```bash
# 1. 环境变量：复制后至少修改 JWT_SECRET / MODEL_KEY_SECRET / INTERNAL_TOKEN / ADMIN_PASSWORD
cp .env.example .env
#    生成随机值：openssl rand -base64 48（JWT）、openssl rand -base64 32（MODEL_KEY_SECRET）

# 2. 启动 PostgreSQL 与 Redis
docker compose up -d

# 3. Python AI 服务（端口 8000）
cd python-backend && uv sync && uv run python -m app --port 8000

# 4. Spring 后端（端口取 .env 中的 SERVER_PORT，默认 8080；首次启动自动执行 Flyway 迁移并创建管理员）
cd springboot-backend && JAVA_HOME=/path/to/jdk-25 ./mvnw spring-boot:run

# 5. 前端（端口 3000）
cd web && cp .env.example .env.local && pnpm install && pnpm dev
```

打开 http://localhost:3000，用 `.env` 中的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录，在「管理后台 → 模型配置」中添加模型并测试连通性。

> 第一次在新电脑上部署（含模型下载、国内镜像、手机访问、代理与证书问题）请看 [docs/新电脑部署指南.md](docs/新电脑部署指南.md)。

| 地址 | 说明 |
|---|---|
| http://localhost:3000 | 前端 |
| http://localhost:8080/swagger-ui.html | 接口文档（非生产环境） |
| http://localhost:8080/actuator/health | Spring 健康检查 |
| http://localhost:8000/internal/health | AI 服务健康检查（需请求头 `X-Internal-Token`，不对浏览器开放） |

## 测试

```bash
cd springboot-backend && JAVA_HOME=/path/to/jdk-25 ./mvnw verify   # 依赖 Docker（Testcontainers，仅使用本地镜像）
cd python-backend && uv run ruff check . && uv run pytest              # 依赖 compose 中的 PostgreSQL
cd web && pnpm lint && pnpm typecheck && pnpm build
```

## 常见问题

- **Python 服务在 Windows 上健康检查显示 `db=DOWN`**：psycopg 异步模式不支持 Windows 默认的 ProactorEventLoop。请用 `uv run python -m app` 启动，或给 uvicorn 加 `--loop app.core.event_loop:selector_event_loop`。Linux 无此问题。
- **端口被占用**：
  - 8080 被占用：在 `.env` 中设置 `SERVER_PORT=18080`，并把 `web/.env.local` 中的 `API_PROXY_TARGET` 改为 `http://localhost:18080`，`NEXT_PUBLIC_API_BASE_URL` 留空。
  - 局域网联调：运行 `pnpm dev:lan`（缺省端口 3001，可加 `--port`），访问终端打印的 `https://本机局域网IP:3001`。`NEXT_PUBLIC_API_BASE_URL` 留空，由前端代理连接 `API_PROXY_TARGET` 指定的后端；修改环境变量后重启前端。
    - 手机浏览器只在 HTTPS（或 localhost）下开放麦克风与 AudioWorklet，因此脚本会用 openssl 生成包含本机局域网 IP 的自签名证书（`web/.certificates/`，IP 变化时自动重签），首次打开时在证书警告页选择"高级 → 继续访问"。
    - 仍可用 `pnpm dev --hostname 0.0.0.0 --port 3001` 以 http 访问，但手机无法录音：加入多语会议室时自动以"仅收听"方式进入（可看字幕、听译文），其他同传模式会提示改用 https 地址。
  - 6379 被本机 Redis 占用：compose 默认把 Redis 映射到宿主机 **6380**，`.env` 中的 `REDIS_PORT` 应保持一致。
- **Spring 读取不到 `.env`**：Spring 会从启动目录的上一级导入 `.env`，请在 `springboot-backend/` 目录内启动。
- **Docker Hub 拉取镜像超时**：compose 使用 `pgvector/pgvector:pg17` 与 `redis:7-alpine`，可先通过镜像加速器拉取；Spring 测试同样只使用这两个本地镜像（并已关闭 Ryuk）。
- **已有开发库缺少 pg_trgm 扩展**（V2 迁移需要）：数据卷早于该扩展创建时，执行一次 `docker compose exec postgres psql -U postgres -d xjl_tl -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"`。
- **`uv sync` 下载依赖时 TLS 握手失败**（files.pythonhosted.org 连接不稳定）：可以先用镜像安装缺失的包，例如 `uv pip install --index-url https://mirrors.aliyun.com/pypi/simple lingua-language-detector==2.2.0`，之后用 `uv run --no-sync ...` 运行。
- **修改了 `.env` 中的数据库角色密码**：角色只在数据卷首次初始化时创建，需执行 `docker compose down -v` 重建（会清空数据）。
