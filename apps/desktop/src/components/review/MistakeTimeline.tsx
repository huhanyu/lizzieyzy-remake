import { useMemo, useState } from 'react';
import type { ReviewMove } from '../../domain/reviewStatistics';
import { qualityColors, qualityLabels, sameMove } from '../../domain/strength/samples';
export function MistakeTimeline({
  moves,
  select,
}: {
  moves: ReviewMove[];
  select: (m: ReviewMove, before?: boolean) => void;
}) {
  const [color, setColor] = useState("both"),
    [dedup, setDedup] = useState(true), [limit, setLimit] = useState(10);
  const mistakes = useMemo(() => {
    const last = new Map<string, ReviewMove>();
    return moves.filter((m) => {
      if (
        !m.strength ||
        m.strength.quality < 3 ||
        (color !== "both" && m.color !== color)
      )
        return false;
      const prev = last.get(m.color);
      last.set(m.color, m);
      return !(
        dedup &&
        m.strength.quality === 5 &&
        prev?.strength?.quality === 5 &&
        m.turn - prev.turn <= 2 &&
        sameMove(m.strength.best, prev.strength.best)
      );
    }).sort((a,b) => b.strength!.winrateLoss-a.strength!.winrateLoss || b.strength!.loss-a.strength!.loss).slice(0,limit).sort((a,b)=>a.turn-b.turn);
  }, [moves, color, dedup, limit]);

  return (
    <>
      <div className="statistics-controls">
        <select
          aria-label="问题手棋手"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        >
          <option value="both">双方</option>
          <option value="black">黑方</option>
          <option value="white">白方</option>
        </select>
        <select aria-label="显示问题手数量" value={limit} onChange={e=>setLimit(Number(e.target.value))}><option value={10}>最重要 10 手</option><option value={20}>最重要 20 手</option></select>
        <label>
          <input
            type="checkbox"
            checked={dedup}
            onChange={(e) => setDedup(e.target.checked)}
          />
          不指出重复恶手
        </label>
      </div>
      <svg
        className="review-mistake-chart"
        viewBox="0 0 600 150"
        role="img"
        aria-label="问题手时间轴"
      >
        <path d="M 20 65 H 580 M 20 130 H 580" stroke="#52616a" />
        <text x="2" y="40">
          黑
        </text>
        <text x="2" y="105">
          白
        </text>
        {mistakes.map((m,index) => {
          const x = 35 + ((index+.5) / Math.max(1,mistakes.length)) * 530,
            y = m.color === "black" ? 50 : 115;
          return (
            <g
              key={m.nodeId}
              role="button"
              tabIndex={0}
              aria-label={`第 ${m.turn} 手 ${qualityLabels[m.strength!.quality]}`}
              onClick={() => select(m, true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select(m, true);
                }
              }}
            >
              <title>
                第 {m.turn} 手 · 损失 {m.strength!.scoreLoss?.toFixed(1) ?? "—"}{" "}
                目 · 点击查看落子前
              </title>
              <path
                d={`M ${x} ${y - 28} v 20 m -3 -4 l 3 4 l 3 -4`}
                stroke={m.color === "black" ? "#111" : "#e9eeee"}
                fill="none"
                strokeWidth="2"
              />
              <circle
                cx={x}
                cy={y}
                r="5"
                fill={qualityColors[m.strength!.quality]}
              />
              <text x={x} y={y + 15} textAnchor="middle">
                {m.turn}
              </text>
            </g>
          );
        })}
      </svg>
      {!mistakes.length && (
        <p className="statistics-note">当前范围没有已识别的问题手。</p>
      )}
    </>
  );
}
