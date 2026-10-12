"""出站 HTTPS 的 TLS 上下文。

openai / anthropic SDK 基于 httpx2，缺省用 truststore 校验证书：在 Windows 上它同步调用系统证书链 API
（CertGetCertificateChain），可能联网获取吊销信息与中间证书。网络或代理卡住时，这一步在事件循环线程里阻塞，
整个服务（翻译、同传、语种识别）都会失去响应，连超时都无法触发（2026-10-07 实测：翻译一直"运行中"，
调用栈停在 truststore._windows._get_and_verify_cert_chain）。

这里改用标准库上下文：创建时加载系统根证书（Windows 证书存储）与 certifi 根证书，握手时由 OpenSSL 在本地校验，
不在握手中联网；校验依然严格（主机名与证书链）。
"""

import logging
import ssl
from functools import lru_cache

log = logging.getLogger("app.core.tls")


@lru_cache(maxsize=1)
def ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()  # 系统根证书（Windows 证书存储 / OpenSSL 缺省路径）
    try:
        import certifi

        ctx.load_verify_locations(certifi.where())
    except Exception:  # noqa: BLE001 - certifi 缺失时只用系统根证书
        log.debug("certifi 不可用，只使用系统根证书", exc_info=True)
    return ctx
