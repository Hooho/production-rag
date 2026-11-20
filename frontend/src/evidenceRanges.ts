// 原文里找证据、名字的位置，规则和后端一致（app/textnorm.py、app/evaluation/evidence.py）：
// 忽略空白、全角半角（NFKC），PDF 里的部首字当成对应的汉字（「⾃⼰」能对上「自己」），
// 证据可以用 || 写几处原文，每处都找。

// 部首补充区里 NFKC 不转的字（康熙部首区 NFKC 会转）。和 app/textnorm.py 的 SUPPLEMENT 一致。
const SUPPLEMENT: Record<string, string> = {
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
};

export function foldText(value: string) {
  let result = "";
  for (const character of value) {
    result += (SUPPLEMENT[character] ?? character)
      .normalize("NFKC")
      .replace(/\s/gu, "");
  }
  return result;
}

// 每一处在原文里的起止位置 [start, end)。
export function evidenceRanges(
  text: string,
  evidence: string[],
): [number, number][] {
  const positions: [number, number][] = [];
  let folded = "";
  let offset = 0;
  for (const character of text) {
    const normalized = foldText(character);
    for (let index = 0; index < normalized.length; index += 1)
      positions.push([offset, offset + character.length]);
    folded += normalized;
    offset += character.length;
  }
  const ranges: [number, number][] = [];
  for (const quote of evidence.flatMap((item) => item.split("||"))) {
    const target = foldText(quote);
    if (!target) continue;
    let start = folded.indexOf(target);
    while (start >= 0) {
      ranges.push([
        positions[start][0],
        positions[start + target.length - 1][1],
      ]);
      start = folded.indexOf(target, start + target.length);
    }
  }
  return ranges;
}
