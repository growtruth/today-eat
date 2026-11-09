"""统一数据采集层（爬取 / 接口采集）。

职责：
1. 数据源注册表：明确每个来源的采集范围、许可、频率限制、字段清单；
2. 出口限流：按 host 维持最小请求间隔，避免高频请求被封；
3. 重试与退避：指数退避，区分“可重试”和“不可重试”；
4. 响应校验：字段清洗 + 数值区间校验 + 距离复算 + 去重；
5. 采集统计：请求数 / 成功率 / 平均耗时 / 丢弃条数，供 /api/sources 透明展示。

合规边界（与 PRD 一致，不可放宽）：
- 不抓取美团、大众点评、抖音的单条用户短评；
- 只采集地图开放平台公开 POI、以及 ODbL 许可的 OpenStreetMap 公开数据；
- 图片仅使用 POI 接口返回的公开图片 URL，不绕过防盗链、不下载再分发。
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime

from .errors import ProviderError

log = logging.getLogger("weekend_eat.crawl")

USER_AGENT = (
    "WeekendEatDemo/1.0 (H5 demo; contact: local) "
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
)

CHINA_BBOX = {"min_lat": 3.0, "max_lat": 54.0, "min_lng": 73.0, "max_lng": 136.0}

# 单个响应体上限：防止异常上游返回超大 JSON 拖垮进程
MAX_RESPONSE_BYTES = 3 * 1024 * 1024


# ---------------------------------------------------------------- 数据源注册表
@dataclass(frozen=True)
class SourceSpec:
    key: str
    name: str
    scope: str
    license: str
    homepage: str
    min_interval: float
    requires_key: bool
    fields: tuple
    notes: str = ""


SOURCES = {
    "amap": SourceSpec(
        key="amap",
        name="高德地图开放平台 · Web 服务",
        scope="以用户坐标为中心、半径 ≤8km 的餐饮 POI（类型码 050000）及其公开图片、评分、人均、营业时间",
        license="高德开放平台服务条款（需自行申请 Key，遵守配额与展示要求）",
        homepage="https://lbs.amap.com/api/webservice/summary",
        min_interval=1.0,
        requires_key=True,
        fields=("name", "address", "location", "type", "biz_ext.rating",
                "biz_ext.cost", "biz_ext.opentime2", "photos", "distance"),
        notes="主数据源；POI 详情、路径规划、地理编码同源。",
    ),
    "baidu": SourceSpec(
        key="baidu",
        name="百度地图开放平台 · Place API",
        scope="周边检索半径 ≤8km 的餐饮 POI，坐标系 BD-09，服务端统一转换为 GCJ-02",
        license="百度地图开放平台服务条款（需自行申请 AK）",
        homepage="https://lbsyun.baidu.com/faq/api?title=webapi",
        min_interval=1.0,
        requires_key=True,
        fields=("name", "address", "location", "detail_info.type", "detail_info.tag",
                "detail_info.price", "detail_info.overall_rating", "detail_info.shop_hours"),
        notes="备用源；与高德互为容错。",
    ),
    "osm": SourceSpec(
        key="osm",
        name="OpenStreetMap · Overpass API",
        scope="半径 ≤8km 的 amenity=restaurant/cafe/fast_food/bar/pub 节点与建筑",
        license="ODbL 1.0（开放数据，需署名 OpenStreetMap contributors）",
        homepage="https://wiki.openstreetmap.org/wiki/Overpass_API",
        min_interval=3.0,
        requires_key=False,
        fields=("name", "cuisine", "addr:street", "opening_hours", "phone", "website", "lat", "lon"),
        notes="无 Key 时唯一可用的真实公开数据源；不含评分/人均/图片，字段缺失由前端降级展示。",
    ),
    "demo": SourceSpec(
        key="demo",
        name="项目演示数据",
        scope="data/restaurants.json 内置的 16 家示例门店（望京），仅用于无 Key 时打通交互",
        license="项目自建，图片来自需求包参考素材",
        homepage="",
        min_interval=0.0,
        requires_key=False,
        fields=("全部字段",),
        notes="非真实商家，界面会标注“演示数据”。",
    ),
}


def source_public_list(active: str = "") -> list:
    """对外暴露的数据源说明（不含任何 Key）。"""
    result = []
    for spec in SOURCES.values():
        result.append({
            "key": spec.key,
            "name": spec.name,
            "scope": spec.scope,
            "license": spec.license,
            "homepage": spec.homepage,
            "minInterval": spec.min_interval,
            "requiresKey": spec.requires_key,
            "fields": list(spec.fields),
            "notes": spec.notes,
            "active": spec.key == active,
        })
    return result


# ---------------------------------------------------------------- 限流
class HostLimiter:
    """按 host 维持最小请求间隔（单进程内串行化，避免突发并发）。"""

    def __init__(self):
        self._last = {}
        self._locks = {}
        self._global_lock = threading.Lock()

    def wait(self, host: str, min_interval: float) -> None:
        if min_interval <= 0:
            return
        with self._global_lock:
            lock = self._locks.setdefault(host, threading.Lock())
        with lock:
            last = self._last.get(host, 0.0)
            elapsed = time.monotonic() - last
            if elapsed < min_interval:
                time.sleep(min_interval - elapsed)
            self._last[host] = time.monotonic()


# ---------------------------------------------------------------- 统计
@dataclass
class SourceStat:
    requests: int = 0
    success: int = 0
    failed: int = 0
    items: int = 0
    rejected: int = 0
    total_ms: float = 0.0
    last_error: str = ""
    last_at: str = ""
    issues: dict = field(default_factory=dict)


class CrawlStats:
    def __init__(self):
        self._data = {key: SourceStat() for key in SOURCES}
        self._lock = threading.Lock()

    def record(self, source: str, ok: bool, elapsed_ms: float, items: int = 0, rejected: int = 0,
               error: str = "", issues: dict | None = None) -> None:
        with self._lock:
            stat = self._data.setdefault(source, SourceStat())
            stat.requests += 1
            stat.total_ms += elapsed_ms
            stat.last_at = datetime.now().strftime("%H:%M:%S")
            if ok:
                stat.success += 1
                stat.items += items
                stat.rejected += rejected
            else:
                stat.failed += 1
                stat.last_error = error[:120]
            for key, count in (issues or {}).items():
                stat.issues[key] = stat.issues.get(key, 0) + count

    def record_items(self, source: str, items: int, rejected: int = 0, issues: dict | None = None) -> None:
        """只累计解析结果，不增加请求计数。"""
        with self._lock:
            stat = self._data.setdefault(source, SourceStat())
            stat.items += items
            stat.rejected += rejected
            for key, count in (issues or {}).items():
                stat.issues[key] = stat.issues.get(key, 0) + count

    def snapshot(self) -> dict:
        with self._lock:
            out = {}
            for key, stat in self._data.items():
                avg = round(stat.total_ms / stat.requests) if stat.requests else 0
                out[key] = {
                    "requests": stat.requests,
                    "success": stat.success,
                    "failed": stat.failed,
                    "items": stat.items,
                    "rejected": stat.rejected,
                    "avgMs": avg,
                    "lastError": stat.last_error,
                    "lastAt": stat.last_at,
                    "issues": dict(stat.issues),
                }
            return out


LIMITER = HostLimiter()
STATS = CrawlStats()


# ---------------------------------------------------------------- 请求
def fetch_json(url: str, params: dict | None = None, source: str = "amap",
               timeout: float = 6.0, method: str = "GET", retries: int = 2) -> dict:
    """带限流、重试、退避的 JSON 抓取。"""
    spec = SOURCES.get(source)
    min_interval = spec.min_interval if spec else 1.0
    host = urllib.parse.urlparse(url).netloc
    params = params or {}
    body = None

    if method == "POST":
        body = urllib.parse.urlencode(params).encode("utf-8")
        target = url
    else:
        target = f"{url}?{urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})}"

    last_error = None
    for attempt in range(retries + 1):
        started = time.monotonic()
        LIMITER.wait(host, min_interval)
        request = urllib.request.Request(
            target,
            data=body,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                "Accept-Language": "zh-CN,zh;q=0.9",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw_bytes = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw_bytes) > MAX_RESPONSE_BYTES:
                STATS.record(source, False, (time.monotonic() - started) * 1000, error="response too large")
                raise ProviderError(source, "响应体过大", retryable=False)
            payload = json.loads(raw_bytes.decode("utf-8", errors="replace"))
            STATS.record(source, True, (time.monotonic() - started) * 1000)
            return payload
        except urllib.error.HTTPError as exc:
            elapsed = (time.monotonic() - started) * 1000
            retryable = exc.code == 429 or exc.code >= 500
            last_error = ProviderError(source, f"HTTP {exc.code}", retryable=retryable)
            STATS.record(source, False, elapsed, error=f"HTTP {exc.code}")
            if exc.code == 429:
                try:
                    wait = min(float(exc.headers.get("Retry-After") or 0), 5.0)
                except (TypeError, ValueError):
                    wait = 0
                if wait > 0:
                    time.sleep(wait)
            if not retryable:
                raise last_error from exc
        except json.JSONDecodeError as exc:
            STATS.record(source, False, (time.monotonic() - started) * 1000, error="bad json")
            last_error = ProviderError(source, "返回内容不是合法 JSON", retryable=True)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            STATS.record(source, False, (time.monotonic() - started) * 1000, error=exc.__class__.__name__)
            last_error = ProviderError(source, f"网络异常：{exc.__class__.__name__}", retryable=True)

        if attempt < retries:
            backoff = min(2 ** attempt * 0.6, 3.0)
            log.info("retry %s in %.1fs (%s)", source, backoff, last_error)
            time.sleep(backoff)

    raise last_error or ProviderError(source, "未知错误")


# ---------------------------------------------------------------- 解析与校验
_TAG_RE = re.compile(r"<[^>]+>")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_CJK_RE = re.compile(r"[\u4e00-\u9fa5]")


def clean_text(value, limit: int = 60) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        value = "".join(str(v) for v in value)
    text = _TAG_RE.sub("", str(value))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def parse_hours(raw: str) -> tuple:
    """解析营业时间，返回 (开始, 结束)，仅接受 HH:MM；兼容「周一至周日 09:00-21:00」前缀并保留跨夜的「次日」。"""
    text = clean_text(raw, 60).replace("–", "-").replace("—", "-")
    if not text:
        return "", ""
    # 提取首个 HH:MM[-~](次日)?HH:MM，忽略星期等前缀
    match = re.search(r"(\d{1,2}:\d{2})\s*[-~]\s*(次日)?\s*(\d{1,2}:\d{2})", text)
    if not match:
        return "", ""
    start, close = match.group(1), match.group(3)
    if not (_TIME_RE.match(start) and _TIME_RE.match(close)):
        return "", ""
    if match.group(2):
        close = "次日 " + close
    return start, close


def validate_item(item: dict, user_lat: float | None = None, user_lng: float | None = None) -> tuple:
    """字段清洗 + 数值校验 + 距离复算。

    返回 (清洗后的数据 | None, 问题列表)。问题会累计到采集统计里。
    """
    issues = []
    data = dict(item)

    # 名称
    data["name"] = clean_text(data.get("name"), 40)
    if not data["name"]:
        return None, ["name_missing"]
    if not _CJK_RE.search(data["name"]) and len(data["name"]) < 2:
        return None, ["name_invalid"]

    # 坐标范围（中国境内）
    try:
        lat = float(data.get("lat"))
        lng = float(data.get("lng"))
    except (TypeError, ValueError):
        return None, ["coord_missing"]
    if not (CHINA_BBOX["min_lat"] <= lat <= CHINA_BBOX["max_lat"]
            and CHINA_BBOX["min_lng"] <= lng <= CHINA_BBOX["max_lng"]):
        return None, ["coord_out_of_china"]
    data["lat"], data["lng"] = round(lat, 6), round(lng, 6)

    # 距离：本地复算，和上游返回值偏差过大时以复算为准
    if user_lat is not None and user_lng is not None:
        from .geo import haversine
        computed = round(haversine(user_lat, user_lng, lat, lng))
        upstream = data.get("distance")
        if isinstance(upstream, (int, float)) and upstream > 0 and abs(upstream - computed) > max(200, upstream * 0.4):
            issues.append("distance_mismatch")
        data["distance"] = computed
    elif not isinstance(data.get("distance"), (int, float)):
        data["distance"] = None

    # 评分：0~5，超出范围视为无效
    rating = data.get("rating")
    if rating is not None:
        try:
            rating = float(rating)
            if not 0 < rating <= 5:
                issues.append("rating_out_of_range")
                rating = None
        except (TypeError, ValueError):
            issues.append("rating_invalid")
            rating = None
    data["rating"] = round(rating, 1) if rating else None

    # 人均：1~5000
    price = data.get("avgPrice")
    if price is not None:
        try:
            price = int(float(price))
            if not 1 <= price <= 5000:
                issues.append("price_out_of_range")
                price = None
        except (TypeError, ValueError):
            issues.append("price_invalid")
            price = None
    data["avgPrice"] = price

    # 图片：只保留 http(s) 或本地相对路径，去重、最多 6 张
    gallery = []
    for image in data.get("gallery") or []:
        image = str(image or "").strip()
        if not image:
            continue
        if image.startswith(("http://", "https://")) or image.startswith("/static/"):
            if image not in gallery:
                gallery.append(image)
    data["gallery"] = gallery[:6]
    if not data.get("cover"):
        data["cover"] = gallery[0] if gallery else ""
    if not gallery:
        issues.append("no_photo")

    # 营业时间
    start, end = parse_hours(data.get("businessHours") or "")
    data["openTime"], data["closeTime"] = start, end

    # 地址 / 标签
    data["address"] = clean_text(data.get("address"), 120)
    data["area"] = clean_text(data.get("area"), 20)
    data["subCuisine"] = clean_text(data.get("subCuisine") or data.get("cuisine"), 20)
    tags = []
    for tag in data.get("tags") or []:
        tag = clean_text(tag, 8)
        if tag and tag not in tags:
            tags.append(tag)
    data["tags"] = tags[:5]

    # 主键
    if not data.get("id"):
        digest = hashlib.md5(f"{data['name']}{lat:.4f}{lng:.4f}".encode()).hexdigest()[:10]
        data["id"] = f"{data.get('source', 'poi')}-{digest}"
        issues.append("id_generated")

    return data, issues


def dedupe_items(items: list, min_gap_m: float = 45.0) -> tuple:
    """按 id / 名称 + 距离去重，返回 (去重结果, 丢弃数)。"""
    from .geo import haversine
    seen_ids, kept, dropped = set(), [], 0
    for item in items:
        if item["id"] in seen_ids:
            dropped += 1
            continue
        duplicate = False
        for exist in kept:
            if exist["name"] == item["name"]:
                if haversine(exist["lat"], exist["lng"], item["lat"], item["lng"]) <= min_gap_m:
                    duplicate = True
                    break
        if duplicate:
            dropped += 1
            continue
        seen_ids.add(item["id"])
        kept.append(item)
    return kept, dropped


def crawl_snapshot() -> dict:
    return {
        "sources": source_public_list(),
        "stats": STATS.snapshot(),
        "policy": {
            "minInterval": "高德/百度 1 秒/次，OSM 3 秒/次（按 host 串行）",
            "retry": "失败重试 2 次，指数退避 0.6s → 1.2s → 2.4s",
            "timeout": "单次请求 6 秒",
            "coverage": "以用户坐标为圆心，3km → 5km → 8km 逐级扩大",
            "excluded": "不采集美团/大众点评/抖音单条短评；不绕过防盗链下载图片",
            "validation": "坐标中国境内校验、评分 0~5、人均 1~5000、距离本地复算、同名 45m 内去重",
        },
    }
