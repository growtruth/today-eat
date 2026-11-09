"""饭搭子域：目录 CRUD、邀请、位置加权抽取、骰子结账。

规则：
- 每个搭子归属一个 owner，跨用户不可见；
- 抽搭子用加权随机，权重由距离/口味/预算/久未见面决定；
- 骰子：两人各掷 1 枚 D6，差值 ≥3 点数小者付，≤2 AA；
- 邀请 token 7 天过期，接受后双方互为搭子。
"""

from __future__ import annotations

import json
import random
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone

from .api_error import ApiError

INVITE_DAYS = 7
AVATAR_COLORS = ["#FFD9B8", "#CDEBDD", "#FFE3C7", "#D9E8F5", "#F3DCDC", "#E6E1F0"]
PLATFORM_FEE_TEXT = "差值 ≥3 点数小者结账，≤2 AA"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _text(value, field: str, max_len: int, required: bool = False) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ApiError("invalid_param", f"{field} 不能为空")
    if len(text) > max_len:
        raise ApiError("invalid_param", f"{field} 最多 {max_len} 个字")
    return text


def _coord(value, field: str, low: float, high: float):
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ApiError("invalid_param", f"{field} 格式不对")
    if not low <= number <= high:
        raise ApiError("invalid_param", f"{field} 超出范围")
    return round(number, 6)


def _budget(value):
    if value in (None, ""):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ApiError("invalid_param", "budget 必须是整数")
    if not 0 <= number <= 5000:
        raise ApiError("invalid_param", "budget 需在 0~5000 之间")
    return number


def _cuisines(value) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ApiError("invalid_param", "cuisines 必须是数组")
    cleaned = []
    for item in value[:6]:
        text = _text(item, "cuisines", 10)
        if text and text not in cleaned:
            cleaned.append(text)
    return cleaned


def profile_completeness(buddy: dict) -> float:
    """资料完整度 0~1：坐标 0.5 · 口味 0.3 · 预算 0.2。

    信息缺失时对应权重按中性值计算，会让「没资料的搭子」靠运气抽中；
    用完整度折算总权重，把「越了解越容易被抽到」变成可解释的规则。
    """
    score = 0.0
    if buddy.get("lat") is not None and buddy.get("lng") is not None:
        score += 0.5
    if buddy.get("cuisines"):
        score += 0.3
    if buddy.get("budget") is not None:
        score += 0.2
    return round(score, 2)


def buddy_dict(row: sqlite3.Row) -> dict:
    try:
        cuisines = json.loads(row["cuisines"] or "[]")
    except json.JSONDecodeError:
        cuisines = []
    data = {
        "id": row["id"],
        "name": row["name"],
        "avatarColor": row["avatar_color"],
        "area": row["area"],
        "lat": row["lat"],
        "lng": row["lng"],
        "cuisines": cuisines,
        "budget": row["budget"],
        "lastMet": row["last_met"],
        "status": row["status"],
        "source": row["source"],
        "createdAt": row["created_at"],
    }
    data["completeness"] = profile_completeness(data)
    return data


def list_buddies(db: sqlite3.Connection, owner_id: str) -> list:
    rows = db.execute(
        "SELECT * FROM buddies WHERE owner_id = ? ORDER BY created_at DESC", (owner_id,)
    ).fetchall()
    return [buddy_dict(row) for row in rows]


def create_buddy(db: sqlite3.Connection, owner_id: str, payload: dict) -> dict:
    name = _text(payload.get("name"), "昵称", 20, required=True)
    area = _text(payload.get("area"), "区域", 20)
    lat = _coord(payload.get("lat"), "lat", -90, 90)
    lng = _coord(payload.get("lng"), "lng", -180, 180)
    cuisines = _cuisines(payload.get("cuisines"))
    budget = _budget(payload.get("budget"))
    color = payload.get("avatarColor") or random.choice(AVATAR_COLORS)
    if not isinstance(color, str) or not color.startswith("#") or len(color) != 7:
        color = random.choice(AVATAR_COLORS)

    buddy_id = "b_" + uuid.uuid4().hex[:12]
    try:
        db.execute(
            "INSERT INTO buddies (id, owner_id, name, avatar_color, area, lat, lng, cuisines, budget, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (buddy_id, owner_id, name, color, area, lat, lng,
             json.dumps(cuisines, ensure_ascii=False), budget, now_iso()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        raise ApiError("buddy_exists", "这个搭子已经在目录里了", 409)
    return buddy_dict(db.execute("SELECT * FROM buddies WHERE id = ?", (buddy_id,)).fetchone())


def update_buddy(db: sqlite3.Connection, owner_id: str, buddy_id: str, payload: dict) -> dict:
    row = db.execute(
        "SELECT * FROM buddies WHERE id = ? AND owner_id = ?", (buddy_id, owner_id)
    ).fetchone()
    if row is None:
        raise ApiError("buddy_not_found", "没有找到这个饭搭子", 404)

    fields, values = [], []
    if "name" in payload:
        fields.append("name = ?")
        values.append(_text(payload.get("name"), "昵称", 20, required=True))
    if "area" in payload:
        fields.append("area = ?")
        values.append(_text(payload.get("area"), "区域", 20))
    if "lat" in payload:
        fields.append("lat = ?")
        values.append(_coord(payload.get("lat"), "lat", -90, 90))
    if "lng" in payload:
        fields.append("lng = ?")
        values.append(_coord(payload.get("lng"), "lng", -180, 180))
    if "cuisines" in payload:
        fields.append("cuisines = ?")
        values.append(json.dumps(_cuisines(payload.get("cuisines")), ensure_ascii=False))
    if "budget" in payload:
        fields.append("budget = ?")
        values.append(_budget(payload.get("budget")))
    if "lastMet" in payload:
        fields.append("last_met = ?")
        fields_value = _text(payload.get("lastMet"), "lastMet", 10)
        if fields_value and not _valid_date(fields_value):
            raise ApiError("invalid_param", "lastMet 需为 YYYY-MM-DD")
        values.append(fields_value or None)

    if not fields:
        return buddy_dict(row)
    values.extend([buddy_id, owner_id])
    try:
        db.execute(f"UPDATE buddies SET {', '.join(fields)} WHERE id = ? AND owner_id = ?", values)
        db.commit()
    except sqlite3.IntegrityError:
        raise ApiError("buddy_exists", "这个搭子已经在目录里了", 409)
    return buddy_dict(db.execute("SELECT * FROM buddies WHERE id = ?", (buddy_id,)).fetchone())


def delete_buddy(db: sqlite3.Connection, owner_id: str, buddy_id: str) -> None:
    cursor = db.execute("DELETE FROM buddies WHERE id = ? AND owner_id = ?", (buddy_id, owner_id))
    db.commit()
    if cursor.rowcount == 0:
        raise ApiError("buddy_not_found", "没有找到这个饭搭子", 404)


def _valid_date(value: str) -> bool:
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------- 抽取
def _haversine(a_lat, a_lng, b_lat, b_lng) -> float:
    from .geo import haversine
    return haversine(a_lat, a_lng, b_lat, b_lng)


def score_buddy(buddy: dict, lat, lng, cuisine: str, budget) -> tuple[float, dict, float | None]:
    distance = None
    if lat is not None and lng is not None and buddy.get("lat") is not None and buddy.get("lng") is not None:
        distance = _haversine(lat, lng, buddy["lat"], buddy["lng"])
        proximity = 1 - min(distance, 5000) / 5000
    else:
        proximity = 0.5  # 没有位置信息给中性分

    affinity = 1.0 if cuisine and cuisine in (buddy.get("cuisines") or []) else 0.4
    if budget is not None and buddy.get("budget") is not None:
        budget_fit = 1 - min(abs(int(budget) - int(buddy["budget"])), 100) / 100
    else:
        budget_fit = 0.5

    recency = 0.5
    if buddy.get("lastMet"):
        try:
            days = (date.today() - date.fromisoformat(buddy["lastMet"])).days
            recency = min(max(days, 0) / 30, 1)
        except ValueError:
            recency = 0.5

    weight = 0.40 * proximity + 0.25 * affinity + 0.20 * budget_fit + 0.10 * recency + 0.05
    breakdown = {
        "proximity": round(proximity, 3),
        "cuisine": round(affinity, 3),
        "budget": round(budget_fit, 3),
        "recency": round(recency, 3),
    }
    return weight ** 2, breakdown, distance


def draw_buddy(db: sqlite3.Connection, owner_id: str, payload: dict) -> dict:
    rows = db.execute("SELECT * FROM buddies WHERE owner_id = ?", (owner_id,)).fetchall()
    if not rows:
        raise ApiError("no_buddies", "还没有饭搭子，先添加一个吧", 409)

    lat = _coord(payload.get("lat"), "lat", -90, 90)
    lng = _coord(payload.get("lng"), "lng", -180, 180)
    cuisine = _text(payload.get("cuisine"), "cuisine", 10)
    budget = _budget(payload.get("budget"))

    pool, weights, details = [], [], {}
    for row in rows:
        buddy = buddy_dict(row)
        weight, breakdown, distance = score_buddy(buddy, lat, lng, cuisine, budget)
        # 信息不完整惩罚：资料全 100%，全空 60%（而不是和完整搭子同权重）
        complete = buddy["completeness"]
        weight *= 0.6 + 0.4 * complete
        pool.append(buddy)
        weights.append(max(weight, 0.0001))
        details[buddy["id"]] = {
            "breakdown": breakdown,
            "distance": round(distance) if distance else None,
            "completeness": complete,
        }

    chosen_index = random.SystemRandom().choices(range(len(pool)), weights=weights, k=1)[0]
    chosen = pool[chosen_index]
    detail = details[chosen["id"]]
    return {
        "buddy": chosen,
        "score": round(weights[chosen_index], 4),
        "breakdown": detail["breakdown"],
        "distance": detail["distance"],
        "completeness": detail["completeness"],
        "incomplete": detail["completeness"] < 1,
        "reason": _explain(detail["breakdown"], detail["distance"]),
        "rule": "距离 40% · 口味 25% · 预算 20% · 久未见面 10% · 随机 5%（资料不全按完整度降权）",
    }


def _explain(breakdown: dict, distance) -> str:
    parts = []
    if distance is not None:
        parts.append(f"离你 {distance / 1000:.1f}km" if distance >= 1000 else f"离你 {distance}m")
    if breakdown["cuisine"] >= 1:
        parts.append("正好爱吃这个菜系")
    if breakdown["budget"] >= 0.8:
        parts.append("预算接近")
    if breakdown["recency"] >= 0.8:
        parts.append("很久没一起吃了")
    return " · ".join(parts) or "随机选中"


# ---------------------------------------------------------------- 邀请
def create_invite(db: sqlite3.Connection, inviter_id: str, invitee_name: str = "") -> dict:
    import secrets
    name = _text(invitee_name, "称呼", 20)
    # 同一个称呼还有未过期的待接受邀请时直接复用，避免连点「发邀请」刷出一堆链接
    existing = db.execute(
        "SELECT * FROM invites WHERE inviter_id = ? AND invitee_name = ? AND status = 'pending' "
        "AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
        (inviter_id, name, now_iso()),
    ).fetchone()
    if existing:
        return {
            "token": existing["token"],
            "status": "pending",
            "expiresAt": existing["expires_at"],
            "reused": True,
        }

    token = secrets.token_urlsafe(16)
    created = datetime.now(timezone.utc)
    expires = created + timedelta(days=INVITE_DAYS)
    db.execute(
        "INSERT INTO invites (token, inviter_id, invitee_name, status, created_at, expires_at) "
        "VALUES (?, ?, ?, 'pending', ?, ?)",
        (token, inviter_id, name, now_iso(), expires.replace(microsecond=0).isoformat()),
    )
    db.commit()
    return {
        "token": token,
        "status": "pending",
        "expiresAt": expires.replace(microsecond=0).isoformat(),
        "reused": False,
    }


def get_invite(db: sqlite3.Connection, token: str) -> dict:
    row = db.execute(
        "SELECT i.*, u.nickname AS inviter_name FROM invites i JOIN users u ON u.id = i.inviter_id "
        "WHERE i.token = ?",
        (token,),
    ).fetchone()
    if row is None:
        raise ApiError("invite_not_found", "邀请链接无效", 404)
    status = row["status"]
    if status == "pending" and row["expires_at"] < now_iso():
        status = "expired"
    return {
        "token": row["token"],
        "inviter": row["inviter_name"],
        "inviteeName": row["invitee_name"],
        "status": status,
        "expiresAt": row["expires_at"],
    }


def accept_invite(db: sqlite3.Connection, token: str, user: sqlite3.Row) -> dict:
    row = db.execute("SELECT * FROM invites WHERE token = ?", (token,)).fetchone()
    if row is None:
        raise ApiError("invite_not_found", "邀请链接无效", 404)
    if row["status"] != "pending":
        raise ApiError("invite_used", "这个邀请已经被使用或撤销", 409)
    if row["expires_at"] < now_iso():
        raise ApiError("invite_expired", "邀请已过期，让对方重新发一个", 410)
    if row["inviter_id"] == user["id"]:
        raise ApiError("invite_self", "不能接受自己的邀请", 409)

    inviter = db.execute("SELECT * FROM users WHERE id = ?", (row["inviter_id"],)).fetchone()
    if inviter is None:
        raise ApiError("invite_not_found", "邀请人不存在", 404)

    # 原子占用：两个人同时点同一 token 时只有一个能成功，避免邀请方目录多出一个人
    claimed = db.execute(
        "UPDATE invites SET status = 'accepted', accepted_by = ? "
        "WHERE token = ? AND status = 'pending' AND expires_at > ?",
        (user["id"], token, now_iso()),
    )
    if claimed.rowcount == 0:
        db.rollback()
        raise ApiError("invite_used", "这个邀请已经被使用或撤销", 409)

    invitee_name = _display_name(user["nickname"], "新搭子")
    inviter_name = _display_name(inviter["nickname"], "邀请人")
    _upsert_mutual_buddy(db, row["inviter_id"], invitee_name, user["city"] or "", "invite")
    _upsert_mutual_buddy(db, user["id"], inviter_name, inviter["city"] or "", "invite")

    db.commit()
    return {"status": "accepted", "buddyName": inviter_name}


def _display_name(raw: str, fallback: str) -> str:
    """设备默认昵称「本机用户」不适合进搭子目录，换成可辨认的占位名。"""
    name = (raw or "").strip()
    if name in ("", "本机用户", "微信用户"):
        return fallback
    return name[:20]


def _upsert_mutual_buddy(db: sqlite3.Connection, owner_id: str, name: str, area: str, source: str) -> None:
    # 同名时保护手工资料：已有区域不被空值覆盖，手工来源也不被「邀请加入」降级
    db.execute(
        "INSERT INTO buddies (id, owner_id, name, avatar_color, area, cuisines, source, created_at) "
        "VALUES (?, ?, ?, ?, ?, '[]', ?, ?) "
        "ON CONFLICT(owner_id, name) DO UPDATE SET "
        "  area = CASE WHEN buddies.area != '' THEN buddies.area ELSE excluded.area END, "
        "  source = CASE WHEN buddies.source = 'manual' THEN 'manual' ELSE excluded.source END",
        ("b_" + uuid.uuid4().hex[:12], owner_id, name[:20], random.choice(AVATAR_COLORS), area[:20], source, now_iso()),
    )


def revoke_invite(db: sqlite3.Connection, inviter_id: str, token: str) -> None:
    cursor = db.execute(
        "UPDATE invites SET status = 'revoked' WHERE token = ? AND inviter_id = ? AND status = 'pending'",
        (token, inviter_id),
    )
    db.commit()
    if cursor.rowcount == 0:
        raise ApiError("invite_not_found", "没有可撤销的邀请", 404)


# ---------------------------------------------------------------- 骰子
def roll_dice(db: sqlite3.Connection, user_id: str, buddy_id: str) -> dict:
    buddy = db.execute(
        "SELECT * FROM buddies WHERE id = ? AND owner_id = ?", (buddy_id, user_id)
    ).fetchone()
    if buddy is None:
        raise ApiError("buddy_not_found", "没有找到这个饭搭子", 404)

    rand = random.SystemRandom()
    my_roll = rand.randint(1, 6)
    buddy_roll = rand.randint(1, 6)
    diff = abs(my_roll - buddy_roll)
    if diff <= 2:
        payer = "aa"
    elif my_roll < buddy_roll:
        payer = "me"
    else:
        payer = "buddy"

    record_id = "d_" + uuid.uuid4().hex[:12]
    db.execute(
        "INSERT INTO dice_records (id, user_id, buddy_id, my_roll, buddy_roll, diff, payer, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (record_id, user_id, buddy_id, my_roll, buddy_roll, diff, payer, now_iso()),
    )
    db.commit()
    return {
        "id": record_id,
        "buddyName": buddy["name"],
        "myRoll": my_roll,
        "buddyRoll": buddy_roll,
        "diff": diff,
        "payer": payer,
        "rule": PLATFORM_FEE_TEXT,
        "createdAt": now_iso(),
    }


def dice_history(db: sqlite3.Connection, user_id: str, limit: int = 20) -> list:
    limit = max(1, min(50, limit))
    rows = db.execute(
        "SELECT d.*, b.name AS buddy_name FROM dice_records d LEFT JOIN buddies b ON b.id = d.buddy_id "
        "WHERE d.user_id = ? ORDER BY d.created_at DESC LIMIT ?",
        (user_id, limit),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "buddyName": row["buddy_name"] or "已删除的搭子",
            "myRoll": row["my_roll"],
            "buddyRoll": row["buddy_roll"],
            "diff": row["diff"],
            "payer": row["payer"],
            "createdAt": row["created_at"],
        }
        for row in rows
    ]
