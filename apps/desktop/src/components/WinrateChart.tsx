import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisFrameDto } from "../domain/types";
import { chartPoints, chartReadout, chartSegments, scoreExtent, type ChartMetric } from "../domain/winrateChart";

type Props = {
  /** Already filtered to the displayed game and branch by reviewChartFrames. */
  frames: AnalysisFrameDto[];
  metric?: "winrate" | "score";
  currentMove: number;
  reviewSource?: string;
  reviewPhase?: string;
  cacheRestoreVerified?: boolean;
  eligibleNodeIds?: readonly string[];
  onMoveSelect?: (turn: number) => void;
};
type Mode = "both" | "winrate" | "score";
const COLORS = { winrate: "#28b8b3", score: "#e5a34c" };

export function WinrateChart({ frames, currentMove, reviewSource = "none", reviewPhase = "idle", cacheRestoreVerified = false, eligibleNodeIds, onMoveSelect, metric }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState(0);
  const [selectedMode, setMode] = useState<Mode>("winrate");
  const mode = metric ?? selectedMode;
  const [hoverMove, setHoverMove] = useState<number | null>(null);
  const points = useMemo(() => chartPoints(frames, eligibleNodeIds), [frames, eligibleNodeIds]);
  const maxTurn = Math.max(currentMove, points.at(-1)?.turn ?? 0, 1);
  const inspectedMove = hoverMove === null ? currentMove : Math.min(hoverMove, maxTurn);
  const inspected = points.find(point => point.turn === inspectedMove);
  const readout = chartReadout(inspected);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setSize(canvas.clientWidth * 10000 + canvas.clientHeight));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current; const ctx = canvas?.getContext("2d"); if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 300; const height = canvas.clientHeight || 100;
    canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(height * dpr);
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height);
    const left = 42, top = 16, right = Math.max(left + 1, width - 46), bottom = Math.max(top + 1, height - 20);
    const plotHeight = bottom - top;
    const extent = scoreExtent(points);
    const x = (turn: number) => left + Math.max(0, Math.min(turn / maxTurn, 1)) * (right - left);
    const y = (value: number, metric: ChartMetric) => bottom - (metric === "winrate" ? value : (value / extent + 1) / 2) * plotHeight;
    ctx.font = "10px system-ui"; ctx.textBaseline = "middle";
    for (const fraction of [0, .5, 1]) {
      const row = bottom - fraction * plotHeight;
      ctx.strokeStyle = fraction === .5 ? "#647077" : "#465059";
      ctx.setLineDash(fraction === .5 ? [3, 3] : []);
      ctx.beginPath(); ctx.moveTo(left, row); ctx.lineTo(right, row); ctx.stroke();
      if (mode !== "score") {
        ctx.fillStyle = COLORS.winrate; ctx.textAlign = "right";
        ctx.fillText(`${fraction * 100}%`, left - 5, row);
      }
      if (mode !== "winrate") {
        const score = (fraction * 2 - 1) * extent;
        ctx.fillStyle = COLORS.score; ctx.textAlign = "left";
        ctx.fillText(`${score > 0 ? "+" : ""}${score}`, right + 5, row);
      }
    }
    ctx.setLineDash([]); ctx.fillStyle = "#a3afb6";
    ctx.textAlign = "left"; if (mode !== "score") ctx.fillText("胜率", 2, 5);
    ctx.textAlign = "right"; if (mode !== "winrate") ctx.fillText("目差 / 目", width - 2, 5);
    ctx.textAlign = "center";
    ctx.fillText("0", left, height - 6); ctx.fillText(`${maxTurn} 手`, right, height - 6);
    for (const metric of ["winrate", "score"] as const) {
      if (mode !== "both" && mode !== metric) continue;
      ctx.strokeStyle = COLORS[metric]; ctx.fillStyle = COLORS[metric]; ctx.lineWidth = 1.8;
      ctx.setLineDash(metric === "score" ? [5, 3] : []);
      for (const segment of chartSegments(points, metric)) {
        ctx.beginPath();
        segment.forEach((point, index) => {
          const value = point[metric]!;
          if (!index) ctx.moveTo(x(point.turn), y(value, metric)); else ctx.lineTo(x(point.turn), y(value, metric));
        }); ctx.stroke();
        for (const point of segment) {
          ctx.beginPath(); ctx.arc(x(point.turn), y(point[metric]!, metric), point.turn === inspectedMove ? 3.6 : 1.8, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.lineWidth = 1; ctx.strokeStyle = "#c1ccc5"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x(currentMove), top); ctx.lineTo(x(currentMove), bottom); ctx.stroke();
    if (hoverMove !== null && inspectedMove !== currentMove) {
      ctx.strokeStyle = "#82918a"; ctx.setLineDash([1, 3]);
      ctx.beginPath(); ctx.moveTo(x(inspectedMove), top); ctx.lineTo(x(inspectedMove), bottom); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (!points.some(point => (mode !== "score" && point.winrate !== null) || (mode !== "winrate" && point.score !== null))) {
      ctx.fillStyle = "#a3afb6"; ctx.textAlign = "center";
      ctx.fillText("分析后显示走势", (left + right) / 2, top + plotHeight / 2 - 10);
    }
  }, [points, currentMove, maxTurn, inspectedMove, hoverMove, mode, size]);
  function pointerMove(clientX: number) {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return currentMove;
    return Math.round(Math.max(0, Math.min(1, (clientX - bounds.left - 42) / Math.max(1, bounds.width - 88))) * maxTurn);
  }
  return <div style={{ minHeight: 0, height: "100%", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
    <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", fontSize: 11 }}>
      {!metric && <select aria-label="走势指标" value={mode} onChange={event => setMode(event.target.value as Mode)} style={{ padding: "1px 4px", fontSize: 11, maxWidth: 115 }}>
        <option value="both">胜率与目差</option><option value="winrate">仅胜率</option><option value="score">仅目差</option>
      </select>}
      <span style={{ color: "#aebbb4", fontVariantNumeric: "tabular-nums" }} data-testid="chart-readout">{hoverMove === null ? "当前" : "查看"} {inspectedMove} 手 · {readout}</span>
    </div>
    <canvas ref={canvasRef} className="winrate-chart" style={{ flex: "1 1 0", height: "auto", minHeight: 48, width: "100%" }}
      aria-label={`黑方胜率与目差走势图，当前第 ${currentMove} 手，查看第 ${inspectedMove} 手，${readout}。左右键查看，回车跳转。`}
      title="实线：黑方胜率（左轴）；虚线：黑方目差（右轴，正值黑优）。缺失分析不连线。"
      tabIndex={0} onMouseMove={event => setHoverMove(pointerMove(event.clientX))} onMouseLeave={() => setHoverMove(null)}
      onClick={event => onMoveSelect?.(pointerMove(event.clientX))} onBlur={() => setHoverMove(null)}
      onKeyDown={event => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault(); setHoverMove(Math.max(0, Math.min(maxTurn, inspectedMove + (event.key === "ArrowRight" ? 1 : -1))));
        } else if (event.key === "Enter") { event.preventDefault(); onMoveSelect?.(inspectedMove); }
        else if (event.key === "Escape") setHoverMove(null);
      }} data-testid="winrate-chart" data-chart-mode={mode}
      data-review-source={reviewSource} data-review-phase={reviewPhase} data-cache-restore-verified={String(cacheRestoreVerified)} />
  </div>;
}
