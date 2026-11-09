"""规则与接口自测（不依赖 pytest，直接 python tests/test_rules.py）。

覆盖验收清单里可自动化的部分：
1. 周末模式：周日开、调休上班日不开、工作日不开；
2. 已打卡门店随机权重 = 普通店 × 0.3；
3. 特色街巷权重 +30%、绕行 > 500 米切回最短路径；
4. 采集校验：坐标越界、评分越界、距离复算、去重；
5. Flask 接口：搜索 / 详情 / 路线 / 游玩点位 / 采集说明。
"""

import os
import sys
from datetime import date

# 测试固定跑演示数据：屏蔽本机 .env 里真实地图 Key，保证结果可复现、不依赖外网
os.environ["AMAP_WEB_KEY"] = ""
os.environ["BAIDU_WEB_AK"] = ""

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.crawler import dedupe_items, validate_item  # noqa: E402
from services.holiday import HolidayCalendar  # noqa: E402
from services.ranker import random_weights, rank_play_spots  # noqa: E402

PASS, FAIL = [], []


def check(name, condition, detail=""):
    if condition:
        PASS.append(name)
        print(f"  OK  {name}")
    else:
        FAIL.append(name + (" :: " + detail if detail else ""))
        print(f"FAIL  {name} {detail}")


def test_holiday():
    print("\n[1] 周末模式与调休")
    cal = HolidayCalendar()
    check("周日自动开启（2026-10-25）", cal.auto_weekend_mode(date(2026, 10, 25)) is True)
    check("调休上班的周六不开启（2026-10-10）", cal.auto_weekend_mode(date(2026, 10, 10)) is False)
    check("工作日不开启（2026-10-26）", cal.auto_weekend_mode(date(2026, 10, 26)) is False)
    check("春节调休周六不开启（2026-02-28）", cal.auto_weekend_mode(date(2026, 2, 28)) is False)


def test_random_weight():
    print("\n[2] 随机抽店权重")
    items = [
        {"id": "a", "cuisine": "火锅", "isNew": False, "rating": 4.2},
        {"id": "b", "cuisine": "火锅", "isNew": False, "rating": 4.2},
    ]
    weights = random_weights(items, {"a"}, {})
    check("已打卡权重恰为 0.3", abs(weights[0] - 0.3) < 1e-9, f"got {weights[0]}")
    check("普通店权重为 1.0", abs(weights[1] - 1.0) < 1e-9, f"got {weights[1]}")


def test_play_ranking():
    print("\n[3] 饭后游玩排序规则")
    store = {"id": "s", "name": "店", "lat": 39.9963, "lng": 116.4703}
    streets = [{"name": "望京小街", "lat": 39.9968, "lng": 116.4780, "radius": 320}]

    # 顺路且经过特色街巷：有效距离 = 步行距离 / 1.3
    near = {"id": "p1", "name": "近点", "lat": 39.9968, "lng": 116.4772, "distance": 600}
    ranked = rank_play_spots([near], store, streets)[0]
    check("特色街巷点位被标记", ranked["featured"] is True)
    check("特色街巷有效距离 = 步行 / 1.3",
          abs(ranked["effectiveDistance"] - round(600 / 1.3)) <= 1,
          f"{ranked['effectiveDistance']} vs {round(600/1.3)}")

    # 绕行超过 500 米：切回最短路径，不再享受加成
    far = {
        "id": "p2", "name": "绕远点", "lat": 39.9999, "lng": 116.4800,
        "distance": 2000, "detourRatio": 0.9,
    }
    ranked_far = rank_play_spots([far], store, streets)[0]
    check("绕行超 500 米切回最短路径", ranked_far["pathMode"] == "shortest", ranked_far["pathMode"])
    check("绕行超限不再标记特色街巷", ranked_far["featured"] is False)
    check("绕行超限时用直线距离排序",
          ranked_far["effectiveDistance"] == ranked_far["straightDistance"])

    # 顺路度公式：100 − 绕行/500×100
    spot = {"id": "p3", "name": "顺路点", "lat": 39.9964, "lng": 116.4710, "distance": 80}
    r3 = rank_play_spots([spot], store, [])[0]
    expected = round(100 * (1 - r3["detour"] / 500))
    check("顺路度按公式计算", abs(r3["smoothness"] - expected) <= 1, f"{r3['smoothness']} vs {expected}")


def test_validation():
    print("\n[4] 采集校验")
    bad = {"name": "坏坐标", "lat": 0, "lng": 0, "rating": 4.5}
    item, issues = validate_item(bad)
    check("境外/零坐标被拒", item is None and "coord_out_of_china" in issues, str(issues))

    good, issues = validate_item({
        "id": "x1", "name": "测试店", "lat": 39.99, "lng": 116.47,
        "rating": 9.9, "avgPrice": 99999, "gallery": [],
    }, 39.99, 116.48)
    check("评分超出 0~5 置空", good["rating"] is None)
    check("人均超出 1~5000 置空", good["avgPrice"] is None)
    check("距离以本地复算为准", isinstance(good["distance"], int) and good["distance"] > 500)

    dup = dedupe_items([
        {"id": "1", "name": "同名店", "lat": 39.99, "lng": 116.47},
        {"id": "2", "name": "同名店", "lat": 39.9901, "lng": 116.4701},
    ])
    check("同名 45 米内去重", len(dup[0]) == 1, str(len(dup[0])))


def test_security():
    print("\n[5] 安全与错误处理")
    import app as app_module
    client = app_module.app.test_client()

    page = client.get("/")
    headers = page.headers
    check("页面带 CSP", "Content-Security-Policy" in headers)
    check("CSP 含 nonce", "nonce-" in headers.get("Content-Security-Policy", ""))
    check("CSP 实际 nonce 注入模板", b'nonce="' in page.data)
    check("nosniff", headers.get("X-Content-Type-Options") == "nosniff")
    check("禁止被 iframe 嵌套", headers.get("X-Frame-Options") == "SAMEORIGIN")
    check("权限策略限制摄像头", "camera=()" in headers.get("Permissions-Policy", ""))

    api = client.get("/api/restaurants?lat=39.99&lng=116.47&radius=3000")
    check("API 不缓存", api.headers.get("Cache-Control") == "no-store")

    bad = client.get("/api/restaurants?lat=abc")
    check("非法纬度返回 400", bad.status_code == 400, str(bad.status_code))
    check("非法纬度返回友好文案", bad.get_json().get("code") == "bad_request")

    out_of_range = client.get("/api/restaurants?lat=999&lng=116.47")
    check("纬度越界返回 400", out_of_range.status_code == 400, str(out_of_range.status_code))

    bad_id = client.get("/api/restaurant/%3Cscript%3E")
    check("非法商家编号返回 400", bad_id.status_code == 400, str(bad_id.status_code))

    unknown = client.get("/api/not-exist")
    check("未知接口返回 404", unknown.status_code == 404, str(unknown.status_code))

    # 限流：临时把阈值调到 2
    app_module.app.config["RATE_LIMIT_PER_MINUTE"] = 2
    app_module.limiter._hits.clear()
    try:
        client.get("/api/bootstrap")
        client.get("/api/bootstrap")
        limited = client.get("/api/bootstrap")
        check("超过阈值返回 429", limited.status_code == 429, str(limited.status_code))
        check("限流响应带 Retry-After", "Retry-After" in limited.headers)
        check("限流提示为友好文案", limited.get_json().get("code") == "rate_limited")
    finally:
        app_module.app.config["RATE_LIMIT_PER_MINUTE"] = 120
        app_module.limiter._hits.clear()


def test_assets():
    print("\n[6] 静态资源")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    img_dir = os.path.join(root, "static", "img")
    thumb_dir = os.path.join(img_dir, "thumb")
    originals = [f for f in os.listdir(img_dir) if f.endswith(".jpg")]
    check("图片已生成缩略图目录", os.path.isdir(thumb_dir))
    check("每张图都有 480w 版本",
          all(os.path.exists(os.path.join(thumb_dir, f)) for f in originals))
    total = sum(os.path.getsize(os.path.join(img_dir, f)) for f in originals)
    check("图片总量 < 2MB", total < 2 * 1024 * 1024, f"{total/1024/1024:.2f}MB")

    check("已移除未使用的 Bootstrap",
          not os.path.exists(os.path.join(root, "static", "vendor", "bootstrap.min.css")))

    import app as app_module
    client = app_module.app.test_client()
    html = client.get("/").get_data(as_text=True)
    check("页面只请求一个 JS 包", html.count("/assets/app.js") == 1)
    check("页面只请求一个 CSS 包", html.count("/assets/app.css") == 1)
    check("静态资源带内容版本号", "/assets/app.js?v=" in html and "/assets/app.css?v=" in html)

    js = client.get("/assets/app.js")
    css = client.get("/assets/app.css")
    check("JS 包可访问", js.status_code == 200)
    check("CSS 包可访问", css.status_code == 200)
    check("JS 包按依赖顺序拼接",
          js.data.find(b"window.Store") >= 0
          and js.data.find(b"window.Store") < js.data.find(b"window.API")
          and js.data.find(b"window.API") < js.data.find(b"App.init"))
    check("JS 包包含全部 23 个模块", js.data.count(b"@bundle ") == 23, str(js.data.count(b"@bundle ")))
    check("CSS 包包含两份样式", css.data.count(b"@bundle ") == 2, str(css.data.count(b"@bundle ")))
    check("首页有美食雷达入口", 'id="radarBtn"' in html)
    check("雷达浮层已挂载", 'id="radarLayer"' in html and 'id="radarStage"' in html)
    check("雷达脚本进入打包", b"@bundle radar.js" in js.data)
    check("静态包长缓存", "immutable" in (js.headers.get("Cache-Control") or ""))
    check("静态包带 ETag", bool(js.headers.get("ETag")))


def test_api():
    print("\n[7] Flask 接口")
    import app as app_module
    client = app_module.app.test_client()

    r = client.get("/api/restaurants?lat=39.9963&lng=116.4703&radius=3000")
    data = r.get_json()
    check("搜索返回 ok", data.get("ok") is True)
    check("演示源可用且有结果", data.get("source") == "demo" and len(data.get("items", [])) > 5)
    check("演示数据含 solo 标记", all("soloFriendly" in item for item in data["items"]))
    check("距离已排序", data["items"][0]["distance"] <= data["items"][-1]["distance"])

    boot = client.get("/api/bootstrap").get_json()
    check("品牌名为今天吃啥", boot.get("appName") == "今天吃啥", str(boot.get("appName")))
    check("bootstrap 暴露微信配置态", "wechatConfigured" in boot and isinstance(boot["wechatConfigured"], bool))
    cloud = boot.get("cloud") or {}
    check("bootstrap 含云服务配置", bool(cloud.get("endpoint") and cloud.get("publishableKey")))

    r = client.get("/api/restaurant/demo-001")
    item = r.get_json().get("item", {})
    check("详情含公开评价摘要", len(item.get("reviews", [])) >= 5)
    check("详情含笔记流", len(item.get("notes", [])) >= 1)

    r = client.get("/api/route?from_lat=39.9963&from_lng=116.4703&to_lat=39.9987&to_lng=116.4850&mode=walking")
    route = r.get_json().get("route", {})
    check("路线含折线与指引", len(route.get("polyline", [])) > 2 and len(route.get("steps", [])) >= 2)
    check("路线标注特色街巷", route.get("featuredSegment") is not None)

    r = client.get("/api/play-spots?lat=39.9987&lng=116.4850&store_id=demo-001")
    spots = r.get_json().get("items", [])
    check("游玩点位返回 8 个", len(spots) == 8, str(len(spots)))
    check("点位含顺路度与类型", all("smoothness" in s and s.get("type") for s in spots))
    check("点位按有效距离升序", all(
        spots[i]["effectiveDistance"] <= spots[i + 1]["effectiveDistance"] for i in range(len(spots) - 1)
    ))

    r = client.get("/api/sources")
    payload = r.get_json()
    check("采集说明含 4 个来源", len(payload.get("sources", [])) == 4)
    check("明确排除第三方平台短评", "美团" in payload["policy"]["excluded"])

    r = client.get("/api/restaurants?lat=abc")
    check("非法参数返回友好提示", r.get_json().get("code") == "bad_request")


if __name__ == "__main__":
    test_holiday()
    test_random_weight()
    test_play_ranking()
    test_validation()
    test_security()
    test_assets()
    test_api()
    print("\n" + "=" * 46)
    print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    if FAIL:
        for item in FAIL:
            print(" - " + item)
        sys.exit(1)
