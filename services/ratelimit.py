"""轻量滑动窗口限流。

用于保护本服务与上游地图配额：单 IP 每分钟默认 120 次 API 请求。
不依赖 Redis，多进程部署时每进程独立计数（够用且无额外运维成本）。
"""

from __future__ import annotations

import threading
import time
from collections import deque


class SlidingWindowLimiter:
    def __init__(self, max_keys: int = 20000):
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()
        self._max_keys = max_keys

    def allow(self, key: str, limit: int, window: float = 60.0) -> tuple[bool, int]:
        """返回 (是否放行, 建议重试秒数)。limit <= 0 表示不限流。"""
        if limit <= 0:
            return True, 0

        now = time.monotonic()
        with self._lock:
            bucket = self._hits.get(key)
            if bucket is None:
                bucket = deque()
                self._hits[key] = bucket
                if len(self._hits) > self._max_keys:
                    self._prune(now, window)

            while bucket and now - bucket[0] > window:
                bucket.popleft()

            if len(bucket) >= limit:
                retry_after = max(1, int(window - (now - bucket[0])) + 1)
                return False, retry_after

            bucket.append(now)
            return True, 0

    def _prune(self, now: float, window: float) -> None:
        """键过多时清理空桶，避免内存无界增长。"""
        stale = [key for key, bucket in self._hits.items() if not bucket or now - bucket[-1] > window]
        for key in stale[: len(stale) // 2 + 1]:
            self._hits.pop(key, None)
