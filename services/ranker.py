"""排序与权重规则（全部数值化，便于验收）。

三条硬规则：
1. 随机抽店：已打卡门店不排除，但权重降为普通店的 30%；
2. 饭后游玩：途经特色街巷/特色步行路线的点位，排序权重比纯距离高 30%（有效距离 ÷1.3）；
3. 饭后游玩：绕行超过 500 米时，切回最短路径（不再享受特色街巷加成）。
"""

import math
import random
from datetime import datetime

# 人均分档（PRD F2-4，写死）
PER_CAPITA_TIERS = {
    "main": [
        {"label": "100 内", "min": 0, "max": 100},
        {"label": "100-200", "min": 100, "max": 200},
        {"label": "200-300", "min": 200, "max": 300},
        {"label": "300+", "min": 300, "max": None},
    ],
    "drink": [
        {"label": "50 内", "min": 0, "max": 50},
        {"label": "50-70", "min": 50, "max": 70},
        {"label": "70-100", "min": 70, "max": 100},
        {"label": "100+", "min": 100, "max": None},
    ],
}

DRINK_CUISINES = {"甜品", "咖啡", "奶茶"}

# 步行路网系数（真实接口返回的实际步行距离优先）
WALK_NETWORK_FACTOR = 1.08
# 特色街巷权重加成：有效距离 ÷ 1.3，即“权重高 30%”
FEATURED_BOOST = 1.3
# 绕行阈值（米）
DETOUR_LIMIT = 500
# 已打卡门店的随机权重
CHECKED_WEIGHT = 0.3
# 个人化对距离的修正幅度
PERSONAL_BOOST = 0.35


def category_of(cuisine: str) -> str:
    return "drink" if cuisine in DRINK_CUISINES else "main"


def tiers_for(cuisine: str) -> list:
    return PER_CAPITA_TIERS[category_of(cuisine)]


def is_weekend_friendly(item: dict) -> bool:
    """周末聚餐（group）：适合多人、有包间、适合拍照的店。

    规则：显式标记“周末友好 / 有包间”，或“适合拍照且人均 ≥80”。
    """
    tags = item.get("tags") or []
    if "周末友好" in tags or "有包间" in tags:
        return True
    price = item.get("avgPrice") or 0
    return "适合拍照" in tags and price >= 80


def personalization_weights(checkins: list) -> dict:
    """从本地打卡记录统计菜系偏好，返回 {菜系: 0~1 的偏好强度}。"""
    if not checkins:
        return {}
    counter = {}
    for record in checkins:
        cuisine = record.get("cuisine")
        if cuisine:
            counter[cuisine] = counter.get(cuisine, 0) + 1
    total = sum(counter.values())
    if not total:
        return {}
    return {cuisine: count / total for cuisine, count in counter.items()}


def apply_personalization(items: list, weights: dict) -> list:
    """按口味偏好对“距离”做轻微修正，地理邻近仍然主导排序。

    effective_distance = distance / (1 + 0.35 × 该菜系偏好占比)
    """
    if not weights:
        for item in items:
            item["tasteBoost"] = 1.0
        return items
    for item in items:
        affinity = weights.get(item.get("cuisine"), 0.0)
        boost = 1 + PERSONAL_BOOST * affinity
        item["tasteBoost"] = round(boost, 3)
        item["sortDistance"] = round((item.get("distance") or 0) / boost)
    items.sort(key=lambda x: (x.get("sortDistance", x.get("distance") or 0), -(x.get("rating") or 0)))
    return items


def random_weights(items: list, checked_ids: set, weights: dict) -> list:
    """随机池权重：已打卡门店 = 普通店 × 0.3；偏好菜系轻微加权；高分新店小幅加权。"""
    result = []
    for item in items:
        weight = CHECKED_WEIGHT if item["id"] in checked_ids else 1.0
        affinity = weights.get(item.get("cuisine"), 0.0)
        weight *= 1 + 0.5 * affinity
        if item.get("isNew") and (item.get("rating") or 0) >= 4.5:
            weight *= 1.1
        result.append(max(weight, 0.001))
    return result


def weighted_pick(items: list, checked_ids: set, weights: dict) -> dict | None:
    """按权重随机抽一家（先应用筛选，再进入本函数）。"""
    if not items:
        return None
    return random.choices(items, weights=random_weights(items, checked_ids, weights), k=1)[0]


# ---------------- 几何：点到线段距离 ----------------
def _to_xy(lat: float, lng: float, base_lat: float):
    """以 base_lat 为基准的等距投影（米），用于点到线段距离计算。"""
    x = math.radians(lng) * 6371008.8 * math.cos(math.radians(base_lat))
    y = math.radians(lat) * 6371008.8
    return x, y


def point_to_segment_m(plat: float, plng: float, alat: float, alng: float, blat: float, blng: float) -> float:
    base = (alat + blat) / 2
    px, py = _to_xy(plat, plng, base)
    ax, ay = _to_xy(alat, alng, base)
    bx, by = _to_xy(blat, blng, base)
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _haversine(lat1, lng1, lat2, lng2):
    from .geo import haversine
    return haversine(lat1, lng1, lat2, lng2)


def match_featured_street(store: dict, spot: dict, streets: list, threshold: float = 260.0) -> dict | None:
    """判断“餐厅 → 点位”的步行段是否经过特色街巷。"""
    best, best_d = None, 1e9
    for street in streets or []:
        d = point_to_segment_m(
            street["lat"], street["lng"],
            store["lat"], store["lng"], spot["lat"], spot["lng"],
        )
        if d < best_d:
            best, best_d = street, d
    if best and best_d <= threshold:
        return best
    return None


def rank_play_spots(spots: list, store: dict, streets: list) -> list:
    """按“顺路度 + 特色街巷权重”排序游玩点位。"""
    ranked = []
    for spot in spots:
        straight = _haversine(store["lat"], store["lng"], spot["lat"], spot["lng"])
        walk_distance = float(spot.get("distance") or straight * WALK_NETWORK_FACTOR)
        if walk_distance < straight:
            walk_distance = straight * WALK_NETWORK_FACTOR
        detour = max(0.0, walk_distance - straight)

        street = match_featured_street(store, spot, streets)
        featured = street is not None
        path_mode = "featured" if featured else "normal"

        # 规则：绕行超过 500 米 → 切回最短路径，且不再享受特色街巷加成
        if detour > DETOUR_LIMIT:
            path_mode = "shortest"
            featured = False
            effective = straight
        else:
            effective = walk_distance / (FEATURED_BOOST if featured else 1.0)

        smoothness = max(0, min(100, round(100 * (1 - detour / DETOUR_LIMIT))))
        ranked.append({
            **spot,
            "straightDistance": round(straight),
            "walkDistance": round(walk_distance),
            "detour": round(detour),
            "walkMinutes": max(1, round(walk_distance / 78)),
            "smoothness": smoothness,
            "featured": featured,
            "featuredStreet": street["name"] if street else "",
            "pathMode": path_mode,
            "effectiveDistance": round(effective),
        })

    ranked.sort(key=lambda x: (x["effectiveDistance"], -x["smoothness"]))
    for index, item in enumerate(ranked, start=1):
        item["rank"] = index
    return ranked


def annotate_featured_segment(route: dict, streets: list) -> dict:
    """为真实路径规划结果补充“特色街巷”标注。

    取整条路线中距离某条特色街巷最近的一段，若在 300 米内则标记为特色段，
    前端据此加粗渲染；否则不标记。
    """
    polyline = route.get("polyline") or []
    if route.get("featuredSegment") is not None:
        return route
    if len(polyline) < 2 or not streets:
        route.setdefault("featuredSegment", None)
        route.setdefault("featuredStreet", None)
        return route

    best = {"gap": 1e9, "index": None, "street": None}
    stride = max(1, len(polyline) // 40)  # 采样，避免长路线全量计算
    for index in range(0, len(polyline) - 1, stride):
        a, b = polyline[index], polyline[index + 1]
        mid_lat, mid_lng = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        for street in streets:
            gap = point_to_segment_m(street["lat"], street["lng"], a[0], a[1], b[0], b[1])
            if gap < best["gap"]:
                best = {"gap": gap, "index": index, "street": street, "mid": (mid_lat, mid_lng)}

    if best["index"] is not None and best["gap"] <= 300:
        route["featuredSegment"] = best["index"]
        route["featuredStreet"] = {
            "name": best["street"]["name"],
            "lat": best["street"]["lat"],
            "lng": best["street"]["lng"],
        }
    else:
        route["featuredSegment"] = None
        route["featuredStreet"] = None
    return route


# ============================================================================
# 位置 + POI 上下文推荐
# ============================================================================
# 权重合计 1.0，所有分项先归一到 0~1，再乘权重后×100 作为展示分
CTX_WALK = 0.40          # 步行可达性（距离不再只是数字，而是"走多久")
CTX_LANDMARK = 0.20      # 地标邻近（地铁/商场/公园 → 交通与延伸消费便利）
CTX_QUALITY = 0.20       # 口碑质量
CTX_TIMEFIT = 0.20       # 时段匹配（午餐偏快、晚餐偏正餐）

WALK_M_PER_MIN = 78.0    # ≈4.7 km/h，与 geo.duration_minutes 一致
IDEAL_WALK_MIN = 8       # 步行 8 分钟内视为最佳可达
MAX_WALK_MIN = 38        # 超过 38 分钟可达性归零
LANDMARK_FULL_M = 300    # 300 米内有地标：满分
LANDMARK_ZERO_M = 1200   # 1200 米外：归零


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def walk_minutes(distance_m: float) -> float:
    return max(0.0, float(distance_m or 0)) / WALK_M_PER_MIN


def _reach_score(distance_m: float) -> float:
    """步行可达性：8 分钟内满分，之后线性衰减，38 分钟归零。"""
    minutes = walk_minutes(distance_m)
    return _clamp01(1 - (minutes - IDEAL_WALK_MIN) / (MAX_WALK_MIN - IDEAL_WALK_MIN))


def _landmark_score(item: dict, landmarks: list) -> tuple:
    """地标邻近度：取离店铺最近的地标，300 米内满分，1200 米外归零。"""
    if not landmarks:
        return 0.5, None  # 无地标数据时给中性分，避免误伤
    from .geo import haversine
    best = None
    for landmark in landmarks:
        if landmark.get("lat") is None or landmark.get("lng") is None:
            continue
        gap = haversine(item["lat"], item["lng"], landmark["lat"], landmark["lng"])
        if best is None or gap < best[0]:
            best = (gap, landmark)
    if best is None:
        return 0.5, None
    gap, landmark = best
    score = _clamp01(1 - (gap - LANDMARK_FULL_M) / (LANDMARK_ZERO_M - LANDMARK_FULL_M))
    return score, {"name": landmark.get("name"), "kind": landmark.get("kind"), "distance": round(gap)}


def _quality_score(rating) -> float:
    """口碑：3.0 分 → 0，5.0 分 → 1；无评分给中性 0.5。"""
    if not rating:
        return 0.5
    return _clamp01((float(rating) - 3.0) / 2.0)


def _time_fit_score(item: dict, hour: int) -> float:
    """时段匹配：午餐偏快、人均适中；晚餐偏正餐、口碑好；其他时段中性。"""
    price = item.get("avgPrice")
    if 11 <= hour <= 14:
        if not price:
            return 0.5
        return _clamp01(1 - abs(float(price) - 50) / 100)
    if 17 <= hour <= 21:
        return 0.5 + 0.5 * _quality_score(item.get("rating"))
    return 0.5


def contextual_rank(items: list, context: dict, limit: int | None = None) -> list:
    """位置 + POI 上下文推荐打分（0~100），并给出每项的拆解用于界面解释。

    context 至少包含 lat/lng；可选 landmarks（周边地标列表）、hour（当前小时）。
    """
    context = context or {}
    landmarks = context.get("landmarks") or []
    hour = context.get("hour")
    if hour is None:
        hour = datetime.now().hour

    ranked = []
    for item in items or []:
        distance = item.get("distance") or 0
        reach = _reach_score(distance)
        landmark_score, landmark_ref = _landmark_score(item, landmarks)
        quality = _quality_score(item.get("rating"))
        time_fit = _time_fit_score(item, hour)
        score = (CTX_WALK * reach + CTX_LANDMARK * landmark_score
                 + CTX_QUALITY * quality + CTX_TIMEFIT * time_fit)
        ranked.append({
            **item,
            "contextScore": round(score * 100),
            "contextBreakdown": {
                "walk": round(reach, 3),
                "landmark": round(landmark_score, 3),
                "quality": round(quality, 3),
                "timeFit": round(time_fit, 3),
            },
            "walkMinutes": max(1, round(walk_minutes(distance))),
            "nearestLandmark": landmark_ref,
        })

    ranked.sort(key=lambda x: (-x["contextScore"], x.get("distance") or 0))
    return ranked[:limit] if limit else ranked
