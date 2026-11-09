"""v1 API：身份、饭搭子、邀请、团购、骰子。

统一约定：
- 成功：HTTP 200 + {ok: true, ...data, requestId}
- 失败：HTTP 4xx/5xx + {ok: false, code, message, hint?, requestId}
- 写操作需要会话 Cookie；GET 中的公开资源（邀请详情）不需要。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlparse

from flask import Blueprint, current_app, g, jsonify, redirect, request

from .api_error import ApiError
from .auth import (
    DEVICE_RE,
    clear_session_cookie,
    create_session,
    current_user,
    delete_user,
    drop_session,
    public_user,
    require_user,
    set_session_cookie,
    upsert_cloud_user,
    upsert_device_user,
    upsert_wechat_user,
)
from .cloud_auth import verify_token as verify_cloud_token
from .db import get_db
from .deals import list_deals
from .social import (
    accept_invite,
    create_buddy,
    create_invite,
    delete_buddy,
    dice_history,
    draw_buddy,
    get_invite,
    list_buddies,
    revoke_invite,
    roll_dice,
    update_buddy,
)
from . import wechat

bp = Blueprint("api_v1", __name__)


# ---------------------------------------------------------------- 工具
def _body() -> dict:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ApiError("invalid_json", "请求体必须是 JSON 对象")
    return payload


def _ok(**data) -> dict:
    payload = {"ok": True}
    payload.update(data)
    payload["requestId"] = getattr(g, "request_id", "")
    return payload


def _safe_next(value: str) -> str:
    if not value or not value.startswith("/") or value.startswith("//"):
        return "/"
    return value[:200]


def _sharecode() -> str:
    """分享码要跟着授权链路走：本平台用 ?sharecode= 做访问门禁，丢了就是 403。"""
    return (request.args.get("sharecode") or "").strip()[:64]


def _with_query(path: str, **params) -> str:
    """在保留原有查询参数的前提下追加/覆盖参数。"""
    parsed = urlparse(path)
    query = dict(parse_qsl(parsed.query))
    for key, value in params.items():
        if value not in (None, ""):
            query[key] = value
        elif key in query:
            query.pop(key)
    encoded = urlencode(query)
    return parsed.path + ("?" + encoded if encoded else "")


# ---------------------------------------------------------------- 身份
@bp.post("/api/auth/device")
def auth_device():
    body = _body()
    device_id = str(body.get("deviceId") or "").strip()
    if not re.fullmatch(DEVICE_RE, device_id):
        raise ApiError("invalid_device", "deviceId 需为 8~64 位字母、数字、下划线或短横线")
    nickname = str(body.get("nickname") or "").strip()[:20]
    db = get_db()
    user = upsert_device_user(db, device_id, nickname)
    token = create_session(db, user["id"])
    response = jsonify(_ok(user=public_user(user)))
    set_session_cookie(response, token)
    return response


@bp.post("/api/auth/cloud")
def auth_cloud():
    """WorkBuddy 账号登录：前端拿云会话 token 来换本站会话。

    token 必须在服务端向云端核验，前端传来的任何 uid 都不可信。
    """
    body = _body()
    profile = verify_cloud_token(current_app.config, str(body.get("token") or ""))
    device_id = str(body.get("deviceId") or "").strip()
    if device_id and not re.fullmatch(DEVICE_RE, device_id):
        device_id = ""
    db = get_db()
    current = current_user(db)
    user = upsert_cloud_user(db, profile, current["id"] if current else None, device_id)
    token = create_session(db, user["id"])
    response = jsonify(_ok(user=public_user(user)))
    set_session_cookie(response, token)
    return response


@bp.get("/api/me")
def api_me():
    user = current_user(get_db())
    return jsonify(_ok(user=public_user(user)))


@bp.patch("/api/me")
def api_update_me():
    """改自己的昵称：设备默认的「本机用户」需要能改成真名，否则邀请方分不清是谁。"""
    db = get_db()
    user = require_user(db)
    nickname = str(_body().get("nickname") or "").strip()
    if not nickname:
        raise ApiError("invalid_param", "昵称不能为空")
    if len(nickname) > 20:
        raise ApiError("invalid_param", "昵称最多 20 个字")
    db.execute("UPDATE users SET nickname = ? WHERE id = ?", (nickname, user["id"]))
    db.commit()
    return jsonify(_ok(user=public_user(db.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone())))


@bp.post("/api/auth/logout")
def auth_logout():
    db = get_db()
    drop_session(db, request.cookies.get("sid"))
    response = jsonify(_ok())
    clear_session_cookie(response)
    return response


@bp.delete("/api/account")
def api_delete_account():
    db = get_db()
    user = require_user(db)
    delete_user(db, user["id"])
    response = jsonify(_ok())
    clear_session_cookie(response)
    return response


# ---------------------------------------------------------------- 饭搭子
@bp.get("/api/buddies")
def api_buddies():
    db = get_db()
    user = require_user(db)
    return jsonify(_ok(items=list_buddies(db, user["id"])))


@bp.post("/api/buddies")
def api_create_buddy():
    db = get_db()
    user = require_user(db)
    return jsonify(_ok(buddy=create_buddy(db, user["id"], _body())))


@bp.patch("/api/buddies/<buddy_id>")
def api_update_buddy(buddy_id: str):
    db = get_db()
    user = require_user(db)
    return jsonify(_ok(buddy=update_buddy(db, user["id"], buddy_id, _body())))


@bp.delete("/api/buddies/<buddy_id>")
def api_delete_buddy(buddy_id: str):
    db = get_db()
    user = require_user(db)
    delete_buddy(db, user["id"], buddy_id)
    return jsonify(_ok())


@bp.post("/api/buddies/draw")
def api_draw_buddy():
    db = get_db()
    user = require_user(db)
    return jsonify(_ok(**draw_buddy(db, user["id"], _body())))


# ---------------------------------------------------------------- 邀请
@bp.post("/api/invites")
def api_create_invite():
    db = get_db()
    user = require_user(db)
    body = _body()
    invite = create_invite(db, user["id"], body.get("inviteeName", ""))
    invite["url"] = request.host_url.rstrip("/") + "/i/" + invite["token"]
    return jsonify(_ok(invite=invite))


@bp.get("/api/invites/<token>")
def api_get_invite(token: str):
    return jsonify(_ok(invite=get_invite(get_db(), token)))


@bp.post("/api/invites/<token>/accept")
def api_accept_invite(token: str):
    db = get_db()
    user = require_user(db)
    return jsonify(_ok(**accept_invite(db, token, user)))


@bp.delete("/api/invites/<token>")
def api_revoke_invite(token: str):
    db = get_db()
    user = require_user(db)
    revoke_invite(db, user["id"], token)
    return jsonify(_ok())


# ---------------------------------------------------------------- 团购
@bp.get("/api/deals")
def api_deals():
    result = list_deals(
        get_db(),
        store_id=request.args.get("store_id", ""),
        store_name=request.args.get("name", ""),
        city=request.args.get("city", ""),
    )
    return jsonify(_ok(**result))


# ---------------------------------------------------------------- 骰子
@bp.post("/api/dice")
def api_dice():
    db = get_db()
    user = require_user(db)
    body = _body()
    buddy_id = str(body.get("buddyId") or "").strip()
    if not buddy_id:
        raise ApiError("invalid_param", "缺少 buddyId")
    return jsonify(_ok(**roll_dice(db, user["id"], buddy_id)))


@bp.get("/api/dice/history")
def api_dice_history():
    db = get_db()
    user = require_user(db)
    limit = request.args.get("limit", "20")
    try:
        limit_value = int(limit)
    except ValueError:
        limit_value = 20
    return jsonify(_ok(items=dice_history(db, user["id"], limit_value)))


# ---------------------------------------------------------------- 微信授权
@bp.get("/auth/wechat")
def wechat_authorize():
    sharecode = _sharecode()
    if not wechat.configured(current_app.config):
        return redirect(_with_query("/", sharecode=sharecode, wechat="unconfigured"))
    # 分享码写进 next：微信回调时只会带 code/state，靠它把用户送回可用链接
    next_path = _with_query(_safe_next(request.args.get("next", "/")), sharecode=sharecode)
    state = wechat.new_state()
    db = get_db()
    # 顺手清理超过 10 分钟的旧 state，避免表无限增长
    expired = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=10)
    db.execute("DELETE FROM oauth_states WHERE created_at < ?", (expired.isoformat(),))
    db.execute(
        "INSERT INTO oauth_states (state, created_at, next_path) VALUES (?, ?, ?)",
        (state, datetime.now(timezone.utc).replace(microsecond=0).isoformat(), next_path),
    )
    db.commit()
    return redirect(wechat.authorize_url(current_app.config, state, request))


@bp.get("/auth/wechat/callback")
def wechat_callback():
    if not wechat.configured(current_app.config):
        return redirect(_with_query("/", sharecode=_sharecode(), wechat="unconfigured"))
    state = request.args.get("state", "")
    code = request.args.get("code", "")
    db = get_db()
    row = db.execute("SELECT * FROM oauth_states WHERE state = ?", (state,)).fetchone()
    if row is None:
        return redirect(_with_query("/", sharecode=_sharecode(), wechat="state_invalid"))
    next_path = _safe_next(row["next_path"])
    db.execute("DELETE FROM oauth_states WHERE state = ?", (state,))
    db.commit()

    try:
        created = datetime.fromisoformat(row["created_at"])
        if (datetime.now(timezone.utc) - created).total_seconds() > 600:
            return redirect(_with_query(next_path, wechat="state_expired"))
        if not code:
            return redirect(_with_query(next_path, wechat="no_code"))
        profile = wechat.exchange_code(current_app.config, code)
        current = current_user(db)
        user = upsert_wechat_user(db, profile, current["id"] if current else None)
        token = create_session(db, user["id"])
    except ApiError as error:
        return redirect(_with_query(next_path, wechat="failed", reason=error.code))

    response = redirect(_with_query(next_path, wechat="ok"))
    set_session_cookie(response, token)
    return response
