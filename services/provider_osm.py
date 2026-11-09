"""OpenStreetMap Overpass 适配器（无 Key 的真实公开数据源）。

许可：ODbL 1.0，界面/文档需署名 OpenStreetMap contributors。
范围：指定坐标半径内的餐饮类 POI（restaurant / cafe / fast_food / bar / pub）。
字段：名称、菜系、地址、营业时间、电话、官网、坐标；**不含评分、人均、图片**，
      缺失字段由前端降级展示（不猜造数据）。
频率：按 Overpass 使用政策，单 host 最小间隔 3 秒，失败指数退避，最多重试 2 次。
"""

from __future__ import annotations

from .crawler import STATS, dedupe_items, fetch_json, validate_item
from .errors import ProviderError
from .geo import haversine
from .provider_amap import classify
from .provider_base import BaseProvider

# 公共镜像，按顺序尝试；主站过载时自动切换
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

AMENITY_FILTER = "restaurant|cafe|fast_food|bar|pub"

QUERY_TEMPLATE = """
[out:json][timeout:20];
(
  node["amenity"~"{amenity}"](around:{radius},{lat},{lng});
  way["amenity"~"{amenity}"](around:{radius},{lat},{lng});
);
out center tags 80;
""".strip()


class OsmProvider(BaseProvider):
    name = "osm"
    label = "OpenStreetMap"

    def __init__(self, timeout: float = 8.0):
        self.timeout = timeout

    def available(self) -> bool:
        return True

    def search_nearby(self, lat: float, lng: float, radius: int, keyword: str = "",
                      offset: int = 0, limit: int = 50) -> list:
        query = QUERY_TEMPLATE.format(amenity=AMENITY_FILTER, radius=radius, lat=lat, lng=lng)
        payload, last_error = None, None
        for endpoint in OVERPASS_ENDPOINTS:
            try:
                payload = fetch_json(endpoint, {"data": query}, "osm", self.timeout, method="POST", retries=1)
                break
            except ProviderError as exc:
                last_error = exc
                continue
        if payload is None:
            raise last_error or ProviderError("osm", "Overpass 无可用镜像")

        raw_items, rejected, issues = [], 0, {}
        kw = (keyword or "").strip().lower()
        for element in payload.get("elements") or []:
            tags = element.get("tags") or {}
            name = tags.get("name") or tags.get("name:zh")
            if not name:
                rejected += 1
                issues["name_missing"] = issues.get("name_missing", 0) + 1
                continue
            if "lat" in element and "lon" in element:
                plat, plng = element["lat"], element["lon"]
            else:
                center = element.get("center") or {}
                if "lat" not in center:
                    rejected += 1
                    continue
                plat, plng = center["lat"], center["lon"]

            cuisine_text = tags.get("cuisine") or ""
            cuisine = classify(cuisine_text, name)
            if kw and not (kw in name.lower() or kw in cuisine.lower() or kw in cuisine_text.lower()):
                continue

            street = tags.get("addr:street") or ""
            number = tags.get("addr:housenumber") or ""
            address = f"{street}{number}".strip()

            raw_items.append({
                "id": f"osm-{element.get('type', 'node')}-{element.get('id')}",
                "name": name,
                "cuisine": cuisine,
                "category": "drink" if cuisine in ("甜品", "咖啡", "奶茶") else "main",
                "subCuisine": cuisine_text or cuisine,
                "rating": None,
                "avgPrice": None,
                "lat": plat,
                "lng": plng,
                "address": address,
                "area": tags.get("addr:district") or tags.get("addr:subdistrict") or "",
                "businessHours": tags.get("opening_hours") or "",
                "tags": [],
                "isNew": False,
                "cover": "",
                "gallery": [],
                "distance": round(haversine(lat, lng, plat, plng)),
                "source": "osm",
                "osmTags": {k: v for k, v in tags.items() if k in ("phone", "website", "cuisine", "opening_hours")},
            })

        validated, rejected_geo = [], 0
        for raw in raw_items:
            item, item_issues = validate_item(raw, lat, lng)
            for key in item_issues:
                issues[key] = issues.get(key, 0) + 1
            if item:
                validated.append(self.normalize(item))
            else:
                rejected_geo += 1

        unique, dropped = dedupe_items(validated)
        STATS.record_items("osm", len(unique), rejected + rejected_geo + dropped, issues)
        unique.sort(key=lambda x: x["distance"])
        start = max(0, int(offset or 0))
        want = max(1, int(limit or 50))
        page = unique[start:start + want]
        self.page_info = {"total": len(unique), "hasMore": start + len(page) < len(unique)}
        if not page:
            if start > 0:
                return []
            raise ProviderError("osm", "周边未返回可用的餐饮 POI")
        return page

    def place_detail(self, poi_id: str) -> dict | None:
        # Overpass 不便按 id 单点查询，详情直接复用前端已持有的列表数据
        return None

    def geocode(self, query: str, city: str) -> dict | None:
        return None

    def route(self, origin: tuple, dest: tuple, mode: str) -> dict | None:
        return None
