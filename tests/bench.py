"""性能与传输测评（零依赖，针对已启动的服务）。

用法：
    python tests/bench.py                 # 表格输出
    python tests/bench.py --json out.json # 同时写 JSON
    python tests/bench.py --port 8000

建议先重启服务再跑，避免上一轮测试流量触发限流。

覆盖：
- 页面 HTML 原始 / gzip 体积；
- CSS、JS 逐文件体积与 gzip 后总量；
- 图片总体积；
- 核心 API 的 p50 / p95 延迟；
- 静态资源缓存头、gzip 是否生效（带预算断言）。
"""

from __future__ import annotations

import argparse
import gzip
import http.client
import json
import statistics
import sys
from pathlib import Path
import time
from urllib.parse import urljoin

BUDGETS = {
    "page_gzip_kb": 14,
    "css_gzip_kb": 22,
    "js_gzip_kb": 80,
    "api_p95_ms": 150,
}


def fetch(port: int, path: str, gzip_ok: bool = True) -> dict:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Accept-Encoding": "gzip"} if gzip_ok else {}
    started = time.perf_counter()
    conn.request("GET", path, headers=headers)
    response = conn.getresponse()
    body = response.read()
    cost = (time.perf_counter() - started) * 1000
    info = {
        "status": response.status,
        "bytes": len(body),
        "encoding": response.getheader("Content-Encoding") or "",
        "cache": response.getheader("Cache-Control") or "",
        "cost": cost,
        "headers": dict(response.getheaders()),
    }
    conn.close()
    return info


def text_of(port: int, path: str) -> str:
    info = fetch(port, path, gzip_ok=True)
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("GET", path, headers={"Accept-Encoding": "identity"})
    body = conn.getresponse().read()
    conn.close()
    return body.decode("utf-8", "replace")


def assets_from(page_html: str) -> tuple[list[str], list[str]]:
    css, js = [], []
    for part in page_html.split("<"):
        if "stylesheet" in part and "href=" in part:
            start = part.find('href="') + 6
            end = part.find('"', start)
            if start > 5 and end > start:
                css.append(part[start:end])
        if part.startswith("script") and "src=" in part:
            start = part.find('src="') + 5
            end = part.find('"', start)
            if start > 4 and end > start:
                js.append(part[start:end])
    return css, js


def percentile(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = min(len(ordered) - 1, int(len(ordered) * pct))
    return ordered[index]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--json", default="")
    parser.add_argument("--rounds", type=int, default=12)
    args = parser.parse_args()
    port = args.port

    # 预热，避免首个请求包含模板编译
    try:
        fetch(port, "/")
    except OSError as exc:
        print(f"无法连接 http://127.0.0.1:{port}：{exc}")
        print("先启动服务：python app.py")
        return 2

    page_raw = fetch(port, "/", gzip_ok=False)
    page_gz = fetch(port, "/", gzip_ok=True)
    html = text_of(port, "/")
    css_paths, js_paths = assets_from(html)

    def sum_assets(paths: list[str]) -> tuple[int, int]:
        raw_total = packed_total = 0
        for path in paths:
            full = path if path.startswith("/") else "/" + path
            raw = fetch(port, full, gzip_ok=False)
            packed = fetch(port, full, gzip_ok=True)
            raw_total += raw["bytes"]
            packed_total += packed["bytes"]
        return raw_total, packed_total

    css_raw, css_gz = sum_assets(css_paths)
    js_raw, js_gz = sum_assets(js_paths)

    api_paths = [
        "/api/bootstrap",
        "/api/restaurants?lat=39.9963&lng=116.4703&radius=3000",
        "/api/play-spots?lat=39.998692&lng=116.484998&store_id=demo-001",
        "/api/sources?active=demo",
    ]
    api = {}
    for path in api_paths:
        samples, size, status = [], 0, 0
        attempts = 0
        while len(samples) < args.rounds and attempts < args.rounds * 3:
            attempts += 1
            info = fetch(port, path)
            status = info["status"]
            if status == 429:
                # 触发单 IP 限流时等窗口恢复，避免把 429 当成接口延迟
                time.sleep(1.2)
                continue
            if status != 200:
                break
            samples.append(info["cost"])
            size = info["bytes"]
        api[path] = {
            "p50": round(statistics.median(samples), 1) if samples else 0,
            "p95": round(percentile(samples, 0.95), 1) if samples else 0,
            "bytes": size,
            "status": status,
            "gzip": fetch(port, path)["encoding"] == "gzip",
        }

    root = Path(__file__).resolve().parent.parent
    img_dir = root / "static" / "img"
    thumb_dir = img_dir / "thumb"
    jpg_thumbs = list(thumb_dir.glob("*.jpg"))
    jpg_large = list(img_dir.glob("*.jpg"))

    def total(paths):
        return sum(path.stat().st_size for path in paths)

    missing_webp = [
        path.name for path in jpg_thumbs
        if not (thumb_dir / (path.stem + ".webp")).exists()
    ] + [
        path.name for path in jpg_large
        if not (img_dir / (path.stem + ".webp")).exists()
    ]

    images = {
        "thumb_jpg_kb": round(total(jpg_thumbs) / 1024, 1),
        "thumb_webp_kb": round(total(thumb_dir.glob("*.webp")) / 1024, 1),
        "large_jpg_kb": round(total(jpg_large) / 1024, 1),
        "large_webp_kb": round(total(img_dir.glob("*.webp")) / 1024, 1),
        "missing_webp": missing_webp,
    }

    result = {
        "page": {
            "raw_kb": round(page_raw["bytes"] / 1024, 1),
            "gzip_kb": round(page_gz["bytes"] / 1024, 1),
            "gzip_enabled": page_gz["encoding"] == "gzip",
        },
        "css": {
            "files": len(css_paths),
            "raw_kb": round(css_raw / 1024, 1),
            "gzip_kb": round(css_gz / 1024, 1),
            "gzip_ratio": round(css_gz / css_raw, 3) if css_raw else 0,
        },
        "js": {
            "files": len(js_paths),
            "raw_kb": round(js_raw / 1024, 1),
            "gzip_kb": round(js_gz / 1024, 1),
            "gzip_ratio": round(js_gz / js_raw, 3) if js_raw else 0,
        },
        "api": api,
        "cache": {
            "immutable": "immutable" in fetch(port, css_paths[0] if css_paths else "/static/css/style.css")["cache"],
            "api_no_store": "no-store" in fetch(port, "/api/bootstrap")["cache"],
        },
        "images": images,
    }

    print("\n== 体积 ==")
    print(f"页面 HTML   {result['page']['raw_kb']:>7} KB  → gzip {result['page']['gzip_kb']:>6} KB")
    print(f"CSS {result['css']['files']} 个     {result['css']['raw_kb']:>7} KB  → gzip {result['css']['gzip_kb']:>6} KB"
          f"  ({result['css']['gzip_ratio'] * 100:.0f}%)")
    print(f"JS  {result['js']['files']} 个     {result['js']['raw_kb']:>7} KB  → gzip {result['js']['gzip_kb']:>6} KB"
          f"  ({result['js']['gzip_ratio'] * 100:.0f}%)")

    print("\n== 图片 ==")
    print(f"缩略图  JPG {images['thumb_jpg_kb']:>7} KB → WebP {images['thumb_webp_kb']:>6} KB")
    print(f"大图    JPG {images['large_jpg_kb']:>7} KB → WebP {images['large_webp_kb']:>6} KB")
    print(f"缺少 WebP 的文件：{len(images['missing_webp'])} 个")

    print("\n== 接口延迟 ==")
    for path, info in api.items():
        print(f"{path:<62} p50 {info['p50']:>6} ms  p95 {info['p95']:>6} ms  "
              f"{info['bytes'] / 1024:>5.1f} KB  HTTP {info['status']}  gzip {'on' if info['gzip'] else 'off'}")

    checks = [
        ("页面 gzip 已开启", result["page"]["gzip_enabled"]),
        ("页面 gzip < 预算", result["page"]["gzip_kb"] <= BUDGETS["page_gzip_kb"]),
        ("CSS gzip < 预算", result["css"]["gzip_kb"] <= BUDGETS["css_gzip_kb"]),
        ("JS gzip < 预算", result["js"]["gzip_kb"] <= BUDGETS["js_gzip_kb"]),
        ("静态资源长缓存", result["cache"]["immutable"]),
        ("WebP 缩略图体积下降 ≥20%",
         images["thumb_webp_kb"] > 0 and images["thumb_webp_kb"] <= images["thumb_jpg_kb"] * 0.8),
        ("每张图都有 WebP 版本", not images["missing_webp"]),
        ("API 不缓存", result["cache"]["api_no_store"]),
        ("API 全部 200", all(info["status"] == 200 for info in api.values())),
        ("API p95 < 预算", all(info["p95"] <= BUDGETS["api_p95_ms"] for info in api.values())),
    ]
    print("\n== 预算 ==")
    failed = 0
    for name, ok in checks:
        print(("  OK  " if ok else "FAIL  ") + name)
        failed += 0 if ok else 1

    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=1)
        print("\n已写入 " + args.json)

    print(f"\n通过 {len(checks) - failed} 项，失败 {failed} 项")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
