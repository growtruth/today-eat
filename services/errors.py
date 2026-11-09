"""统一异常定义。

对前端只暴露人话文案与稳定错误码，堆栈一律只记录在服务端日志。
ApiError 是 FriendlyError 的子类，两者共用同一套错误响应。
"""

STATUS_BY_CODE = {
    "friendly": 400,
    "bad_request": 400,
    "invalid_param": 400,
    "not_found": 404,
    "rate_limited": 429,
    "server_error": 500,
    "not_implemented": 501,
    "upstream_error": 502,
}


class FriendlyError(Exception):
    """可直接展示给用户的错误。"""

    def __init__(self, message: str, hint: str = "", code: str = "friendly", status: int | None = None):
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.code = code
        self.status = status or STATUS_BY_CODE.get(code, 400)

    def to_dict(self, request_id: str = "") -> dict:
        payload = {"ok": False, "message": self.message, "code": self.code}
        if self.hint:
            payload["hint"] = self.hint
        if request_id:
            payload["requestId"] = request_id
        return payload


class ProviderError(Exception):
    """单个数据源内部的失败（Key 缺失、超时、限流、返回空等）。

    由 DataService 捕获并切换到下一个数据源，不会直接到达前端。
    """

    def __init__(self, provider: str, reason: str, retryable: bool = True):
        super().__init__(f"[{provider}] {reason}")
        self.provider = provider
        self.reason = reason
        self.retryable = retryable
