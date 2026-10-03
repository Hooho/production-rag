"""界面配色：把 CSS 里的蓝色系颜色收成变量，并生成「蓝调」「绿调」两套取值（src/theme.css）。

做法：扫描 src/*.css 里的每个颜色，按 OKLCH 判断色相，色相在蓝色范围（195°–285°）的就是主题色——
主色、蓝灰文字、边框、背景、渐变、阴影都在里面；替换成 var(--t-xxxxxx)（rgba 写成 rgb(var(--t-xxxxxx-rgb) / 透明度)）。
绿调把每个颜色在 OKLCH 里转动同样的色相（蓝 263° → 青绿 165°），亮度和彩度不变，所以深浅、渐变、透明度和原来一样，
只是色调换了；超出屏幕色域时只降彩度。
表示含义的颜色不动：状态色（红、橙、绿、紫）不在蓝色范围；数据类别里的蓝（向量检索、评测曲线）和「已处理」等蓝色状态标签
按下面的 EXCLUDE 排除。
用法：python3 frontend/scripts/theme.py      （改了 CSS 里的颜色后重新运行，已经是变量的不会重复处理）
"""
import math
import re
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
HUE_SHIFT = 165 - 263
BLUE_HUES = (195, 285)
MIN_CHROMA = 0.004
# 这些选择器或自定义属性里的颜色表示数据类别或状态，不跟着主题换。
EXCLUDE_SELECTORS = (".status-tag.is-blue", ".sp-method.is-answer", ".rg-expect.is-answer", "method-dense", "is-turns",
    ".diag-funnel-fill", ".inspection-kind", ".inspection-category")
EXCLUDE_PROPERTIES = ("--series-", "--diag-dense")
COLOR = re.compile(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)")


def to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def to_srgb(c):
    return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def oklch(rgb):
    r, g, b = (to_linear(x / 255) for x in rgb)
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l, m, s = (math.copysign(abs(x) ** (1 / 3), x) for x in (l, m, s))
    big_l = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return big_l, math.hypot(a, bb), math.degrees(math.atan2(bb, a)) % 360


def linear_rgb(big_l, c, h):
    a, b = c * math.cos(math.radians(h)), c * math.sin(math.radians(h))
    l = (big_l + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (big_l - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (big_l - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)


def from_oklch(big_l, c, h):
    def inside(chroma):
        return all(-1e-6 <= x <= 1 + 1e-6 for x in linear_rgb(big_l, chroma, h))
    if not inside(c):
        low, high = 0.0, c
        for _ in range(30):
            middle = (low + high) / 2
            low, high = (middle, high) if inside(middle) else (low, middle)
        c = low
    return tuple(max(0, min(255, round(to_srgb(max(0.0, min(1.0, x))) * 255))) for x in linear_rgb(big_l, c, h))


def parse(text):
    if text.startswith("#"):
        value = text[1:]
        if len(value) == 3:
            value = "".join(x * 2 for x in value)
        return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4)), None
    numbers = re.findall(r"[\d.]+", text)
    return tuple(int(x) for x in numbers[:3]), (numbers[3] if len(numbers) > 3 else None)


def is_theme(rgb):
    _, c, h = oklch(rgb)
    return c >= MIN_CHROMA and BLUE_HUES[0] <= h <= BLUE_HUES[1]


def hex_of(rgb):
    return "%02x%02x%02x" % rgb


def replace_block(selector, body, used):
    if any(item in selector for item in EXCLUDE_SELECTORS):
        return body
    parts = re.split(r"(;)", body)
    out = []
    for part in parts:
        name = part.split(":", 1)[0].strip()
        if ":" not in part or any(name.startswith(prefix) for prefix in EXCLUDE_PROPERTIES):
            out.append(part)
            continue

        def swap(match):
            rgb, alpha = parse(match.group(0))
            if not is_theme(rgb):
                return match.group(0)
            key = hex_of(rgb)
            used.add(key)
            return f"var(--t-{key})" if alpha is None else f"rgb(var(--t-{key}-rgb) / {alpha})"
        out.append(COLOR.sub(swap, part))
    return "".join(out)


def main():
    used = set()
    for path in sorted(SRC.glob("*.css")):
        if path.name == "theme.css":
            continue
        text = path.read_text(encoding="utf-8")
        # 只处理规则块的内容（最内层的 {...}），选择器和注释原样保留。
        new = re.sub(r"([^{}]*)\{([^{}]*)\}", lambda m: m.group(1) + "{" + replace_block(" ".join(m.group(1).split()), m.group(2), used) + "}", text)
        if new != text:
            path.write_text(new, encoding="utf-8")
    # 已经替换过的变量也要保留定义：从各文件里收集全部 var(--t-xxxxxx)。
    for path in SRC.glob("*.css"):
        if path.name != "theme.css":
            used.update(re.findall(r"--t-([0-9a-f]{6})", path.read_text(encoding="utf-8")))
    blue, green = [], []
    for key in sorted(used, key=lambda k: oklch(parse("#" + k)[0])):
        rgb = parse("#" + key)[0]
        big_l, c, h = oklch(rgb)
        shifted = from_oklch(big_l, c, (h + HUE_SHIFT) % 360)
        blue.append(f"   --t-{key}: #{key};\n   --t-{key}-rgb: {rgb[0]} {rgb[1]} {rgb[2]};")
        green.append(f"   --t-{key}: #{hex_of(shifted)};\n   --t-{key}-rgb: {shifted[0]} {shifted[1]} {shifted[2]};")
    header = ("/* 界面配色（由 frontend/scripts/theme.py 生成，不要手改）。\n"
        "   变量名是蓝调下的原色；绿调把每个颜色在 OKLCH 里转到青绿色相，亮度和彩度不变，深浅、渐变、透明度都和蓝调一致。\n"
        "   在设置页「系统参数 → 通用与高级 → 界面配色」切换，<html data-theme=\"green\"> 时用绿调。 */\n")
    (SRC / "theme.css").write_text(header + ":root {\n" + "\n".join(blue) + "\n}\n\n:root[data-theme=\"green\"] {\n"
        + "\n".join(green) + "\n}\n", encoding="utf-8")
    print(f"{len(used)} 个主题色")


if __name__ == "__main__":
    main()
