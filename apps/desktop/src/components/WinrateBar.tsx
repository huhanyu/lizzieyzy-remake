import { useEffect, useState } from 'react';

/** Retain geometry during a position request, never present stale percentages. */
export function WinrateBar({ winrate }: { winrate?: number }) {
  const valid = winrate !== undefined && Number.isFinite(winrate);
  const value = valid ? Math.max(0, Math.min(1, winrate)) : undefined;
  const [previous, setPrevious] = useState<number | undefined>(value);
  useEffect(() => { if (value !== undefined) setPrevious(value); }, [value]);
  const width = value ?? previous;
  return <div className="balance-track" aria-busy={!valid} title={!valid ? '等待当前局面结果，暂保留上一局面的条形位置' : undefined}>
    <i style={{width: `${(width ?? .5) * 100}%`, visibility: width === undefined ? 'hidden' : undefined}} />
    <span>{value === undefined ? '更新中…' : `${(value * 100).toFixed(1)}%`}</span>
    <span>{value === undefined ? '—' : `${((1 - value) * 100).toFixed(1)}%`}</span>
  </div>;
}
