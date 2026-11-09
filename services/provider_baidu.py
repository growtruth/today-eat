"""百度地图适配器（备用数据源）。

- 周边检索：/place/v2/search
- 地理编码：/geocoding/v3
- 路径规划：/directionlite/v1/{walking|riding|driving}

注意：百度使用 BD-09 坐标系，出入参统一在适配器内部转换为 GCJ-02，
保证与高德数据源、浏览器定位可直接混用。
文档：https://lbsyun.baidu.com/faq/api?title=webapi
AK 申请：https://lbsyun.baidu.com/apiconsole/key （应用类型选“服务端”）
"""

from __future__ import annotations

from .crawler import STATS, dedupe_items, fetch_json, validate_item
from .errors import ProviderError
from .geo import bd09_to_gcj02, duration_minutes, gcj02_to_bd09, haversine
from .provider_amap import classify
from .provider_base import BaseProvider

BAIDU_BASE = "https://api.map.baidu.com"
DRINK_CUISINES = {"甜品", "咖啡", "奶茶"}


def _to_float(value, default=None):
    try:
        number = float(value)
        return number if number > 0 else default
    except (TypeError, ValueError):
        return default


class BaiduProvider(BaseProvider):
    name = "baidu"
    label = "百度地图"

    def __init__(self, web_ak: str, timeout: float = 6.0):
        self.ak = web_ak
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.ak)

    def _get(self, path: str, params: dict) -> dict:
        if not self.ak:
            raise ProviderError("baidu", "未配置 BAIDU_WEB_AK", retryable=False)
        payload = fetch_json(f"{BAIDU_BASE}{path}", {**params, "ak": self.ak, "output": "json"}, "baidu", self.timeout)
        if payload.get("status") != 0:
            raise ProviderError("baidu", payload.get("message", "接口返回失败"))
        return payload

    # ---------------- POI ----------------
    PAGE_SIZE = 20

    def search_nearby(self, lat: float, lng: float, radius: int, keyword: str = "",
                      offset: int = 0, limit: int = 20) -> list:
        blat, blng = gcj02_to_bd09(lat, lng)
        start = max(0, int(offset or 0))
        want = max(1, int(limit or self.PAGE_SIZE))
        payload = self._get("/place/v2/search", {
            "query": keyword or "美食",
            "location": f"{blat},{blng}",
            "radius": radius,
            "scope": 2,
            "page_size": min(self.PAGE_SIZE, want),
            "page_num": start // self.PAGE_SIZE,
            "filter": "sort_name:distance|sort_rule:1",
        })
        total = int(payload.get("total") or 0)
        items = []
        for poi in payload.get("results") or []:
            location = poi.get("location") or {}
            if not location.get("lat") or not location.get("lng"):
                continue
            glat, glng = bd09_to_gcj02(float(location["lat"]), float(location["lng"]))
            detail = poi.get("detail_info") or {}
            cuisine = classify(detail.get("type") or "", poi.get("name") or "")
            rating = _to_float(detail.get("overall_rating"))
            price = _to_float(detail.get("price"))
            hours = detail.get("shop_hours") or ""
            tags = []
            if price and price >= 100:
                tags.append("周末友好")
            if price and price >= 150:
                tags.append("有包间")
            if rating and rating >= 4.5:
                tags.append("适合拍照")
            address = poi.get("address")
            if isinstance(address, list):
                address = "".join(address)
            items.append(self.normalize({
                "id": poi.get("uid"),
                "name": poi.get("name") or "未命名商家",
                "cuisine": cuisine,
                "category": "drink" if cuisine in DRINK_CUISINES else "main",
                "subCuisine": (detail.get("tag") or cuisine),
                "rating": rating,
                "avgPrice": int(price) if price else None,
                "lat": glat,
                "lng": glng,
                "address": address or "",
                "area": (poi.get("area") or ""),
                "businessHours": hours,
                "openTime": "",
                "closeTime": "",
                "tags": tags,
                "isNew": False,
                "cover": "",
                "gallery": [],
                "distance": round(haversine(lat, lng, glat, glng)),
                "source": "baidu",
            }))
        if not items:
            if start > 0:
                return []
            raise ProviderError("baidu", "周边未返回餐饮 POI")
        validated, rejected, issues = [], 0, {}
        for item in items:
            clean, item_issues = validate_item(item, lat, lng)
            for key in item_issues:
                issues[key] = issues.get(key, 0) + 1
            if clean:
                validated.append(self.normalize(clean))
            else:
                rejected += 1
        unique, dropped = dedupe_items(validated)
        STATS.record_items("baidu", len(unique), rejected + dropped, issues)
        unique.sort(key=lambda x: x["distance"])
        if not unique:
            if start > 0:
                return []
            raise ProviderError("baidu", "周边未返回餐饮 POI")
        align = start % self.PAGE_SIZE
        if align:
            unique = unique[align:]
        page = unique[:want]
        self.page_info = {
            "total": total,
            "hasMore": (start // self.PAGE_SIZE * self.PAGE_SIZE + len(unique)) < total,
        }
        return page
        return unique

    def place_detail(self, poi_id: str) -> dict | None:
        payload = self._get("/place/v2/detail", {"uid": poi_id, "scope": 2})
        detail = payload.get("detail") or {}
        if not detail:
            return None
        location = detail.get("location") or {}
        if not location:
            return None
        glat, glng = bd09_to_gcj02(float(location["lat"]), float(location["lng"]))
        cuisine = classify(detail.get("type") or "", detail.get("name") or "")
        return self.normalize({
            "id": detail.get("uid") or poi_id,
            "name": detail.get("name") or "未命名商家",
            "cuisine": cuisine,
            "category": "drink" if cuisine in DRINK_CUISINES else "main",
            "subCuisine": detail.get("tag") or cuisine,
            "rating": _to_float(detail.get("overall_rating")),
            "avgPrice": int(_to_float(detail.get("price"), 0)) or None,
            "lat": glat,
            "lng": glng,
            "address": detail.get("address") or "",
            "area": detail.get("area") or "",
            "businessHours": detail.get("shop_hours") or "",
            "tags": [],
            "cover": "",
            "gallery": [],
            "distance": None,
            "source": "baidu",
        })

    # ---------------- 地理编码 ----------------
    def geocode(self, query: str, city: str) -> dict | None:
        payload = self._get("/geocoding/v3/", {"address": query, "city": city or "全国"})
        location = (payload.get("result") or {}).get("location") or {}
        if not location:
            return None
        glat, glng = bd09_to_gcj02(float(location["lat"]), float(location["lng"]))
        return {"lat": glat, "lng": glng, "name": query, "city": city, "source": "baidu"}

    # ---------------- 路径规划 ----------------
    def route(self, origin: tuple, dest: tuple, mode: str) -> dict:
        (olat, olng), (dlat, dlng) = origin, dest
        blat1, blng1 = gcj02_to_bd09(olat, olng)
        blat2, blng2 = gcj02_to_bd09(dlat, dlng)
        endpoint = {"walking": "walking", "cycling": "riding", "driving": "driving"}.get(mode, "walking")
        payload = self._get(f"/directionlite/v1/{endpoint}", {
            "origin": f"{blat1},{blng1}",
            "destination": f"{blat2},{blng2}",
        })
        routes = ((payload.get("result") or {}).get("routes")) or []
        if not routes:
            raise ProviderError("baidu", "未返回可用路线")
        route = routes[0]
        polyline, steps = [], []
        for step in route.get("steps") or []:
            for pair in (step.get("path") or "").split(";"):
                if "," in pair:
                    lng, lat = pair.split(",", 1)[:2]
                    try:
                        glat, glng = bd09_to_gcj02(float(lat), float(lng))
                    except ValueError:
                        continue
                    polyline.append([glat, glng])
            if step.get("instruction"):
                steps.append({
                    "instruction": str(step["instruction"]).replace("<", "").replace(">", ""),
                    "distance": int(_to_float(step.get("distance"), 0)),
                })
        distance = int(_to_float(route.get("distance"), 0)) or int(sum(s["distance"] for s in steps))
        duration = int(_to_float(route.get("duration"), 0) / 60) or duration_minutes(distance, mode)
        return {
            "source": "baidu",
            "mode": mode,
            "distance": distance,
            "duration": max(1, duration),
            "polyline": polyline,
            "featuredSegment": None,
            "featuredStreet": None,
            "steps": steps,
            "origin": {"lat": olat, "lng": olng},
            "destination": {"lat": dlat, "lng": dlng},
        }
