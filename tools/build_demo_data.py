"""生成演示数据 data/restaurants.json。

说明：
- 演示数据的图片全部来自需求包 04_参考素材（实拍图），不做任何 AI 生成；
- 真实环境下商家实拍图由高德/百度 POI 接口返回，本文件的图片仅作演示兜底；
- 坐标以望京 SOHO 为中心，按“距离 + 方位角”推算，保证列表距离与筛选档位自洽。

用法：python tools/build_demo_data.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from services.geo import offset_point  # noqa: E402

CENTER = (39.9963, 116.4703)

# 名称 / 菜系 / 分类 / 评分 / 人均 / 距离(m) / 方位角 / 图片 / 标签
STORES = [
    ("巷子里九宫格火锅", "火锅", "main", 4.8, 128, 1280, 78, "hotpot.jpg",
     ["周末友好", "有包间", "适合拍照"], True, "川渝火锅", "阜通东大街 6 号院"),
    ("老铜锅涮肉", "火锅", "main", 4.6, 156, 2400, 250, "hotpot-store.jpg",
     ["周末友好", "有包间"], False, "老北京火锅", "望京西路 12 号"),
    ("木の寿司小屋", "日料", "main", 4.7, 168, 860, 310, "sushi.jpg",
     ["新店", "适合拍照"], True, "日式料理", "望京 SOHO T2 一层"),
    ("一膳居酒屋", "日料", "main", 4.3, 186, 1880, 285, "sushi.jpg",
     ["有包间"], False, "居酒屋", "阜安西路 3 号"),
    ("炭火小串局", "烧烤", "main", 4.5, 96, 2050, 120, "bbq.jpg",
     ["新店", "周末友好"], True, "烧烤", "花家地南街 8 号"),
    ("铁签子烤肉", "烧烤", "main", 4.4, 118, 1750, 55, "bbq.jpg",
     ["有包间", "周末友好"], False, "韩式烤肉", "望京东路 1 号"),
    ("午后甜点研究所", "甜品", "drink", 4.6, 58, 820, 20, "dessert.jpg",
     ["新店", "适合拍照"], True, "甜品 · 蛋糕", "望京街 9 号"),
    ("奶油小方", "甜品", "drink", 4.4, 46, 1460, 200, "dessert.jpg",
     ["周末友好"], False, "甜品 · 蛋糕", "广顺北大街 33 号"),
    ("窗边燕麦拿铁", "咖啡", "drink", 4.9, 42, 460, 350, "coffee.jpg",
     ["适合拍照", "新店"], True, "咖啡", "望京 SOHO 下沉广场"),
    ("胡同咖啡小屋", "咖啡", "drink", 4.7, 48, 1560, 160, "hutong.jpg",
     ["周末友好", "适合拍照"], False, "手冲咖啡", "南湖中园二区"),
    ("桃桃芝士茶", "奶茶", "drink", 4.5, 28, 320, 30, "milktea.jpg",
     ["新店"], True, "奶茶 · 鲜果茶", "望京 SOHO T1 大堂"),
    ("一杯桂花乌龙", "奶茶", "drink", 4.2, 22, 1080, 260, "milktea.jpg",
     [], False, "奶茶", "望京西园四区"),
    ("胡同口炸酱面", "小吃", "main", 4.4, 38, 680, 330, "hutong.jpg",
     ["周末友好"], False, "北京小吃", "花家地西里"),
    ("老北京卤煮张", "小吃", "main", 4.1, 45, 1920, 185, "hutong.jpg",
     [], False, "小吃", "望京南湖东园"),
    ("渝味小馆", "川菜", "main", 4.6, 88, 1380, 95, "hotpot.jpg",
     ["周末友好", "适合拍照"], False, "川菜", "广顺南大街 5 号"),
    ("望京小酒馆", "西餐", "main", 4.7, 198, 2620, 245, "hotpot-store.jpg",
     ["周末友好", "适合拍照", "有包间"], False, "西餐 · 酒馆", "丽都花园路 2 号"),
]

PHOTO_POS = ["50% 50%", "45% 42%", "55% 58%"]

# 适合一个人吃的店（吧台、单人套餐、小吃咖啡等）；其余默认更适合聚餐
SOLO_FRIENDLY = {
    "木の寿司小屋", "炭火小串局", "午后甜点研究所", "奶油小方", "窗边燕麦拿铁",
    "胡同咖啡小屋", "桃桃芝士茶", "一杯桂花乌龙", "胡同口炸酱面", "老北京卤煮张", "渝味小馆",
}

GALLERY_EXTRA = {
    "火锅": ["hotpot-store.jpg", "hutong.jpg"],
    "日料": ["coffee.jpg", "hutong.jpg"],
    "烧烤": ["hutong.jpg", "hotpot-store.jpg"],
    "甜品": ["coffee.jpg", "milktea.jpg"],
    "咖啡": ["dessert.jpg", "hutong.jpg"],
    "奶茶": ["dessert.jpg", "coffee.jpg"],
    "小吃": ["hutong.jpg", "hotpot-store.jpg"],
    "川菜": ["hotpot-store.jpg", "hutong.jpg"],
    "西餐": ["coffee.jpg", "hutong.jpg"],
}

HOURS = {
    "火锅": ("11:00", "23:00"),
    "日料": ("11:30", "22:30"),
    "烧烤": ("16:00", "次日 02:00"),
    "甜品": ("10:00", "21:30"),
    "咖啡": ("08:00", "19:00"),
    "奶茶": ("09:30", "22:00"),
    "小吃": ("07:00", "20:30"),
    "川菜": ("10:30", "21:30"),
    "西餐": ("17:00", "次日 01:00"),
}


def main() -> None:
    items = []
    for idx, (
        name, cuisine, category, rating, price, dist, bearing, cover, tags, is_new, sub, addr
    ) in enumerate(STORES, start=1):
        lat, lng = offset_point(CENTER[0], CENTER[1], dist, bearing)
        open_t, close_t = HOURS[cuisine]
        gallery = [cover] + [p for p in GALLERY_EXTRA[cuisine] if p != cover]
        items.append({
            "id": f"demo-{idx:03d}",
            "name": name,
            "cuisine": cuisine,
            "category": category,
            "subCuisine": sub,
            "rating": rating,
            "avgPrice": price,
            "lat": lat,
            "lng": lng,
            "address": f"{addr}（{sub}）",
            "area": "望京",
            "businessHours": f"{open_t}-{close_t}",
            "openTime": open_t,
            "closeTime": close_t,
            "tags": tags,
            "soloFriendly": name in SOLO_FRIENDLY,
            "isNew": is_new,
            "cover": cover,
            "gallery": gallery,
            "photoPos": PHOTO_POS[idx % len(PHOTO_POS)],
            "signature": sub,
            "seatInfo": "4 人桌 6 张 · 8 人包间 2 间" if "有包间" in tags else "2-4 人桌为主",
        })

    out = {
        "source": "demo",
        "note": "图片取自需求包实拍参考素材，仅用于演示；真实版本由 POI 实拍图替换。",
        "center": {"lat": CENTER[0], "lng": CENTER[1], "city": "北京", "area": "望京"},
        "items": items,
    }
    path = ROOT / "data" / "restaurants.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {path} ({len(items)} stores)")


if __name__ == "__main__":
    main()
