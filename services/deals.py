"""团购推荐：只返回真实套餐，或返回“去平台看团购”的跳转链接。

原则：
- 不编造价格、折扣、销量；
- 没有商家/官方数据时，返回 linkOnly=true 与平台搜索深链；
- 价格带来源与更新时间，过期自动隐藏。
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date
from urllib.parse import quote

from .api_error import ApiError

PLATFORMS = {
    "meituan": {"label": "美团", "search": "https://www.meituan.com/s/{kw}/"},
    "dianping": {"label": "大众点评", "search": "https://www.dianping.com/search/keyword/0/0_{kw}"},
    "douyin": {"label": "抖音", "search": "https://www.douyin.com/search/{kw}"},
    "amap": {"label": "高德", "search": "https://www.amap.com/search?query={kw}"},
}


def _deal_dict(row: sqlite3.Row) -> dict:
    try:
        items = json.loads(row["items"] or "[]")
    except json.JSONDecodeError:
        items = []
    price = row["price_cents"] / 100
    original = row["original_price_cents"] / 100 if row["original_price_cents"] else None
    discount = round(1 - price / original, 2) if original and original > price else None
    return {
        "id": row["id"],
        "storeId": row["store_id"],
        "storeName": row["store_name"],
        "platform": row["platform"],
        "platformLabel": PLATFORMS.get(row["platform"], {}).get("label", row["platform"]),
        "title": row["title"],
        "items": items,
        "price": price,
        "originalPrice": original,
        "discount": discount,
        "sold": row["sold"],
        "validUntil": row["valid_until"],
        "url": row["url"],
        "source": row["source"],
        "updatedAt": row["updated_at"],
    }


def list_deals(db: sqlite3.Connection, store_id: str = "", store_name: str = "", city: str = "") -> dict:
    store_name = (store_name or "").strip()[:40]
    store_id = (store_id or "").strip()[:80]
    if not store_name and not store_id:
        raise ApiError("invalid_param", "缺少门店信息")

    today = date.today().isoformat()
    rows = db.execute(
        "SELECT * FROM deals WHERE (store_id = ? OR store_name = ?) "
        "AND (valid_until IS NULL OR valid_until >= ?) "
        "ORDER BY price_cents ASC LIMIT 10",
        (store_id, store_name, today),
    ).fetchall()

    if rows:
        # 推荐顺序：折扣力度 > 销量 > 价格，避免只按低价排出无折扣套餐
        items = sorted(
            (_deal_dict(row) for row in rows),
            key=lambda deal: (-(deal["discount"] or 0), -(deal["sold"] or 0), deal["price"]),
        )
        return {"items": items, "linkOnly": False, "links": []}

    return {
        "items": [],
        "linkOnly": True,
        "links": search_links(store_name, city),
        "note": "暂无合作套餐，去平台查看实时团购；本页不展示未经授权的价格",
    }


def search_links(store_name: str, city: str = "") -> list:
    # 平台搜索用门店名即可；城市前缀会显著降低命中率
    kw = quote(store_name or (f"{city}美食" if city else "附近美食"))
    return [
        {"platform": key, "label": meta["label"], "url": meta["search"].format(kw=kw)}
        for key, meta in PLATFORMS.items()
    ]


def with_deal_flags(db: sqlite3.Connection, items: list) -> list:
    """给门店列表打上“有在售套餐”标记，供首页卡片展示团购角标。

    只查当前页门店，避免全表扫描；过期套餐不算。
    """
    ids = [str(item.get("id")) for item in items if item.get("id")]
    if not ids:
        return items
    placeholders = ",".join("?" * len(ids))
    rows = db.execute(
        f"SELECT DISTINCT store_id FROM deals WHERE store_id IN ({placeholders}) "
        "AND (valid_until IS NULL OR valid_until >= ?)",
        (*ids, date.today().isoformat()),
    ).fetchall()
    hit = {row["store_id"] for row in rows}
    for item in items:
        item["hasDeal"] = str(item.get("id")) in hit
    return items
