import type { ReviewMove } from '../../domain/reviewStatistics';
export function MatchTimeline({
  moves,
  select,
}: {
  moves: ReviewMove[];
  select: (m: ReviewMove, before?: boolean) => void;
}) {
  const max = Math.max(1, ...moves.map((m) => m.turn));
  return (
    <div className="review-hit-tracks">
      {(["black", "white"] as const).map((color) => (
        <div key={color} className={`review-hit-side ${color}`}>
          <strong>{color === "black" ? "黑方" : "白方"}</strong>
          {["一选", "好手"].map((label, row) => (
            <div key={label} className="review-hit-row">
              <small>{label}</small>
              <div>
                {moves
                  .filter((m) => m.color === color)
                  .map((m) => (
                    <button
                      key={m.nodeId}
                      style={{ left: `${(m.turn / max) * 98}%` }}
                      data-hit={
                        m.strength
                          ? row === 0
                            ? m.strength.first
                            : m.strength.loss < 1.2
                          : undefined
                      }
                      title={`第 ${m.turn} 手 · ${!m.strength ? "未分析" : (row === 0 ? m.strength.first : m.strength.loss < 1.2) ? "命中" : "未命中"}`}
                      aria-label={`查看第 ${m.turn} 手`}
                      onClick={() => select(m)}
                    />
                  ))}
              </div>
            </div>
          ))}
        </div>
      ))}
      <div className="review-axis">
        <span>1</span>
        <span>第 {max} 手</span>
      </div>
    </div>
  );
}
