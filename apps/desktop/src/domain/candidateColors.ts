import type { CandidateMoveDto } from "./types";

// Zhangqi quality bands; retain Lizzie blue for the first recommendation.
export function candidateColor(candidate: CandidateMoveDto, best: CandidateMoveDto, first: boolean, totalVisits: number): string {
  if (first) return "#287FB8";
  const scoreDiff = Math.abs(best.score_mean_black - candidate.score_mean_black);
  const winrateDiff = Math.abs(best.winrate_black - candidate.winrate_black);
  if (scoreDiff <= 2 && winrateDiff <= .05)
    return totalVisits > 0 && candidate.visits / totalVisits > .05 ? "#77C103" : "#A2B537";
  if (scoreDiff <= 6 && winrateDiff <= .15) return "#FFBD00";
  if (scoreDiff <= 10 && winrateDiff <= .30) return "#CE6C0C";
  return "#BA2121";
}
