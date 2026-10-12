"""平台黑盒客户端：通过 Spring 对外接口驱动平台（design D1）。

- 统一解包 `{code, message, data, traceId}`，失败抛出 PlatformError
- 访问令牌过期（A0230）时用刷新令牌续期一次；令牌无效或刷新失败（A0231 / A0232）时重新登录一次
- 同步实现（httpx.Client），并发由调用方用线程池控制；单个实例不保证线程安全，每个线程各建一个实例
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

import httpx

from eval.config import EvalConfig, get_config

TERMINAL_STATUSES = {"COMPLETED", "FAILED", "CANCELLED"}


class PlatformError(Exception):
    def __init__(self, code: str, message: str, status: int = 0, trace_id: str | None = None, data: Any = None):
        super().__init__(f"[{code}] {message} (HTTP {status}, traceId={trace_id})")
        self.code = code
        self.message = message
        self.status = status
        self.trace_id = trace_id
        self.data = data


@dataclass
class StreamResult:
    """一次短文本流式翻译的结果。"""

    events: list[tuple[str, dict]] = field(default_factory=list)
    final: dict | None = None
    error: dict | None = None
    clarify: dict | None = None  # 以 clarify 结束：等待用户回答歧义追问
    ttfe_ms: float | None = None  # 首个事件到达时间（time to first event）
    total_ms: float | None = None

    @property
    def ok(self) -> bool:
        return self.final is not None


def parse_sse_lines(lines: Iterator[str]) -> Iterator[tuple[str, str]]:
    """按 SSE 规范切分事件：字段名后的冒号之后有一个可选空格；以冒号开头的行是注释（心跳）。"""
    event, data = "message", []
    for raw in lines:
        line = raw.rstrip("\r")
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "message", []
            continue
        if line.startswith(":"):
            continue
        name, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if name == "event":
            event = value
        elif name == "data":
            data.append(value)
    if data:
        yield event, "\n".join(data)


class PlatformClient:
    def __init__(
        self,
        base_url: str | None = None,
        username: str | None = None,
        password: str | None = None,
        timeout: float | None = None,
        config: EvalConfig | None = None,
    ) -> None:
        cfg = config or get_config()
        self.base_url = (base_url or cfg.base_url).rstrip("/")
        self.username = username or cfg.username
        self.password = password if password is not None else cfg.password
        self.timeout = timeout or cfg.request_timeout
        self._http = httpx.Client(base_url=self.base_url, timeout=self.timeout)
        self._access: str | None = None
        self._refresh: str | None = None

    # ------------------------------------------------------------------ 基础

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> PlatformClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @staticmethod
    def _unwrap(resp: httpx.Response) -> Any:
        try:
            body = resp.json()
        except ValueError as e:
            raise PlatformError("B0001", f"非 JSON 响应：{resp.text[:200]}", resp.status_code) from e
        code = str(body.get("code", ""))
        if code != "00000":
            raise PlatformError(code, body.get("message", ""), resp.status_code, body.get("traceId"), body.get("data"))
        return body.get("data")

    def login(self) -> dict:
        resp = self._http.post("/api/auth/login", json={"username": self.username, "password": self.password})
        data = self._unwrap(resp)
        self._access, self._refresh = data["accessToken"], data["refreshToken"]
        return data

    def _refresh_tokens(self) -> bool:
        if not self._refresh:
            return False
        try:
            data = self._unwrap(self._http.post("/api/auth/refresh", json={"refreshToken": self._refresh}))
        except PlatformError:
            return False
        self._access, self._refresh = data["accessToken"], data["refreshToken"]
        return True

    def _headers(self) -> dict[str, str]:
        if self._access is None:
            self.login()
        return {"Authorization": f"Bearer {self._access}"}

    def request(self, method: str, path: str, *, auth: bool = True, **kwargs: Any) -> Any:
        """发送请求并解包；令牌问题自动续期或重新登录一次。"""
        for attempt in range(2):
            headers = {**kwargs.pop("headers", {}), **(self._headers() if auth else {})}
            resp = self._http.request(method, path, headers=headers, **kwargs)
            try:
                return self._unwrap(resp)
            except PlatformError as e:
                if not auth or attempt == 1 or e.code not in ("A0230", "A0231", "A0232"):
                    raise
                if e.code == "A0230" and self._refresh_tokens():
                    continue
                self.login()
        raise AssertionError("unreachable")

    # ------------------------------------------------------------------ 账号

    def register(self, username: str, password: str, nickname: str | None = None) -> dict:
        body = {"username": username, "password": password, "nickname": nickname or username}
        return self.request("POST", "/api/auth/register", auth=False, json=body)

    # ------------------------------------------------------------------ 模型配置（管理员）

    def model_configs(self) -> list[dict]:
        page = self.request("GET", "/api/admin/model-configs", params={"pageNum": 1, "pageSize": 100})
        return page["records"]

    def default_model_config(self) -> dict | None:
        return next((m for m in self.model_configs() if m.get("isDefault")), None)

    def create_model_config(self, body: dict) -> dict:
        return self.request("POST", "/api/admin/model-configs", json=body)

    def set_default_model(self, config_id: int) -> None:
        self.request("PUT", f"/api/admin/model-configs/{config_id}/default")

    def set_model_enabled(self, config_id: int, enabled: bool) -> None:
        self.request("PUT", f"/api/admin/model-configs/{config_id}/enabled", json={"enabled": enabled})

    # ------------------------------------------------------------------ 文档任务

    def create_doc_task(
        self,
        text: str,
        *,
        title: str,
        target_lang: str = "zh",
        source_lang: str = "auto",
        fmt: str = "md",
        style: str = "faithful",
        strategy: str = "serial",
        options: dict | None = None,
        confirm_terms: bool = False,
        model_config_id: int | None = None,
        glossary_ids: list[int] | None = None,
        domain: str | None = None,
        review_model_config_id: int | None = None,
    ) -> dict:
        body: dict[str, Any] = {
            "title": title,
            "text": text,
            "format": fmt,
            "sourceLang": source_lang,
            "targetLang": target_lang,
            "style": style,
            "strategy": strategy,
            "confirmTerms": confirm_terms,
            "glossaryIds": glossary_ids or [],
        }
        if options is not None:
            body["options"] = options
        if model_config_id is not None:
            body["modelConfigId"] = model_config_id
        if domain:
            body["domain"] = domain
        if review_model_config_id is not None:
            body["reviewModelConfigId"] = review_model_config_id
        return self.request("POST", "/api/doc-tasks", json=body)

    def doc_task(self, task_id: int) -> dict:
        return self.request("GET", f"/api/doc-tasks/{task_id}")

    def doc_segments(self, task_id: int) -> list[dict]:
        return self.request("GET", f"/api/doc-tasks/{task_id}/segments")

    def doc_traces(self, task_id: int) -> list[dict]:
        return self.request("GET", f"/api/doc-tasks/{task_id}/traces")

    def doc_terms(self, task_id: int) -> list[dict]:
        return self.request("GET", f"/api/doc-tasks/{task_id}/terms")

    def confirm_doc_terms(self, task_id: int, terms: list[dict]) -> list[dict]:
        """terms：[{id, source, target, status}]；未出现在列表中的待确认术语视为拒绝。"""
        return self.request("POST", f"/api/doc-tasks/{task_id}/terms/confirm", json={"terms": terms})

    def retry_doc_task(self, task_id: int) -> dict:
        return self.request("POST", f"/api/doc-tasks/{task_id}/retry")

    def cancel_doc_task(self, task_id: int) -> dict:
        return self.request("POST", f"/api/doc-tasks/{task_id}/cancel")

    def wait_doc_task(
        self,
        task_id: int,
        *,
        timeout: float | None = None,
        poll: float | None = None,
        on_progress: Callable[[dict], None] | None = None,
        until: set[str] | None = None,
    ) -> dict:
        """轮询直到任务进入终结状态（或 until 中的状态），返回此时的任务详情；超时抛出 TimeoutError。"""
        cfg = get_config()
        deadline = time.monotonic() + (timeout or cfg.task_timeout)
        interval = poll or cfg.poll_interval
        while True:
            task = self.doc_task(task_id)
            if on_progress:
                on_progress(task)
            if task["status"] in TERMINAL_STATUSES or (until and task["status"] in until):
                return task
            if time.monotonic() > deadline:
                raise TimeoutError(f"文档任务 {task_id} 超时，当前状态 {task['status']}")
            time.sleep(interval)

    # ------------------------------------------------------------------ 短文本流式翻译

    def translate_stream(
        self,
        text: str,
        *,
        target_lang: str = "zh",
        source_lang: str = "auto",
        mode: str = "auto",
        style: str = "faithful",
        model_config_id: int | None = None,
        glossary_ids: list[int] | None = None,
        review_model_config_id: int | None = None,
        session_id: int | None = None,
        timeout: float = 240.0,
    ) -> StreamResult:
        body: dict[str, Any] = {
            "text": text,
            "sourceLang": source_lang,
            "targetLang": target_lang,
            "mode": mode,
            "style": style,
            "glossaryIds": glossary_ids or [],
        }
        if model_config_id is not None:
            body["modelConfigId"] = model_config_id
        if review_model_config_id is not None:
            body["reviewModelConfigId"] = review_model_config_id
        if session_id is not None:
            body["sessionId"] = session_id
        return self._stream("/api/translate/stream", body, timeout)

    def _stream(self, path: str, body: dict[str, Any], timeout: float = 240.0) -> StreamResult:
        """POST 一个事件流接口并收集事件；令牌问题续期后重试一次。"""
        result = StreamResult()
        for attempt in range(2):
            started = time.perf_counter()
            headers = {**self._headers(), "Accept": "text/event-stream"}
            stream = self._http.stream("POST", path, json=body, headers=headers, timeout=timeout)
            with stream as resp:
                ctype = resp.headers.get("content-type", "")
                if resp.status_code != 200 or "text/event-stream" not in ctype:
                    resp.read()
                    try:
                        self._unwrap(resp)
                    except PlatformError as e:
                        if attempt == 0 and e.code in ("A0230", "A0231", "A0232"):
                            if not (e.code == "A0230" and self._refresh_tokens()):
                                self.login()
                            continue
                        raise
                    raise PlatformError("B0001", f"非事件流响应 {resp.status_code}", resp.status_code)
                for event, data in parse_sse_lines(resp.iter_lines()):
                    if result.ttfe_ms is None:
                        result.ttfe_ms = (time.perf_counter() - started) * 1000
                    payload = json.loads(data) if data else {}
                    result.events.append((event, payload))
                    if event == "final":
                        result.final = payload
                    elif event == "error":
                        result.error = payload
                    elif event == "clarify":
                        result.clarify = payload
                result.total_ms = (time.perf_counter() - started) * 1000
                return result
        raise AssertionError("unreachable")

    # ------------------------------------------------------------------ 翻译会话（add-session-context-and-memory）

    def create_session(self, *, target_lang: str = "zh", source_lang: str = "auto", **kw: Any) -> dict:
        """kw：title / style / domain / glossaryIds / modelConfigId / clarifyEnabled（驼峰键名，原样提交）。"""
        body = {"sourceLang": source_lang, "targetLang": target_lang, **kw}
        return self.request("POST", "/api/translate/sessions", json=body)

    def session(self, session_id: int) -> dict:
        return self.request("GET", f"/api/translate/sessions/{session_id}")

    def delete_session(self, session_id: int) -> None:
        self.request("DELETE", f"/api/translate/sessions/{session_id}")

    def revise_stream(self, session_id: int, record_id: int, instruction: str, timeout: float = 240.0) -> StreamResult:
        body = {"recordId": record_id, "instruction": instruction}
        return self._stream(f"/api/translate/sessions/{session_id}/revise", body, timeout)

    def clarify_stream(self, session_id: int, thread_id: str, answer: str, timeout: float = 240.0) -> StreamResult:
        body = {"threadId": thread_id, "answer": answer}
        return self._stream(f"/api/translate/sessions/{session_id}/clarify", body, timeout)

    # ------------------------------------------------------------------ 翻译记忆

    def tm_entries(self, *, page_num: int = 1, page_size: int = 100, **filters: Any) -> dict:
        params = {"pageNum": page_num, "pageSize": page_size, **{k: v for k, v in filters.items() if v}}
        return self.request("GET", "/api/tm", params=params)

    def tm_delete(self, entry_id: int) -> None:
        self.request("DELETE", f"/api/tm/{entry_id}")

    def tm_clear(self) -> int:
        """删除当前用户的全部翻译记忆，返回删除条数。"""
        removed = 0
        while True:
            page = self.tm_entries(page_size=100)
            records = page.get("records") or []
            if not records:
                return removed
            for r in records:
                self.tm_delete(r["id"])
                removed += 1

    def doc_task_memory(self, task_id: int) -> int:
        """把已完成文档任务的译文写入翻译记忆，返回写入条数。"""
        return int(self.request("POST", f"/api/doc-tasks/{task_id}/memory")["written"])

    # ------------------------------------------------------------------ 术语库

    def ensure_glossary(self, name: str, source_lang: str, target_lang: str, terms: list[tuple[str, str]]) -> int:
        """按名称查找当前用户的术语库，不存在则创建；补齐缺失的术语（已存在的 A0112 忽略），返回术语库 id。"""
        page = self.request("GET", "/api/glossaries", params={"keyword": name, "pageSize": 100})
        found = next((g for g in page.get("records") or [] if g["name"] == name), None)
        if found is None:
            found = self.request("POST", "/api/glossaries", json={
                "name": name, "sourceLang": source_lang, "targetLang": target_lang, "description": "评测用术语库"})
        gid = int(found["id"])
        for src, tgt in terms:
            try:
                self.request("POST", f"/api/glossaries/{gid}/terms", json={"sourceTerm": src, "targetTerm": tgt})
            except PlatformError as e:
                if e.code != "A0112":
                    raise
        return gid

    # ------------------------------------------------------------------ 图片翻译（add-speech-and-image-translation）

    def image_translate_stream(
        self,
        image_path: str,
        *,
        target_lang: str,
        source_lang: str = "auto",
        engine: str = "vision",
        model_config_id: int | None = None,
        glossary_ids: list[int] | None = None,
        timeout: float = 240.0,
    ) -> StreamResult:
        """multipart 提交图片并收集 SSE 事件（done 事件放在 result.final）。"""
        data: dict[str, Any] = {"sourceLang": source_lang, "targetLang": target_lang, "engine": engine}
        if model_config_id is not None:
            data["modelConfigId"] = str(model_config_id)
        if glossary_ids:
            data["glossaryIds"] = [str(g) for g in glossary_ids]  # 同名字段重复提交
        mime = "image/png" if image_path.lower().endswith(".png") else "image/jpeg"
        result = StreamResult()
        for attempt in range(2):
            started = time.perf_counter()
            with open(image_path, "rb") as fh:
                files = {"image": (image_path.replace("\\", "/").rsplit("/", 1)[-1], fh, mime)}
                headers = {**self._headers(), "Accept": "text/event-stream"}
                with self._http.stream("POST", "/api/image-translations", data=data, files=files,
                                       headers=headers, timeout=timeout) as resp:
                    ctype = resp.headers.get("content-type", "")
                    if resp.status_code != 200 or "text/event-stream" not in ctype:
                        resp.read()
                        try:
                            self._unwrap(resp)
                        except PlatformError as e:
                            if attempt == 0 and e.code in ("A0230", "A0231", "A0232"):
                                if not (e.code == "A0230" and self._refresh_tokens()):
                                    self.login()
                                continue
                            raise
                        raise PlatformError("B0001", f"非事件流响应 {resp.status_code}", resp.status_code)
                    for event, payload_text in parse_sse_lines(resp.iter_lines()):
                        if result.ttfe_ms is None:
                            result.ttfe_ms = (time.perf_counter() - started) * 1000
                        payload = json.loads(payload_text) if payload_text else {}
                        result.events.append((event, payload))
                        if event == "done":
                            result.final = payload
                        elif event == "error":
                            result.error = payload
                    result.total_ms = (time.perf_counter() - started) * 1000
                    return result
        raise AssertionError("unreachable")

