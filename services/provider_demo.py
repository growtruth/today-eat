"""演示数据源：无 Key 时保证五页链路可完整跑通。

数据全部为本项目自建（data/*.json），不包含任何来自第三方平台的抓取内容。
"""

from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

from .errors import ProviderError
from .geo import duration_minutes, haversine, offset_point
from .provider_base import BaseProvider

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# 常见商圈中心点（用于“手动输入城市+商圈”）
AREA_CENTERS = {
    "望京": (39.9963, 116.4703),
    "三里屯": (39.9337, 116.4553),
    "五道口": (39.9928, 116.3376),
    "国贸": (39.9087, 116.4610),
    "中关村": (39.9835, 116.3163),
    "西单": (39.9130, 116.3740),
    "王府井": (39.9147, 116.4100),
    "朝阳大悦城": (39.9243, 116.5170),
    "酒仙桥": (39.9740, 116.4930),
    "亚运村": (39.9930, 116.4030),
    "亦庄": (39.7950, 116.5060),
    "上地": (40.0330, 116.3080),
}

CUISINE_KEYWORDS = {
    "火锅": ["火锅", "涮肉", "涮羊肉", "串串香"],
    "日料": ["日本料理", "寿司", "居酒屋", "日式", "刺身"],
    "烧烤": ["烧烤", "烤串", "烤肉", "串吧"],
    "甜品": ["甜品", "蛋糕", "面包", "冰淇淋", "烘焙"],
    "咖啡": ["咖啡"],
    "奶茶": ["奶茶", "茶饮", "饮品", "果汁"],
    "小吃": ["小吃", "面馆", "包子", "炸酱面", "卤煮", "快餐"],
    "川菜": ["川菜", "四川", "重庆"],
    "西餐": ["西餐", "牛排", "意大利", "酒吧", "酒馆"],
}

DRINK_CUISINES = {"甜品", "咖啡", "奶茶"}


def _load(name: str) -> dict:
    try:
        return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProviderError("demo", f"演示数据读取失败：{name}") from exc


class DemoProvider(BaseProvider):
    name = "demo"
    label = "演示数据"

    def __init__(self):
        self._stores = None
        self._reviews = None
        self._play = None
        self._review_cache = {}

    # ---------------- 懒加载 ----------------
    @property
    def stores(self) -> list:
        if self._stores is None:
            self._stores = _load("restaurants.json")["items"]
        return self._stores

    @property
    def review_data(self) -> dict:
        if self._reviews is None:
            self._reviews = _load("reviews.json")
        return self._reviews

    @property
    def play_data(self) -> dict:
        if self._play is None:
            self._play = _load("play_spots.json")
        return self._play

    def available(self) -> bool:
        return True

    # ---------------- POI ----------------
    def search_nearby(self, lat: float, lng: float, radius: int, keyword: str = "",
                      offset: int = 0, limit: int = 50) -> list:
        result = []
        kw = (keyword or "").strip().lower()
        for store in self.stores:
            distance = haversine(lat, lng, store["lat"], store["lng"])
            if distance > radius:
                continue
            if kw and not (
                kw in store["name"].lower()
                or kw in store["cuisine"].lower()
                or kw in store.get("subCuisine", "").lower()
                or kw in store.get("address", "").lower()
                or kw in store.get("area", "").lower()
            ):
                continue
            item = dict(store)
            item["distance"] = round(distance)
            item["source"] = "demo"
            result.append(self.normalize(item))
        result.sort(key=lambda x: x["distance"])
        start = max(0, int(offset or 0))
        want = max(1, int(limit or 50))
        page = result[start:start + want]
        self.page_info = {"total": len(result), "hasMore": start + len(page) < len(result)}
        return page

    def place_detail(self, poi_id: str) -> dict | None:
        for store in self.stores:
            if store["id"] == poi_id:
                item = dict(store)
                item["source"] = "demo"
                item["reviews"] = self._make_reviews(store)
                item["notes"] = self._make_notes(store)
                return self.normalize(item)
        return None

    def geocode(self, query: str, city: str) -> dict | None:
        q = (query or "").strip()
        if not q:
            return None
        for name, (lat, lng) in AREA_CENTERS.items():
            if name in q or q in name:
                return {"lat": lat, "lng": lng, "name": name, "city": city or "北京", "source": "demo"}
        # 未收录的商圈直接返回 None：不编造坐标，前端提示“未收录”
        return None

    # ---------------- 评价 ----------------
    def _make_reviews(self, store: dict) -> list:
        cached = self._review_cache.get(store["id"])
        if cached is not None:
            return cached

        data = self.review_data
        pool = data["pools"].get(store["cuisine"], data["pools"]["小吃"])
        seed = int(hashlib.md5(store["id"].encode("utf-8")).hexdigest()[:8], 16)
        rnd = random.Random(seed)
        picks = rnd.sample(pool, k=min(6, len(pool)))
        reviews = []
        for idx, base in enumerate(picks):
            likes = int(base["likes"] * rnd.uniform(0.75, 1.25))
            reviews.append({
                "id": f"{store['id']}-r{idx + 1}",
                "user": data["nicknames"][(seed + idx * 3) % len(data["nicknames"])],
                "avatarColor": data["avatarColors"][(seed + idx) % len(data["avatarColors"])],
                "text": base["text"],
                "likes": max(8, likes),
                "platform": "高德地图" if idx % 2 == 0 else "百度地图",
                "time": data["times"][(seed + idx) % len(data["times"])],
            })
        reviews.sort(key=lambda r: r["likes"], reverse=True)
        self._review_cache[store["id"]] = reviews
        return reviews

    def _make_notes(self, store: dict) -> list:
        reviews = self._make_reviews(store)
        return [
            {
                "user": r["user"],
                "avatarColor": r["avatarColor"],
                "text": r["text"],
                "likes": r["likes"],
                "time": r["time"],
                "platform": r["platform"],
            }
            for r in reviews[:3]
        ]

    # ---------------- 路线 ----------------
    def route(self, origin: tuple, dest: tuple, mode: str) -> dict:
        """生成一条带拐点的演示路线，并标出途经的特色街巷段。"""
        (olat, olng), (dlat, dlng) = origin, dest
        straight = haversine(olat, olng, dlat, dlng)
        factor = {"walking": 1.16, "cycling": 1.12, "driving": 1.26}.get(mode, 1.16)

        def pt(ry: float, rx: float):
            return [round(olat + (dlat - olat) * ry, 6), round(olng + (dlng - olng) * rx, 6)]

        # 先横后纵的“街道感”折线，避免地图上出现一条直斜线
        path = [
            [olat, olng],
            pt(0.02, 0.45),
            pt(0.34, 0.45),
            pt(0.34, 0.86),
            pt(0.72, 0.86),
            [dlat, dlng],
        ]

        # 逐段计算长度，找出最长段作为“特色街巷”段
        seg_lengths = []
        for a, b in zip(path, path[1:]):
            seg_lengths.append(haversine(a[0], a[1], b[0], b[1]))
        featured_idx = max(range(len(seg_lengths)), key=lambda i: seg_lengths[i]) if seg_lengths else 0

        street = self._nearest_street(path[len(path) // 2])
        distance = max(straight * factor, sum(seg_lengths))
        steps = self._build_steps(distance, mode, street["name"] if street else "")
        return {
            "source": "demo",
            "mode": mode,
            "distance": int(distance),
            "duration": duration_minutes(distance, mode),
            "polyline": path,
            "featuredSegment": featured_idx,
            "featuredStreet": street,
            "steps": steps,
            "origin": {"lat": olat, "lng": olng},
            "destination": {"lat": dlat, "lng": dlng},
        }

    def _nearest_street(self, point: list) -> dict | None:
        best, best_d = None, 1e9
        for street in self.play_data.get("featuredStreets", []):
            d = haversine(point[0], point[1], street["lat"], street["lng"])
            if d < best_d:
                best, best_d = street, d
        if best and best_d < 2500:
            return {"name": best["name"], "lat": best["lat"], "lng": best["lng"]}
        return None

    def _build_steps(self, distance: int, mode: str, street_name: str) -> list:
        label = {"walking": "步行", "cycling": "骑行", "driving": "驾车"}.get(mode, "步行")
        d1 = int(distance * 0.28)
        d2 = int(distance * 0.44)
        d3 = distance - d1 - d2
        steps = [
            {"instruction": f"从当前位置出发，沿当前道路{label} {d1} 米", "distance": d1},
            {"instruction": f"在下一个路口转向，继续{label} {d2} 米", "distance": d2},
        ]
        if street_name:
            steps.append({"instruction": f"途经{street_name}特色步行段，路面较窄，注意行人", "distance": 0})
        steps.append({"instruction": f"目的地在道路右侧，再{label} {int(round(d3))} 米即到", "distance": int(round(d3))})
        return steps

    # ---------------- 游玩点位 ----------------
    def play_spots(self, store_lat: float, store_lng: float) -> tuple:
        spots = []
        for tpl in self.play_data.get("items", []):
            lat, lng = offset_point(store_lat, store_lng, tpl["distance"], tpl["bearing"])
            spots.append({
                "id": tpl["id"],
                "name": tpl["name"],
                "type": tpl["type"],
                "kind": tpl["kind"],
                "lat": lat,
                "lng": lng,
                "image": tpl.get("image", ""),
                "desc": tpl.get("desc", ""),
                "openTime": tpl.get("openTime", ""),
                "detourRatio": tpl.get("detourRatio", 0.05),
                "source": "demo",
            })
        return spots, self.play_data.get("featuredStreets", [])

    # ---------------- 城市/商圈补全 ----------------
    def suggestions(self, city: str = "北京") -> list:
        return [{"name": k, "city": city} for k in AREA_CENTERS]
