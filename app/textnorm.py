"""把 PDF 解析出来的「部首字」换回对应的汉字。

有些 PDF 的字形对照表把常用字对到了 Unicode 的部首区：「⾃⼰」不是「自己」，「⻛险」不是「风险」，
看起来一样，编码不同。不换回来的话，关键词检索搜「自己」搜不到「⾃⼰」，图谱合并也会出错。

- 康熙部首区（U+2F00–U+2FDF，例如 ⼀ ⼈ ⼤ ⾃）：NFKC 会转成对应的汉字，逐字转换；
- 部首补充区（U+2E80–U+2EFF，例如 ⻛ ⻓ ⻅）：NFKC 不转，按下面的对照表转（只收了有对应常用字的）。

只转这两个区的字，不对整段文字做 NFKC（那样会把中文全角逗号「，」变成英文逗号）。
"""

import re
import unicodedata

SUPPLEMENT = {
    "⺟": "母",
    "⺠": "民",
    "⺩": "王",
    "⺮": "竹",
    "⻁": "虎",
    "⻄": "西",
    "⻅": "见",
    "⻆": "角",
    "⻈": "讠",
    "⻉": "贝",
    "⻋": "车",
    "⻑": "長",
    "⻓": "长",
    "⻔": "门",
    "⻘": "青",
    "⻙": "韦",
    "⻚": "页",
    "⻛": "风",
    "⻜": "飞",
    "⻝": "食",
    "⻢": "马",
    "⻣": "骨",
    "⻤": "鬼",
    "⻥": "鱼",
    "⻦": "鸟",
    "⻧": "卤",
    "⻨": "麦",
    "⻩": "黄",
    "⻬": "齐",
    "⻮": "齿",
    "⻰": "龙",
    "⻳": "龟",
}
RADICAL = re.compile("[⺀-⻿⼀-⿟]")


def replace(match):
    character = match.group()
    return SUPPLEMENT.get(character) or unicodedata.normalize("NFKC", character)


def fold_radicals(text):
    if not text or not RADICAL.search(text):
        return text
    return RADICAL.sub(replace, text)


# 解析结果（章节列表）里的正文、各段原文和标题路径都换掉。
def fold_sections(sections):
    for section in sections or []:
        section["text"] = fold_radicals(section.get("text"))
        section["heading_path"] = [
            fold_radicals(item) for item in section.get("heading_path") or []
        ]
        for part in section.get("parts") or []:
            if isinstance(part.get("text"), str):
                part["text"] = fold_radicals(part["text"])
    return sections
