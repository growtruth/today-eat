"""页面路由：主应用与邀请落地页。"""

from __future__ import annotations

from flask import Blueprint, Response, current_app, g, render_template, request

from .bootstrap import build_bootstrap

bp = Blueprint("pages", __name__)


def _context() -> dict:
    return {
        "csp_nonce": getattr(g, "csp_nonce", ""),
        "asset_version": current_app.extensions.get("asset_version", "0"),
    }


@bp.get("/")
def index():
    return render_template("index.html", bootstrap=build_bootstrap(), **_context())


def _asset(kind: str) -> Response:
    bundle = current_app.extensions["bundles"]
    mime = "application/javascript" if kind == "js" else "text/css"
    response = Response(bundle[kind], mimetype=mime)
    response.set_etag(bundle["version"])
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response.make_conditional(request)


@bp.get("/assets/app.js")
def app_js():
    return _asset("js")


@bp.get("/assets/app.css")
def app_css():
    return _asset("css")


@bp.get("/i/<token>")
def invite_page(token: str):
    # 邀请落地页：前端拿 token 调 /api/invites/<token> 展示并接受
    return render_template("invite.html", token=token[:64], **_context())
