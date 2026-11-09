# 前后端职责与 API 约定（v1）

本文是「今天吃啥」的工程契约：前端只负责渲染与本地交互，后端负责第三方代理、身份、社交关系、团购与持久化。所有接口以本文为准，改动需同步版本号。

---

## 一、职责划分

| 层 | 负责 | 不负责 |
|---|---|---|
| 前端（HTML/CSS/JS） | 五页渲染、筛选/抽店/泡泡动画、本地打卡、调用 API、错误态与空态 | 不直连第三方 Key、不落业务数据、不判断权限 |
| 后端（Flask） | POI/路线代理、多源容错、匿名/微信身份、饭搭子与邀请、团购查询、骰子、SQLite 持久化、限流与安全头 | 不做页面渲染（除邀请落地页）、不做支付 |

数据归属：

- 打卡记录：仍只存浏览器 localStorage（PRD 边界）；
- 用户/搭子/邀请/骰子/团购：SQLite；
- 商家/路线：实时拉取，不落库（团购套餐除外）。

---

## 二、统一响应

成功：

```json
{ "ok": true, "requestId": "a1b2c3d4", "...": "业务字段" }
```

失败：

```json
{ "ok": false, "code": "invalid_param", "message": "昵称 不能为空",
  "hint": "可选的修复建议", "requestId": "a1b2c3d4" }
```

- 所有响应带 `X-Request-Id` 头；错误体也带 `requestId`；
- `Content-Type: application/json; charset=utf-8`；
- API 一律 `Cache-Control: no-store`；
- 写操作（POST/PATCH/DELETE）校验 `Origin`，跨站返回 403 `cross_origin`。

---

## 三、身份与会话

### 3.1 匿名设备（默认）

```http
POST /api/auth/device
Content-Type: application/json

{ "deviceId": "8~64 位字母数字_-", "nickname": "可选，≤20 字" }
```

返回用户并 `Set-Cookie: sid=...; HttpOnly; SameSite=Lax; Path=/`。前端把 `deviceId` 存 localStorage，首次进入调用一次。

### 3.2 微信网页授权（可选）

```http
GET /auth/wechat?next=/
→ 302 open.weixin.qq.com/connect/oauth2/authorize?...
GET /auth/wechat/callback?code=&state=
→ 302 next；失败重定向 /?wechat=unconfigured|state_invalid|state_expired|failed
```

- 需要认证服务号、网页授权域名、`WECHAT_APP_ID/SECRET/REDIRECT_URI`；
- `state` 一次性、10 分钟过期；
- 已登录的匿名用户会把 openid 绑到当前账号，保留饭搭子数据；
- **不读取微信好友列表**（平台不提供）。

### 3.3 当前用户 / 退出 / 注销

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/me` | 未登录返回 `user: null`，不报错 |
| POST | `/api/auth/logout` | 删除会话并清 Cookie |
| DELETE | `/api/account` | 注销并级联删除搭子/邀请/骰子 |

---

## 四、饭搭子

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/buddies` | 是 | 当前用户的搭子目录 |
| POST | `/api/buddies` | 是 | `{name, area?, lat?, lng?, cuisines?, budget?, avatarColor?}` |
| PATCH | `/api/buddies/<id>` | 是 | 部分更新；跨用户返回 404 |
| DELETE | `/api/buddies/<id>` | 是 | 删除 |
| POST | `/api/buddies/draw` | 是 | `{lat?, lng?, cuisine?, budget?}` 加权抽一个搭子 |

抽取权重（写死）：

```
proximity = 1 − min(distance, 5000) / 5000        # 无位置给 0.5
cuisine   = 1.0 if 菜系匹配 else 0.4
budget    = 1 − min(|预算差|, 100) / 100           # 缺失给 0.5
recency   = min(距上次聚餐天数 / 30, 1)            # 缺失给 0.5
weight    = (0.40*proximity + 0.25*cuisine + 0.20*budget + 0.10*recency + 0.05)²
```

返回 `buddy / score / breakdown / distance / reason / rule`，前端可直接展示“为什么抽到 TA”。

---

## 五、邀请

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/invites` | 是 | `{inviteeName?}` → `{token, url, expiresAt}` |
| GET | `/api/invites/<token>` | 否 | 公开详情：邀请人、状态、过期时间 |
| POST | `/api/invites/<token>/accept` | 是 | 接受后双方互为搭子 |
| DELETE | `/api/invites/<token>` | 是 | 撤销未使用的邀请 |
| GET | `/i/<token>` | 否 | 邀请落地页（H5，接受后互加） |
| GET | `/assets/app.css` | 否 | 打包后的样式（内容哈希版本、immutable） |
| GET | `/assets/app.js` | 否 | 打包后的脚本（按依赖顺序拼接） |
| POST | `/api/client-error` | 否 | 前端错误上报：`{kind,message,source,line,stack,path}`，写日志 |

- token 7 天过期，一次性；
- 不能接受自己的邀请（409 `invite_self`）；
- 重复接受 409，过期 410。

---

## 六、团购

```http
GET /api/deals?store_id=demo-001&name=巷子里九宫格火锅&city=北京
```

有真实套餐：

```json
{ "ok": true, "linkOnly": false, "items": [{
  "id": "deal-1", "platform": "meituan", "platformLabel": "美团",
  "title": "双人套餐", "items": ["锅底","毛肚"], "price": 128.0,
  "originalPrice": 198.0, "discount": 0.35, "sold": 320,
  "validUntil": "2026-11-30", "url": "https://...", "source": "merchant",
  "updatedAt": "2026-10-26" }] }
```

无套餐（降级）：

```json
{ "ok": true, "linkOnly": true, "items": [], "links": [
  { "platform": "meituan", "label": "美团", "url": "https://www.meituan.com/s/..." }
], "note": "暂无合作套餐，去平台查看实时团购" }
```

规则：**绝不返回编造价格**；过期套餐自动过滤；只展示商家提供或官方授权数据。

---

## 七、骰子结账

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/dice` | 是 | `{buddyId}`；服务端 `SystemRandom` 各掷 1 枚 D6 |
| GET | `/api/dice/history?limit=20` | 是 | 最近记录 |

规则：差值 ≥3 点数小者付（`payer=me|buddy`），≤2 AA（`payer=aa`）。服务端生成并落库，避免前端改结果。

---

## 八、错误码

| code | HTTP | 含义 |
|---|---|---|
| `auth_required` | 401 | 未建立会话 |
| `invalid_param` | 400 | 参数缺失/越界/格式错 |
| `invalid_json` | 400 | 请求体不是 JSON 对象 |
| `buddy_exists` | 409 | 同名搭子已存在 |
| `buddy_not_found` | 404 | 搭子不存在或不属于当前用户 |
| `no_buddies` | 409 | 目录为空，无法抽取 |
| `invite_not_found` | 404 | token 无效 |
| `invite_used` | 409 | 已被接受/撤销 |
| `invite_expired` | 410 | 已过期 |
| `invite_self` | 409 | 接受自己的邀请 |
| `cross_origin` | 403 | 跨站写请求 |
| `rate_limited` | 429 | 触发限流，带 `Retry-After` |
| `wechat_unconfigured` | 501 | 未配置公众号 |
| `wechat_error` | 502 | 微信返回错误 |

---

## 九、数据模型（SQLite）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | id, device_id, wechat_openid, unionid, nickname, avatar, city | 匿名/微信身份 |
| `sessions` | token_hash, user_id, expires_at | 只存 token 哈希，30 天 |
| `oauth_states` | state, created_at, next_path | 一次性、10 分钟 |
| `buddies` | id, owner_id, name, area, lat, lng, cuisines, budget, last_met | 唯一 `(owner_id, name)` |
| `invites` | token, inviter_id, status, expires_at | 7 天 |
| `deals` | store_id, platform, price_cents, original_price_cents, valid_until, source | 真实套餐 |
| `dice_records` | user_id, buddy_id, my_roll, buddy_roll, payer | 结账记录 |

外键均 `ON DELETE CASCADE`（除 `deals`），WAL 模式，每请求一连接。

---

## 十、前端接入状态

已接入（`static/js/`）：

| 能力 | 模块 | 入口 |
|---|---|---|
| 匿名设备身份 | `buddy.js:ensureSession` | 首次进入自动建立，失败不影响选店 |
| 搭子目录 / 添加 / 删除 | `buddy.js` | 底部 Tab「搭子」 |
| 邀请链接 | `buddy.js:openInvite` | 搭子页「发邀请」 |
| 加权抽搭子 | `buddy.js:draw` | 搭子页底部 / 详情页「抽个搭子陪我吃」 |
| 骰子结账 | `buddy.js:rollDice` | 搭子页「今天谁结账」 |
| 团购 | `deals.js` | 详情页底部「看团购」 |

### 原接入顺序（供二次开发参考）

1. 首次进入：从 localStorage 取 `deviceId`，没有则生成 UUID，调用 `POST /api/auth/device`；
2. 搭子页：`GET /api/buddies`，新增用 `POST`，删除用 `DELETE`；
3. 邀请：`POST /api/invites` 拿到 `url`，用系统分享/复制；被邀请人打开链接后先建会话，再 `POST /accept`；
4. 详情页团购：`GET /api/deals?store_id=&name=&city=`；`linkOnly=true` 时只渲染平台入口；
5. 骰子：`POST /api/dice`，禁止前端自行随机，保证可追溯；
6. 所有写请求带 `Content-Type: application/json`，失败按 `code` 分支提示。

---

## 十一、运行与验证

```bash
# 开发
python app.py                 # http://127.0.0.1:5000

# Windows 生产
python run.py                 # waitress，默认 8000

# Linux / Docker
docker compose up --build     # http://127.0.0.1:8000，数据卷 ./data

# 验证
python tests/test_rules.py     # 页面、静态资源与规则 61 项
python tests/test_backend.py   # 后端与鉴权 59 项
node tests/e2e_smoke.js        # 浏览器链路 72 项
```

部署检查：HTTPS、`SESSION_COOKIE_SECURE=1`、地图 Key 域名白名单、`TRUST_PROXY=1`（反向代理后）、`DATABASE_PATH` 挂载持久卷。
