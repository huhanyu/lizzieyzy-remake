import type { ReviewMove } from "../reviewStatistics.ts";
import { clamp, type StrengthSample } from "./samples.ts";
export const featureIndices = [
  13, 5, 2, 19, 10, 20, 26, 3, 14, 11, 28, 8, 18, 7, 12, 23, 27, 22, 25, 0,
];
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const fit = (v: number, cap = 50) => 1 / (1 + clamp(v, 0, cap));
function quantile(sorted: number[], p: number) {
  const n = p * (sorted.length - 1),
    lo = Math.floor(n);
  return sorted[lo] + (sorted[Math.ceil(n)] - sorted[lo]) * (n - lo);
}
/** Port of PlayerStrengthEstimator.Accumulator and full29 feature order. Model phases end at 60/160. */
export function strengthSummary(moves: readonly ReviewMove[]) {
  const known = moves.filter(
    (m): m is ReviewMove & { strength: StrengthSample } => !!m.strength,
  );
  if (!known.length) return null;
  const samples = known.map((m) => m.strength),
    rate = (test: (s: StrengthSample) => boolean) =>
      samples.filter(test).length / samples.length;
  const losses = samples.map((s) => s.loss).sort((a, b) => a - b),
    avg = mean(losses);
  const weighted = (ss: StrengthSample[]) =>
    ss.length
      ? ss.reduce((a, s) => a + s.loss * s.weight, 0) /
        ss.reduce((a, s) => a + s.weight, 0)
      : weightedLoss;
  const weightedLoss =
    samples.reduce((a, s) => a + s.loss * s.weight, 0) /
    samples.reduce((a, s) => a + s.weight, 0);
  const first = rate((s) => s.first),
    good = rate((s) => s.loss < 1.2),
    mistake = rate((s) => s.loss >= 4),
    match = clamp(0.45 * first + 0.45 * good + 0.1 * (1 - mistake));
  const phases = [
    known.filter((m) => m.turn <= 60),
    known.filter((m) => m.turn > 60 && m.turn <= 160),
    known.filter((m) => m.turn > 160),
  ].map((ms) => ms.map((m) => m.strength));
  const phaseGood = phases.map((ss) =>
    ss.length ? ss.filter((s) => s.loss < 1.2).length / ss.length : good,
  );
  const score = samples
    .flatMap((s) => (s.scoreLoss === null ? [] : [s.scoreLoss]))
    .sort((a, b) => a - b);
  const difficulty = mean(samples.map((s) => s.complexity)) * 100,
    difficultyFit = clamp((difficulty - 25) / 35),
    top5 = rate((s) => s.rank < 5);
  const features = [
    first,
    rate((s) => s.rank < 3),
    top5,
    1 / (1 + clamp(mean(samples.map((s) => Math.min(s.rank + 1, 10))), 0, 10)),
    rate((s) => s.loss < 0.2),
    good,
    1 - rate((s) => s.loss >= 1.2 && s.loss < 4),
    match,
    1 - mistake,
    1 - rate((s) => s.loss >= 10),
    fit(weightedLoss),
    fit(avg),
    fit(score.length ? quantile(score, 0.5) : avg),
    fit(quantile(losses, 0.75)),
    fit(quantile(losses, 0.9), 80),
    fit(quantile(losses, 0.95), 100),
    fit(losses.at(-1)!, 120),
    fit(Math.sqrt(mean(losses.map((l) => (l - avg) ** 2)))),
    difficultyFit,
    ...phases.map((ss) => fit(weighted(ss))),
    ...phaseGood,
    first * difficultyFit,
    good * difficultyFit,
    match * difficultyFit,
    top5 * difficultyFit,
  ];
  return {
    count: samples.length,
    total: moves.length,
    first,
    good,
    match,
    difficulty,
    averageScore: score.length ? mean(score) : null,
    averageWin: mean(samples.map((s) => s.winrateLoss)),
    qualityCounts: Array.from(
      { length: 6 },
      (_, i) => samples.filter((s) => s.quality === i).length,
    ),
    features,
    minVisits: Math.min(...samples.map((s) => s.visits)),
  };
}
