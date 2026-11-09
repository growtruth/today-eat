"""轻量 HTTP 客户端（仅标准库），统一超时、UA 与异常归一化。"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from .errors import ProviderError

USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)


def get_json(base_url: str, params: dict, provider: str, timeout: float = 6.0) -> dict:
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{base_url}?{query}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raise ProviderError(provider, f"HTTP {exc.code}", retryable=exc.code >= 500) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ProviderError(provider, f"网络异常：{exc.__class__.__name__}", retryable=True) from exc
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProviderError(provider, "返回内容不是合法 JSON", retryable=True) from exc
