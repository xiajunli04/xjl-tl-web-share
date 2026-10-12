"""`uv run python -m app [--port 8000]`：强制使用 SelectorEventLoop（见 app.core.event_loop）。

Windows 上 uvicorn 默认 ProactorEventLoop，psycopg 异步模式不支持；selector 还会扛住 Windows 偶发的 WSAENOBUFS。

等价于 `uv run uvicorn app.main:app --loop app.core.event_loop:selector_event_loop`。
"""

import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        loop="app.core.event_loop:selector_event_loop",
    )


if __name__ == "__main__":
    main()
