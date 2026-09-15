import { useMemo } from 'react';
import type { ReviewMove } from '../../domain/reviewStatistics';
import { strengthSummary } from '../../domain/strength/features';
import { qualityColors, qualityLabels } from '../../domain/strength/samples';
import { percent } from './format';
export function QualityDistribution({ moves }: { moves: ReviewMove[] }) {
  const sides = useMemo(() => (['black', 'white'] as const).map(color => strengthSummary(moves.filter(m => m.color === color))), [moves]);
  const max = Math.max(1, ...sides.flatMap(s => s?.qualityCounts ?? []));
  return <div className="review-quality-chart"><div className="review-chart-legend"><span>● 黑方</span><span>○ 白方</span></div><svg viewBox="0 0 600 235" role="img" aria-label="黑白双方六级落子质量分布">
    {[0, .5, 1].map(f => <path key={f} d={`M 12 ${195-f*155} H 590`} stroke="#52616a" opacity=".4" />)}
    {qualityLabels.map((label,i) => <g key={label}>
      {sides.map((s,j) => { const count = s?.qualityCounts[i] ?? 0, height = count/max*140, x = 28+i*96+j*29;
        return <g key={j}><title>{j===0?'黑方':'白方'} · {label} · {count} 手 · {s?percent(count/s.count):'—'}</title>
          <rect x={x} y={195-height} width="23" height={height} rx="2" fill={j===0?'#11191c':'#e4eaec'} stroke={qualityColors[i]} strokeWidth="1"/>
          <text x={x+11.5} y={184-height} textAnchor="middle">{count}</text>
          <text x={x+11.5} y={168-height} textAnchor="middle" className="quality-percentage">{s?percent(count/s.count):'—'}</text>
        </g>;
      })}
      <text x={54+i*96} y="220" textAnchor="middle" fill={qualityColors[i]}>{label}</text>
    </g>)}
  </svg></div>;
}
