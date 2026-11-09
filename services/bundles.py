"""静态资源打包：启动时按固定顺序拼接 CSS/JS，减少首屏请求数。

不引入构建工具：源文件仍是 static/css、static/js 下的独立文件，
进程启动时读入内存并计算内容哈希，作为缓存版本号。
"""

from __future__ import annotations

import hashlib
import os

# 顺序即依赖顺序：后面的模块可以使用前面模块暴露的全局对象
JS_ORDER = [
    "telemetry.js",
    "util.js",
    "cloud.js",
    "store.js",
    "api.js",
    "pager.js",
    "map.js",
    "bubbles.js",
    "filters.js",
    "feed.js",
    "detail.js",
    "nav.js",
    "play.js",
    "checkin.js",
    "buddy.js",
    "deals.js",
    "draw.js",
    "radar.js",
    "locdetail.js",
    "router.js",
    "location.js",
    "source.js",
    "app.js",
]

CSS_ORDER = ["style.css", "pages.css"]


def _concat(static_folder: str, sub: str, names: list[str]) -> bytes:
    chunks = []
    for name in names:
        path = os.path.join(static_folder, sub, name)
        with open(path, "rb") as handle:
            chunks.append(b"/* @bundle " + name.encode("utf-8") + b" */\n" + handle.read() + b"\n")
    return b"".join(chunks)


def build(static_folder: str) -> dict:
    js = _concat(static_folder, "js", JS_ORDER)
    css = _concat(static_folder, "css", CSS_ORDER)
    digest = hashlib.sha1(js + css).hexdigest()[:12]
    return {"js": js, "css": css, "version": digest}
