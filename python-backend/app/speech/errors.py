"""语音引擎异常。"""

from app.core.errors import BizException, ErrorCode


class SpeechHttpError(BizException):
    """远程语音接口调用失败（C0172 / C0173）；status 为上游 HTTP 状态码，供连通性测试归类错误码。"""

    def __init__(self, error: ErrorCode, message: str, status: int | None = None):
        super().__init__(error, message)
        self.status = status
