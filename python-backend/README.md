# 译桥 · LinguaBridge · AI 服务

AI 服务（FastAPI）。配置读取仓库根目录 `.env`，或直接读取环境变量。

```bash
uv sync
uv run python -m app --port 8000
# 或：uv run uvicorn app.main:app --port 8000 --loop app.core.event_loop:selector_event_loop
```

Windows 注意：uvicorn 默认使用 ProactorEventLoop，而 psycopg 异步模式不支持它，
直接 `uvicorn app.main:app` 能启动但健康检查中 db 会是 DOWN。请用上面两种方式之一启动
（也可设置环境变量 `UVICORN_LOOP=app.core.event_loop:selector_event_loop`）。Linux/macOS 无此问题。

```bash
uv run ruff check . && uv run pytest
```

测试需要本地 docker compose 中的 PostgreSQL（localhost:5432，超级用户 postgres），会自动创建测试库 `xjl_tl_pytest`。
