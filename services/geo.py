"""地理计算与坐标系转换。

高德使用 GCJ-02，百度使用 BD-09，浏览器 Geolocation 返回 WGS-84。
统一在服务端转换为 GCJ-02 后再计算距离，避免跨源偏差（约 50~500 米）。
"""

import math

EARTH_RADIUS = 6371008.8

# 常用出行速度（米/分钟），用于无路径规划接口时的时长估算
SPEED_M_PER_MIN = {
    "walking": 78.0,   # ≈4.7 km/h
    "cycling": 208.0,  # ≈12.5 km/h
    "driving": 380.0,  # ≈22.8 km/h（含红绿灯）
}


def haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """两点球面距离（米）。"""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS * math.asin(math.sqrt(a))


def offset_point(lat: float, lng: float, distance_m: float, bearing_deg: float):
    """按方位角推算目标点，用于演示数据布点与路线生成。"""
    br = math.radians(bearing_deg)
    dr = distance_m / EARTH_RADIUS
    lat1 = math.radians(lat)
    lat2 = math.asin(math.sin(lat1) * math.cos(dr) + math.cos(lat1) * math.sin(dr) * math.cos(br))
    lng2 = math.radians(lng) + math.atan2(
        math.sin(br) * math.sin(dr) * math.cos(lat1),
        math.cos(dr) - math.sin(lat1) * math.sin(lat2),
    )
    return round(math.degrees(lat2), 6), round(math.degrees(lng2), 6)


# ---------------- 坐标系转换 ----------------
_A = 6378245.0
_EE = 0.00669342162296594323
_X_PI = math.pi * 3000.0 / 180.0


def _out_of_china(lat: float, lng: float) -> bool:
    return not (72.004 <= lng <= 137.8347 and 0.8293 <= lat <= 55.8271)


def _transform_lat(x: float, y: float) -> float:
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(x: float, y: float) -> float:
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lat: float, lng: float):
    if _out_of_china(lat, lng):
        return lat, lng
    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - _EE * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (_A / sqrtmagic * math.cos(radlat) * math.pi)
    return round(lat + dlat, 6), round(lng + dlng, 6)


def gcj02_to_bd09(lat: float, lng: float):
    z = math.sqrt(lng * lng + lat * lat) + 0.00002 * math.sin(lat * _X_PI)
    theta = math.atan2(lat, lng) + 0.000003 * math.cos(lng * _X_PI)
    return round(z * math.sin(theta) + 0.006, 6), round(z * math.cos(theta) + 0.0065, 6)


def bd09_to_gcj02(lat: float, lng: float):
    x, y = lng - 0.0065, lat - 0.006
    z = math.sqrt(x * x + y * y) - 0.00002 * math.sin(y * _X_PI)
    theta = math.atan2(y, x) - 0.000003 * math.cos(x * _X_PI)
    return round(z * math.sin(theta), 6), round(z * math.cos(theta), 6)


def duration_minutes(distance_m: float, mode: str) -> int:
    """按平均速度估算时长（真实接口会返回更准确的 duration，此处仅兜底/演示）。"""
    speed = SPEED_M_PER_MIN.get(mode, SPEED_M_PER_MIN["walking"])
    return max(1, int(round(distance_m / speed)))


def format_distance(meters: float) -> str:
    if meters is None:
        return ""
    if meters < 1000:
        return f"{int(round(meters / 10.0) * 10)}m"
    return f"{meters / 1000:.1f}km"
