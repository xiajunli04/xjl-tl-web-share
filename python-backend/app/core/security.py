import hmac

from fastapi import Header

from app.core.config import get_settings
from app.core.errors import BizException, ErrorCode


async def verify_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    """校验 X-Internal-Token（常量时间比较）。未配置 INTERNAL_TOKEN 时一律拒绝。"""
    expected = get_settings().internal_token
    if not x_internal_token or not expected or not hmac.compare_digest(x_internal_token.encode(), expected.encode()):
        raise BizException(ErrorCode.INTERNAL_AUTH_FAILED)
