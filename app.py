"""「今天吃啥」Flask 入口。

应用装配在 services/app_factory.py：
- 页面：services/routes_pages.py
- 只读 API：services/routes_legacy.py
- 身份 / 搭子 / 团购 / 骰子：services/api_v1.py
- 安全、限流、压缩、缓存、访问日志：services/web_security.py

这里只保留 app 实例与开发启动入口；service / limiter 作为兼容别名导出，
测试与旧代码仍可通过 app.service、app.limiter 访问。
"""

from __future__ import annotations

import os

from services.app_factory import create_app

app = create_app()

service = app.extensions["service"]
limiter = app.extensions["limiter"]


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") != "0"
    app.run(host="0.0.0.0", port=port, debug=debug)
