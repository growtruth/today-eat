"""应用装配：配置、扩展、蓝图、错误处理。

app.py 只保留入口与兼容别名；页面/接口/安全策略各自在独立模块中。
"""

from __future__ import annotations

import logging
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

from config import Config

from . import db as db_module
from .api_v1 import bp as api_v1_bp
from .bootstrap import APP_VERSION, build_bootstrap
from .bundles import build as build_bundles
from .data_service import DataService
from .errors import FriendlyError
from .ratelimit import SlidingWindowLimiter
from .routes_legacy import bp as legacy_bp
from .routes_pages import bp as pages_bp
from .web_security import install as install_security

BASE_DIR = Path(__file__).resolve().parent.parent
log = logging.getLogger("today_eat")


def create_app(config_object=Config) -> Flask:
    app = Flask(
        __name__,
        template_folder=str(BASE_DIR / "templates"),
        static_folder=str(BASE_DIR / "static"),
    )
    app.config.from_object(config_object)
    app.json.ensure_ascii = False

    if app.config["TRUST_PROXY"]:
        # 仅在明确位于反向代理之后时启用，避免伪造 X-Forwarded-For
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    db_module.init_app(app)

    app.extensions["service"] = DataService(app.config)
    app.extensions["limiter"] = SlidingWindowLimiter()
    app.extensions["app_version"] = APP_VERSION
    bundles = build_bundles(app.static_folder)
    app.extensions["bundles"] = bundles
    app.extensions["asset_version"] = bundles["version"]

    install_security(app)
    app.register_blueprint(pages_bp)
    app.register_blueprint(legacy_bp)
    app.register_blueprint(api_v1_bp)

    _register_error_handlers(app)
    return app


def _render_page(status: int):
    return render_template(
        "index.html",
        bootstrap=build_bootstrap(),
        csp_nonce=getattr(g, "csp_nonce", ""),
        asset_version="0",
    ), status


def _register_error_handlers(app: Flask) -> None:
    @app.errorhandler(FriendlyError)
    def handle_friendly(error: FriendlyError):
        return jsonify(error.to_dict(getattr(g, "request_id", ""))), error.status

    @app.errorhandler(404)
    def handle_404(error):
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "message": "没有找到这个接口", "code": "not_found"}), 404
        return _render_page(404)

    @app.errorhandler(413)
    def handle_too_large(error):
        return jsonify({"ok": False, "message": "请求内容太大", "code": "bad_request"}), 413

    @app.errorhandler(HTTPException)
    def handle_http_error(error: HTTPException):
        """405 等 HTTP 异常也返回 JSON，避免前端拿到 HTML 报错页。"""
        if request.path.startswith("/api/"):
            return jsonify({
                "ok": False,
                "message": "请求有点问题，再试一次？",
                "code": (error.name or "http_error").lower().replace(" ", "_"),
            }), error.code
        return _render_page(error.code or 500)

    @app.errorhandler(Exception)
    def handle_unexpected(error: Exception):
        # 只在服务端记录堆栈，前端永远拿到人话
        log.exception("unhandled: %s", error)
        if request.path.startswith("/api/"):
            return jsonify({
                "ok": False,
                "message": "刚刚走神了一下，再试一次？",
                "hint": "如果一直失败，可以手动输入「城市 + 商圈」",
                "code": "server_error",
                "requestId": getattr(g, "request_id", ""),
            }), 500
        return _render_page(500)
