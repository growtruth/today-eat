"""WorkBuddy 账号登录：服务端校验云会话 token。

为什么要在服务端校验：
- 前端拿到的 access_token 只能证明「浏览器里有个会话」，不能直接当成用户身份；
- 必须带 publishableKey 调云端 `/v1/user/me`，由云端确认 token 有效并返回用户，
  再据此建立本站会话，避免有人伪造 uid 直接登录别人的账号。

云端接口：`{CLOUD_ENDPOINT}/.cloud/auth/v1/user/me`
（SDK 把所有接口挂在 `/.cloud` 下，auth 前缀再加 `/v1`）
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from .api_error import ApiError

TIMEOUT = 8


def configured(config) -> bool:
    return bool(config.get("CLOUD_ENDPOINT") and config.get("CLOUD_PUBLISHABLE_KEY"))


def verify_token(config, token: str) -> dict:
    """校验云会话 token，返回 {uid, email, name, avatar}；失败抛 ApiError。"""
    if not configured(config):
        raise ApiError("cloud_unconfigured", "账号登录未配置", 501, "缺少 CLOUD_ENDPOINT / CLOUD_PUBLISHABLE_KEY")
    token = (token or "").strip()
    if not token or len(token) > 4096:
        raise ApiError("invalid_token", "登录凭证无效，请重新登录", 400)

    endpoint = str(config["CLOUD_ENDPOINT"]).rstrip("/")
    request = urllib.request.Request(
        endpoint + "/.cloud/auth/v1/user/me",
        headers={
            "Accept": "application/json",
            "x-wb-webapp-access-key": str(config["CLOUD_PUBLISHABLE_KEY"]),
            "Authorization": "Bearer " + token,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            raw = response.read(256 * 1024).decode("utf-8", errors="replace")
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read(64 * 1024).decode("utf-8", errors="replace")
        status = exc.code
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ApiError("cloud_network", "账号服务暂时不可用，先用本机身份吧", 502) from exc

    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        raise ApiError("cloud_bad_response", "账号服务返回内容异常", 502) from exc

    if payload.get("error") or payload.get("code") in ("UNAUTHENTICATED", "invalid_grant"):
        raise ApiError("cloud_auth_failed", "登录已过期，请重新登录", 401)
    if status >= 400:
        raise ApiError("cloud_auth_failed", "账号登录失败，请重试", 401)

    user = payload.get("user") or (payload.get("data") or {}).get("user") or payload
    uid = str(user.get("id") or user.get("user_id") or user.get("sub") or "").strip()
    if not uid:
        raise ApiError("cloud_auth_failed", "账号信息不完整，请重试", 502)

    return {
        "uid": uid[:64],
        "email": str(user.get("email") or "")[:120],
        "name": str(user.get("name") or user.get("nickname") or "")[:20],
        "avatar": str(user.get("avatar") or user.get("picture") or "")[:300],
    }
