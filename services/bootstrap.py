"""首屏配置载荷：页面与 /api/bootstrap 共用一份。"""

from __future__ import annotations

from datetime import date

from flask import current_app

from . import wechat

APP_VERSION = "1.3.0"


def build_bootstrap(weekend: dict | None = None) -> dict:
    cfg = current_app.config
    service = current_app.extensions["service"]
    weekend = weekend or service.weekend_info()
    return {
        "appName": "今天吃啥",
        "version": APP_VERSION,
        "today": date.today().isoformat(),
        "weekend": weekend,
        "defaults": {
            "city": cfg["DEFAULT_CITY"],
            "area": cfg["DEFAULT_AREA"],
            "lat": cfg["DEFAULT_LAT"],
            "lng": cfg["DEFAULT_LNG"],
        },
        "map": {
            "provider": cfg["MAP_PROVIDER"],
            "amapJsKey": cfg["AMAP_JS_KEY"],
            "amapSecurityCode": cfg["AMAP_JS_SECURITY_CODE"],
            "baiduJsAk": cfg["BAIDU_JS_AK"],
        },
        "demoMode": not (cfg["AMAP_WEB_KEY"] or cfg["BAIDU_WEB_AK"]),
        "wechatConfigured": wechat.configured(cfg),
        "cloud": {
            "endpoint": cfg["CLOUD_ENDPOINT"],
            "publishableKey": cfg["CLOUD_PUBLISHABLE_KEY"],
            "oauthRelayBaseUrl": cfg["CLOUD_OAUTH_RELAY_BASE_URL"],
        },
        "limits": {
            "radiusSteps": list(cfg["SEARCH_RADIUS_STEPS"]),
            "requestInterval": cfg["REQUEST_INTERVAL"],
            "maxRetry": cfg["MAX_RETRY"],
            "rateLimit": cfg["RATE_LIMIT_PER_MINUTE"],
        },
        "policy": {
            "reviews": "仅使用地图 POI 公开评价摘要，不抓取第三方平台单条短评",
            "photos": "商家图片来自 POI 接口返回的公开图片 URL",
        },
    }
