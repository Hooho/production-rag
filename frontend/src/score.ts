// 每道题的得分（满分 100），和后端 app/evaluation/score.py 同一套规则：
//   能回答的题：全部找到 100；找到一部分按比例（找到几条 / 一共几条 × 100），最高 90；一条都没找到每条证据扣 10，最多扣 50。
//   无法回答的题：一段资料都没拿到 100；拿到了资料扣 20。
// 页面上逐题、卡片里现算，旧记录没有后端分数也能显示。
export const SCORE_RULE = "每题满分 100：全部找到 100，没拿全按比例、最高 90，一条没找到每条证据扣 10、最多扣 50";

export function questionScore(answerable: boolean, found: number, total: number, returned = 0): number | null {
  if (!answerable) return returned ? -20 : 100;
  if (!total) return null;
  if (found >= total) return 100;
  if (found > 0) return Math.round(Math.min(90, (found / total) * 100) * 10) / 10;
  return Math.max(-50, -10 * total);
}

export type ScoreBand = "full" | "half" | "some" | "none";
export const BAND_LABELS: Record<ScoreBand, string> = { full: "全中", half: "过半", some: "少量", none: "没找到" };

export function scoreBand(found: number, total: number): ScoreBand | null {
  if (!total) return null;
  if (found >= total) return "full";
  if (found * 2 >= total) return "half";
  return found > 0 ? "some" : "none";
}

// items：[能回答, 找到几条, 一共几条, 拿到几段]。返回平均分和分档计数（分档只算能回答的题）。
export function summarizeScores(items: [boolean, number, number, number][]) {
  const scores: number[] = [];
  const bands: Record<ScoreBand, number> = { full: 0, half: 0, some: 0, none: 0 };
  for (const [answerable, found, total, returned] of items) {
    const value = questionScore(answerable, found, total, returned);
    if (value === null) continue;
    scores.push(value);
    const band = answerable ? scoreBand(found, total) : null;
    if (band) bands[band] += 1;
  }
  return { score: scores.length ? Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10 : null, bands };
}

export function formatPoints(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${Math.round(value * 10) / 10} 分`;
}

export function bandsText(bands: Partial<Record<ScoreBand, number>> | null | undefined) {
  if (!bands) return "";
  return (Object.keys(BAND_LABELS) as ScoreBand[]).map((key) => `${BAND_LABELS[key]} ${bands[key] ?? 0}`).join(" · ");
}
