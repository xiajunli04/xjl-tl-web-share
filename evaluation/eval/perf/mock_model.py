"""压测前把 mock LLM 注册为平台默认模型，结束后恢复（design D7）。

恢复顺序：先把原默认模型设回默认，再停用 mock 配置。切换前把原默认模型 id 写入
``results/perf/.restore.json``，进程被强制结束时可以执行 ``python -m eval.perf.run restore`` 手动恢复。
"""

from __future__ import annotations

import atexit
import json
import logging
import signal
import threading
from pathlib import Path
from typing import Any

import httpx

from eval.client import PlatformClient
from eval.config import RESULTS_DIR

log = logging.getLogger("eval.perf")

MOCK_NAME = "压测 Mock LLM"
MOCK_HOST = "127.0.0.1"
MOCK_PORT = 9100
MOCK_BASE_URL = f"http://{MOCK_HOST}:{MOCK_PORT}/v1"
MOCK_MODEL_NAME = "mock-llm"
RESTORE_FILE = RESULTS_DIR / "perf" / ".restore.json"


def mock_config_body(enabled: bool = True) -> dict[str, Any]:
    return {
        "name": MOCK_NAME,
        "provider": "OPENAI_COMPATIBLE",
        "baseUrl": MOCK_BASE_URL,
        "modelName": MOCK_MODEL_NAME,
        "apiKey": "mock-key-not-secret",
        "params": {"timeoutSeconds": 60, "maxRetries": 0},
        "remark": "性能测试专用（evaluation/mock_llm），压测结束后自动停用",
        "enabled": enabled,
    }


def find_mock_config(configs: list[dict]) -> dict | None:
    return next((m for m in configs if m.get("name") == MOCK_NAME and m.get("baseUrl") == MOCK_BASE_URL), None)


def ensure_mock_config(admin: PlatformClient) -> dict:
    """返回已启用的 mock 配置；不存在时新建，已停用时重新启用。"""
    mock = find_mock_config(admin.model_configs())
    if mock is None:
        mock = admin.create_model_config(mock_config_body())
        log.info("已注册 mock 模型配置 id=%s", mock["id"])
    elif not mock.get("enabled"):
        admin.set_model_enabled(mock["id"], True)
        log.info("已重新启用 mock 模型配置 id=%s", mock["id"])
    return mock


def mock_alive(timeout: float = 2.0) -> bool:
    try:
        return httpx.get(f"{MOCK_BASE_URL}/models", timeout=timeout).status_code == 200
    except httpx.HTTPError:
        return False


def restore_platform(admin: PlatformClient, original_id: int | None, mock_id: int | None) -> dict:
    """恢复原默认模型并停用 mock 配置；返回恢复后的状态（供报告确认）。"""
    if original_id is not None:
        admin.set_default_model(original_id)
    if mock_id is not None:
        admin.set_model_enabled(mock_id, False)
    configs = admin.model_configs()
    default = next((m for m in configs if m.get("isDefault")), None)
    mock = next((m for m in configs if m["id"] == mock_id), None) if mock_id is not None else None
    state = {
        "defaultId": default["id"] if default else None,
        "mockId": mock_id,
        "mockEnabled": mock.get("enabled") if mock else None,
    }
    if original_id is not None and state["defaultId"] != original_id:
        raise RuntimeError(f"默认模型恢复失败：期望 {original_id}，实际 {state['defaultId']}")
    return state


class MockModelSwitch:
    """上下文管理器：进入时把 mock 设为默认，退出时（含异常、Ctrl+C、atexit）恢复，恢复只执行一次。"""

    def __init__(self, admin: PlatformClient, restore_file: Path = RESTORE_FILE):
        self.admin = admin
        self.restore_file = restore_file
        self.original_id: int | None = None
        self.mock_id: int | None = None
        self.restored_state: dict | None = None
        self._lock = threading.Lock()
        self._done = False
        self._old_handlers: dict[int, Any] = {}

    def __enter__(self) -> MockModelSwitch:
        original = self.admin.default_model_config()
        mock = ensure_mock_config(self.admin)
        self.mock_id = mock["id"]
        if original is not None and original["id"] == self.mock_id:
            # 上次压测异常退出未恢复：从恢复文件读取真正的原默认模型
            original_id = self._read_restore_file()
        else:
            original_id = original["id"] if original else None
        self.original_id = original_id
        self.restore_file.parent.mkdir(parents=True, exist_ok=True)
        self.restore_file.write_text(json.dumps({"originalId": original_id, "mockId": self.mock_id}), encoding="utf-8")
        atexit.register(self.restore)
        self._install_signal_handlers()
        self.admin.set_default_model(self.mock_id)
        log.info("默认模型已切换为 mock（id=%s），原默认 id=%s", self.mock_id, original_id)
        return self

    def __exit__(self, *exc: object) -> None:
        self.restore()

    def _read_restore_file(self) -> int | None:
        if self.restore_file.exists():
            return json.loads(self.restore_file.read_text(encoding="utf-8")).get("originalId")
        return None

    def _install_signal_handlers(self) -> None:
        if threading.current_thread() is not threading.main_thread():
            return
        sigs = [signal.SIGTERM] + ([signal.SIGBREAK] if hasattr(signal, "SIGBREAK") else [])
        for sig in sigs:
            self._old_handlers[sig] = signal.getsignal(sig)

            def handler(signum, frame):
                self.restore()
                raise SystemExit(128 + signum)

            signal.signal(sig, handler)

    def restore(self) -> dict | None:
        with self._lock:
            if self._done:
                return self.restored_state
            self._done = True
        for sig, old in self._old_handlers.items():
            try:
                signal.signal(sig, old)
            except (ValueError, TypeError):
                pass
        last_error: Exception | None = None
        for _ in range(3):
            try:
                self.restored_state = restore_platform(self.admin, self.original_id, self.mock_id)
                self.restore_file.unlink(missing_ok=True)
                log.info("已恢复默认模型 id=%s，mock 配置已停用", self.original_id)
                return self.restored_state
            except Exception as e:  # noqa: BLE001 - 恢复失败必须重试并明确报告
                last_error = e
        log.error("恢复默认模型失败（%s），请执行 python -m eval.perf.run restore", last_error)
        return None


def restore_from_file(admin: PlatformClient, restore_file: Path = RESTORE_FILE) -> dict:
    """手动恢复：读取恢复文件；没有文件时只停用 mock 配置（默认模型保持不变，除非它就是 mock）。"""
    original_id = None
    if restore_file.exists():
        original_id = json.loads(restore_file.read_text(encoding="utf-8")).get("originalId")
    mock = find_mock_config(admin.model_configs())
    state = restore_platform(admin, original_id, mock["id"] if mock else None)
    restore_file.unlink(missing_ok=True)
    return state
