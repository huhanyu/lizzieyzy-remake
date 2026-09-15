import { WinrateBar } from "./WinrateBar";
import type { AnalysisFrameDto, ProblemMarkerDto } from "../domain/types";
import { vertexLabel } from "../domain/board";

type PolicyPoint = { x: number; y: number; value: number };

type Props = {
  frame?: AnalysisFrameDto;
  searchRate?: number | null;
  showCandidates?: boolean;
  onShowCandidatesChange?: (show: boolean) => void;
  lastMoveMetrics?: { winrateLoss: number | null; scoreLoss: number | null };
  blackName?: string;
  whiteName?: string;
  problems: ProblemMarkerDto[];
  boardSize: number;
  currentMove: number;
  selectedCandidateIndex: number | null;
  onSelectCandidate: (index: number | null) => void;
  onSelectProblem: (moveNumber: number) => void;
  reviewSource?: string;
  reviewPhase?: string;
  cacheRestoreVerified?: boolean;
};

export function AnalysisPanel({
  frame,
  searchRate,
  showCandidates = true,
  onShowCandidatesChange,
  lastMoveMetrics,
  blackName = "黑方",
  whiteName = "白方",
  problems,
  boardSize,
  currentMove,
  selectedCandidateIndex,
  onSelectCandidate,
  onSelectProblem,
  reviewSource = "none",
  reviewPhase = "idle",
  cacheRestoreVerified = false
}: Props) {
  const hasOwnership = (frame?.ownership?.length ?? 0) >= boardSize * boardSize;
  const topPolicy = getTopPolicyPoints(frame?.policy, boardSize, 5);
  const hasPolicy = topPolicy.length > 0;

  return <aside
    className="analysis-panel"
    data-testid="analysis-panel"
    data-review-source={reviewSource}
    data-review-phase={reviewPhase}
    data-cache-restore-verified={String(cacheRestoreVerified)}
    data-current-move={currentMove}
    data-analysis-frame-source={frame ? `frame:${frame.turn}` : "none"}
    data-candidate-count={frame?.candidates.length ?? 0}
    data-winrate-black={frame?.winrate_black ?? ""}
    data-ownership-observed={String(hasOwnership)}
    data-policy-observed={String(hasPolicy)}
    data-visits={frame?.visits ?? 0}
  >
    <section data-section="ownership">
      <div className="player-summary"><div><img src="/themes/photorealistic/black.png" alt="" /><span><small>黑方</small><strong>{blackName}</strong></span></div><div><span><small>白方</small><strong>{whiteName}</strong></span><img src="/themes/photorealistic/white.png" alt="" /></div></div>
      <p className="muted" data-testid="analysis-source-status">
        {reviewSource === "recorded" ? "真实 KataGo 结果回放；浏览器不运行引擎。"
          : reviewSource === "katago" && reviewPhase === "paused" ? "分析已暂停，显示最后一次实时结果。"
          : reviewSource === "cache"
          ? "显示历史缓存复盘数据；当前无正在运行的引擎。"
          : reviewPhase === "running" || reviewPhase === "starting"
            ? "复盘分析正在更新当前局面..."
            : "当前显示工作区局面数据。"}
      </p>
      <div className="position-balance" aria-label="黑白胜率">
        <WinrateBar winrate={frame?.winrate_black} />
        <div className="position-facts"><strong>{frame ? `${frame.score_mean_black >= 0 ? "黑" : "白"}领先 ${Math.abs(frame.score_mean_black).toFixed(1)} 目` : "等待分析"}</strong><span>速率 {searchRate == null ? "—" : Math.round(searchRate).toLocaleString()} 次/秒 · 计算量 {frame?.visits.toLocaleString() ?? "—"}</span></div>
        <div className="last-move-facts"><span>上一手掉胜率 <strong>{lastMoveMetrics?.winrateLoss == null ? "—" : `${lastMoveMetrics.winrateLoss.toFixed(1)} 百分点`}</strong></span><span>损失目差 <strong>{lastMoveMetrics?.scoreLoss == null ? "—" : `${lastMoveMetrics.scoreLoss.toFixed(1)} 目`}</strong></span></div>
      </div>
    </section>
    <section data-section="candidates">
      <div className="candidate-heading"><strong>推荐选点</strong>{onShowCandidatesChange && <label className="hide-candidates-control"><input type="checkbox" checked={!showCandidates} onChange={event => onShowCandidatesChange(!event.target.checked)} />不在棋盘上显示推荐选点</label>}</div>
      <div className="candidate-columns" aria-hidden="true"><span>#</span><span>坐标</span><span>黑胜率</span><span>黑目差</span><span>计算量</span></div>
      <ol className="candidate-list">{(frame?.candidates ?? []).slice(0, 8).map((candidate, index) => {
        const pv = candidate.pv.slice(0, 6).map((vertex) => vertexLabel(vertex, boardSize));
        const isSelected = selectedCandidateIndex === index;
        return <li key={index}>
          <button
            type="button"
            className={`candidate-button${isSelected ? " is-selected" : ""}`}
            title={`后续 ${pv.join(" ")}`}
            aria-label={`${vertexLabel(candidate.vertex, boardSize)}，黑胜率 ${(candidate.winrate_black * 100).toFixed(1)}%，后续 ${pv.join(" ")}`}
            aria-pressed={isSelected}
            onClick={() => onSelectCandidate(index)}
            onFocus={() => onSelectCandidate(index)}
            onMouseEnter={() => onSelectCandidate(index)}
            onMouseLeave={() => onSelectCandidate(null)}
            onBlur={() => onSelectCandidate(null)}
          >
            <span className="candidate-rank">{index + 1}</span>
            <span className="candidate-move">{vertexLabel(candidate.vertex, boardSize)}</span>
            <span>{(candidate.winrate_black * 100).toFixed(1)}%</span>
            <span>{candidate.score_mean_black > 0 ? "+" : ""}{candidate.score_mean_black.toFixed(1)}</span>
            <span>{candidate.visits >= 1000 ? `${(candidate.visits / 1000).toFixed(1)}k` : candidate.visits}</span>
          </button>
        </li>;
      })}</ol>
    </section>
    <section data-section="policy" hidden={!hasPolicy}>
      <h2>策略选点</h2>
      {hasPolicy ? <ol className="candidate-list">{topPolicy.map((point, index) => {
        const vertex = { point: { x: point.x, y: point.y } };
        return <li key={`${point.x}:${point.y}`}>
          <div className="candidate-button" style={{ cursor: "default" }}>
            <span className="candidate-move">{vertexLabel(vertex, boardSize)}</span>
            <span>第 {index + 1} 选点</span>
            <span>{formatPolicyValue(point.value)}</span>
          </div>
        </li>;
      })}</ol> : <p className="muted">当前着法暂无策略数据。</p>}
    </section>
    <section data-section="review-marks" hidden={problems.length === 0}>
      <h2>失误与疑问手</h2>
      {problems.length === 0 ? <p className="muted">本局暂未发现明显失误。</p> : <ol className="problem-list">{problems.slice(0, 12).map((p) => {
        const isCurrent = currentMove === p.turn;
        return <li key={p.turn} className={`severity-${p.severity}${isCurrent ? " is-current" : ""}`}>
          <button type="button" className="problem-button" aria-current={isCurrent ? "step" : undefined} onClick={() => onSelectProblem(p.turn)}>
            <span>第 {p.turn} 手</span>
            <strong>{formatSeverityLabel(p.severity, p.label)}</strong>
            <small>胜率下降 {(p.winrate_loss * 100).toFixed(1)}%</small>
          </button>
        </li>;
      })}</ol>}
    </section>
  </aside>;
}

function formatSeverityLabel(severity: string, fallback: string): string {
  if (severity === "blunder") return "恶手";
  if (severity === "mistake") return "失误";
  if (severity === "inaccuracy") return "缓手";
  if (severity === "info") return "参考";
  return fallback;
}

function getTopPolicyPoints(policy: number[] | null | undefined, boardSize: number, limit: number): PolicyPoint[] {
  if (!policy || policy.length < boardSize * boardSize) return [];
  const points: PolicyPoint[] = [];
  for (let index = 0; index < boardSize * boardSize; index += 1) {
    const value = policy[index];
    if (!Number.isFinite(value) || value <= 0) continue;
    points.push({ x: index % boardSize, y: Math.floor(index / boardSize), value });
  }
  return points.sort((a, b) => b.value - a.value).slice(0, limit);
}

function formatPolicyValue(value: number): string {
  if (value <= 1) return `${(value * 100).toFixed(value >= 0.01 ? 1 : 2)}%`;
  return value.toFixed(2);
}
