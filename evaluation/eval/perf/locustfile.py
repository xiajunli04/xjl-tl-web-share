"""Locust 压测场景（design D7）。由 ``eval/perf/run.py`` 以 headless 模式调用，也可以单独运行：

    uv run --no-sync locust -f eval/perf/locustfile.py --headless -u 10 -r 10 -t 15s
        --host http://localhost:18080 RestUser   （实际执行时写在同一行）

- RestUser：登录后循环请求翻译历史分页、术语库列表、文档任务列表
- StreamUser：``/api/translate/stream``（mode=fast），以自定义事件上报首事件时间（TTFE）与完成时间
  （每个用户按固定节拍发请求，避免触发每用户每分钟 20 次的翻译限流）

每个虚拟用户使用独立账号 ``{PERF_USER_PREFIX}{i}``（i 从 PERF_USER_OFFSET 起递增，账号由 run.py 预先注册）。
文档任务吞吐场景见 ``eval/perf/doc_throughput.py``。
"""

from __future__ import annotations

import itertools
import json
import os
import random
import threading
import time

from locust import HttpUser, between, constant_pacing, events, task

USER_PREFIX = os.environ.get("PERF_USER_PREFIX", "perf_user_")
PASSWORD = os.environ.get("PERF_PASSWORD", "Perf123456")
USER_OFFSET = int(os.environ.get("PERF_USER_OFFSET", 0))
REST_WAIT_MIN = float(os.environ.get("PERF_REST_WAIT_MIN", 0.5))
REST_WAIT_MAX = float(os.environ.get("PERF_REST_WAIT_MAX", 1.5))
# 每用户每分钟最多 20 次翻译：3.2 秒一个请求，60 秒窗口内最多 19 次
STREAM_PACING = float(os.environ.get("PERF_STREAM_PACING", 3.2))

SAMPLE_TEXTS = (
    "Machine translation has come a long way in the last decade.",
    "Please restart the service after updating the configuration file.",
    "The meeting has been moved to Thursday afternoon.",
    "Large language models can translate whole documents with consistent terminology.",
    "Kubernetes schedules pods onto nodes based on available resources.",
)

_counter = itertools.count(USER_OFFSET)
_counter_lock = threading.Lock()


def next_username() -> str:
    with _counter_lock:
        return f"{USER_PREFIX}{next(_counter)}"


class PlatformUser(HttpUser):
    abstract = True

    def on_start(self) -> None:
        self.username = next_username()
        with self.client.post(
            "/api/auth/login",
            json={"username": self.username, "password": PASSWORD},
            name="/api/auth/login",
            catch_response=True,
        ) as resp:
            body = _json(resp)
            if body.get("code") != "00000":
                resp.failure(f"登录失败 {self.username}: {body.get('code')} {body.get('message')}")
                self.token = None
                return
            self.token = body["data"]["accessToken"]

    @property
    def auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def get_api(self, path: str, name: str) -> None:
        with self.client.get(path, headers=self.auth, name=name, catch_response=True) as resp:
            body = _json(resp)
            if resp.status_code != 200 or body.get("code") != "00000":
                resp.failure(f"HTTP {resp.status_code} {body.get('code')}")


def _json(resp) -> dict:
    try:
        body = resp.json()
        return body if isinstance(body, dict) else {}
    except ValueError:
        return {}


class RestUser(PlatformUser):
    wait_time = between(REST_WAIT_MIN, REST_WAIT_MAX)

    @task
    def history(self) -> None:
        self.get_api("/api/translations?pageNum=1&pageSize=10", "GET /api/translations")

    @task
    def glossaries(self) -> None:
        self.get_api("/api/glossaries?pageNum=1&pageSize=10", "GET /api/glossaries")

    @task
    def doc_tasks(self) -> None:
        self.get_api("/api/doc-tasks?pageNum=1&pageSize=10", "GET /api/doc-tasks")


class StreamUser(PlatformUser):
    wait_time = constant_pacing(STREAM_PACING)

    def _report(self, name: str, ms: float, exc: Exception | None = None) -> None:
        events.request.fire(
            request_type="SSE",
            name=name,
            response_time=ms,
            response_length=0,
            exception=exc,
            context={},
        )

    @task
    def translate_fast(self) -> None:
        body = {
            "text": random.choice(SAMPLE_TEXTS),
            "sourceLang": "auto",
            "targetLang": "zh",
            "mode": "fast",
            "style": "faithful",
            "glossaryIds": [],
        }
        headers = {**self.auth, "Accept": "text/event-stream"}
        started = time.perf_counter()
        ttfe = None
        event = None
        outcome: str | None = None
        with self.client.post(
            "/api/translate/stream",
            json=body,
            headers=headers,
            stream=True,
            name="POST /api/translate/stream (headers)",
            catch_response=True,
        ) as resp:
            ctype = resp.headers.get("content-type", "")
            if resp.status_code != 200 or "text/event-stream" not in ctype:
                b = _json(resp)
                resp.failure(f"HTTP {resp.status_code} {b.get('code')} {b.get('message')}")
                self._report("translate total", (time.perf_counter() - started) * 1000, RuntimeError("非事件流"))
                return
            try:
                for raw in resp.iter_lines(decode_unicode=True):
                    line = (raw or "").rstrip("\r")
                    if not line or line.startswith(":"):
                        continue
                    if ttfe is None:
                        ttfe = (time.perf_counter() - started) * 1000
                    name, _, value = line.partition(":")
                    value = value[1:] if value.startswith(" ") else value
                    if name == "event":
                        event = value
                    elif name == "data" and event in ("final", "error"):
                        outcome = event if event == "final" else f"error {json.loads(value or '{}').get('code')}"
                        break
            except Exception as e:  # 连接中断等
                outcome = f"stream broken: {type(e).__name__}"
            resp.success()
        total = (time.perf_counter() - started) * 1000
        if ttfe is not None:
            self._report("translate TTFE", ttfe)
        exc = None if outcome == "final" else RuntimeError(outcome or "未收到 final 事件")
        self._report("translate total", total, exc)
