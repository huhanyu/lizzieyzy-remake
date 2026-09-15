import { calculatePositionMetrics, gameRulesLabel } from "../domain/positionMetrics";
import type { PositionMetricsInput } from "../domain/positionMetrics";
import type { PositionDto } from "../domain/types";
import "./PositionSummary.css";

export type PositionSummaryProps = PositionMetricsInput & {
  position: PositionDto;
  rules?: string | null;
  komi?: number | null;
};
const numberText = (value: number | null | undefined): string => value == null || !Number.isFinite(value) ? "—" : value.toFixed(1);
export function PositionSummary(props: PositionSummaryProps) {
  const metrics = calculatePositionMetrics(props);
  const mover = metrics.mover === "black" ? "黑" : metrics.mover === "white" ? "白" : "";
  return <section className="position-summary" aria-label="局面指标">
    <dl className="position-summary-grid">
      <div><dt>本分支吻合率（黑 / 白）</dt><dd>{metrics.black.matchPercent === null ? "—" : `${numberText(metrics.black.matchPercent)}%`} / {metrics.white.matchPercent === null ? "—" : `${numberText(metrics.white.matchPercent)}%`}</dd><small>黑已分析 {metrics.black.analyzed}/{metrics.black.totalMoves} 手 · 白已分析 {metrics.white.analyzed}/{metrics.white.totalMoves} 手</small></div>
      <div><dt>最后一手{mover ? `（${mover}）` : ""}掉胜率</dt><dd>{numberText(metrics.winrateLoss)}{metrics.winrateLoss !== null ? " 百分点" : ""}</dd></div>
      <div><dt>最后一手损失目差</dt><dd>{numberText(metrics.scoreLoss)}{metrics.scoreLoss !== null ? " 目" : ""}</dd></div>
      <div><dt>规则</dt><dd>{gameRulesLabel(props.rules)}</dd></div>
      <div><dt>贴目</dt><dd>{numberText(props.komi)}{props.komi != null && Number.isFinite(props.komi) ? " 目" : ""}</dd></div>
      <div><dt>提子（黑 / 白）</dt><dd>{Number.isFinite(props.position.captures_black) ? props.position.captures_black : "—"} / {Number.isFinite(props.position.captures_white) ? props.position.captures_white : "—"}</dd></div>
    </dl>
    <details className="position-summary-method"><summary>统计口径</summary>
    <p className="position-summary-note">吻合：前三候选且计算量≥最高候选的20%；{metrics.matched}/{metrics.analyzed}手吻合，已分析{metrics.analyzed}/{metrics.totalMoves}手。停着及缺失分析不计入。</p>
    <p className="position-summary-note">损失按落子方计算；负值表示改善。仅比较同次分析的真实父子局面，缺失显示 —。</p>
    </details>
  </section>;
}
