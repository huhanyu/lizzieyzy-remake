import type { AnalysisFrameDto, MoveVertex, PlayerColor, SgfTreeDto, SgfTreeNodeDto } from "./types";

export type PositionMetricsInput = {
  documentKey: string;
  tree: SgfTreeDto | null;
  selectedNodeId: string | null;
  /** Only document/node-bound frames are accepted; an unbound turn is ambiguous. */
  frames: readonly AnalysisFrameDto[];
  analysisJobId?: string | null;
};
export type MatchCoverage = { matchPercent: number | null; matched: number; analyzed: number; totalMoves: number };
export type PositionMetrics = {
  black: MatchCoverage;
  white: MatchCoverage;
  mover: PlayerColor | null;
  winrateLoss: number | null;
  scoreLoss: number | null;
  matchPercent: number | null;
  matched: number;
  analyzed: number;
  totalMoves: number;
};
const finite = (n: number): boolean => Number.isFinite(n);
function sameVertex(a: MoveVertex, b: MoveVertex): boolean {
  return a === "pass" || b === "pass" ? a === b : a.point.x === b.point.x && a.point.y === b.point.y;
}
export function frameNode(frame: AnalysisFrameDto, documentKey: string): string | null {
  try {
    const identity: unknown = JSON.parse(frame.node_id ?? "null");
    if (Array.isArray(identity) && identity[0] === documentKey && typeof identity[1] === "string") return identity[1];
  } catch { /* Unbound or invalid identity is not evidence for this document. */ }
  return null;
}
/** Java Board.isMatchAi default: candidate index < 3 and visits/maxVisits >= 20%.
 * Pass and missing/empty analysis remain unknown, rather than a fabricated mismatch.
 */
export type MatchPolicy = { topN: number; relativeVisits: number };
export const DEFAULT_MATCH_POLICY: MatchPolicy = { topN: 3, relativeVisits: 0.2 };
export function javaMoveMatch(node: SgfTreeNodeDto, parent: AnalysisFrameDto | undefined, policy: MatchPolicy = DEFAULT_MATCH_POLICY): boolean | null {
  if (!node.color || !node.vertex || node.vertex === "pass" || !parent || parent.visits <= 0 || !parent.candidates.length) return null;
  const candidates = parent.candidates;
  if (candidates.some(candidate => !finite(candidate.visits) || candidate.visits < 0)) return null;
  const maxVisits = Math.max(...candidates.map(candidate => candidate.visits));
  if (maxVisits <= 0) return null;
  const index = candidates.findIndex(candidate => sameVertex(candidate.vertex, node.vertex!));
  return index >= 0 && index < Math.max(1, Math.floor(policy.topN)) && candidates[index].visits / maxVisits >= Math.max(0, Math.min(1, policy.relativeVisits));
}

/** Signed losses from black-perspective DTOs; comparisons must share a task. */
export function moveLosses(color: PlayerColor, before?: AnalysisFrameDto, after?: AnalysisFrameDto): { winrateLoss: number | null; scoreLoss: number | null } {
  const result = { winrateLoss: null as number | null, scoreLoss: null as number | null };
  if (!before || !after || before.job_id !== after.job_id) return result;
  const sign = color === "black" ? 1 : -1;
  if ([before.winrate_black, after.winrate_black].every(value => finite(value) && value >= 0 && value <= 1)) result.winrateLoss = sign * (before.winrate_black - after.winrate_black) * 100;
  if ([before.score_mean_black, after.score_mean_black].every(finite)) result.scoreLoss = sign * (before.score_mean_black - after.score_mean_black);
  return result;
}

export function calculatePositionMetrics(input: PositionMetricsInput): PositionMetrics {
  const coverage = (): MatchCoverage => ({ matchPercent: null, matched: 0, analyzed: 0, totalMoves: 0 });
  const result: PositionMetrics = { black: coverage(), white: coverage(), mover: null, winrateLoss: null, scoreLoss: null, matchPercent: null, matched: 0, analyzed: 0, totalMoves: 0 };
  if (!input.tree || !input.selectedNodeId) return result;
  const nodes = new Map(input.tree.nodes.map(node => [node.id, node]));
  const selected = nodes.get(input.selectedNodeId);
  if (!selected) return result;
  // Follow actual parent IDs; broken/cyclic ancestry is not a valid branch.
  const path: SgfTreeNodeDto[] = [];
  const seen = new Set<string>();
  let cursor: SgfTreeNodeDto | undefined = selected;
  while (cursor) {
    if (seen.has(cursor.id)) return result;
    seen.add(cursor.id); path.push(cursor);
    if (!cursor.parent_id) break;
    cursor = nodes.get(cursor.parent_id);
    if (!cursor) return result;
  }
  if (path.at(-1)?.id !== input.tree.root_id) return result;
  const bound = input.frames.flatMap(frame => {
    const id = frameNode(frame, input.documentKey);
    return id && nodes.has(id) && finite(frame.visits) && frame.visits > 0 ? [{ id, frame }] : [];
  });
  const selectedLatest = bound.filter(entry => entry.id === selected.id).at(-1)?.frame;
  const parentLatest = bound.filter(entry => entry.id === selected.parent_id).at(-1)?.frame;
  const job = input.analysisJobId ?? selectedLatest?.job_id ?? parentLatest?.job_id;
  const byNode = new Map<string, AnalysisFrameDto>();
  for (const { id, frame } of bound) {
    if (frame.job_id !== job) continue;
    const old = byNode.get(id);
    if (!old || frame.visits >= old.visits) byNode.set(id, frame);
  }
  for (const node of path) {
    if (!node.color || !node.vertex || !node.parent_id) continue;
    result.totalMoves++;
    const colorResult = result[node.color];
    colorResult.totalMoves++;
    const match = javaMoveMatch(node, byNode.get(node.parent_id));
    if (match !== null) { result.analyzed++; colorResult.analyzed++; if (match) { result.matched++; colorResult.matched++; } }
  }
  if (result.analyzed) result.matchPercent = 100 * result.matched / result.analyzed;
  for (const color of ["black", "white"] as const) {
    const stats = result[color];
    if (stats.analyzed) stats.matchPercent = 100 * stats.matched / stats.analyzed;
  }
  if (!selected.color || !selected.vertex || !selected.parent_id) return result;
  result.mover = selected.color;
  Object.assign(result, moveLosses(selected.color, byNode.get(selected.parent_id), byNode.get(selected.id)));
  return result;
}

/** The caller must first verify that this batch/cache belongs to documentKey.
 * A turn maps only when exactly one mainline node owns it; ambiguity stays unbound.
 */
export function bindBatchFramesToNodes(documentKey: string, tree: SgfTreeDto | null,
  batch: readonly AnalysisFrameDto[]): AnalysisFrameDto[] {
  if (!tree) return [];
  const nodesByTurn = new Map<number, string[]>();
  for (const node of tree.nodes) {
    if (!node.is_mainline) continue;
    const turn = node.id === tree.root_id ? 0 : node.move_number;
    if (turn == null) continue;
    const ids = nodesByTurn.get(turn) ?? [];
    ids.push(node.id); nodesByTurn.set(turn, ids);
  }
  return batch.flatMap(frame => {
    const ids = nodesByTurn.get(frame.turn);
    return ids?.length === 1 ? [{ ...frame, node_id: JSON.stringify([documentKey, ids[0]]) }] : [];
  });
}

export const SUPPORTED_GAME_RULES = [
  { value: "chinese", label: "中国规则" },
  { value: "japanese", label: "日本规则" },
  { value: "korean", label: "韩国规则" },
  { value: "aga", label: "AGA 规则" },
  { value: "bga", label: "英国规则（BGA）" },
  { value: "chinese-ogs", label: "中国规则（OGS）" },
  { value: "chinese-kgs", label: "中国规则（KGS）" },
  { value: "tromp-taylor", label: "Tromp–Taylor 规则" },
  { value: "new-zealand", label: "新西兰规则" },
] as const;
export function gameRulesLabel(rules?: string | null): string {
  const value = rules?.trim();
  if (!value) return "中国规则（默认）";
  return SUPPORTED_GAME_RULES.find(rule => rule.value === value.toLowerCase())?.label ?? value;
}
