import { useEffect, useMemo, useState } from 'react';
import { useReviewSnapshot } from '../hooks/useReviewSnapshot';
import { reviewMoves, type ReviewMove, type ReviewScope } from '../domain/reviewStatistics';
import { loadStrengthModel } from '../domain/strength/model';
import { SideSummary } from './review/SideSummary';
import { MatchTimeline } from './review/MatchTimeline';
import { QualityDistribution } from './review/QualityDistribution';
import { MistakeTimeline } from './review/MistakeTimeline';
export type ReviewModule = "summary" | "match" | "mistakes" | "performance";
type Props = {
  scope: ReviewScope;
  mode: ReviewModule;
  onNodeSelect?: (id: string) => void;
  onMoveSelect?: (turn: number) => void;
};
export function ReviewDashboard({
  scope,
  mode,
  onNodeSelect,
  onMoveSelect,
}: Props) {
  const [phase, setPhase] = useState("all"),
    [model, setModel] = useState<Awaited<
      ReturnType<typeof loadStrengthModel>
    > | null>(null),
    [error, setError] = useState("");
  const snapshot = useReviewSnapshot(scope);
  const all = useMemo(() => reviewMoves(snapshot), [snapshot]);
  const moves = useMemo(
    () =>
      all.filter(
        (m) =>
          phase === "all" ||
          (phase === "opening" && m.turn <= 60) ||
          (phase === "middle" && m.turn > 60 && m.turn <= 160) ||
          (phase === "end" && m.turn > 160),
      ),
    [all, phase],
  );
  const sideMoves = useMemo(
    () =>
      (["black", "white"] as const).map((c) =>
        moves.filter((m) => m.color === c),
      ),
    [moves],
  );
  useEffect(() => {
    if (mode !== "summary") return;
    let active = true;
    loadStrengthModel()
      .then((m) => {
        if (active) setModel(m);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [mode]);
  const select = (m: ReviewMove, before = false) => {
    const id = before ? m.parentId : m.nodeId;
    if (id && onNodeSelect) onNodeSelect(id);
    else onMoveSelect?.(before ? Math.max(0, m.turn - 1) : m.turn);
  };
  return (
    <div className="review-dashboard">
      <div className="statistics-controls">
        <select
          aria-label="复盘阶段"
          value={phase}
          onChange={(e) => setPhase(e.target.value)}
        >
          <option value="all">全盘</option>
          <option value="opening">布局 · 1–60</option>
          <option value="middle">中盘 · 61–160</option>
          <option value="end">官子 · 161 起</option>
        </select>
        <small>
          完整分析 {moves.filter((m) => m.strength).length}/{moves.length} 手
        </small>
      </div>
      {mode === "summary" && (
        <>
          <table className="review-summary-table"><thead><tr><th>棋手</th><th>预估棋力</th><th>损失/目</th><th>一选</th><th>好手</th><th>难度</th></tr></thead><tbody>
            {(["black", "white"] as const).map((c, i) => (
              <SideSummary
                key={c}
                moves={sideMoves[i]}
                color={c === "black" ? "黑方" : "白方"}
                model={model}
              />
            ))}
          </tbody></table>
          {error && <p role="alert">{error}</p>}
          <p className="statistics-note">
            按 Java 棋力模型计算；难度为 Java
            局面复杂度，不是人类策略概率。未分析手数不计入分母。
          </p>
        </>
      )}
      {mode === "match" && (
        <>
          <MatchTimeline moves={moves} select={select} />
          <p className="statistics-note">
            一选严格匹配第一推荐；好手沿用 Java 模型的损失小于 1.2
            目口径。点击查看对应手数。
          </p>
        </>
      )}
      {mode === "performance" && (
        <>
          <QualityDistribution moves={moves} />
          <p className="statistics-note">
            六级分类沿用 Java 默认 AUTO
            阈值；每手只计入一级，颜色与推荐点展示协调。
          </p>
        </>
      )}
      {mode === "mistakes" && <MistakeTimeline moves={moves} select={select} />}
    </div>
  );
}
