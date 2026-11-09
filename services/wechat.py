"""微信网页授权（OAuth 2.0）。

仅在配置了认证服务号参数时启用：
- WECHAT_APP_ID / WECHAT_APP_SECRET / WECHAT_REDIRECT_URI
- 公众号后台需配置“网页授权域名”，服务器 IP 加入白名单

未配置时不做任何模拟登录，由前端降级为本机匿名身份。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from .api_error import ApiError

AUTHORIZE_URL = "https://open.weixin.qq.com/connect/oauth2/authorize"
TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token"
USERINFO_URL = "https://api.weixin.qq.com/sns/userinfo"


def configured(config) -> bool:
    """只要 AppID + Secret 齐全就算「可尝试授权」。

    回调地址优先用 WECHAT_REDIRECT_URI；没配时按请求的对外域名自动拼，
    避免反向代理下把内网地址写进 redirect_uri（微信会直接回调失败）。
    """
    return bool(config.get("WECHAT_APP_ID") and config.get("WECHAT_APP_SECRET"))


def public_base(config, request) -> str:
    """当前请求的对外基地址（含协议），优先取代理转发头与 PUBLIC_HOSTS。"""
    forwarded_host = (request.headers.get("X-Forwarded-Host") or "").split(",")[0].strip()
    public_hosts = [h.strip() for h in str(config.get("PUBLIC_HOSTS") or "").split(",") if h.strip()]
    host = forwarded_host or (public_hosts[0] if public_hosts else request.host)
    forwarded_proto = (request.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip()
    scheme = forwarded_proto or request.scheme or "https"
    return f"{scheme}://{host}"


def redirect_uri(config, request) -> str:
    configured_uri = (config.get("WECHAT_REDIRECT_URI") or "").strip()
    if configured_uri:
        return configured_uri
    return public_base(config, request).rstrip("/") + "/auth/wechat/callback"


def authorize_url(config, state: str, request=None) -> str:
    if not configured(config):
        raise ApiError("wechat_unconfigured", "微信登录未配置", 501, "请配置公众号 AppID/Secret 与网页授权域名")
    if request is None:
        raise ApiError("wechat_unconfigured", "缺少请求上下文", 501)
    params = {
        "appid": config["WECHAT_APP_ID"],
        "redirect_uri": redirect_uri(config, request),
        "response_type": "code",
        "scope": "snsapi_userinfo",
        "state": state,
    }
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}#wechat_redirect"


def _get_json(url: str, timeout: float = 6.0) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "weekend-eat/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(512 * 1024).decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ApiError("wechat_network", "微信服务暂时不可用", 502) from exc
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ApiError("wechat_bad_response", "微信返回内容异常", 502) from exc
    if payload.get("errcode"):
        raise ApiError("wechat_error", f"微信授权失败（{payload.get('errcode')}）", 502)
    return payload


def exchange_code(config, code: str) -> dict:
    if not configured(config):
        raise ApiError("wechat_unconfigured", "微信登录未配置", 501)
    token_params = {
        "appid": config["WECHAT_APP_ID"],
        "secret": config["WECHAT_APP_SECRET"],
        "code": code,
        "grant_type": "authorization_code",
    }
    token_payload = _get_json(f"{TOKEN_URL}?{urllib.parse.urlencode(token_params)}")
    access_token = token_payload.get("access_token")
    openid = token_payload.get("openid")
    if not access_token or not openid:
        raise ApiError("wechat_error", "微信未返回访问凭证", 502)

    info_params = {"access_token": access_token, "openid": openid, "lang": "zh_CN"}
    profile = _get_json(f"{USERINFO_URL}?{urllib.parse.urlencode(info_params)}")
    profile.setdefault("openid", openid)
    if token_payload.get("unionid") and not profile.get("unionid"):
        profile["unionid"] = token_payload["unionid"]
    return profile


def new_state() -> str:
    import secrets
    return secrets.token_urlsafe(24)
