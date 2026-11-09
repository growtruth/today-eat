"""请求生命周期：请求上下文、同源校验、限流、安全头、压缩、缓存与访问日志。

拆成独立模块后，app.py 只保留应用装配，安全策略集中在一处，便于审计。
"""

from __future__ import annotations

import gzip
import secrets
import time
import uuid
from urllib.parse import urlparse

from flask import current_app, g, jsonify, request

from .api_error import ApiError

# 只压缩文本型响应；图片已经是压缩格式，再压反而浪费 CPU
_COMPRESSIBLE = (
    "text/",
    "application/json",
    "application/javascript",
    "application/xml",
    "image/svg+xml",
)
_MIN_COMPRESS_BYTES = 1024


def _candidate_hosts() -> set:
    """收集「本站可能的对外主机名」。

    容器/网关会把 Host 改写成内网地址（如 8000-xxx.sandbox...），
    浏览器发来的 Origin 却是公网域名，直接比 request.host 会把正常请求判成跨站。
    """
    raw = [request.host, request.headers.get("X-Forwarded-Host", "")]
    raw.extend((current_app.config.get("PUBLIC_HOSTS") or "").split(","))
    hosts = set()
    for value in raw:
        for part in str(value or "").split(","):
            part = part.strip().lower()
            if not part:
                continue
            hosts.add(part)
            hosts.add(part.split(":")[0])  # 端口不同不算跨站
    return hosts


def _same_origin(origin: str) -> bool:
    """Origin 是否属于本站。代理场景下用 X-Forwarded-Host / PUBLIC_HOSTS 兜底。"""
    netloc = (urlparse(origin).netloc or "").lower()
    if not netloc:
        return True
    hosts = _candidate_hosts()
    if netloc in hosts or netloc.split(":")[0] in hosts:
        return True
    # 浏览器自己写的 Sec-Fetch-Site 无法被页面脚本伪造，同源请求可以放行
    fetch_site = (request.headers.get("Sec-Fetch-Site") or "").lower()
    return fetch_site in ("same-origin", "none")


def install(app) -> None:
    limiter = app.extensions["limiter"]

    @app.before_request
    def _prepare_request():
        g.csp_nonce = secrets.token_urlsafe(16)
        g.request_id = request.headers.get("X-Request-Id") or uuid.uuid4().hex[:12]
        g.started_at = time.perf_counter()

        # 写操作做同源校验（SameSite=Lax 之外的第二道闸）
        if request.method in ("POST", "PATCH", "DELETE"):
            origin = request.headers.get("Origin")
            if origin and not _same_origin(origin):
                raise ApiError("cross_origin", "跨站请求被拒绝", 403)

        if not request.path.startswith("/api/"):
            return None

        limit = current_app.config["RATE_LIMIT_PER_MINUTE"]
        demo_mode = not (
            current_app.config["AMAP_WEB_KEY"] or current_app.config["BAIDU_WEB_AK"]
        )
        # 搜索接口的更严限流是为了保护付费地图配额；演示模式没有上游配额，不额外收紧
        if request.path == "/api/restaurants" and not demo_mode:
            limit = current_app.config["SEARCH_RATE_LIMIT_PER_MINUTE"]
        if limit <= 0:
            return None

        client = request.remote_addr or "unknown"
        allowed, retry_after = limiter.allow(client, limit)
        if allowed:
            return None

        response = jsonify({
            "ok": False,
            "message": "请求有点频繁，歇一会儿再试",
            "hint": f"{retry_after} 秒后自动恢复",
            "code": "rate_limited",
            "requestId": g.request_id,
        })
        response.status_code = 429
        response.headers["Retry-After"] = str(retry_after)
        return response

    @app.after_request
    def _security_and_cache(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault(
            "Permissions-Policy", "geolocation=(self), camera=(), microphone=(), payment=()"
        )
        response.headers.setdefault("X-Request-Id", getattr(g, "request_id", ""))

        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        elif request.path.startswith("/static/"):
            if request.args.get("v"):
                response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            else:
                response.headers.setdefault("Cache-Control", "public, max-age=3600")

        if current_app.config["CSP_ENABLED"]:
            script_src = f"'self' 'nonce-{getattr(g, 'csp_nonce', '')}'"
            if current_app.config["AMAP_JS_KEY"]:
                # 地图 SDK 由 webapi.amap.com 加载，并按需创建脚本/worker
                script_src += " https://webapi.amap.com https://*.amap.com 'unsafe-eval'"
            response.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; "
                f"script-src {script_src}; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob: https:; "
                "font-src 'self' data:; "
                "connect-src 'self' https:; "
                "worker-src 'self' blob:; "
                "frame-src 'self' https://*.amap.com; "
                "frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
            )
        return response

    @app.after_request
    def _compress(response):
        """对 HTML/CSS/JS/JSON 做 gzip，移动网络下通常能省 60% 以上。"""
        if request.method == "HEAD" or not 200 <= response.status_code < 300:
            return response
        if response.headers.get("Content-Encoding"):
            return response
        if "gzip" not in (request.headers.get("Accept-Encoding") or "").lower():
            return response

        mime = response.mimetype or ""
        if not (mime.startswith(_COMPRESSIBLE[0]) or mime in _COMPRESSIBLE[1:]):
            return response

        # 静态文件默认 direct_passthrough，需要读入内存后才能压缩
        if response.direct_passthrough:
            response.direct_passthrough = False

        try:
            data = response.get_data()
        except RuntimeError:
            return response
        if len(data) < _MIN_COMPRESS_BYTES:
            return response

        packed = gzip.compress(data, compresslevel=6)
        if len(packed) >= len(data) * 0.95:
            return response

        response.set_data(packed)
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Content-Length"] = str(len(packed))
        response.headers.add("Vary", "Accept-Encoding")
        return response

    @app.after_request
    def _access_log(response):
        if not request.path.startswith("/api/") or app.testing:
            return response
        started = getattr(g, "started_at", None)
        cost = (time.perf_counter() - started) * 1000 if started else 0
        app.logger.info(
            "api %s %s -> %s %.1fms rid=%s",
            request.method,
            request.path,
            response.status_code,
            cost,
            getattr(g, "request_id", ""),
        )
        return response
