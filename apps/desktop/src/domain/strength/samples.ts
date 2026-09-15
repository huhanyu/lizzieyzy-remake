import type { AnalysisFrameDto, MoveVertex, SgfTreeNodeDto } from "../types.ts";
import { moveLosses } from "../positionMetrics.ts";
export const qualityLabels = ["最佳", "好手", "一般", "欠佳", "差手", "恶手"];
export const qualityColors = [
  "#287fb8",
  "#77c103",
  "#a2b537",
  "#ffbd00",
  "#ce6c0c",
  "#ba2121",
];
export const clamp = (v: number, low = 0, high = 1) =>
  Math.max(low, Math.min(high, v));
export const sameMove = (a: MoveVertex, b: MoveVertex) =>
  typeof a === "string" || typeof b === "string"
    ? a === b
    : a.point.x === b.point.x && a.point.y === b.point.y;
export type StrengthSample = {
  first: boolean;
  rank: number;
  loss: number;
  scoreLoss: number | null;
  winrateLoss: number;
  complexity: number;
  weight: number;
  quality: number;
  best: MoveVertex;
  visits: number;
};
/** Java MoveRankDefinition AUTO defaults. Strict first choice is a separate statistic. */
export function qualityRank(win: number, score: number | null) {
  const w = [1, 3, 6, 12, 24],
    s = [0.5, 1.5, 3, 6, 12];
  for (let i = 4; i >= 0; i--)
    if (
      score === null
        ? win >= w[i]
        : score >= s[i] || (i + 1 >= 4 && win >= w[i])
    )
      return i + 1;
  return 0;
}
export function strengthSample(
  node: SgfTreeNodeDto,
  before?: AnalysisFrameDto,
  after?: AnalysisFrameDto,
): StrengthSample | null {
  if (
    !node.color ||
    !node.vertex ||
    !before ||
    !after ||
    before.job_id !== after.job_id ||
    !before.candidates.length
  )
    return null;
  const top = before.candidates[0],
    sign = node.color === "black" ? 1 : -1;
  const rank = before.candidates.findIndex((c) =>
    sameMove(c.vertex, node.vertex!),
  );
  const actual = before.candidates[rank];
  const fallback = moveLosses(node.color, before, after);
  const score =
    actual &&
    Number.isFinite(top.score_mean_black) &&
    Number.isFinite(actual.score_mean_black)
      ? sign * (top.score_mean_black - actual.score_mean_black)
      : fallback.scoreLoss;
  const win =
    actual &&
    Number.isFinite(top.winrate_black) &&
    Number.isFinite(actual.winrate_black)
      ? sign * (top.winrate_black - actual.winrate_black) * 100
      : fallback.winrateLoss;
  if (win === null || !Number.isFinite(win)) return null;
  const scoreLoss = score === null ? null : Math.max(0, score),
    winrateLoss = Math.max(0, win);
  const loss = scoreLoss ?? winrateLoss / 6;
  const candidateLoss = (c: typeof top) =>
    Math.max(
      0,
      Number.isFinite(top.score_mean_black) &&
        Number.isFinite(c.score_mean_black)
        ? sign * (top.score_mean_black - c.score_mean_black)
        : (sign * (top.winrate_black - c.winrate_black) * 100) / 6,
    );
  let sum = 0,
    weight = 0;
  for (const c of before.candidates)
    if (Number.isFinite(c.policy_prior) && (c.policy_prior ?? 0) > 0) {
      sum += candidateLoss(c) * c.policy_prior!;
      weight += c.policy_prior!;
    }
  const complexity = clamp(
    weight > 0
      ? sum / weight
      : before.candidates[1]
        ? candidateLoss(before.candidates[1]) / 1.2
        : 0,
  );
  return {
    first: rank === 0,
    rank: rank < 0 ? 999 : rank,
    scoreLoss,
    winrateLoss,
    loss,
    complexity,
    weight: clamp(Math.max(complexity, loss / 4), 0.05),
    quality: qualityRank(winrateLoss, scoreLoss),
    best: top.vertex,
    visits: Math.min(before.visits, after.visits),
  };
}
