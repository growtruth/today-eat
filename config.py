"""全局配置。

所有第三方 Key 一律从环境变量读取（可写在项目根目录 .env 中），
代码里不出现真实 Key，便于替换数据源与安全交付。
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def _load_dotenv(path: Path) -> None:
    """极简 .env 解析：仅在系统环境变量缺失时写入，避免覆盖线上配置。"""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv(BASE_DIR / ".env")


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "weekend-eat-dev-only")

    # ---------------- 数据源 ----------------
    # auto：按 amap → baidu → demo 的顺序依次尝试；
    # 也可强制指定单一数据源，便于排查问题。
    MAP_PROVIDER = os.getenv("MAP_PROVIDER", "auto").strip().lower()

    # 高德 Web 服务 Key（服务端调用 POI / 路径规划 / 地理编码）
    AMAP_WEB_KEY = os.getenv("AMAP_WEB_KEY", "").strip()
    # 高德 Web 端（JS API）Key（前端内嵌地图）
    AMAP_JS_KEY = os.getenv("AMAP_JS_KEY", "").strip()
    AMAP_JS_SECURITY_CODE = os.getenv("AMAP_JS_SECURITY_CODE", "").strip()
    # 百度地图 AK（服务端 Place / Direction / Geocoding）
    BAIDU_WEB_AK = os.getenv("BAIDU_WEB_AK", "").strip()
    # 百度地图 JS API AK（前端内嵌地图）
    BAIDU_JS_AK = os.getenv("BAIDU_JS_AK", "").strip()

    # ---------------- 容错参数 ----------------
    # 搜索半径阶梯：主半径失败/结果过少时逐级扩大
    SEARCH_RADIUS_STEPS = (3000, 5000, 8000)
    # 服务端对外请求的最小间隔（秒）
    REQUEST_INTERVAL = _float("REQUEST_INTERVAL", 1.0)
    # 单个数据源的最大重试次数
    MAX_RETRY = _int("MAX_RETRY", 2)
    # 单次外部请求超时（秒）
    REQUEST_TIMEOUT = _float("REQUEST_TIMEOUT", 6.0)

    # ---------------- 定位默认值 ----------------
    DEFAULT_CITY = os.getenv("DEFAULT_CITY", "北京")
    DEFAULT_AREA = os.getenv("DEFAULT_AREA", "望京")
    # 望京 SOHO 附近，作为定位失败/未授权时的兜底中心点
    DEFAULT_LAT = _float("DEFAULT_LAT", 39.9963)
    DEFAULT_LNG = _float("DEFAULT_LNG", 116.4703)

    # 打开此项后，即使没有任何 Key 也仅使用演示数据（默认即为自动降级）
    ALLOW_DEMO_FALLBACK = os.getenv("ALLOW_DEMO_FALLBACK", "1") != "0"

    # ---------------- 安全与限流 ----------------
    # 单次请求体上限（本项目只有 GET，仍设上限防止异常大包）
    MAX_CONTENT_LENGTH = 1024 * 1024
    # 单 IP 每分钟 API 请求上限；0 表示关闭
    RATE_LIMIT_PER_MINUTE = _int("RATE_LIMIT_PER_MINUTE", 300)
    SEARCH_RATE_LIMIT_PER_MINUTE = _int("SEARCH_RATE_LIMIT_PER_MINUTE", 40)
    # 是否信任反向代理的 X-Forwarded-For（部署在 Nginx 后设为 1）
    TRUST_PROXY = os.getenv("TRUST_PROXY", "0") == "1"
    # 内容安全策略开关（地图 SDK 若因 CSP 异常可临时关闭）
    CSP_ENABLED = os.getenv("CSP_ENABLED", "1") != "0"

    # ---------------- 持久化 ----------------
    # SQLite 路径；容器部署时挂载到 /data
    DATABASE_PATH = os.getenv("DATABASE_PATH", str(BASE_DIR / "data" / "app.db"))

    # ---------------- 会话与微信 ----------------
    # HTTPS 部署时设为 1，让会话 Cookie 带 Secure
    SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "0") == "1"
    # 对外访问域名（可选）：反向代理改写 Host 时用它做同源校验白名单，
    # 形如 today-eat-47626.app.workbuddy.host，多个用逗号分隔
    PUBLIC_HOSTS = os.getenv("PUBLIC_HOSTS", "").strip()
    # 微信网页授权（认证服务号）；未配置时降级为本机匿名身份
    WECHAT_APP_ID = os.getenv("WECHAT_APP_ID", "").strip()
    WECHAT_APP_SECRET = os.getenv("WECHAT_APP_SECRET", "").strip()
    WECHAT_REDIRECT_URI = os.getenv("WECHAT_REDIRECT_URI", "").strip()

    # ---------------- 云服务（WorkBuddy Cloud Service） ----------------
    # 公开配置（publishableKey / endpoint 均为可下发前端的公开值，不含密钥）
    CLOUD_ENDPOINT = os.getenv("CLOUD_ENDPOINT", "").strip()
    CLOUD_PUBLISHABLE_KEY = os.getenv("CLOUD_PUBLISHABLE_KEY", "").strip()
    CLOUD_OAUTH_RELAY_BASE_URL = os.getenv("CLOUD_OAUTH_RELAY_BASE_URL", "").strip()

    TEMPLATES_AUTO_RELOAD = True
    SEND_FILE_MAX_AGE_DEFAULT = 3600
