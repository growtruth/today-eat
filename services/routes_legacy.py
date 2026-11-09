"""前台只读 API：配置、POI、路线、游玩点位、地理编码、采集说明。

这些接口不需要身份；失败时统一抛 FriendlyError，由全局错误处理器转成 JSON。
"""

from __future__ import annotations

import math
import platform
import re

from flask import Blueprint, current_app, g, jsonify, request

from .bootstrap import build_bootstrap
from .deals import with_deal_flags
from .errors import FriendlyError
from .db import get_db

bp = Blueprint("legacy_api", __name__, url_prefix="/api")

POI_ID_RE = re.compile(r"^[A-Za-z0-9_\-:.]{1,80}$")


def _service():
    return current_app.extensions["service"]


def _float_arg(name: str, default: float) -> float:
    raw = request.args.get(name)
    if raw is None or raw == "":
        return float(default)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise FriendlyError("参数格式不对", code="bad_request")
    if not math.isfinite(value):
        raise FriendlyError("参数格式不对", code="bad_request")
    return value


def _coord(name: str, default: float, minimum: float, maximum: float) -> float:
    value = _float_arg(name, default)
    if not minimum <= value <= maximum:
        raise FriendlyError("位置参数超出范围", hint="重新定位或手动选择商圈", code="bad_request")
    return value


@bp.get("/bootstrap")
def api_bootstrap():
    return jsonify({"ok": True, **build_bootstrap()})


@bp.get("/restaurants")
def api_restaurants():
    cfg = current_app.config
    lat = _coord("lat", cfg["DEFAULT_LAT"], -90, 90)
    lng = _coord("lng", cfg["DEFAULT_LNG"], -180, 180)
    radius = int(_float_arg("radius", 3000))
    keyword = (request.args.get("q") or "").strip()[:30]
    radius = max(1000, min(8000, radius))
    # strict=1：半径分页模式，严格按该半径返回，不自动扩张
    strict = (request.args.get("strict") or "").lower() in ("1", "true", "yes")
    # offset/limit：按距离升序的游标分页，翻页拿到的是真正更远的店
    offset = max(0, min(1000, int(_float_arg("offset", 0))))
    limit = max(1, min(100, int(_float_arg("limit", 50))))
    payload = _service().search(lat, lng, radius, keyword, strict=strict, offset=offset, limit=limit)
    with_deal_flags(get_db(), payload.get("items") or [])
    return jsonify(payload)


@bp.get("/restaurant/<path:poi_id>")
def api_restaurant(poi_id: str):
    if not POI_ID_RE.match(poi_id or ""):
        raise FriendlyError("商家编号不合法", hint="回首页重新选一家", code="bad_request")
    return jsonify({"ok": True, "item": _service().detail(poi_id)})


@bp.get("/route")
def api_route():
    cfg = current_app.config
    origin = (
        _coord("from_lat", cfg["DEFAULT_LAT"], -90, 90),
        _coord("from_lng", cfg["DEFAULT_LNG"], -180, 180),
    )
    dest = (
        _coord("to_lat", 0.0, -90, 90),
        _coord("to_lng", 0.0, -180, 180),
    )
    if dest == (0.0, 0.0):
        raise FriendlyError("缺少目的地坐标", code="bad_request")
    mode = (request.args.get("mode") or "walking").strip()
    if mode not in ("walking", "cycling", "driving"):
        mode = "walking"
    return jsonify({"ok": True, "route": _service().route(origin, dest, mode)})


@bp.get("/play-spots")
def api_play_spots():
    cfg = current_app.config
    store = {
        "id": (request.args.get("store_id") or "")[:80],
        "name": (request.args.get("name") or "")[:40],
        "lat": _coord("lat", cfg["DEFAULT_LAT"], -90, 90),
        "lng": _coord("lng", cfg["DEFAULT_LNG"], -180, 180),
    }
    return jsonify(_service().play_spots(store))


@bp.get("/geocode")
def api_geocode():
    cfg = current_app.config
    query = (request.args.get("q") or "").strip()[:40]
    city = (request.args.get("city") or cfg["DEFAULT_CITY"]).strip()[:20]
    return jsonify({"ok": True, "place": _service().geocode(query, city)})


@bp.get("/regeo")
def api_regeo():
    lat = _coord("lat", 0.0, -90, 90)
    lng = _coord("lng", 0.0, -180, 180)
    if lat == 0.0 and lng == 0.0:
        raise FriendlyError("缺少坐标", code="bad_request")
    place = _service().regeo(lat, lng)
    if not place:
        raise FriendlyError("逆地理编码暂不可用", hint="稍后再试", code="not_found")
    return jsonify({"ok": True, "place": place})


@bp.get("/ip-locate")
def api_ip_locate():
    return jsonify({"ok": True, "place": _service().ip_locate()})


@bp.get("/locate-context")
def api_locate_context():
    """定位详情：POI 级地址 + 周边地标 + 区域洞察 + 位置感知推荐。"""
    lat = _coord("lat", 0.0, -90, 90)
    lng = _coord("lng", 0.0, -180, 180)
    if lat == 0.0 and lng == 0.0:
        raise FriendlyError("缺少坐标", code="bad_request")
    radius = int(_float_arg("radius", 3000))
    radius = max(1000, min(8000, radius))
    return jsonify(_service().locate_context(lat, lng, radius))


@bp.get("/areas")
def api_areas():
    cfg = current_app.config
    city = (request.args.get("city") or cfg["DEFAULT_CITY"]).strip()[:20]
    return jsonify({"ok": True, "items": _service().suggestions(city)})


@bp.get("/sources")
def api_sources():
    active = (request.args.get("active") or "")[:12]
    return jsonify({"ok": True, **_service().sources_info(active)})


@bp.post("/client-error")
def api_client_error():
    """接收前端错误，写服务端日志；只保留排障所需字段，不采集用户数据。"""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise FriendlyError("请求体必须是 JSON 对象", code="bad_request")

    def clean(value, limit):
        return str(value or "").replace("\r", " ").replace("\n", " ").strip()[:limit]

    message = clean(payload.get("message"), 300)
    if not message:
        raise FriendlyError("缺少错误信息", code="bad_request")

    current_app.logger.warning(
        "client-error kind=%s message=%s path=%s source=%s line=%s rid=%s stack=%s",
        clean(payload.get("kind") or "error", 20),
        message,
        clean(payload.get("path"), 120),
        clean(payload.get("source"), 200),
        payload.get("line") or 0,
        getattr(g, "request_id", ""),
        clean(payload.get("stack"), 1200),
    )
    return jsonify({"ok": True})


@bp.get("/health")
def api_health():
    cfg = current_app.config
    return jsonify({
        "ok": True,
        "version": current_app.extensions.get("app_version", ""),
        "provider": cfg["MAP_PROVIDER"],
        "hasAmapKey": bool(cfg["AMAP_WEB_KEY"]),
        "hasBaiduKey": bool(cfg["BAIDU_WEB_AK"]),
        "python": platform.python_version(),
    })
