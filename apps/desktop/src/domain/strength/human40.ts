import { reviewContext, type ReviewMove, type ReviewScope } from '../reviewStatistics.ts';
import type { AnalysisFrameDto, MoveVertex, PlayerColor } from '../types.ts';
import { clamp, qualityRank, sameMove } from './samples.ts';
import type { Booster } from './model.ts';

export const HUMAN_PROFILES = ['rank_1d', 'rank_5d', 'rank_9d'] as const;
export type HumanProfile = typeof HUMAN_PROFILES[number];
export type HumanPolicies = Record<string, Record<HumanProfile, number[]>>;
export type PolicyRequest = { sgfText: string; endNodeId: string; turns: number[] };
export type HumanPosition = { nodeId: string; parentId?: string; turn: number; color: PlayerColor; vertex: MoveVertex; before: AnalysisFrameDto; after: AnalysisFrameDto };
export type HumanCapture = { key: string; request: PolicyRequest; positions: HumanPosition[] };
export type HumanMove = ReviewMove & { human40: { actorWinrate: number; delta: number; adjacent: boolean; reversal: boolean; profiles: number[][] } };

export const humanFeatureNames = [
  'first_choice_rate', 'top3_rate', 'top5_rate', 'average_ai_rank_fit', 'excellent_rate',
  'good_move_rate', 'non_inaccuracy_rate', 'match_rate', 'non_mistake_rate', 'non_blunder_rate',
  'median_loss_fit', 'p75_loss_fit', 'difficulty_fit', 'opening_good_move_rate',
  'middlegame_good_move_rate', 'endgame_good_move_rate', 'first_choice_x_difficulty',
  'good_move_x_difficulty', 'match_x_difficulty', 'top5_x_difficulty',
  'capped_mean_loss_3', 'capped_mean_loss_5', 'capped_mean_loss_10', 'mean_log_loss',
  'top3_loss_share', 'lost_position_fraction', 'reversal_fraction', 'adjacent_root_fraction',
  ...HUMAN_PROFILES.flatMap(p => [`${p}_mean_surprisal`, `${p}_difficulty`, `${p}_coverage_mean`, `${p}_reliable_fraction`]),
];

export function captureHuman40(scope: ReviewScope): HumanCapture {
  const context = reviewContext(scope);
  if (!context) throw new Error('请先打开棋谱');
  const root = context.path[0];
  const size = root.properties.find(p => p.key === 'SZ')?.values[0] ?? '19';
  if (size !== '19') throw new Error('HumanSL 40 暂时仅支持 19 路棋盘');
  if (context.path.some(n => n.properties.some(p => ['AB', 'AW', 'AE', 'PL'].includes(p.key)))
      || Number(root.properties.find(p => p.key === 'HA')?.values[0] ?? 0) > 0)
    throw new Error('此模型尚未验证让子、摆子和指定行棋方的棋谱');
  const nodes = context.path.filter(n => n.color && n.vertex).slice(0, 210);
  if (!nodes.length) throw new Error('棋谱没有落子');
  const positions: HumanPosition[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (i && node.color === nodes[i - 1].color) throw new Error('此模型暂不支持非交替落子');
    const before = context.bound.get(node.parent_id ?? ''), after = context.bound.get(node.id);
    if (!before || !after || before.job_id !== after.job_id || !before.candidates.length
        || ![before.score_mean_black, after.score_mean_black, before.winrate_black, after.winrate_black].every(Number.isFinite)
        || before.candidates.some(c => !Number.isFinite(c.score_mean_black))) continue;
    positions.push({ nodeId: node.id, parentId: node.parent_id ?? undefined, turn: i + 1, color: node.color!, vertex: node.vertex!, before, after });
  }
  if (['black', 'white'].some(color => positions.filter(p => p.color === color).length < 6))
    throw new Error('当前分析不足：每方至少需要 6 手带候选点和相邻目差的完整分析，不会另行重跑普通分析');
  const endNodeId = nodes.at(-1)!.id;
  const request = { sgfText: scope.documentKey, endNodeId, turns: positions.map(p => p.turn - 1) };
  return { key: JSON.stringify([scope.documentKey, endNodeId]), request, positions };
}

function probability(policy: number[], vertex: MoveVertex) {
  const index = vertex === 'pass' ? 361 : vertex.point.y * 19 + vertex.point.x;
  const p = policy[index];
  if (policy.length !== 362 || !Number.isFinite(p) || p < 0 || p > 1) throw new Error('HumanSL 合法落点概率缺失');
  return p;
}

export function human40Moves(capture: HumanCapture, policies: HumanPolicies): HumanMove[] {
  const moves: HumanMove[] = [];
  for (const position of capture.positions) {
    const { before, after, color, vertex, turn } = position;
    const profiles = policies[String(turn - 1)];
    if (!profiles || HUMAN_PROFILES.some(p => !profiles[p])) continue;
    const sign = color === 'black' ? 1 : -1, candidates = before.candidates;
    const top = sign * candidates[0].score_mean_black;
    const rank = candidates.findIndex(c => sameMove(c.vertex, vertex));
    const loss = Math.max(0, rank < 0 ? sign * (before.score_mean_black - after.score_mean_black)
      : top - sign * candidates[rank].score_mean_black);
    let mass = 0, sum = 0;
    for (const c of candidates) {
      const prior = Math.max(0, c.policy_prior ?? 0);
      mass += prior; sum += prior * Math.max(0, top - sign * c.score_mean_black);
    }
    const complexity = candidates.length < 2 ? 0 : clamp(mass > 0 ? sum / mass
      : Math.max(0, top - sign * candidates[1].score_mean_black) / 1.2);
    const human = HUMAN_PROFILES.map(profile => {
      const policy = profiles[profile];
      let coverage = 0, good = 0;
      for (const c of candidates) {
        const p = probability(policy, c.vertex);
        coverage += p;
        if (Math.max(0, top - sign * c.score_mean_black) <= 1.2) good += p;
      }
      coverage = clamp(coverage);
      return [-Math.log(Math.max(probability(policy, vertex), 1e-9)),
        coverage >= .9 ? (Math.max(coverage - good, 0) + Math.min(1 - good, 1)) / 2 : NaN,
        coverage, coverage >= .9 ? 1 : 0];
    });
    const winrateLoss = Math.max(0, sign * (before.winrate_black - after.winrate_black) * 100);
    moves.push({ nodeId: position.nodeId, parentId: position.parentId, turn, color,
      matched: rank === 0, scoreLoss: loss, winrateLoss,
      strength: { loss, scoreLoss: loss, winrateLoss, complexity, rank: rank < 0 ? 999 : rank,
        first: rank === 0, weight: clamp(Math.max(complexity, loss / 4), .05),
        quality: rank === 0 ? 0 : Math.max(1, qualityRank(winrateLoss, loss)),
        best: candidates[0].vertex, visits: Math.min(before.visits, after.visits) },
      human40: { actorWinrate: color === 'black' ? before.winrate_black : 1 - before.winrate_black,
        delta: after.score_mean_black - before.score_mean_black, adjacent: rank < 0, reversal: false, profiles: human } });
  }
  for (let end = 3; end < moves.length; end++) {
    let start = Math.max(0, end - 7);
    while (start < end && moves[start].turn < moves[end].turn - 7) start++;
    const window = moves.slice(start, end + 1);
    if (window.some((m, i) => i && m.turn !== window[i - 1].turn + 1)) continue;
    const large = window.map(m => m.human40.delta).filter(d => Math.abs(d) >= 8);
    if (large.filter((d, i) => i && d * large[i - 1] < 0).length >= 3)
      window.forEach(m => { m.human40.reversal = true; });
  }
  return moves;
}

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
// The training CSV and Java recipe use round-to-even, not JavaScript's half-up rounding.
export function trainingRound(value: number, places: number) {
  const scale = 10 ** places, scaled = value * scale, floor = Math.floor(scaled);
  return (scaled - floor === .5 ? (floor % 2 ? floor + 1 : floor) : Math.round(scaled)) / scale;
}
const quantile = (sorted: number[], p: number) => {
  const n = (sorted.length - 1) * p, lo = Math.floor(n), hi = Math.ceil(n);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (n - lo);
};
export function human40Summary(moves: readonly HumanMove[]) {
  if (!moves.length) return null;
  const rate = (test: (m: HumanMove) => boolean) => moves.filter(test).length / moves.length;
  const first = trainingRound(rate(m => m.strength!.first), 4),
    top3 = trainingRound(rate(m => m.strength!.rank < 3), 4),
    top5 = trainingRound(rate(m => m.strength!.rank < 5), 4),
    good = trainingRound(rate(m => m.strength!.loss < 1.2), 4);
  const match = trainingRound(.45 * rate(m => m.strength!.first) + .45 * rate(m => m.strength!.loss < 1.2)
    + .1 * (1 - rate(m => m.strength!.loss >= 4)), 4);
  const difficultyFit = clamp((trainingRound(100 * mean(moves.map(m => m.strength!.complexity)), 1) - 25) / 35);
  const losses = moves.map(m => m.strength!.loss), sorted = [...losses].sort((a, b) => a - b);
  const averageRank = trainingRound(mean(moves.map(m => m.strength!.rank >= 999 ? 10 : Math.min(m.strength!.rank + 1, 10))), 3);
  const phaseGood = (a: number, b: number) => {
    const selected = moves.filter(m => m.turn >= a && m.turn <= b);
    return selected.length ? trainingRound(selected.filter(m => m.strength!.loss < 1.2).length / selected.length, 4) : good;
  };
  const features = [first, top3, top5, 1 / (1 + averageRank), trainingRound(rate(m => m.strength!.loss < .2), 4), good,
    1 - trainingRound(rate(m => m.strength!.loss >= 1.2 && m.strength!.loss < 4), 4), match,
    1 - trainingRound(rate(m => m.strength!.loss >= 4), 4), 1 - trainingRound(rate(m => m.strength!.loss >= 10), 4),
    1 / (1 + Math.min(trainingRound(quantile(sorted, .5), 3), 50)),
    1 / (1 + Math.min(trainingRound(quantile(sorted, .75), 3), 50)), difficultyFit,
    phaseGood(1, 60), phaseGood(61, 160), phaseGood(161, 210), first * difficultyFit, good * difficultyFit,
    match * difficultyFit, top5 * difficultyFit, ...[3, 5, 10].map(cap => mean(losses.map(v => Math.min(v, cap)))),
    mean(losses.map(Math.log1p)), losses.reduce((a, b) => a + b, 0) > 0
      ? sorted.slice(-3).reduce((a, b) => a + b, 0) / losses.reduce((a, b) => a + b, 0) : 0,
    rate(m => m.human40.actorWinrate < .05), rate(m => m.human40.reversal), rate(m => m.human40.adjacent),
    ...HUMAN_PROFILES.flatMap((_, p) => [0, 1, 2, 3].map(field => mean(moves.map(m => m.human40.profiles[p][field]).filter(Number.isFinite))))];
  return { features, count: moves.length,
    difficulty: mean(moves.map(m => m.human40.profiles[2][1]).filter(Number.isFinite)) * 100,
    coverage: mean(moves.map(m => m.human40.profiles[2][2])) };
}

export function predictHuman40(features: number[], booster: Booster): number | null {
  const learner = booster.learner;
  if (features.length !== 40 || features.some(v => v === Infinity || v === -Infinity)
      || Number(learner.learner_model_param.num_feature) !== 40
      || JSON.stringify(learner.feature_names) !== JSON.stringify(humanFeatureNames)) return null;
  let value = Number(learner.learner_model_param.base_score.replace(/[\[\]]/g, ''));
  for (const tree of learner.gradient_booster.model.trees) {
    let node = 0;
    while (tree.left_children[node] !== -1) {
      const feature = features[tree.split_indices[node]];
      node = Number.isNaN(feature) ? (tree.default_left[node] ? tree.left_children[node] : tree.right_children[node])
        : feature < tree.split_conditions[node] ? tree.left_children[node] : tree.right_children[node];
    }
    value += tree.split_conditions[node];
  }
  return Number.isFinite(value) ? clamp(value, 0, 12) : null;
}
let bundle: Promise<Booster> | undefined;
export function loadHuman40Model() {
  return bundle ??= fetch('/models/humansl40_booster.json').then(async response => {
    if (!response.ok) throw new Error('HumanSL 40 模型加载失败');
    return await response.json() as Booster;
  }).catch(error => { bundle = undefined; throw error; });
}
