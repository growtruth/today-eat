"""API 异常：与 FriendlyError 同源，仅保留旧导入路径。

历史上 api_v1 使用 ApiError(code, message, status)，前台使用
FriendlyError(message, hint, code)。现在统一为一条继承链：
ApiError -> FriendlyError -> Exception，错误处理器只保留一个。
"""

from __future__ import annotations

from .errors import FriendlyError


class ApiError(FriendlyError):
    def __init__(self, code: str, message: str, status: int = 400, hint: str = ""):
        super().__init__(message, hint=hint, code=code, status=status)
