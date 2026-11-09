# 今天吃啥 · H5 网页小程序

面向大学生与年轻上班族的日常吃饭决策工具：基于定位拉取周边餐饮 POI，用「筛选 + 摇一摇」解决选择困难，选定餐厅后顺带给「饭后逛玩」路线。周末提供 solo / 聚餐两种子模式。

- 交付形态：移动端 H5（手机浏览器打开即用），技术栈 **Python Flask + 原生 HTML/CSS/JS**（无前端框架、无构建步骤）
- 五页主链路：首页瀑布流 → 商家详情 → 内嵌导航 → 饭后游玩 →（右滑回首页）；底部 Tab 直达「我的打卡」「谁陪我吃呀」
- 决策更准：列表标注「已打烊」并支持「营业中」筛选；饭后游玩可按 30 分钟 / 1 小时 / 2 小时预算过滤
- 吃饭之外：详情页看团购（真实套餐或平台入口）、抽个搭子陪我吃（位置加权）、今天谁结账（服务端掷骰）、抽到的店可分享直达
- 空间找店：美食雷达按方位角 + 直线距离把当前筛选结果铺到雷达盘上，支持点选看店与「扫描推荐一家」
- 打卡可**云同步**：接入 WorkBuddy Cloud Service（数据库 + 账号登录），登录后打卡自动上云、跨设备可恢复；未登录仍存本机
- 后端持久化：SQLite（用户、会话、搭子、邀请、团购、骰子）；打卡云同步走 WorkBuddy Cloud Service

---

## 一、快速开始

```bash
# 1. 安装依赖（仅需 Flask）
pip install -r requirements.txt

# 2. 启动（默认 http://127.0.0.1:5000）
python app.py

# 3. 手机同局域网访问
#    Windows: ipconfig 查本机 IPv4，手机浏览器打开 http://<本机IP>:5000
```

首次打开会请求浏览器定位；拒绝授权后弹「城市 + 商圈」手动输入框（不使用 IP 归属地推荐）。

### 无 Key 也能完整跑通

未配置任何地图 Key 时，`MAP_PROVIDER=auto` 会自动降级到**演示数据源**：

- 16 家望京示例门店（含 solo / 聚餐标记）（坐标、评分、人均、营业时间、标签、公开评价摘要）；
- 图片为需求包内的实拍参考素材（占位），界面底部标注「演示数据」；
- 路线、游玩点位、特色街巷按真实几何规则计算，五页交互全部可用。

### 接入真实数据

复制 `.env.example` 为 `.env`，填入 Key 后重启：

| 变量 | 用途 | 申请地址 |
|---|---|---|
| `AMAP_WEB_KEY` | 服务端 POI / 路径规划 / 地理编码 | https://console.amap.com/dev/key/app （类型选 **Web 服务**） |
| `AMAP_JS_KEY` | 前端内嵌地图（可选） | 同上，类型选 **Web 端 (JS API)** |
| `AMAP_JS_SECURITY_CODE` | JS API 安全密钥（可选） | 与 JS Key 配套 |
| `BAIDU_WEB_AK` | 备用 POI 源 | https://lbsyun.baidu.com/apiconsole/key （**服务端**） |
| `BAIDU_JS_AK` | 备用前端地图（可选） | 同上，**浏览器端** |

配置后需在控制台为 Key 设置域名白名单（本地调试可填 `127.0.0.1`）。

也可以强制指定数据源：

```bash
MAP_PROVIDER=amap    # 只用高德
MAP_PROVIDER=baidu   # 只用百度
MAP_PROVIDER=osm     # 只用 OpenStreetMap（无需 Key，字段较少）
MAP_PROVIDER=demo    # 只用演示数据
```

---

## 二、目录结构

```
.
├── app.py                  # 入口：app 实例 + 开发启动（装配在 services/app_factory.py）
├── wsgi.py / run.py        # gunicorn / waitress 生产入口
├── Dockerfile              # 容器镜像
├── docker-compose.yml      # 一键启动 + 数据卷
├── config.py               # 配置：数据源、Key、容错、DB、微信
├── services/
│   ├── app_factory.py      # 应用装配：配置、蓝图、错误处理
│   ├── routes_pages.py     # 页面与邀请落地页 + 静态资源包路由
│   ├── routes_legacy.py    # 只读 API：POI/路线/游玩/采集说明
│   ├── web_security.py     # 安全头、同源校验、限流、gzip、缓存、访问日志
│   ├── bundles.py          # 启动时合并 CSS/JS，内容哈希做版本号
│   ├── bootstrap.py        # 首屏配置载荷
│   ├── db.py               # SQLite 连接与建表
│   ├── auth.py             # 匿名会话 / 微信用户 / Cookie
│   ├── social.py           # 饭搭子、邀请、抽取、骰子
│   ├── deals.py            # 团购查询与降级
│   ├── wechat.py           # 微信 OAuth
│   ├── api_v1.py           # v1 API 蓝图
│   ├── api_error.py        # 统一 API 异常
│   ├── crawler.py          # 采集层：来源注册、限流、重试、校验、统计
│   ├── provider_amap.py    # 高德适配器（POI / 详情 / 路线 / 游玩点位）
│   ├── provider_baidu.py   # 百度适配器（BD-09 → GCJ-02 坐标转换）
│   ├── provider_osm.py     # OpenStreetMap Overpass（无需 Key）
│   ├── provider_demo.py    # 演示数据源（含评价语料、路线生成）
│   ├── data_service.py     # 主源 → 备源 → 扩半径 → 友好报错
│   ├── ratelimit.py        # 单 IP 滑动窗口限流
│   ├── ranker.py           # 权重规则：0.3 降权 / +30% / 500m
│   ├── holiday.py          # 2026 调休日历与周末模式判定
│   └── geo.py              # 球面距离、坐标系转换、时长估算
├── data/
│   ├── app.db              # SQLite（运行时生成，已 gitignore）
│   ├── restaurants.json    # 16 家演示门店
│   ├── reviews.json        # 评价语料（项目自建，非抓取）
│   ├── play_spots.json     # 游玩点位模板 + 特色街巷
│   └── holidays.json       # 国办发明电〔2025〕7 号
├── templates/
│   ├── index.html          # 五页结构 + SVG 图标集
│   └── invite.html         # 饭搭子邀请落地页
├── static/
│   ├── css/style.css       # 设计令牌、通用组件
│   ├── css/pages.css       # 分页样式
│   ├── js/                 # 22 个模块：分页/筛选/瀑布流/泡泡/地图/打卡/搭子/团购/雷达/云服务/路由/定位/错误上报…
│   ├── favicon.svg         # 站点图标
│   ├── img/                # 需求包实拍图（1080w）
│   └── img/thumb/          # 480w 列表缩略图
├── deploy/nginx.conf       # 生产反向代理示例（HTTP/2、TLS、缓存、gzip/brotli）
├── tools/
│   ├── build_demo_data.py  # 生成演示门店数据
│   ├── img_optimize.js     # 图片两档压缩（Chromium Canvas，无三方依赖）
│   └── img_webp.js         # 生成 WebP 两档图（原 JPEG 保留回退）
├── tests/
│   ├── test_rules.py       # 66 项规则、安全、静态资源与前台接口
│   ├── test_backend.py     # 59 项身份/搭子/邀请/团购/骰子/错误上报
│   ├── e2e_smoke.js        # 88 项浏览器链路（含雷达/WebP/错误上报/返回键）
│   └── bench.py            # 性能测评：体积、gzip、图片格式、API p50/p95
└── docs/                   # 需求/设计/采集/鉴权/前端架构/产品迭代/重构测评/改进记录
```

---

## 三、接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 五页单页应用 |
| GET | `/api/bootstrap` | 首屏配置：地图 Key、周末判定、默认坐标 |
| GET | `/api/restaurants?lat&lng&radius&q` | 周边餐饮 POI（含多源容错） |
| GET | `/api/restaurant/<id>` | 商家详情 + 公开评价摘要 |
| GET | `/api/route?from_lat&from_lng&to_lat&to_lng&mode` | 步行 / 骑行 / 驾车路线 |
| GET | `/api/play-spots?lat&lng&store_id` | 饭后点位（含顺路度、特色街巷） |
| GET | `/api/geocode?q&city` | 商圈 → 坐标 |
| GET | `/api/sources` | 采集来源、频率策略、校验规则、实时统计 |
| POST | `/api/auth/device` | 匿名设备换取会话 Cookie |
| GET | `/api/me` | 当前用户（未登录返回 null） |
| POST | `/api/auth/logout` | 退出会话 |
| DELETE | `/api/account` | 注销并级联删除数据 |
| GET/POST | `/api/buddies` | 饭搭子目录 |
| PATCH/DELETE | `/api/buddies/<id>` | 更新 / 删除搭子 |
| POST | `/api/buddies/draw` | 位置加权抽搭子 |
| POST | `/api/invites` | 生成邀请（7 天） |
| GET | `/api/invites/<token>` | 邀请公开详情 |
| POST | `/api/invites/<token>/accept` | 接受邀请，双方互加 |
| GET | `/api/deals` | 团购套餐或平台跳转 |
| POST | `/api/client-error` | 前端错误上报（写日志，不采集用户数据） |
| POST | `/api/dice` | 服务端掷骰并判定谁结账 |
| GET | `/api/dice/history` | 骰子历史 |
| GET | `/i/<token>` | 邀请落地页（接受后互加） |
| GET | `/auth/wechat` | 微信网页授权（需配置） |

完整字段、错误码与数据模型见 [`docs/API约定.md`](docs/API约定.md)。

所有接口统一返回 `{ok: true, ...}` 或 `{ok: false, message, hint, code}`；
服务端异常只写日志，前端永远收到人话提示。

---

## 四、饭搭子 / 团购 / 骰子

### 谁陪我吃呀（底部 Tab「搭子」）

| 能力 | 说明 |
|---|---|
| 饭搭子目录 | 昵称、常出没商圈、爱吃的菜系（≤3）、人均预算；保存后进入加权抽取池 |
| 添加方式 | 手动填写、Android `navigator.contacts.select()`（仅读取你勾选的联系人）、邀请链接 |
| 邀请 | `POST /api/invites` 生成 7 天一次性链接；对方打开 `/i/<token>` 接受后**双方自动互加** |
| 抽搭子 | 以当前门店坐标/菜系/人均为条件，服务端加权随机：距离 40% · 口味 25% · 预算 20% · 久未见面 10% · 随机 5%，返回权重拆解 |
| 微信登录 | 可选；只拿 openid / 昵称 / 头像 / 城市。**微信不提供好友列表**，所以搭子仍靠邀请链接 |

### 今天谁结账

两位各掷 1 枚 D6，由服务端 `SystemRandom` 生成并落库：差值 ≥3 点数小者结账，≤2（含平局）AA。结果与历史可在「搭子 → 今天谁结账」查看。

### 营业状态与时间预算

- 列表会标注「已打烊」，并支持「营业中」筛选；**没有营业时间的门店按未知处理，不会被过滤**；
- 营业时间支持跨夜（如 `16:00 - 次日 02:00`），凌晨时段同样能正确判断；
- 饭后游玩可选 30 分钟 / 1 小时 / 2 小时内，按步行时间过滤卡片与地图点位。

### 团购

`GET /api/deals` 有商家/官方套餐时返回真实价格、原价、折扣、有效期与来源；没有数据时 `linkOnly=true`，只给美团/大众点评/抖音/高德搜索入口。**任何情况下都不编造价格**，下单与支付都在平台侧完成。

---

## 五、写死的规则参数

| 规则 | 实现位置 | 数值 |
|---|---|---|
| 搜索半径阶梯 | `config.SEARCH_RADIUS_STEPS` | 3km → 5km → 8km |
| 已打卡门店随机权重 | `ranker.CHECKED_WEIGHT` | 0.3 |
| 特色街巷排序加成 | `ranker.FEATURED_BOOST` | 1.3（权重高 30%） |
| 绕行阈值 | `ranker.DETOUR_LIMIT` | 500 米 |
| 顺路度 | `ranker.rank_play_spots` | `100 − 绕行 ÷ 500 × 100` |
| 人均分档（正餐） | `ranker.PER_CAPITA_TIERS` | 100 内 / 100-200 / 200-300 / 300+ |
| 人均分档（甜点饮品） | 同上 | 50 内 / 50-70 / 70-100 / 100+ |
| 请求间隔 | `crawler.SOURCES` | 高德/百度 1s，OSM 3s |
| 失败重试 | `crawler.fetch_json` | ≤2 次，指数退避 0.6/1.2/2.4s |

周末模式：周六/周日自动开启，但 `data/holidays.json` 中的**调休上班日**不开启；用户手动开关当天优先，存 localStorage。开启后可在「一个人吃（solo）/ 一起聚餐」之间切换，默认 solo。solo 优先用 `soloFriendly` 标记，真实数据源无标记时按「无包间 + 饮品/人均≤100」推断。

---

## 六、自测

```bash
python tests/test_rules.py     # 通过 66 项
python tests/test_backend.py   # 通过 59 项（身份/搭子/邀请/团购/骰子/错误上报）
node tests/e2e_smoke.js        # 通过 88 项
```

覆盖：调休判定、0.3 权重、+30% 与 500m 规则、顺路度公式、坐标/评分/人均校验、去重、安全响应头、限流、状态码、静态资源体积、6 个 API。

端到端冒烟（真实点击五页链路，需先启动服务；需要 Node 22 + Edge/Chrome）：

```bash
node tests/e2e_smoke.js          # 88 项检查
node tests/e2e_smoke.js --shots  # 同时输出 shots/*.png
python tests/bench.py --json docs/bench-after.json   # 8 项性能预算
```

图片重新压缩（会覆盖 `static/img`）：

```bash
node tools/img_optimize.js --port 5000
```

移动端手工验收建议：

1. 首页左右滑动 → 详情 → 出行方式 → 导航 → 吃完去哪玩 → 右滑回首页；
2. 详情页点「吃过了」→ 底部 Tab「我的打卡」查看分组；
3. 摇一摇（需真机）或点「🎲 随机抽一家」；
4. 断开定位权限，验证手动商圈弹层；
5. 打卡页导出 JSON，清空站点数据后导入恢复。

---

## 七、性能与安全

### 已做优化

| 项 | 数据 |
|---|---|
| 图片总量 | 8.49MB → **1.41MB**（-83%），两档 1080w / 480w |
| 首屏 4 张卡片图片 | 约 3.7MB → **96KB** |
| 未使用的 Bootstrap CSS | 移除 **233KB**（含同名类冲突） |
| CSS/JS 打包 | 启动时合并为 1 个 CSS + 1 个 JS，首屏资源请求 **18 → 2** |
| 传输压缩 | 自建 gzip 中间件：CSS 55.9KB → **11.0KB**，JS 162KB → **43.9KB** |
| 图片格式 | 新增 WebP 两档 + `<picture>` 回退：缩略图 -32%，大图 -35% |
| 静态缓存 | 内容哈希版本号 + `immutable`，重复访问 0 请求 |
| 列表切换筛选 | 复用 DOM，不重建图片、不重放入场动画 |
| 首图加载 | `fetchpriority=high`，前两张 eager，其余 lazy |
| 请求竞态 | AbortController + 序号，旧响应不覆盖新结果 |

首屏 HTML + CSS + JS 传输：**约 476KB → 61.6KB（-87%）**，请求数 19 → 3。
首屏图片（8 张缩略图）：246.6KB → **167KB**，整屏合计约 307KB → **229KB**。
接口 `/api/restaurants`：9.7KB → 2.1KB（gzip -78%），本地 p95 约 32ms。
实测脚本：

```bash
python tests/bench.py --json docs/bench-after.json
```

生产环境建议在前面再加一层 Nginx：HTTP/2、brotli、TLS 与会话复用。

### 安全配置

- 安全响应头：CSP（带 nonce）、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`；
- `/api/*` 一律 `Cache-Control: no-store`；
- 单 IP 限流：默认 300 次/分（NAT / 办公网下多设备共享出口 IP）；配置真实地图 Key 后，搜索接口另按 40 次/分收紧（`RATE_LIMIT_PER_MINUTE` / `SEARCH_RATE_LIMIT_PER_MINUTE`）；
- 参数校验：经纬度范围、商家编号白名单正则、关键词长度；
- 响应体上限 3MB、请求体上限 1MB；
- 生产默认关闭 debug（`FLASK_DEBUG=0`）。

若反向代理后部署，设 `TRUST_PROXY=1` 以正确获取客户端 IP；若地图 SDK 与 CSP 冲突，可临时 `CSP_ENABLED=0` 排查。

## 八、部署

```bash
# 开发（Flask 自带服务器，含热重载）
python app.py                  # http://127.0.0.1:5000

# Windows 生产（waitress）
pip install -r requirements.txt
python run.py                  # http://127.0.0.1:8000

# Linux 生产（gunicorn）
pip install gunicorn
gunicorn -w 2 --threads 4 -b 0.0.0.0:8000 wsgi:app

# Docker（含 SQLite 数据卷）
docker compose up --build      # http://127.0.0.1:8000
```

数据库默认 `data/app.db`，首次启动自动建表；容器内为 `/data/app.db`，由 `docker-compose.yml` 挂载。备份直接复制该文件即可。

微信登录需额外配置（不配则自动降级为匿名设备）：

```bash
WECHAT_APP_ID=...
WECHAT_APP_SECRET=...
WECHAT_REDIRECT_URI=https://your.domain/auth/wechat/callback
```

上线注意：

- 必须 HTTPS（浏览器定位 API 要求安全上下文，`localhost` 除外）；
- 地图 Key 配置域名白名单，不要把 `AMAP_WEB_KEY` 写进前端；
- `REQUEST_INTERVAL` 不应低于 1 秒，避免触发平台限流；
- 限流计数在进程内，多 worker 时实际阈值约为 `worker 数 × 配置值`，需要严格限流请放到网关层；
- 打卡数据在用户浏览器本地；用户/搭子/邀请/骰子/团购在 SQLite，需持久化 `data/app.db`；
- 多 worker 下 SQLite 写入串行，已开 WAL + 5s busy_timeout，小团队 2 worker 足够；
- 微信登录不提供好友列表，饭搭子仍通过邀请链接建立。

---

## 九、已知限制

1. **演示数据非真实商家**：未配置 Key 时展示的 16 家店为示例，界面对应位置标注「演示数据」；真实版本由 POI 接口返回。
2. **评价合规**：只使用地图 POI 公开评价摘要 + 跳转原平台，不抓取美团/大众点评/抖音/小红书的单条内容（见 `docs/数据采集说明.md`）。
3. **OSM 源字段有限**：无评分、人均、图片，星级/人均筛选在该源下会过滤掉无数据门店。
4. **真实地图需 Key**：未配置 JS Key 时使用自绘 SVG 简版地图，能画路线、标记与特色街巷，但不含真实路网瓦片与实时路况。
5. **摇一摇**：iOS 需用户手势触发一次动作权限申请；不支持时按钮抽店仍可用。
6. **清缓存提醒**：浏览器不允许自定义 `beforeunload` 文案，只能弹系统确认框；另有 7 天未备份的站内提示。
