"""数据源适配层基类。

所有数据源统一输出同一种 POI 结构，前端无需感知高德 / 百度 / 演示源的差异。
"""

from __future__ import annotations


class BaseProvider:
    name = "base"
    label = "基础数据源"

    # 最近一次 search_nearby 的分页信息：{"total": int, "hasMore": bool}
    # 由实现方在返回前写入，data_service 据此判断「还有没有下一页」
    page_info = {"total": 0, "hasMore": False}

    # ---------------- 能力声明 ----------------
    def available(self) -> bool:
        """是否具备调用条件（主要是 Key 是否配置）。"""
        return False

    def search_nearby(self, lat: float, lng: float, radius: int, keyword: str = "",
                      offset: int = 0, limit: int = 50) -> list:
        """按距离升序返回 radius 内的餐饮 POI。

        offset/limit 用于「滚到底加载更远一档」：offset 是已取条数，
        实现方应尽量下推到数据源分页，避免每次只返回最近一批导致翻页无效。
        """
        raise NotImplementedError

    def place_detail(self, poi_id: str) -> dict | None:
        raise NotImplementedError

    def geocode(self, query: str, city: str) -> dict | None:
        raise NotImplementedError

    def route(self, origin: tuple, dest: tuple, mode: str) -> dict | None:
        raise NotImplementedError

    # ---------------- 工具 ----------------
    @staticmethod
    def normalize(item: dict) -> dict:
        """补齐字段，避免前端到处判空。"""
        item.setdefault("tags", [])
        item.setdefault("gallery", [])
        item.setdefault("isNew", False)
        item.setdefault("address", "")
        item.setdefault("businessHours", "")
        item.setdefault("signature", item.get("cuisine", ""))
        item.setdefault("photoPos", "50% 50%")
        item.setdefault("seatInfo", "")
        return item
