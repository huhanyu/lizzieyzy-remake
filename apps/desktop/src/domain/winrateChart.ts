import type { AnalysisFrameDto } from "./types";

export type ChartPoint = { turn: number; winrate: number | null; score: number | null };
export type ChartMetric = "winrate" | "score";

/** Input frames must belong to the displayed document/path (reviewChartFrames).
 * Optional exact node identities add a strict boundary; ambiguous same-turn nodes
 * are omitted rather than choosing an arbitrary branch. DTO values are already black-relative. */
export function chartPoints(frames: readonly AnalysisFrameDto[], eligibleNodeIds?: readonly string[]): ChartPoint[] {
  const allowed = eligibleNodeIds === undefined ? null : new Set(eligibleNodeIds);
  const byTurn = new Map<number, { frame: AnalysisFrameDto; identities: Set<string> }>();
  for (const frame of frames) {
    if (!Number.isInteger(frame.turn) || frame.turn < 0 || !Number.isFinite(frame.visits) || frame.visits <= 0) continue;
    if (allowed && (!frame.node_id || !allowed.has(frame.node_id))) continue;
    const identity = JSON.stringify([frame.game_id ?? null, frame.node_id ?? null]);
    const previous = byTurn.get(frame.turn);
    const identities = previous?.identities ?? new Set<string>();
    identities.add(identity);
    // The latest supplied sample wins only for the same position, including a
    // restarted live session with fewer visits than an older cached sample.
    byTurn.set(frame.turn, { frame, identities });
  }
  return [...byTurn.values()].filter(entry => entry.identities.size === 1).map(({ frame }) => ({
    turn: frame.turn,
    winrate: Number.isFinite(frame.winrate_black) && frame.winrate_black >= 0 && frame.winrate_black <= 1 ? frame.winrate_black : null,
    score: Number.isFinite(frame.score_mean_black) ? frame.score_mean_black : null,
  })).sort((a, b) => a.turn - b.turn);
}

export function chartSegments(points: readonly ChartPoint[], metric: ChartMetric): ChartPoint[][] {
  const segments: ChartPoint[][] = [];
  let segment: ChartPoint[] = [];
  for (const point of points) {
    if (point[metric] === null) { segment = []; continue; }
    if (!segment.length || point.turn !== segment[segment.length - 1].turn + 1) {
      segment = []; segments.push(segment);
    }
    segment.push(point);
  }
  return segments;
}

/** Symmetric black-score axis with readable steps; never clips a finite sample. */
export function scoreExtent(points: readonly ChartPoint[]): number {
  const largest = points.reduce((max, point) => Math.max(max, Math.abs(point.score ?? 0)), 5);
  const magnitude = 10 ** Math.floor(Math.log10(largest));
  const step = [1, 2, 5, 10].find(value => value * magnitude >= largest) ?? 10;
  return step * magnitude;
}

export function chartReadout(point: ChartPoint | undefined): string {
  const winrate = point?.winrate == null ? "暂无" : `${(point.winrate * 100).toFixed(1)}%`;
  const score = point?.score == null ? "暂无" : `${point.score > 0 ? "+" : ""}${point.score.toFixed(1)} 目`;
  return `黑胜率 ${winrate} · 黑目差 ${score}`;
}
