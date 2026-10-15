import { useMemo } from 'react';
import type { ReviewMove } from '../../domain/reviewStatistics';
import { strengthSummary } from '../../domain/strength/features';
import { loadStrengthModel, predictStrength } from '../../domain/strength/model';
import { percent } from './format';
import { human40Summary, predictHuman40, type HumanMove } from '../../domain/strength/human40';
import type { Booster } from '../../domain/strength/model';
function rankText(rank: number | null) {
  return rank === null
    ? "—"
    : rank < 0
      ? `${Math.abs(rank).toFixed(1)} 级`
      : rank >= 10
        ? `${rank.toFixed(1)} 段（职业标尺）`
        : `${rank.toFixed(1)} 段`;
}
export function SideSummary({
  moves,
  color,
  model,
  modelId = 'xgboost20tun',
  humanModel = null,
}: {
  moves: ReviewMove[];
  color: string;
  model: Awaited<ReturnType<typeof loadStrengthModel>> | null;
  modelId?: 'xgboost20tun' | 'humansl40';
  humanModel?: Booster | null;
}) {
  const stats = useMemo(() => strengthSummary(moves), [moves]);
  const human = useMemo(() => modelId === 'humansl40' ? human40Summary(moves as HumanMove[]) : null, [moves, modelId]);
  const rank = useMemo(
    () =>
      modelId === 'humansl40' ? (human && human.count >= 6 && humanModel ? predictHuman40(human.features, humanModel) : null)
      : stats && stats.count >= 6 && model
        ? predictStrength(stats.features, ...model)
        : null,
    [stats, model, modelId, human, humanModel],
  );
  return <tr>
    <th scope="row">{color}</th>
    <td title={rank === null ? '至少 6 手完整分析后测评' : modelId === 'humansl40' ? 'HumanSL 40 · 实验评估，复用分析设置可能不同于训练设置' : 'XGBoost 20TUN · 模型固定 σ 0.92'}><strong>{rankText(rank)}</strong></td>
    <td>{stats?.averageScore?.toFixed(2) ?? '—'}</td>
    <td>{percent(stats?.first)}</td>
    <td>{percent(stats?.good)}</td>
    <td>{modelId === 'humansl40' ? (human && Number.isFinite(human.difficulty) ? human.difficulty.toFixed(1) : '—') : stats?.difficulty.toFixed(1) ?? '—'}</td>
    {modelId === 'humansl40' && <td>{percent(human?.coverage)}</td>}
  </tr>;
}
