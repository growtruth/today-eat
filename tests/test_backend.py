"""后端工程化自测（不依赖 pytest）。

运行：python tests/test_backend.py
覆盖：匿名会话、饭搭子 CRUD/隔离、位置加权抽取、邀请互加、
团购降级与真实套餐、骰子规则、跨站拦截、错误封装、微信未配置降级。
"""

import os
import sys
import tempfile
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

DB_PATH = os.path.join(tempfile.gettempdir(), "weekend_eat_backend_test.db")
for suffix in ("", "-wal", "-shm"):
    try:
        os.remove(DB_PATH + suffix)
    except OSError:
        pass
os.environ["DATABASE_PATH"] = DB_PATH

# 屏蔽本机 .env 真实地图 Key，后端测试固定跑演示数据
os.environ["AMAP_WEB_KEY"] = ""
os.environ["BAIDU_WEB_AK"] = ""

import app as app_module  # noqa: E402
from services.db import get_db  # noqa: E402

PASS, FAIL = [], []


def check(name, condition, detail=""):
    if condition:
        PASS.append(name)
        print(f"  OK  {name}")
    else:
        FAIL.append(name + (" :: " + str(detail) if detail else ""))
        print(f"FAIL  {name} {detail}")


def new_client():
    return app_module.app.test_client()


def auth(client, device_id, nickname):
    response = client.post("/api/auth/device", json={"deviceId": device_id, "nickname": nickname})
    assert response.status_code == 200, response.get_json()
    return response


def test_auth():
    print("\n[1] 匿名身份与会话")
    client = new_client()
    me = client.get("/api/me").get_json()
    check("未登录时 /api/me 返回 null", me.get("user") is None, me)

    bad = client.post("/api/auth/device", json={"deviceId": "x"})
    check("非法 deviceId 返回 400", bad.status_code == 400, bad.status_code)
    check("错误体含稳定 code", bad.get_json().get("code") == "invalid_device")
    check("错误体含 requestId", bool(bad.get_json().get("requestId")))

    response = auth(client, "device-test-aaaa", "小圆")
    cookie = response.headers.get("Set-Cookie", "")
    check("会话 Cookie 为 HttpOnly", "HttpOnly" in cookie, cookie[:80])
    check("会话 Cookie SameSite=Lax", "SameSite=Lax" in cookie, cookie[:80])

    me = client.get("/api/me").get_json()
    check("登录后 /api/me 有用户", me["user"]["nickname"] == "小圆", me)
    check("响应头带 X-Request-Id", bool(client.get("/api/me").headers.get("X-Request-Id")))

    client.post("/api/auth/logout")
    check("退出后会话失效", client.get("/api/me").get_json().get("user") is None)


def test_buddy_crud():
    print("\n[2] 饭搭子目录与隔离")
    client = new_client()
    unauth = new_client().post("/api/buddies", json={"name": "阿橘"})
    check("未登录写操作返回 401", unauth.status_code == 401, unauth.status_code)

    auth(client, "device-test-bbbb", "小圆")
    created = client.post("/api/buddies", json={
        "name": "阿橘", "area": "望京", "lat": 39.99, "lng": 116.47,
        "cuisines": ["火锅"], "budget": 120,
    })
    check("创建搭子成功", created.status_code == 200, created.get_json())
    buddy = created.get_json()["buddy"]
    check("返回搭子字段完整", buddy["name"] == "阿橘" and buddy["cuisines"] == ["火锅"])

    duplicate = client.post("/api/buddies", json={"name": "阿橘"})
    check("同名搭子返回 409", duplicate.status_code == 409, duplicate.status_code)

    listed = client.get("/api/buddies").get_json()["items"]
    check("目录返回 1 个搭子", len(listed) == 1, len(listed))

    patched = client.patch(f"/api/buddies/{buddy['id']}", json={"budget": 200, "lastMet": date.today().isoformat()})
    check("部分更新生效", patched.get_json()["buddy"]["budget"] == 200, patched.get_json())

    other = new_client()
    auth(other, "device-test-cccc", "别人")
    hijack = other.patch(f"/api/buddies/{buddy['id']}", json={"budget": 1})
    check("跨用户修改返回 404", hijack.status_code == 404, hijack.status_code)
    check("跨用户目录为空", other.get("/api/buddies").get_json()["items"] == [])

    invalid = client.post("/api/buddies", json={"name": "长" * 30})
    check("昵称超长返回 400", invalid.status_code == 400, invalid.status_code)
    invalid_coord = client.post("/api/buddies", json={"name": "坐标错", "lat": 999})
    check("坐标越界返回 400", invalid_coord.status_code == 400, invalid_coord.status_code)


def test_draw():
    print("\n[3] 位置加权抽搭子")
    client = new_client()
    auth(client, "device-test-dddd", "抽签人")
    check("无搭子时抽取返回 409", client.post("/api/buddies/draw", json={}).status_code == 409)

    client.post("/api/buddies", json={"name": "近的", "lat": 39.9963, "lng": 116.4703, "cuisines": ["火锅"], "budget": 100})
    client.post("/api/buddies", json={"name": "远的", "lat": 40.05, "lng": 116.60, "cuisines": ["日料"], "budget": 300})

    result = client.post("/api/buddies/draw", json={
        "lat": 39.9963, "lng": 116.4703, "cuisine": "火锅", "budget": 100,
    }).get_json()
    check("抽取返回搭子", result.get("buddy", {}).get("name") in ("近的", "远的"), result)
    check("分数在 0~1 之间", 0 < result.get("score", 0) <= 1, result.get("score"))
    check("返回权重拆解", set(result.get("breakdown", {})) == {"proximity", "cuisine", "budget", "recency"})
    check("返回可解释理由", bool(result.get("reason")), result.get("reason"))


def test_invites():
    print("\n[4] 邀请与互加")
    inviter = new_client()
    auth(inviter, "device-test-eeee", "小圆")
    created = inviter.post("/api/invites", json={"inviteeName": "汤圆"}).get_json()["invite"]
    check("邀请含 token 与链接", bool(created["token"]) and "/i/" in created["url"], created)

    landing = inviter.get(f"/i/{created['token']}")
    check("邀请落地页可打开", landing.status_code == 200 and "接受邀请" in landing.get_data(as_text=True),
          landing.status_code)

    public = inviter.get(f"/api/invites/{created['token']}").get_json()["invite"]
    check("邀请详情可公开读取", public["inviter"] == "小圆", public)
    check("邀请初始为 pending", public["status"] == "pending", public)

    invitee = new_client()
    auth(invitee, "device-test-ffff", "汤圆")
    accepted = invitee.post(f"/api/invites/{created['token']}/accept")
    check("接受邀请成功", accepted.status_code == 200, accepted.get_json())
    check("重复接受返回 409", invitee.post(f"/api/invites/{created['token']}/accept").status_code == 409)

    inviter_buddies = [item["name"] for item in inviter.get("/api/buddies").get_json()["items"]]
    invitee_buddies = [item["name"] for item in invitee.get("/api/buddies").get_json()["items"]]
    check("邀请人目录出现对方", "汤圆" in inviter_buddies, inviter_buddies)
    check("被邀请人目录出现对方", "小圆" in invitee_buddies, invitee_buddies)

    self_invite = inviter.post("/api/invites", json={}).get_json()["invite"]
    check("不能接受自己的邀请", inviter.post(f"/api/invites/{self_invite['token']}/accept").status_code == 409)


def test_buddy_fixes():
    print("\n[5] 搭子修复：同名保护、邀请复用与撤销、完整度降权、昵称兜底")
    # 1) 同名保护：手工「阿强」填了国贸，阿强本人接受邀请后不能被清空
    inviter = new_client()
    auth(inviter, "device-test-gggg", "小圆")
    created = inviter.post("/api/buddies", json={
        "name": "阿强", "area": "国贸", "lat": 39.9087, "lng": 116.4575,
        "cuisines": ["日料"], "budget": 300,
    }).get_json()["buddy"]
    invite = inviter.post("/api/invites", json={}).get_json()["invite"]
    again = inviter.post("/api/invites", json={}).get_json()["invite"]
    check("未接受的邀请会被复用", invite["token"] == again["token"], (invite["token"], again["token"]))

    invitee = new_client()
    auth(invitee, "device-test-hhhh", "阿强")
    accepted = invitee.post(f"/api/invites/{invite['token']}/accept")
    check("同名者接受邀请成功", accepted.status_code == 200, accepted.get_json())

    row = [item for item in inviter.get("/api/buddies").get_json()["items"] if item["name"] == "阿强"][0]
    check("同名搭子区域不被清空", row["area"] == "国贸", row)
    check("同名搭子口味不被清空", row["cuisines"] == ["日料"], row)
    check("同名搭子手工来源不被降级", row["source"] == "manual", row)
    check("同名搭子保留原 id", row["id"] == created["id"], (row["id"], created["id"]))

    # 2) 撤销邀请
    fresh = inviter.post("/api/invites", json={"inviteeName": "小王"}).get_json()["invite"]
    check("撤销邀请成功", inviter.delete(f"/api/invites/{fresh['token']}").status_code == 200)
    public = inviter.get(f"/api/invites/{fresh['token']}").get_json()["invite"]
    check("撤销后状态为 revoked", public["status"] == "revoked", public)
    outsider = new_client()
    auth(outsider, "device-test-iiii", "小王")
    check("撤销后不能再接受", outsider.post(f"/api/invites/{fresh['token']}/accept").status_code == 409)

    # 3) 资料完整度降权：空资料搭子不该和完整搭子同权重
    client = new_client()
    auth(client, "device-test-jjjj", "抽签人")
    client.post("/api/buddies", json={
        "name": "完整", "lat": 39.9963, "lng": 116.4703, "cuisines": ["火锅"], "budget": 100})
    client.post("/api/buddies", json={"name": "空资料"})
    payload = {"lat": 39.9963, "lng": 116.4703, "cuisine": "火锅", "budget": 100}
    first = client.post("/api/buddies/draw", json=payload).get_json()
    check("抽取返回资料完整度", "completeness" in first and "incomplete" in first, first)
    counts = {"完整": 0, "空资料": 0}
    from services.social import draw_buddy  # 直接调用避免触发接口限流
    with app_module.app.app_context():
        db = get_db()
        owner = db.execute("SELECT id FROM users WHERE device_id = ?", ("device-test-jjjj",)).fetchone()["id"]
        for _ in range(500):
            picked = draw_buddy(db, owner, payload)
            counts[picked["buddy"]["name"]] += 1
    check("资料不完整被降权（<25%）", counts["空资料"] / 500 < 0.25, counts)
    check("完整搭子更容易抽中", counts["完整"] > counts["空资料"], counts)

    # 4) 默认昵称不进目录 + 可改自己的昵称
    host = new_client()
    auth(host, "device-test-kkkk", "主人")
    inv = host.post("/api/invites", json={}).get_json()["invite"]
    guest = new_client()
    auth(guest, "device-test-llll", "")
    check("默认昵称为「本机用户」", guest.get("/api/me").get_json()["user"]["nickname"] == "本机用户")
    guest.post(f"/api/invites/{inv['token']}/accept")
    names = [item["name"] for item in host.get("/api/buddies").get_json()["items"]]
    check("默认昵称不进对方目录", "本机用户" not in names, names)
    renamed = guest.patch("/api/me", json={"nickname": "小汤圆"})
    check("可以修改自己的昵称", renamed.get_json()["user"]["nickname"] == "小汤圆", renamed.get_json())


def test_pagination():
    print("\n[6] 游标分页（更远一档）")
    client = new_client()
    base = "/api/restaurants?lat=39.9963&lng=116.4703&radius=3000&strict=1&limit=8"

    first = client.get(base + "&offset=0").get_json()
    second = client.get(base + "&offset=8").get_json()
    third = client.get(base + "&offset=16").get_json()

    ids1 = [item["id"] for item in first.get("items") or []]
    ids2 = [item["id"] for item in second.get("items") or []]
    dists = [item.get("distance") or 0 for item in (first.get("items") or []) + (second.get("items") or [])]

    check("首页按 limit 返回", len(ids1) == 8, len(ids1))
    check("首页标记还有更多", first.get("hasMore") is True, first.get("hasMore"))
    check("游标指向下一页", first.get("nextOffset") == 8, first.get("nextOffset"))
    check("第二页与首页不重复", not (set(ids1) & set(ids2)), (ids1, ids2))
    check("跨页距离单调不减", dists == sorted(dists), dists[:6])
    check("翻到底返回空页", third.get("items") == [], third.get("items"))
    check("翻到底 hasMore=false", third.get("hasMore") is False, third.get("hasMore"))

    beyond = client.get(base + "&offset=999").get_json()
    check("越过末尾不报错", beyond.get("items") == [] and beyond.get("hasMore") is False, beyond)


def test_cloud_login():
    print("\n[7] WorkBuddy 账号登录")
    import services.api_v1 as api_v1

    client = new_client()
    auth(client, "device-test-cloud1", "本机用户")
    before = client.get("/api/me").get_json()["user"]
    created = client.post("/api/buddies", json={"name": "账号搭子", "area": "望京"}).get_json()["buddy"]

    empty = client.post("/api/auth/cloud", json={"token": ""})
    check("空 token 被拒绝", empty.status_code in (400, 401), empty.status_code)

    original = api_v1.verify_cloud_token
    api_v1.verify_cloud_token = lambda config, token: {
        "uid": "wb_user_123", "email": "eat@example.com", "name": "八哥", "avatar": "",
    }
    try:
        linked = client.post("/api/auth/cloud", json={"token": "fake-but-verified"})
        body = linked.get_json()
        check("账号登录成功", linked.status_code == 200 and body.get("ok"), body)
        check("返回账号标记", body["user"].get("cloud") is True, body["user"])
        check("昵称换成账号名", body["user"]["nickname"] == "八哥", body["user"])
        check("绑定到当前设备用户，数据不丢", body["user"]["id"] == before["id"], (before["id"], body["user"]["id"]))
        still = client.get("/api/buddies").get_json()["items"]
        check("原有搭子仍在", any(item["name"] == "账号搭子" for item in still), still)

        other = new_client()
        again = other.post("/api/auth/cloud", json={"token": "fake-but-verified"})
        check("同一账号换设备登录复用同一用户", again.get_json()["user"]["id"] == before["id"],
              again.get_json().get("user"))
        check("设备未登录也能建账号会话", again.status_code == 200, again.status_code)

        api_v1.verify_cloud_token = lambda config, token: (_ for _ in ()).throw(
            __import__("services.api_error", fromlist=["ApiError"]).ApiError("cloud_auth_failed", "登录已过期", 401))
        expired = new_client().post("/api/auth/cloud", json={"token": "expired"})
        check("云端判定失效时返回 401", expired.status_code == 401, expired.status_code)
    finally:
        api_v1.verify_cloud_token = original


def test_deals():
    print("\n[8] 团购降级与真实套餐")
    client = new_client()
    no_data = client.get("/api/deals?name=巷子里九宫格火锅&city=北京").get_json()
    check("无套餐时 linkOnly", no_data.get("linkOnly") is True, no_data)
    check("提供 4 个平台入口", len(no_data.get("links", [])) == 4, len(no_data.get("links", [])))
    check("不返回任何价格", all("price" not in item for item in no_data.get("items", [])))

    with app_module.app.app_context():
        conn = get_db()
        conn.execute(
            "INSERT INTO deals (id, store_id, store_name, platform, title, items, price_cents, "
            "original_price_cents, sold, valid_until, url, source, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("deal-test-1", "demo-001", "巷子里九宫格火锅", "meituan", "双人套餐",
             '["锅底","毛肚","鸭血"]', 12800, 19800, 320,
             (date.today() + timedelta(days=30)).isoformat(),
             "https://example.com/deal", "merchant", date.today().isoformat()),
        )
        conn.commit()

    with_deal = client.get("/api/deals?store_id=demo-001&name=巷子里九宫格火锅").get_json()
    check("有真实套餐时 linkOnly=false", with_deal.get("linkOnly") is False, with_deal)
    item = with_deal["items"][0]
    check("价格按元返回", item["price"] == 128.0, item["price"])
    check("折扣按原价计算", item["discount"] == 0.35, item["discount"])
    check("套餐标注来源", item["source"] == "merchant")

    listing = client.get("/api/restaurants?lat=39.9963&lng=116.4703&radius=3000").get_json()
    flagged = [row["id"] for row in listing["items"] if row.get("hasDeal")]
    check("门店列表标记有团购", "demo-001" in flagged, flagged)
    check("无套餐门店标记为 false",
          all(row.get("hasDeal") is False for row in listing["items"] if row["id"] != "demo-001"))

    # 折扣更高的套餐排在前面（推荐顺序：折扣 > 销量 > 价格）
    with app_module.app.app_context():
        conn = get_db()
        conn.execute(
            "INSERT INTO deals (id, store_id, store_name, platform, title, items, price_cents, "
            "original_price_cents, sold, valid_until, url, source, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("deal-test-2", "demo-001", "巷子里九宫格火锅", "dianping", "单人套餐",
             '["锅底"]', 9000, 10000, 90,
             (date.today() + timedelta(days=30)).isoformat(),
             "https://example.com/deal2", "merchant", date.today().isoformat()),
        )
        conn.commit()
    ranked = client.get("/api/deals?store_id=demo-001").get_json()["items"]
    check("按折扣力度排序", ranked[0]["id"] == "deal-test-1", [row["id"] for row in ranked])

    check("缺少门店参数返回 400", client.get("/api/deals").status_code == 400)


def test_dice():
    print("\n[9] 骰子结账规则")
    client = new_client()
    auth(client, "device-test-gggg", "掷骰人")
    buddy = client.post("/api/buddies", json={"name": "搭子"}).get_json()["buddy"]

    history_count = 0
    for _ in range(15):
        result = client.post("/api/dice", json={"buddyId": buddy["id"]}).get_json()
        history_count += 1
        my_roll, buddy_roll, diff, payer = result["myRoll"], result["buddyRoll"], result["diff"], result["payer"]
        ok_range = 1 <= my_roll <= 6 and 1 <= buddy_roll <= 6
        if diff <= 2:
            ok_rule = payer == "aa"
        elif my_roll < buddy_roll:
            ok_rule = payer == "me"
        else:
            ok_rule = payer == "buddy"
        if not (ok_range and ok_rule and diff == abs(my_roll - buddy_roll)):
            check("骰子规则正确", False, result)
            break
    else:
        check("骰子点数与赔付规则正确（15 次）", True)

    history = client.get("/api/dice/history").get_json()["items"]
    check("历史记录可查询", len(history) == history_count, len(history))
    check("不能给别人的搭子掷骰", client.post("/api/dice", json={"buddyId": "b_not_exist"}).status_code == 404)


def test_telemetry():
    print("\n[11] 前端错误上报")
    client = new_client()

    ok = client.post("/api/client-error", json={
        "kind": "error", "message": "boom", "source": "app.js", "line": 12,
        "stack": "Error: boom\n  at app.js:12", "path": "/",
    })
    check("错误上报返回 ok", ok.status_code == 200 and ok.get_json().get("ok") is True, ok.status_code)

    check("缺少信息返回 400",
          client.post("/api/client-error", json={}).status_code == 400)
    check("非 JSON 请求体返回 400",
          client.post("/api/client-error", data="x", content_type="text/plain").status_code == 400)

    long = client.post("/api/client-error", json={"message": "x" * 2000})
    check("超长信息截断而不报错", long.status_code == 200, long.status_code)

    wrong = client.get("/api/client-error")
    check("GET 错误上报返回 JSON 405",
          wrong.status_code == 405 and wrong.get_json().get("code") == "method_not_allowed",
          wrong.status_code)


def test_security():
    print("\n[10] 安全与错误处理")
    client = new_client()
    auth(client, "device-test-hhhh", "安全测试")

    cross = client.post("/api/buddies", json={"name": "跨站"}, headers={"Origin": "http://evil.example"})
    check("跨站写请求被拒绝", cross.status_code == 403, cross.status_code)
    check("跨站错误码稳定", cross.get_json().get("code") == "cross_origin")

    # 反向代理场景：Host 被改写成内网地址，浏览器 Origin 是公网域名，不能判成跨站
    proxied = client.post(
        "/api/buddies",
        json={"name": "同源代理"},
        headers={
            "Origin": "https://today-eat-47626.app.workbuddy.host",
            "X-Forwarded-Host": "today-eat-47626.app.workbuddy.host",
        },
    )
    check("代理改写 Host 时不再误判跨站", proxied.status_code == 200, proxied.get_json())

    sec_fetch = client.post(
        "/api/buddies",
        json={"name": "同源兜底"},
        headers={
            "Origin": "https://today-eat-47626.app.workbuddy.host",
            "Sec-Fetch-Site": "same-origin",
        },
    )
    check("同源写请求可用 Sec-Fetch-Site 兜底", sec_fetch.status_code == 200, sec_fetch.get_json())

    spoof = client.post(
        "/api/buddies",
        json={"name": "伪造同源"},
        headers={
            "Origin": "http://evil.example",
            "Sec-Fetch-Site": "cross-site",
        },
    )
    check("声明跨站的写请求仍被拒绝", spoof.status_code == 403, spoof.status_code)

    bad_json = client.post("/api/buddies", data="not-json", content_type="application/json")
    check("非 JSON 请求体返回 400", bad_json.status_code == 400, bad_json.status_code)

    wechat = client.get("/auth/wechat?sharecode=SC123")
    check("未配置微信时重定向提示", wechat.status_code == 302 and "wechat=unconfigured" in wechat.headers["Location"],
          wechat.headers.get("Location"))
    check("未配置时分享码不丢", "sharecode=SC123" in (wechat.headers.get("Location") or ""),
          wechat.headers.get("Location"))

    app_module.app.config.update(
        WECHAT_APP_ID="wx_test_appid",
        WECHAT_APP_SECRET="wx_test_secret",
        WECHAT_REDIRECT_URI="",
    )
    try:
        # 没配 WECHAT_REDIRECT_URI 时，回调地址要按对外域名自动拼，不能是内网 host
        derived = client.get(
            "/auth/wechat?next=/&sharecode=SC123",
            headers={"X-Forwarded-Host": "today-eat-47626.app.workbuddy.host", "X-Forwarded-Proto": "https"},
        )
        derived_loc = derived.headers.get("Location", "")
        from urllib.parse import parse_qs, urlparse as _urlparse
        params = parse_qs(_urlparse(derived_loc).query)
        check("授权地址按对外域名生成回调",
              params.get("redirect_uri", [""])[0] == "https://today-eat-47626.app.workbuddy.host/auth/wechat/callback",
              params.get("redirect_uri"))

        app_module.app.config.update(WECHAT_REDIRECT_URI="https://example.com/auth/wechat/callback")
        authorize = client.get("/auth/wechat?next=/home&sharecode=SC123")
        location = authorize.headers.get("Location", "")
        check("微信授权跳转含 appid 与 scope",
              "open.weixin.qq.com" in location and "appid=wx_test_appid" in location and "snsapi_userinfo" in location,
              location[:120])

        # state 里应带着分享码，回调失败也能回到可用链接
        with app_module.app.app_context():
            from services.db import get_db
            row = get_db().execute("SELECT next_path FROM oauth_states ORDER BY rowid DESC LIMIT 1").fetchone()
        check("state 记录保留分享码", row and "sharecode=SC123" in row["next_path"], row["next_path"] if row else None)

        bad_state = client.get("/auth/wechat/callback?state=bad&code=x&sharecode=SC123")
        check("微信回调 state 校验失败",
              bad_state.status_code == 302 and "state_invalid" in bad_state.headers["Location"],
              bad_state.headers.get("Location"))
        check("回调失败保留分享码", "sharecode=SC123" in (bad_state.headers.get("Location") or ""),
              bad_state.headers.get("Location"))
    finally:
        app_module.app.config.update(WECHAT_APP_ID="", WECHAT_APP_SECRET="", WECHAT_REDIRECT_URI="")

    client.delete("/api/account")
    check("注销后身份失效", client.get("/api/me").get_json().get("user") is None)


if __name__ == "__main__":
    test_auth()
    test_buddy_crud()
    test_draw()
    test_invites()
    test_buddy_fixes()
    test_pagination()
    test_cloud_login()
    test_deals()
    test_dice()
    test_security()
    test_telemetry()
    print("\n" + "=" * 46)
    print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    if FAIL:
        for item in FAIL:
            print(" - " + item)
        sys.exit(1)
