"""数据编排层：主源 → 备源 → 扩大半径 → 友好报错。

对外只暴露 search / detail / route / play_spots / geocode，
内部负责数据源顺序、半径扩张、异常归一化与合规兜底。

注意：限流与重试统一由 services/crawler.py 处理（按 host 1~3 秒、指数退避、≤2 次重试），
本层不再叠加睡眠，避免出现重复等待。
"""

from __future__ import annotations

import logging

from .crawler import crawl_snapshot
from .errors import FriendlyError, ProviderError
from .geo import format_distance, haversine
from .holiday import HolidayCalendar
from .provider_amap import AmapProvider
from .provider_baidu import BaiduProvider
from .provider_demo import DemoProvider
from .provider_osm import OsmProvider
from .ranker import annotate_featured_segment, contextual_rank, rank_play_spots

log = logging.getLogger("weekend_eat")

FRIENDLY_EMPTY = "附近暂时没找到合适的店"
FRIENDLY_HINT = "点我重试，或手动输入「城市 + 商圈」再试一次"


class DataService:
    def __init__(self, config):
        self.config = config
        self.demo = DemoProvider()
        self.amap = AmapProvider(config["AMAP_WEB_KEY"], timeout=config["REQUEST_TIMEOUT"])
        self.baidu = BaiduProvider(config["BAIDU_WEB_AK"], timeout=config["REQUEST_TIMEOUT"])
        self.osm = OsmProvider(timeout=max(config["REQUEST_TIMEOUT"], 8.0))
        self.holiday = HolidayCalendar()

        forced = (config["MAP_PROVIDER"] or "auto").lower()
        if forced in ("amap", "baidu", "osm", "demo"):
            self.order = [forced]
        else:
            # auto：真实地图平台优先，未配置 Key 时自动落到演示数据（界面会标注）
            self.order = ["amap", "baidu", "demo"] if config["ALLOW_DEMO_FALLBACK"] else ["amap", "baidu"]

    # ---------------- 内部工具 ----------------
    def providers(self) -> list:
        mapping = {"amap": self.amap, "baidu": self.baidu, "osm": self.osm, "demo": self.demo}
        return [mapping[name] for name in self.order if name in mapping]

    @staticmethod
    def _call(provider_name, func, *args, **kwargs):
        """单次调用。网络重试由 crawler.fetch_json 负责，这里只做异常归一。"""
        try:
            return func(*args, **kwargs)
        except ProviderError:
            raise
        except Exception as exc:  # 解析等未预期异常，避免污染前端
            log.exception("provider crashed: %s", exc)
            raise ProviderError(provider_name, "解析异常", retryable=False)

    # ---------------- 搜索 ----------------
    def search(self, lat: float, lng: float, radius: int = 3000, keyword: str = "",
               strict: bool = False, offset: int = 0, limit: int = 50) -> dict:
        """strict=True 用于半径分页：严格按传入半径返回，不自动扩张。

        非 strict 保持原行为：结果过少时逐级扩大半径兜底。

        offset/limit 是「按距离升序」的游标分页。只加大 radius 而不翻页时，
        数据源永远返回最近的同一批店（高德 /place/around 只给最近 N 家），
        翻页就会一直拿到重复结果——这是之前「越翻越没有新店」的根因。
        """
        offset = max(0, min(1000, int(offset or 0)))
        limit = max(1, min(100, int(limit or 50)))
        if strict:
            steps = [max(1000, min(8000, int(radius)))]
        else:
            steps = [r for r in self.config["SEARCH_RADIUS_STEPS"] if r >= radius]
            if not steps:
                steps = [self.config["SEARCH_RADIUS_STEPS"][-1]]
        tried = []
        last_error = None

        for step_index, step_radius in enumerate(steps):
            for provider in self.providers():
                if not provider.available():
                    continue
                tried.append(f"{provider.name}:{step_radius}")
                try:
                    items = self._call(provider.name, provider.search_nearby,
                                       lat, lng, step_radius, keyword, offset, limit)
                except ProviderError as exc:
                    last_error = exc
                    continue

                if not items:
                    if offset > 0:
                        # 翻到这一档末尾不是错误：返回空页，由前端决定升档
                        return self._page_payload([], provider, step_radius, radius,
                                                  offset, limit, tried, has_more=False)
                    break

                # 首页结果过少时扩大半径再试（演示源除外，避免无意义放大）
                if offset == 0 and len(items) < 3 and provider.name != "demo" and step_index < len(steps) - 1:
                    break

                for item in items:
                    item["distanceLabel"] = format_distance(item.get("distance") or 0)
                return self._page_payload(items, provider, step_radius, radius,
                                          offset, limit, tried)

        log.warning("search exhausted: %s", last_error)
        raise FriendlyError(FRIENDLY_EMPTY, hint=FRIENDLY_HINT, code="empty")

    @staticmethod
    def _page_payload(items, provider, step_radius, requested, offset, limit, tried, has_more=None) -> dict:
        if has_more is None:
            info = getattr(provider, "page_info", None) or {}
            has_more = info.get("hasMore")
        if has_more is None:
            has_more = len(items) >= limit
        return {
            "ok": True,
            "items": items,
            "source": provider.name,
            "sourceLabel": provider.label,
            "demo": provider.name == "demo",
            "radius": step_radius,
            "requestedRadius": requested,
            "expanded": step_radius > requested,
            "offset": offset,
            "limit": limit,
            "nextOffset": offset + len(items),
            "hasMore": bool(has_more),
            "tried": tried,
            "total": len(items),
        }

    # ---------------- 详情 ----------------
    def detail(self, poi_id: str) -> dict:
        if not poi_id:
            raise FriendlyError("这家店的信息不完整", code="bad_request")

        if poi_id.startswith("demo-"):
            item = self.demo.place_detail(poi_id)
            if item:
                return item
            raise FriendlyError("这家店暂时找不到了", hint="换个关键词搜搜看", code="not_found")

        for provider in self.providers():
            if provider.name in ("demo", "osm") or not provider.available():
                continue
            try:
                item = self._call(provider.name, provider.place_detail, poi_id)
            except ProviderError as exc:
                log.warning("detail failed: %s", exc)
                continue
            if item:
                item["reviews"] = []
                item["notes"] = []
                item["complianceNote"] = "评价仅使用地图 POI 公开摘要，可跳转原平台查看完整内容。"
                return item

        raise FriendlyError("这家店的详情暂时没拉到", hint="稍后再试，或先看看别家", code="not_found")

    # ---------------- 路线 ----------------
    def route(self, origin: tuple, dest: tuple, mode: str = "walking") -> dict:
        mode = mode if mode in ("walking", "cycling", "driving") else "walking"
        for provider in self.providers():
            if provider.name in ("demo", "osm") or not provider.available():
                continue
            try:
                route = self._call(provider.name, provider.route, origin, dest, mode)
            except ProviderError as exc:
                log.warning("route failed: %s", exc)
                continue
            if route and route.get("polyline"):
                route["fallback"] = False
                return annotate_featured_segment(route, self.featured_streets())

        route = self.demo.route(origin, dest, mode)
        route["fallback"] = True
        return annotate_featured_segment(route, self.featured_streets())

    # ---------------- 游玩点位 ----------------
    def play_spots(self, store: dict) -> dict:
        spots, streets = None, self.featured_streets()
        for provider in self.providers():
            if provider.name != "amap" or not provider.available():
                continue
            try:
                spots = self._call(provider.name, provider.play_spots, store["lat"], store["lng"])
            except (ProviderError, AttributeError) as exc:
                log.warning("play spots failed: %s", exc)
                spots = None
            if spots:
                for spot in spots:
                    if not spot.get("distance"):
                        spot["distance"] = round(
                            haversine(store["lat"], store["lng"], spot["lat"], spot["lng"])
                        )
                break

        source = "amap"
        if not spots:
            spots, streets = self.demo.play_spots(store["lat"], store["lng"])
            source = "demo"

        ranked = rank_play_spots(spots, store, streets)
        return {
            "ok": True,
            "items": ranked,
            "source": source,
            "featuredStreets": streets,
            "rule": {
                "featuredBoost": "特色街巷 / 特色步行路段权重 +30%",
                "detourLimit": "绕行超过 500 米自动切回最短路径",
                "smoothness": "顺路度 = 100 − 绕行米数 ÷ 500 × 100",
            },
        }

    def featured_streets(self) -> list:
        return self.demo.play_data.get("featuredStreets", [])

    # ---------------- 地理编码 ----------------
    def geocode(self, query: str, city: str = "北京") -> dict:
        query = (query or "").strip()
        if not query:
            raise FriendlyError("请输入城市 + 商圈", code="bad_request")
        for provider in self.providers():
            if provider.name in ("demo", "osm") or not provider.available():
                continue
            try:
                result = self._call(provider.name, provider.geocode, query, city)
            except ProviderError as exc:
                log.warning("geocode failed: %s", exc)
                continue
            if result:
                return result
        result = self.demo.geocode(query, city)
        if not result:
            raise FriendlyError(
                "这个商圈还没收录",
                hint="演示模式内置望京、三里屯等 12 个商圈；配置地图 Key 后可任意搜索",
                code="not_found",
            )
        return result

    # ---------------- 逆地理编码 ----------------
    def regeo(self, lat: float, lng: float) -> dict | None:
        for provider in self.providers():
            if provider.name in ("demo", "osm") or not provider.available():
                continue
            try:
                result = self._call(provider.name, provider.regeo, lat, lng)
            except (ProviderError, AttributeError) as exc:
                log.warning("regeo failed: %s", exc)
                continue
            if result:
                return result
        return None

    # ---------------- IP 定位 ----------------
    def ip_locate(self, ip: str = "") -> dict | None:
        for provider in self.providers():
            if provider.name in ("demo", "osm") or not provider.available():
                continue
            try:
                result = self._call(provider.name, provider.ip_locate, ip)
            except (ProviderError, AttributeError) as exc:
                log.warning("ip_locate failed: %s", exc)
                continue
            if result:
                return result
        return None

    # ---------------- 定位上下文（地址 + 地标 + 区域洞察 + 位置感知推荐） ----------------
    def locate_context(self, lat: float, lng: float, radius: int = 3000) -> dict:
        address = self.regeo(lat, lng)

        landmarks = []
        for provider in self.providers():
            if provider.name != "amap" or not provider.available():
                continue
            try:
                landmarks = self._call(provider.name, provider.landmarks, lat, lng, 1200, 12)
            except (ProviderError, AttributeError) as exc:
                log.warning("landmarks failed: %s", exc)
            break

        insight = self._area_insight(landmarks, address)

        # 位置感知推荐：对周边店按「步行可达/地标邻近/口碑/时段」重排，前 8 家带拆解
        picks = []
        try:
            payload = self.search(lat, lng, radius)
            picks = contextual_rank(payload.get("items") or [], {
                "lat": lat, "lng": lng, "landmarks": landmarks,
            }, limit=8)
        except FriendlyError as exc:
            log.warning("context rank skipped: %s", exc)

        return {
            "ok": True,
            "address": address,
            "landmarks": landmarks,
            "insight": insight,
            "picks": picks,
        }

    @staticmethod
    def _area_insight(landmarks: list, address: dict | None) -> dict:
        """按周边地标构成推断区域类型，解释推荐为什么这样排。"""
        kinds = {}
        for landmark in landmarks:
            kind = landmark.get("kind") or "地标"
            kinds[kind] = kinds.get(kind, 0) + 1

        if kinds.get("商场", 0) >= 2:
            area_type, tip = "商圈型", "商场集中，餐饮选择多，适合逛吃"
        elif kinds.get("地铁", 0) + kinds.get("公交", 0) >= 2:
            area_type, tip = "交通枢纽型", "公共交通便利，通勤顺路选店更省时间"
        elif kinds.get("公园", 0) + kinds.get("景点", 0) >= 2:
            area_type, tip = "休闲型", "公园景点多，适合饭后散步"
        elif address and address.get("poi"):
            area_type, tip = "生活区", f"位于{address['poi']}附近，以周边日常餐饮为主"
        else:
            area_type, tip = "生活区", "以居民日常餐饮为主"

        nearest = landmarks[0] if landmarks else None
        return {
            "areaType": area_type,
            "tip": tip,
            "landmarkKinds": kinds,
            "nearestLandmark": {
                "name": nearest.get("name"),
                "kind": nearest.get("kind"),
                "distance": nearest.get("distance"),
            } if nearest else None,
            "walkableRadius": 800,
            "rule": "步行可达 40% · 地标邻近 20% · 口碑 20% · 时段匹配 20%",
        }

    # ---------------- 日历 ----------------
    def weekend_info(self) -> dict:
        from datetime import date
        return self.holiday.info(date.today())

    def suggestions(self, city: str = "北京") -> list:
        return self.demo.suggestions(city)

    # ---------------- 采集透明度 ----------------
    def sources_info(self, active: str = "") -> dict:
        snapshot = crawl_snapshot()
        snapshot["active"] = active
        snapshot["configuredOrder"] = list(self.order)
        snapshot["keys"] = {
            "amap": bool(self.config["AMAP_WEB_KEY"]),
            "baidu": bool(self.config["BAIDU_WEB_AK"]),
            "osm": True,
            "demo": True,
        }
        return snapshot

