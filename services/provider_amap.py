"""高德地图适配器。

- POI 周边搜索：/v3/place/around
- POI 详情：/v3/place/detail
- 地理编码：/v3/geocode/geo
- 路径规划：/v3/direction/walking|driving，/v4/direction/bicycling

文档：https://lbs.amap.com/api/webservice/summary
Key 申请：https://console.amap.com/dev/key/app （类型选“Web 服务”）
"""

from __future__ import annotations

import re

from .crawler import STATS, dedupe_items, fetch_json, validate_item
from .errors import ProviderError
from .geo import duration_minutes, haversine
from .provider_base import BaseProvider

AMAP_BASE = "https://restapi.amap.com"

FOOD_TYPES = "050000"          # 餐饮服务
PLAY_TYPES = "050500|060100|110000|080600"  # 咖啡厅|书店|风景名胜|剧场

# 定位详情用的周边地标：地铁站|公交站|商场|风景名胜|公园广场
LANDMARK_TYPES = "150500|150700|060100|110000|110200"

LANDMARK_KINDS = [
    ("地铁", ("地铁", "轻轨")),
    ("公交", ("公交", "巴士")),
    ("商场", ("商场", "购物中心", "百货", "商业街")),
    ("公园", ("公园", "广场", "绿地")),
    ("景点", ("风景", "名胜", "景点", "博物馆", "美术馆", "展览馆")),
]


def landmark_kind(type_text: str, name: str = "") -> str:
    blob = f"{type_text}{name}"
    for kind, keys in LANDMARK_KINDS:
        if any(k in blob for k in keys):
            return kind
    return "地标"

CUISINE_RULES = [
    ("火锅", ("火锅", "涮肉", "涮羊肉", "串串香")),
    ("日料", ("日本料理", "寿司", "居酒屋", "日式", "刺身")),
    ("烧烤", ("烧烤", "烤串", "烤肉", "串吧")),
    ("甜品", ("甜品", "蛋糕", "面包", "冰淇淋", "烘焙")),
    ("咖啡", ("咖啡",)),
    ("奶茶", ("奶茶", "茶饮", "饮品", "果汁")),
    ("小吃", ("小吃", "面馆", "包子", "炸酱面", "卤煮", "快餐")),
    ("川菜", ("川菜", "四川", "重庆")),
    ("西餐", ("西餐", "牛排", "意大利", "酒吧", "酒馆")),
]
DRINK_CUISINES = {"甜品", "咖啡", "奶茶"}


def _to_float(value, default=None):
    # biz_ext.cost / rating 可能是字符串，也可能是列表（取首项）
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    try:
        number = float(value)
        return number if number > 0 else default
    except (TypeError, ValueError):
        return default


def classify(type_text: str, name: str) -> str:
    blob = f"{type_text}{name}"
    for cuisine, keys in CUISINE_RULES:
        if any(k in blob for k in keys):
            return cuisine
    return "中餐"


def _split_hours(raw: str):
    """把 '周一至周日 09:00-21:00' / '10:00-14:00,17:00-21:00' 拆成首个时段；保留跨夜的「次日」前缀。"""
    if not raw:
        return "", ""
    match = re.search(r"(\d{1,2}:\d{2})\s*[-~]\s*(次日)?\s*(\d{1,2}:\d{2})", raw)
    if not match:
        return "", ""
    start = match.group(1)
    close = ("次日 " if match.group(2) else "") + match.group(3)
    return start, close


class AmapProvider(BaseProvider):
    name = "amap"
    label = "高德地图"

    def __init__(self, web_key: str, timeout: float = 6.0):
        self.key = web_key
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.key)

    # ---------------- 基础请求 ----------------
    def _get(self, path: str, params: dict) -> dict:
        if not self.key:
            raise ProviderError("amap", "未配置 AMAP_WEB_KEY", retryable=False)
        payload = fetch_json(f"{AMAP_BASE}{path}", {**params, "key": self.key}, "amap", self.timeout)
        if str(payload.get("status")) != "1":
            raise ProviderError("amap", payload.get("info", "接口返回失败"))
        return payload

    # ---------------- POI ----------------
    PAGE_SIZE = 25
    MAX_PAGES = 8  # 单次最多翻 8 页（200 条），避免一次请求把配额吃光

    def search_nearby(self, lat: float, lng: float, radius: int, keyword: str = "",
                      offset: int = 0, limit: int = 50) -> list:
        """按距离升序翻页：offset 是已取条数，page 从 offset//25+1 开始。

        高德 /place/around 本身只给「最近 N 家」，必须靠 page 才能拿到更远的店；
        只按 radius 反复查同一批最近结果，永远翻不出新店。
        """
        want = max(1, int(limit or 50))
        start = max(0, int(offset or 0))
        first_page = start // self.PAGE_SIZE + 1
        page_count = min(self.MAX_PAGES, max(1, (want + self.PAGE_SIZE - 1) // self.PAGE_SIZE))

        items = []
        total = 0
        last_page = first_page - 1
        last_page_size = 0
        for page in range(first_page, first_page + page_count):
            payload = self._get("/v3/place/around", {
                "location": f"{lng},{lat}",
                "radius": radius,
                "types": FOOD_TYPES,
                "keywords": keyword or None,
                "offset": self.PAGE_SIZE,
                "page": page,
                "extensions": "all",
                "sortrule": "distance",
            })
            pois = payload.get("pois") or []
            if not pois:
                break
            total = int(payload.get("count") or total or 0)
            last_page = page
            last_page_size = len(pois)
            for poi in pois:
                item = self._parse_poi(poi, lat, lng)
                if item:
                    items.append(item)
            if len(pois) < self.PAGE_SIZE:
                break
        # 是否能继续往后翻：优先用服务端总数，缺失时退回「最后一页是否取满」
        if total:
            self.page_info = {"total": total, "hasMore": last_page * self.PAGE_SIZE < total}
        else:
            self.page_info = {"total": 0, "hasMore": last_page_size >= self.PAGE_SIZE}
        # 字段清洗 + 坐标/评分/人均校验 + 距离复算 + 去重
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
        STATS.record_items("amap", len(unique), rejected + dropped, issues)
        unique.sort(key=lambda x: x.get("distance", 0))
        if not unique:
            # 翻页翻到底不是错误：交给上层返回「没有更多」
            if start > 0:
                return []
            raise ProviderError("amap", "周边未返回餐饮 POI")
        align = start % self.PAGE_SIZE
        if align:
            unique = unique[align:]
        return unique[:want]

    def _parse_poi(self, poi: dict, user_lat: float, user_lng: float) -> dict | None:
        location = poi.get("location") or ""
        if "," not in location:
            return None
        try:
            lng, lat = [float(x) for x in location.split(",", 1)]
        except ValueError:
            return None

        biz = poi.get("biz_ext") or {}
        rating = _to_float(biz.get("rating"))
        cost = _to_float(biz.get("cost"))
        type_text = poi.get("type") or ""
        cuisine = classify(type_text, poi.get("name") or "")
        photos = poi.get("photos") or []
        gallery = [p.get("url") for p in photos[:6] if isinstance(p, dict) and p.get("url")]
        hours = biz.get("opentime2") or biz.get("open_time") or biz.get("business_time") or ""
        open_t, close_t = _split_hours(hours)

        tags = []
        if cost and cost >= 100:
            tags.append("周末友好")
        if cost and cost >= 150:
            tags.append("有包间")
        if rating and rating >= 4.5 and len(gallery) >= 3:
            tags.append("适合拍照")

        address = poi.get("address")
        if isinstance(address, list):
            address = "".join(address)

        return self.normalize({
            "id": poi.get("id"),
            "name": poi.get("name") or "未命名商家",
            "cuisine": cuisine,
            "category": "drink" if cuisine in DRINK_CUISINES else "main",
            "subCuisine": (type_text.split(";")[-1] if type_text else cuisine),
            "rating": rating,
            "avgPrice": int(cost) if cost else None,
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "address": address or "",
            "area": poi.get("adname") or "",
            "businessHours": hours or "",
            "openTime": open_t,
            "closeTime": close_t,
            "tags": tags,
            "isNew": False,
            "cover": gallery[0] if gallery else "",
            "gallery": gallery,
            "distance": round(haversine(user_lat, user_lng, lat, lng)),
            "source": "amap",
        })

    def place_detail(self, poi_id: str) -> dict | None:
        payload = self._get("/v3/place/detail", {"id": poi_id, "extensions": "all"})
        pois = payload.get("pois") or []
        if not pois:
            return None
        item = self._parse_poi(pois[0], 0, 0)
        if item:
            item["distance"] = None
        return item

    # ---------------- 地理编码 ----------------
    def geocode(self, query: str, city: str) -> dict | None:
        payload = self._get("/v3/geocode/geo", {"address": query, "city": city or "全国"})
        geocodes = payload.get("geocodes") or []
        if not geocodes:
            return None
        location = geocodes[0].get("location") or ""
        if "," not in location:
            return None
        lng, lat = [float(x) for x in location.split(",", 1)]
        return {
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "name": geocodes[0].get("formatted_address") or query,
            "city": geocodes[0].get("city") or city,
            "source": "amap",
        }

    # ---------------- 逆地理编码 ----------------
    @staticmethod
    def _first(value):
        """高德部分字段可能是列表（如直辖市 city 为 []），统一取首项。"""
        if isinstance(value, (list, tuple)):
            return value[0] if value else ""
        return value or ""

    def regeo(self, lat: float, lng: float) -> dict | None:
        # extensions=all 才会返回 aois/pois，用于精确到 POI 级
        payload = self._get("/v3/geocode/regeo", {"location": f"{lng},{lat}", "extensions": "all"})
        regeo = payload.get("regeocode") or {}
        if not regeo:
            return None
        component = regeo.get("addressComponent") or {}
        province = self._first(component.get("province"))
        city = self._first(component.get("city"))
        district = self._first(component.get("district"))
        township = self._first(component.get("township"))
        street_number = component.get("streetNumber") or {}
        street = self._first(street_number.get("street")) if isinstance(street_number, dict) else ""

        # 直辖市 city 常为空，用 province 补前缀，避免缺省
        prefix = city or province
        label = "".join([prefix, district, township]) or regeo.get("formatted_address") or "当前位置"

        # POI 级：优先 AOI（小区/园区/商场），其次最近 POI
        poi_name, poi_type, poi_distance = "", "", None
        aois = regeo.get("aois") or []
        pois = regeo.get("pois") or []
        if aois and isinstance(aois[0], dict):
            poi_name = aois[0].get("name") or ""
            poi_type = aois[0].get("type") or ""
            poi_distance = _to_float(aois[0].get("distance"), 0)
        elif pois and isinstance(pois[0], dict):
            poi_name = pois[0].get("name") or ""
            poi_type = pois[0].get("type") or ""
            poi_distance = _to_float(pois[0].get("distance"), 0)

        precise = f"{label} · {poi_name}" if poi_name and poi_name not in label else label
        return {
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "name": regeo.get("formatted_address") or label,
            "city": city or province,
            "district": district,
            "township": township,
            "street": street,
            "label": label,
            "poi": poi_name,
            "poiType": poi_type,
            "poiDistance": int(poi_distance) if poi_distance is not None else None,
            "precise": precise,
            "level": "poi" if poi_name else "street",
            "source": "amap",
        }

    # ---------------- 周边地标 ----------------
    def landmarks(self, lat: float, lng: float, radius: int = 1000, limit: int = 12) -> list:
        try:
            payload = self._get("/v3/place/around", {
                "location": f"{lng},{lat}",
                "radius": max(200, min(5000, radius)),
                "types": LANDMARK_TYPES,
                "offset": max(1, min(25, limit)),
                "page": 1,
                "extensions": "base",
                "sortrule": "distance",
            })
        except ProviderError:
            return []  # 地标是增强信息，失败不阻断定位

        items = []
        for poi in payload.get("pois") or []:
            location = poi.get("location") or ""
            if "," not in location:
                continue
            try:
                plng, plat = [float(x) for x in location.split(",", 1)]
            except ValueError:
                continue
            type_text = poi.get("type") or ""
            address = poi.get("address")
            if isinstance(address, list):
                address = "".join(str(x) for x in address)
            items.append({
                "id": poi.get("id"),
                "name": poi.get("name") or "未命名地标",
                "type": type_text,
                "kind": landmark_kind(type_text, poi.get("name") or ""),
                "address": address or "",
                "lat": round(plat, 6),
                "lng": round(plng, 6),
                "distance": round(haversine(lat, lng, plat, plng)),
                "tel": poi.get("tel") if isinstance(poi.get("tel"), str) else "",
            })
        items.sort(key=lambda x: x["distance"])
        return items[:limit]

    # ---------------- IP 定位 ----------------
    def ip_locate(self, ip: str = "") -> dict | None:
        payload = self._get("/v3/ip", {"ip": ip} if ip else {})
        province = self._first(payload.get("province"))
        city = self._first(payload.get("city"))
        adcode = payload.get("adcode") or ""
        rectangle = payload.get("rectangle") or ""

        lat = lng = None
        if rectangle and ";" in rectangle:
            try:
                p1, p2 = rectangle.split(";", 1)
                lng1, lat1 = [float(x) for x in p1.split(",", 1)]
                lng2, lat2 = [float(x) for x in p2.split(",", 1)]
                lat = round((lat1 + lat2) / 2, 6)
                lng = round((lng1 + lng2) / 2, 6)
            except (ValueError, IndexError):
                lat = lng = None

        label = province if province == city else (province + city)
        return {
            "province": province,
            "city": city,
            "adcode": adcode,
            "lat": lat,
            "lng": lng,
            "label": label or "全国",
            "accuracy": "city",
            "source": "amap",
        }

    # ---------------- 路径规划 ----------------
    def route(self, origin: tuple, dest: tuple, mode: str) -> dict:
        (olat, olng), (dlat, dlng) = origin, dest
        if mode == "cycling":
            payload = self._get("/v4/direction/bicycling", {
                "origin": f"{olng},{olat}",
                "destination": f"{dlng},{dlat}",
            })
            paths = ((payload.get("data") or {}).get("paths")) or []
        else:
            endpoint = "driving" if mode == "driving" else "walking"
            payload = self._get(f"/v3/direction/{endpoint}", {
                "origin": f"{olng},{olat}",
                "destination": f"{dlng},{dlat}",
                "extensions": "all",
            })
            paths = ((payload.get("route") or {}).get("paths")) or []

        if not paths:
            raise ProviderError("amap", "未返回可用路线")
        path = paths[0]
        polyline = []
        steps = []
        for step in path.get("steps") or []:
            for pair in (step.get("polyline") or "").split(";"):
                if "," in pair:
                    lng, lat = pair.split(",", 1)[:2]
                    try:
                        polyline.append([float(lat), float(lng)])
                    except ValueError:
                        continue
            instruction = step.get("instruction")
            if instruction:
                steps.append({"instruction": instruction, "distance": int(_to_float(step.get("distance"), 0))})

        distance = int(_to_float(path.get("distance"), 0)) or int(
            sum(s["distance"] for s in steps)
        )
        duration = int(_to_float(path.get("duration"), 0) / 60) or duration_minutes(distance, mode)
        return {
            "source": "amap",
            "mode": mode,
            "distance": distance,
            "duration": max(1, duration),
            "polyline": polyline,
            "featuredSegment": None,
            "featuredStreet": None,
            "steps": steps,
            "origin": {"lat": olat, "lng": olng},
            "destination": {"lat": dlat, "lng": dlng},
            "taxiCost": path.get("taxi_cost"),
        }

    # ---------------- 游玩点位 ----------------
    def play_spots(self, lat: float, lng: float, radius: int = 1200) -> list:
        payload = self._get("/v3/place/around", {
            "location": f"{lng},{lat}",
            "radius": radius,
            "types": PLAY_TYPES,
            "offset": 20,
            "page": 1,
            "extensions": "all",
            "sortrule": "distance",
        })
        spots = []
        for poi in payload.get("pois") or []:
            location = poi.get("location") or ""
            if "," not in location:
                continue
            try:
                plng, plat = [float(x) for x in location.split(",", 1)]
            except ValueError:
                continue
            type_text = poi.get("type") or ""
            kind = "小众特色" if any(k in type_text for k in ("咖啡", "书店", "特色")) else "大众景点"
            photos = poi.get("photos") or []
            gallery = [p.get("url") for p in photos[:2] if isinstance(p, dict) and p.get("url")]
            spots.append({
                "id": poi.get("id"),
                "name": poi.get("name") or "未命名点位",
                "type": kind,
                "kind": (type_text.split(";")[-1] if type_text else "点位"),
                "lat": round(plat, 6),
                "lng": round(plng, 6),
                "image": gallery[0] if gallery else "",
                "desc": poi.get("address") or "",
                "openTime": "",
                "detourRatio": 0.06,
                "distance": round(haversine(lat, lng, plat, plng)),
                "source": "amap",
            })
        if not spots:
            raise ProviderError("amap", "周边未返回游玩点位")
        return spots
