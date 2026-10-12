"""服务事件循环（app.core.event_loop）：Windows 偶发 WSAENOBUFS 时不退出，其余错误照常抛出。"""

import asyncio
import selectors

import pytest

from app.core import event_loop
from app.core.event_loop import WSAENOBUFS, ResilientSelector, selector_event_loop


def _winerror(code: int) -> OSError:
    e = OSError(code, "boom")
    e.winerror = code  # Windows 上 OSError 带 winerror；测试中手动补上
    return e


def test_wsaenobufs_is_swallowed(monkeypatch):
    sel = ResilientSelector()
    calls = []

    def boom(self, timeout=None):
        calls.append(timeout)
        raise _winerror(WSAENOBUFS)

    monkeypatch.setattr(selectors.DefaultSelector, "select", boom)
    monkeypatch.setattr(event_loop.time, "sleep", lambda s: None)
    assert sel.select(0.5) == []
    assert sel.select(None) == []
    assert len(calls) == 2 and sel._suppressed == 2


def test_other_errors_still_raise(monkeypatch):
    sel = ResilientSelector()

    def boom(self, timeout=None):
        raise _winerror(10054)

    monkeypatch.setattr(selectors.DefaultSelector, "select", boom)
    with pytest.raises(OSError):
        sel.select(0.1)


def test_loop_keeps_running_after_transient_error(monkeypatch):
    """事件循环里出现一次 WSAENOBUFS 后，任务仍能正常完成。"""
    loop = selector_event_loop()
    original = selectors.DefaultSelector.select
    state = {"failed": False}

    def flaky(self, timeout=None):
        if not state["failed"]:
            state["failed"] = True
            raise _winerror(WSAENOBUFS)
        return original(self, timeout)

    monkeypatch.setattr(selectors.DefaultSelector, "select", flaky)
    try:
        assert isinstance(loop, asyncio.SelectorEventLoop)
        assert loop.run_until_complete(asyncio.sleep(0.01, result="ok")) == "ok"
        assert state["failed"]
    finally:
        loop.close()
