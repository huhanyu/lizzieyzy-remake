import type { AnalysisFrameDto, SgfTreeDto } from './types';
import { frameNode } from './positionMetrics.ts';

export type ScanOptions = { from: number; to: number; visits: number; coarseFirst: boolean; incremental: boolean; allBranches?: boolean };
export type ScanTarget = { nodeId: string; turn: number; visits: number; phase: 'coarse' | 'deep' };
export function planFullGameReview(tree: SgfTreeDto, options: ScanOptions): ScanTarget[] {
  if (![options.from, options.to, options.visits].every(Number.isFinite) || options.from < 0 || options.to < options.from || options.visits <= 0) throw new Error('分析范围和计算量必须是有效正数，结束手数不能小于起始手数。');
  const nodes = new Map(tree.nodes.map(n => [n.id, n])), path: {nodeId:string;turn:number}[] = [], seen = new Set<string>();
  const queue = [tree.root_id];
  for(let index=0;index<queue.length;index++) {
    const id = queue[index], node = nodes.get(id);
    if (!node || seen.has(id)) continue;
    seen.add(id);
    const turn = node.move_number ?? (node.id === tree.root_id ? 0 : null);
    if (turn != null && turn >= Math.max(0, Math.floor(options.from) - 1) && turn <= options.to) path.push({nodeId: node.id, turn});
    for (const childId of options.allBranches ? node.child_ids : node.child_ids.slice(0,1)) {
      if (nodes.get(childId)?.parent_id === node.id) queue.push(childId);
    }
  }
  const budget = Math.max(1, Math.floor(options.visits));
  return [...(options.coarseFirst && budget > 32 ? path.map(t => ({...t, visits: 32, phase: 'coarse' as const})) : []), ...path.map(t => ({...t, visits: budget, phase: 'deep' as const}))];
}
export function analyzedVisits(frames: readonly AnalysisFrameDto[], documentKey: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const frame of frames) {
    const id = frameNode(frame, documentKey);
    if (id && Number.isFinite(frame.visits) && frame.visits > 0) result.set(id, Math.max(result.get(id) ?? 0, frame.visits));
  }
  return result;
}
export type ScanFrame = { job_id: string; generation: number; turn: number; frame: AnalysisFrameDto };
/** Captures frames arriving before set-position ACK; bounded to latest frame per generation. */
export class ScanFrameGate {
  private generation: number | null = null;
  private early = new Map<number, ScanFrame>();
  private closed = false;
  private job: string;
  private target: ScanTarget;
  private accept: (frame: AnalysisFrameDto) => void;
  private finish: () => void;
  constructor(job: string, target: ScanTarget, accept: (frame: AnalysisFrameDto) => void, finish: () => void) {
    this.job = job; this.target = target; this.accept = accept; this.finish = finish;
  }
  consume(payload: ScanFrame) {
    if (this.closed || payload.job_id !== this.job || payload.turn !== this.target.turn || payload.frame.turn !== this.target.turn) return;
    if (this.generation === null) {
      const old = this.early.get(payload.generation);
      if (!old || payload.frame.visits >= old.frame.visits) this.early.set(payload.generation, payload);
      if (this.early.size > 16) this.early.delete(this.early.keys().next().value!);
      return;
    }
    if (payload.generation !== this.generation || !Number.isFinite(payload.frame.visits) || payload.frame.visits <= 0) return;
    this.accept({...payload.frame, job_id: this.job});
    if (payload.frame.visits >= this.target.visits) { this.close(); this.finish(); }
  }
  acknowledge(generation: number) {
    if (this.closed) return;
    this.generation = generation;
    const buffered = this.early.get(generation); this.early.clear();
    if (buffered) this.consume(buffered);
  }
  close() { this.closed = true; this.early.clear(); }
}
