"""身份与会话。

两种身份来源：
1. 匿名设备：前端生成 UUID，POST /api/auth/device 换取 HttpOnly 会话；
2. 微信网页授权：/auth/wechat 回调后按 openid 建/并用户。

安全要点：
- 会话 token 只存 SHA-256，不落明文；
- Cookie 默认 HttpOnly + SameSite=Lax，HTTPS 下加 Secure；
- 微信 AppSecret 只在服务端使用，不进入前端与日志。
"""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

from flask import current_app, request

from .api_error import ApiError

SESSION_COOKIE = "sid"
SESSION_DAYS = 30
DEVICE_RE = r"^[A-Za-z0-9_-]{8,64}$"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(moment: datetime) -> str:
    return moment.replace(microsecond=0).isoformat()


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def public_user(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {
        "id": row["id"],
        "nickname": row["nickname"] or "饭搭子",
        "avatar": row["avatar"] or "",
        "city": row["city"] or "",
        "wechat": bool(row["wechat_openid"]),
        "cloud": bool(row["cloud_uid"]),
        "email": row["cloud_email"] or "",
    }


# ---------------------------------------------------------------- 用户
def upsert_device_user(db: sqlite3.Connection, device_id: str, nickname: str = "") -> sqlite3.Row:
    row = db.execute("SELECT * FROM users WHERE device_id = ?", (device_id,)).fetchone()
    timestamp = iso(now_utc())
    if row is None:
        user_id = "u_" + uuid.uuid4().hex[:16]
        db.execute(
            "INSERT INTO users (id, device_id, nickname, created_at, last_seen) VALUES (?, ?, ?, ?, ?)",
            (user_id, device_id, nickname[:20] or "本机用户", timestamp, timestamp),
        )
        db.commit()
    else:
        user_id = row["id"]
        db.execute(
            "UPDATE users SET last_seen = ?, nickname = CASE WHEN ? != '' THEN ? ELSE nickname END WHERE id = ?",
            (timestamp, nickname[:20], nickname[:20], user_id),
        )
        db.commit()
    return db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def upsert_wechat_user(db: sqlite3.Connection, profile: dict, link_user_id: str | None = None) -> sqlite3.Row:
    openid = (profile.get("openid") or "").strip()
    if not openid:
        raise ApiError("wechat_invalid", "微信未返回有效身份", 502)
    timestamp = iso(now_utc())
    nickname = (profile.get("nickname") or "微信用户")[:20]
    avatar = profile.get("headimgurl") or ""
    city = (profile.get("city") or profile.get("province") or "")[:20]
    unionid = (profile.get("unionid") or "").strip() or None

    existing = db.execute("SELECT * FROM users WHERE wechat_openid = ?", (openid,)).fetchone()
    if existing:
        db.execute(
            "UPDATE users SET nickname = ?, avatar = ?, city = ?, unionid = COALESCE(?, unionid), last_seen = ? WHERE id = ?",
            (nickname, avatar, city, unionid, timestamp, existing["id"]),
        )
        db.commit()
        return db.execute("SELECT * FROM users WHERE id = ?", (existing["id"],)).fetchone()

    # 已登录的匿名用户：把 openid 绑到当前用户，保留其饭搭子数据
    if link_user_id:
        try:
            db.execute(
                "UPDATE users SET wechat_openid = ?, unionid = ?, nickname = ?, avatar = ?, city = ?, last_seen = ? WHERE id = ?",
                (openid, unionid, nickname, avatar, city, timestamp, link_user_id),
            )
            db.commit()
            return db.execute("SELECT * FROM users WHERE id = ?", (link_user_id,)).fetchone()
        except sqlite3.IntegrityError:
            # 该 openid 已绑定其他账号：以已有账号为准，避免 500
            db.rollback()
            existing = db.execute("SELECT * FROM users WHERE wechat_openid = ?", (openid,)).fetchone()
            if existing:
                return existing
            raise

    user_id = "u_" + uuid.uuid4().hex[:16]
    db.execute(
        "INSERT INTO users (id, wechat_openid, unionid, nickname, avatar, city, created_at, last_seen) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (user_id, openid, unionid, nickname, avatar, city, timestamp, timestamp),
    )
    db.commit()
    return db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def delete_user(db: sqlite3.Connection, user_id: str) -> None:
    db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    db.commit()


# ---------------------------------------------------------------- 账号登录
DEFAULT_NICKNAMES = ("", "本机用户", "微信用户", "饭搭子")


def upsert_cloud_user(db: sqlite3.Connection, profile: dict,
                      link_user_id: str | None = None, device_id: str = "") -> sqlite3.Row:
    """按 WorkBuddy 账号落库。

    优先级：已有同 uid 用户 → 绑定当前设备用户（保留搭子/打卡数据）→ 新建。
    昵称只在当前是默认值时覆盖，避免把用户自己改的名字冲掉。
    """
    uid = (profile.get("uid") or "").strip()
    if not uid:
        raise ApiError("cloud_auth_failed", "账号信息不完整", 502)
    email = (profile.get("email") or "").strip()[:120]
    name = (profile.get("name") or "").strip()[:20]
    avatar = (profile.get("avatar") or "").strip()[:300]
    timestamp = iso(now_utc())

    existing = db.execute("SELECT * FROM users WHERE cloud_uid = ?", (uid,)).fetchone()
    if existing:
        db.execute(
            "UPDATE users SET last_seen = ?, avatar = CASE WHEN ? != '' THEN ? ELSE avatar END, "
            "cloud_email = CASE WHEN ? != '' THEN ? ELSE cloud_email END WHERE id = ?",
            (timestamp, avatar, avatar, email, email, existing["id"]),
        )
        db.commit()
        return db.execute("SELECT * FROM users WHERE id = ?", (existing["id"],)).fetchone()

    if link_user_id:
        try:
            db.execute(
                "UPDATE users SET cloud_uid = ?, cloud_email = ?, "
                "avatar = CASE WHEN ? != '' THEN ? ELSE avatar END, "
                "nickname = CASE WHEN nickname IN (?, ?, ?, ?) THEN ? ELSE nickname END, "
                "last_seen = ? WHERE id = ?",
                (uid, email, avatar, avatar,
                 *DEFAULT_NICKNAMES, name or "饭搭子", timestamp, link_user_id),
            )
            db.commit()
            return db.execute("SELECT * FROM users WHERE id = ?", (link_user_id,)).fetchone()
        except sqlite3.IntegrityError:
            # uid 已绑在别的账号上：以已有账号为准
            db.rollback()
            existing = db.execute("SELECT * FROM users WHERE cloud_uid = ?", (uid,)).fetchone()
            if existing:
                return existing
            raise

    user_id = "u_" + uuid.uuid4().hex[:16]
    try:
        db.execute(
            "INSERT INTO users (id, device_id, cloud_uid, cloud_email, nickname, avatar, created_at, last_seen) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, device_id or None, uid, email, name or "饭搭子", avatar, timestamp, timestamp),
        )
        db.commit()
    except sqlite3.IntegrityError:
        # 该设备已有用户：直接绑到它身上
        db.rollback()
        row = db.execute("SELECT * FROM users WHERE device_id = ?", (device_id,)).fetchone() if device_id else None
        if row is None:
            raise
        return upsert_cloud_user(db, profile, row["id"])
    return db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


# ---------------------------------------------------------------- 会话
def create_session(db: sqlite3.Connection, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    created = now_utc()
    db.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (hash_token(token), user_id, iso(created), iso(created + timedelta(days=SESSION_DAYS))),
    )
    db.execute("DELETE FROM sessions WHERE expires_at < ?", (iso(created),))
    db.commit()
    return token


def session_user(db: sqlite3.Connection, token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    row = db.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token_hash = ? AND s.expires_at > ?",
        (hash_token(token), iso(now_utc())),
    ).fetchone()
    return row


def current_user(db: sqlite3.Connection) -> sqlite3.Row | None:
    return session_user(db, request.cookies.get(SESSION_COOKIE))


def require_user(db: sqlite3.Connection) -> sqlite3.Row:
    user = current_user(db)
    if user is None:
        raise ApiError("auth_required", "请先登录或初始化本机身份", 401, "调用 POST /api/auth/device 获取会话")
    return user


def drop_session(db: sqlite3.Connection, token: str | None) -> None:
    if token:
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))
        db.commit()


def set_session_cookie(response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        secure=bool(current_app.config.get("SESSION_COOKIE_SECURE")),
        samesite="Lax",
        path="/",
    )


def clear_session_cookie(response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
