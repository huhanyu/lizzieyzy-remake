import { useMemo } from 'react';
import type { ReviewMove } from '../../domain/reviewStatistics';
import { strengthSummary } from '../../domain/strength/features';
import { loadStrengthModel, predictStrength } from '../../domain/strength/model';
import { percent } from './format';
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
}: {
  moves: ReviewMove[];
  color: string;
  model: Awaited<ReturnType<typeof loadStrengthModel>> | null;
}) {
  const stats = useMemo(() => strengthSummary(moves), [moves]);
  const rank = useMemo(
    () =>
      stats && stats.count >= 6 && model
        ? predictStrength(stats.features, ...model)
        : null,
    [stats, model],
  );
  return <tr>
    <th scope="row">{color}</th>
    <td title={rank === null ? '至少 6 手完整分析后测评' : 'XGBoost 20TUN · 模型固定 σ 0.92'}><strong>{rankText(rank)}</strong></td>
    <td>{stats?.averageScore?.toFixed(2) ?? '—'}</td>
    <td>{percent(stats?.first)}</td>
    <td>{percent(stats?.good)}</td>
    <td>{stats?.difficulty.toFixed(1) ?? '—'}</td>
  </tr>;
}
