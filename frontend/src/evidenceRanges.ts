// 与后端证据匹配保持一致：支持 || 候选原文，忽略空白和全半角差异。
export function evidenceRanges(text: string, evidence: string[]): [number, number][] {
  const positions: [number, number][] = [];
  let folded = "";
  let offset = 0;
  for (const character of text) {
    const normalized = character.normalize("NFKC").replace(/\s/gu, "");
    for (let index = 0; index < normalized.length; index += 1) positions.push([offset, offset + character.length]);
    folded += normalized;
    offset += character.length;
  }
  const ranges: [number, number][] = [];
  for (const quote of evidence.flatMap((item) => item.split("||"))) {
    const target = quote.normalize("NFKC").replace(/\s/gu, "");
    if (!target) continue;
    let start = folded.indexOf(target);
    while (start >= 0) {
      ranges.push([positions[start][0], positions[start + target.length - 1][1]]);
      start = folded.indexOf(target, start + target.length);
    }
  }
  return ranges;
}
