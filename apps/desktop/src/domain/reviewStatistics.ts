import { strengthSample, type StrengthSample } from './strength/samples.ts';
import type { AnalysisFrameDto, PlayerColor, SgfTreeDto } from './types.ts';
import { DEFAULT_MATCH_POLICY, frameNode, javaMoveMatch, moveLosses, type MatchPolicy } from './positionMetrics.ts';

export type ReviewMove = { nodeId: string; parentId?: string; strength?: StrengthSample | null; turn: number; color: PlayerColor; matched: boolean | null; winrateLoss: number | null; scoreLoss: number | null };
export type LossMetric = 'winrateLoss' | 'scoreLoss';
export type ReviewScope = { documentKey: string; tree: SgfTreeDto | null; selectedNodeId: string | null; frames: readonly AnalysisFrameDto[]; analysisJobId?: string | null };
/** Selected ancestry followed by its main continuation. Siblings never enter a report. */
export function reviewMoves(input: ReviewScope, policy: MatchPolicy = DEFAULT_MATCH_POLICY): ReviewMove[] {
  if (!input.tree) return [];
  const nodes = new Map(input.tree.nodes.map(n => [n.id, n]));
  let node = nodes.get(input.selectedNodeId ?? input.tree.root_id);
  const path: typeof input.tree.nodes = [], seen = new Set<string>();
  while (node) {
    if (seen.has(node.id)) return [];
    seen.add(node.id); path.push(node);
    if (!node.parent_id) break;
    node = nodes.get(node.parent_id);
  }
  path.reverse();
  if (path[0]?.id !== input.tree.root_id) return [];
  node = path.at(-1);
  while (node?.child_ids?.length) {
    const next = nodes.get(node.child_ids[0]);
    if (!next || next.parent_id !== node.id || seen.has(next.id)) break;
    seen.add(next.id); path.push(next); node = next;
  }
  const bound = new Map<string, AnalysisFrameDto>();
  for (const frame of input.frames) {
    const id = frameNode(frame, input.documentKey);
    if (!id || !seen.has(id) || !Number.isFinite(frame.visits) || frame.visits <= 0 || (input.analysisJobId && input.analysisJobId !== frame.job_id)) continue;
    const previous = bound.get(id);
    // Latest job wins; within one job keep deepest completed sample.
    if (!previous || previous.job_id !== frame.job_id || frame.visits >= previous.visits) bound.set(id, frame);
  }
  return path.flatMap(n => {
    if (!n.color || !n.vertex || !n.parent_id) return [];
    const before = bound.get(n.parent_id), after = bound.get(n.id);
    return [{ nodeId: n.id, parentId: n.parent_id, strength: strengthSample(n, before, after), turn: n.move_number ?? n.depth, color: n.color,
      matched: javaMoveMatch(n, before, policy), ...moveLosses(n.color, before, after) }];
  });
}
export function summarizeMoves(moves: readonly ReviewMove[], color: PlayerColor) {
  const own = moves.filter(m => m.color === color), known = own.filter(m => m.matched !== null);
  const average = (key: LossMetric) => {
    const values = own.flatMap(m => m[key] === null ? [] : [m[key]!]);
    return { value: values.length ? values.reduce((a,b) => a + b, 0) / values.length : null, count: values.length };
  };
  return { total: own.length, analyzed: known.length, match: known.length ? known.filter(m => m.matched).length / known.length * 100 : null,
    winrate: average('winrateLoss'), score: average('scoreLoss') };
}
export function filterMistakes(moves: readonly ReviewMove[], color: PlayerColor | 'both', metric: LossMetric, threshold: number, sort: 'loss' | 'turn') {
  return moves.filter(m => (color === 'both' || m.color === color) && m[metric] !== null && m[metric]! >= threshold)
    .sort((a,b) => sort === 'turn' ? a.turn - b.turn : b[metric]! - a[metric]! || a.turn - b.turn);
}
