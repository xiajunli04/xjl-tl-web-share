"""服务使用的事件循环：SelectorEventLoop + 能扛住 Windows 偶发 WSAENOBUFS 的 selector。

- Windows 上 uvicorn 缺省是 ProactorEventLoop，psycopg 异步模式不支持，所以统一用 SelectorEventLoop；
- Windows 的 select() 在网络栈资源短暂紧张时（如 TUN 模式代理 / VPN、大量连接同时关闭）会抛
  `OSError: [WinError 10055] 由于系统缓冲区空间不足或队列已满…`。asyncio 不处理这个错误，整个服务直接退出
  （2026-10-07 实测：一条同传发言流结束、连接集中关闭时崩溃）。这里把它当作"本轮没有就绪事件"，短暂退避后重试，
  其余错误照常抛出。
"""

import asyncio
import logging
import selectors
import time

log = logging.getLogger("app.core.event_loop")

WSAENOBUFS = 10055
BACKOFF_SECONDS = 0.05
LOG_INTERVAL_SECONDS = 30.0


class ResilientSelector(selectors.DefaultSelector):
    """select() 遇到 WSAENOBUFS 时退避重试，不让事件循环崩溃。"""

    def __init__(self) -> None:
        super().__init__()
        self._suppressed = 0
        self._logged_at = 0.0

    def select(self, timeout: float | None = None):
        try:
            return super().select(timeout)
        except OSError as e:
            if getattr(e, "winerror", None) != WSAENOBUFS:
                raise
            self._suppressed += 1
            now = time.monotonic()
            if now - self._logged_at >= LOG_INTERVAL_SECONDS:
                log.warning("select() 返回 WSAENOBUFS（系统网络缓冲区暂时不足），已退避重试 %d 次", self._suppressed)
                self._logged_at = now
            time.sleep(BACKOFF_SECONDS if timeout is None else min(BACKOFF_SECONDS, max(timeout, 0)))
            return []


def selector_event_loop(*_args, **_kwargs) -> asyncio.AbstractEventLoop:
    """uvicorn 的 loop 工厂（`--loop app.core.event_loop:selector_event_loop`）。"""
    return asyncio.SelectorEventLoop(ResilientSelector())
