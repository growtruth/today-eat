"""节假日与调休日历。

规则（PRD F9）：
1. 周六 / 周日默认开启“周末模式”；
2. 但若是法定调休上班日（周末补班），不自动开启；
3. 用户手动开关优先级最高，当天以手动结果为准，不再自动弹开。
"""

import json
from datetime import date
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "holidays.json"


class HolidayCalendar:
    def __init__(self, path: Path = DATA_PATH):
        self.path = path
        self._raw = {}
        self.reload()

    def reload(self) -> None:
        try:
            self._raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._raw = {"years": {}, "note": "节假日数据缺失"}

    # ---------------- 基础查询 ----------------
    def year_data(self, year: int) -> dict:
        return self._raw.get("years", {}).get(str(year), {})

    def holidays(self, year: int) -> list:
        return self.year_data(year).get("holidays", [])

    def workdays(self, year: int) -> set:
        return set(self.year_data(year).get("workdays", []))

    def is_weekend(self, day: date) -> bool:
        return day.weekday() >= 5

    def is_adjusted_workday(self, day: date) -> bool:
        """法定调休上班日（通常落在周六/周日）。"""
        return day.isoformat() in self.workdays(day.year)

    def holiday_name(self, day: date) -> str:
        for item in self.holidays(day.year):
            if item["start"] <= day.isoformat() <= item["end"]:
                return item["name"]
        return ""

    def is_holiday(self, day: date) -> bool:
        return bool(self.holiday_name(day))

    # ---------------- 业务规则 ----------------
    def auto_weekend_mode(self, day: date) -> bool:
        """是否应自动开启周末模式（solo / 聚餐由前端子模式决定）。"""
        if not self.is_weekend(day):
            return False
        if self.is_adjusted_workday(day):
            return False
        return True

    def info(self, day: date) -> dict:
        return {
            "date": day.isoformat(),
            "weekday": "周" + "一二三四五六日"[day.weekday()],
            "isWeekend": self.is_weekend(day),
            "isAdjustedWorkday": self.is_adjusted_workday(day),
            "holidayName": self.holiday_name(day),
            "autoWeekendMode": self.auto_weekend_mode(day),
            "source": self._raw.get("source", ""),
        }
