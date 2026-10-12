"""openai / anthropic SDK 使用 httpx2，respx 只拦截 httpx。

这里提供一个 httpx2 传输层，把请求转换为 httpx.Request 交给当前激活的 respx 路由（respx.mock），
再把 httpx.Response 转回 httpx2.Response；respx side_effect 抛出的 httpx 异常转成同名 httpx2 异常。
"""

import httpx
import httpx2
import respx


async def _handler(request: httpx2.Request) -> httpx2.Response:
    body = await request.aread()
    req = httpx.Request(request.method, str(request.url), headers=list(request.headers.raw), content=body)
    try:
        resp = await respx.mock.async_handler(req)
    except httpx.HTTPError as e:
        exc_cls = getattr(httpx2, type(e).__name__, httpx2.TransportError)
        raise exc_cls(str(e)) from None
    content = await resp.aread()
    return httpx2.Response(resp.status_code, headers=list(resp.headers.raw), content=content)


def make_http_client() -> httpx2.AsyncClient:
    return httpx2.AsyncClient(transport=httpx2.MockTransport(_handler))
