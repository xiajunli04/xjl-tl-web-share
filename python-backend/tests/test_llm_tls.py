"""出站 TLS（app.core.tls）：SDK 客户端不再使用 httpx2 缺省的 truststore（Windows 上会阻塞事件循环）。"""

import ssl

from app.core.tls import ssl_context
from app.llm.registry import LLMRegistry


def test_ssl_context_is_stdlib_and_strict():
    ctx = ssl_context()
    assert type(ctx) is ssl.SSLContext  # 不是 truststore.SSLContext
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname
    assert ctx.cert_store_stats()["x509_ca"] > 0  # 已加载根证书
    assert ssl_context() is ctx  # 进程内复用


def _ssl_of(client) -> ssl.SSLContext:
    pool = client._transport._pool
    return pool._ssl_context


def test_registry_default_clients_use_stdlib_context():
    registry = LLMRegistry(repo=None, secret_b64="eA==")  # type: ignore[arg-type]
    for provider in ("OPENAI_COMPATIBLE", "ANTHROPIC"):
        client = registry._new_http_client(provider)
        assert _ssl_of(client) is ssl_context()


def test_injected_factory_still_wins():
    marker = object()
    registry = LLMRegistry(repo=None, secret_b64="eA==", http_client_factory=lambda: marker)  # type: ignore[arg-type]
    assert registry._new_http_client("OPENAI_COMPATIBLE") is marker
