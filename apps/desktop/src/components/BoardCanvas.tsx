import { candidateColor } from "../domain/candidateColors";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { AnalysisFrameDto, PlayerColor, PositionDto, SgfTreeDto, PointDto } from "../domain/types";
import { isPoint, vertexLabel, previewVariation } from "../domain/board";

import { boardThemes, loadBoardTheme, saveBoardTheme, loadBoardThemeImages, type BoardThemeImages, type BoardThemeId } from "../domain/boardThemes";

import { transformPoint, transformPosition, transformAnalysis, stoneMoveNodes, visibleMoveNumbers, type NumberMode } from "../domain/boardView";

type Props = {
  showCandidates?: boolean;
  tree?: SgfTreeDto | null;
  selectedNodeId?: string | null;
  onDragStone?: (from: PointDto, to: PointDto, nodeId?: string) => void;
  allowOccupied?: boolean;
  position: PositionDto;
  controls?: ReactNode;
  analysis?: AnalysisFrameDto;
  selectedCandidateIndex?: number | null;
  onPlayPoint?: (point: { x: number; y: number }) => void;
  canEdit?: boolean;
  editColor?: PlayerColor;
};
type OverlayMode = "candidates" | "ownership" | "policy";
type PolicyPoint = { x: number; y: number; value: number };

export function BoardCanvas(props: Props) {
  const [view,setView] = useState({turns:0,mirror:false});
  const [mode,setMode] = useState<NumberMode>('off');
  const [recent,setRecent] = useState(10);
  const [drag,setDrag] = useState(false);
  const provenance = useMemo(()=>stoneMoveNodes(props.tree,props.selectedNodeId,props.position),[props.tree,props.selectedNodeId,props.position]);
  const numbers = useMemo(()=>visibleMoveNumbers(provenance,props.position.move_number,mode,recent),[provenance,props.position.move_number,mode,recent]);
  const position = useMemo(()=>transformPosition(props.position,view),[props.position,view]);
  const analysis = useMemo(()=>transformAnalysis(props.analysis,props.position.board_size,view),[props.analysis,props.position.board_size,view]);
  const actual = (point: PointDto) => transformPoint(point,props.position.board_size,view,true);
  const displayedNumbers = useMemo(()=>new Map([...numbers].map(([key,n])=>{const [x,y]=key.split(':').map(Number);const p=transformPoint({x,y},props.position.board_size,view);return [`${p.x}:${p.y}`,n];})),[numbers,view,props.position.board_size]);
  const nextMoves = useMemo(() => {
    const nodes = new Map(props.tree?.nodes.map(node => [node.id, node]));
    const selected = props.selectedNodeId ? nodes.get(props.selectedNodeId) : undefined;
    return (selected?.child_ids ?? []).flatMap(id => {
      const node = nodes.get(id);
      return node?.vertex && isPoint(node.vertex) && node.color
        ? [{ point: transformPoint(node.vertex.point, props.position.board_size, view), color: node.color }]
        : [];
    });
  }, [props.tree, props.selectedNodeId, props.position.board_size, view]);
  return <BoardSurface nextMoves={nextMoves} {...props} position={position} analysis={analysis} numbers={displayedNumbers}
    coordinateLabel={(axis,i)=> {const p=actual(axis==='x'?{x:i,y:0}:{x:0,y:i});const horizontal=(view.turns%2===0)===(axis==='x');return horizontal ? 'ABCDEFGHJKLMNOPQRSTUVWXYZ'[p.x] : String(props.position.board_size-p.y);}}
    onPlayPoint={props.onPlayPoint ? p=>props.onPlayPoint!(actual(p)) : undefined}
    onDragStone={drag && props.onDragStone ? (from,to)=>{const a=actual(from);props.onDragStone!(a,actual(to),provenance.get(`${a.x}:${a.y}`)?.nodeId);} : undefined}
    controls={<>{props.controls}<details className="board-view-tools"><summary>棋盘显示 / 编辑</summary><div className="statistics-controls">
      <label>手数 <select aria-label="手数显示" value={mode} onChange={e=>setMode(e.target.value as NumberMode)}><option value="off">不显示</option><option value="all">全部</option><option value="last">最后一手</option><option value="recent">最近 N 手</option></select></label>
      {mode==='recent' && <input aria-label="最近显示手数" type="number" min={1} max={1000} value={recent} onChange={e=>setRecent(Math.max(1,Math.min(1000,Number(e.target.value)||1)))}/>}
      <button onClick={()=>setView(v=>({...v,turns:(v.turns+1)%4}))}>旋转 90°</button><button aria-pressed={view.mirror} onClick={()=>setView(v=>({...v,mirror:!v.mirror}))}>镜像</button><button onClick={()=>setView({turns:0,mirror:false})}>复位视角</button>
      {props.onDragStone && <button aria-pressed={drag} disabled={!props.canEdit} onClick={()=>setDrag(!drag)}>拖子编辑</button>}
    </div></details></>}/>;
}
function BoardSurface({ showCandidates = true, nextMoves, position, analysis, selectedCandidateIndex, onPlayPoint, onDragStone, allowOccupied, canEdit = false, editColor, controls, numbers, coordinateLabel }: Props & {nextMoves: {point: PointDto; color: PlayerColor}[];numbers: Map<string,number>;coordinateLabel:(axis:'x'|'y',i:number)=>string}) {
  const dragStart = useRef<PointDto | null>(null);
  const suppressClick = useRef(false);
  const [themeId, setThemeId] = useState<BoardThemeId>(loadBoardTheme);
  const [themeImages, setThemeImages] = useState<BoardThemeImages | null>(null);
  const [themeMessage, setThemeMessage] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const theme = boardThemes.find(item => item.id === themeId)!;
  useEffect(() => {
    let active = true; setThemeImages(null); setThemeMessage("");
    if (themeId !== "classic") loadBoardThemeImages(themeId).then(images => {
      if (active) setThemeImages(images);
    }).catch(() => { if (active) setThemeMessage("主题图片加载失败，暂用经典棋盘"); });
    return () => { active = false; };
  }, [themeId]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasSize, setCanvasSize] = useState(0);
  const [hoverPoint, setHoverPoint] = useState<{x: number; y: number} | null>(null);
  useEffect(() => setHoverPoint(null), [position]);
  const hoveredCandidate = showCandidates && hoverPoint ? analysis?.candidates.slice(0, 8).find(candidate =>
    isPoint(candidate.vertex) && candidate.vertex.point.x === hoverPoint.x && candidate.vertex.point.y === hoverPoint.y) : undefined;
  const previewCandidate = hoveredCandidate ?? (selectedCandidateIndex != null ? analysis?.candidates[selectedCandidateIndex] : undefined);
  const previewStones = useMemo(() => previewCandidate ? previewVariation(position,
    previewCandidate.pv.length ? previewCandidate.pv : [previewCandidate.vertex]) : null, [position, previewCandidate]);
  useEffect(() => {
    const host = canvasRef.current?.parentElement;
    if (!host) return;
    const measure = () => setCanvasSize(Math.floor(Math.min(host.clientWidth, host.clientHeight)));
    const observer = new ResizeObserver(measure);
    observer.observe(host); measure();
    return () => observer.disconnect();
  }, []);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>("candidates");
  const boardPointCount = position.board_size * position.board_size;
  const hasOwnership = (analysis?.ownership?.length ?? 0) >= boardPointCount;
  const policyPoints = useMemo(() => getTopPolicyPoints(analysis?.policy, position.board_size, 12), [analysis?.policy, position.board_size]);
  const hasPolicy = policyPoints.length > 0;
  const effectiveOverlayMode = overlayMode === "ownership" && !hasOwnership ? "candidates" : overlayMode === "policy" && !hasPolicy ? "candidates" : overlayMode;
  const occupiedPoints = useMemo(() => new Set(position.stones.map((stone) => pointKey(stone.x, stone.y))), [position.stones]);

  function handleCanvasClick(event: MouseEvent<HTMLCanvasElement>) {
    if (suppressClick.current) { suppressClick.current=false; return; }
    if (!canEdit || !onPlayPoint) return;
    const point = canvasEventToBoardPoint(event, position.board_size);
    if (!point || (!allowOccupied && occupiedPoints.has(pointKey(point.x, point.y)))) return;
    onPlayPoint(point);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    // 棋盘必须是正方形：取容器可用空间的较小边作为边长，并把 canvas 的 CSS 尺寸
    // 显式设为该边长。此前由 CSS 的 width/height:100% 拉伸填满非正方形容器，
    // 导致棋盘被压扁（实测宽高比 2.19、格距比 0.46，棋子呈椭圆）。
    const host = canvas.parentElement;
    const availableWidth = host?.clientWidth || canvas.clientWidth || 720;
    const availableHeight = host?.clientHeight || canvas.clientHeight || 720;
    const cssSize = Math.max(0, canvasSize || Math.min(availableWidth, availableHeight));
    canvas.style.width = `${cssSize}px`;
    canvas.style.height = `${cssSize}px`;
    canvas.width = Math.floor(cssSize * dpr);
    canvas.height = Math.floor(cssSize * dpr);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssSize, cssSize);

    const boardSize = position.board_size;
    const padding = cssSize * 0.07;
    const grid = (cssSize - padding * 2) / (boardSize - 1);
    const coord = (n: number) => padding + n * grid;

    ctx.lineWidth = 1;
    ctx.fillStyle = theme.color;
    ctx.fillRect(0, 0, cssSize, cssSize);
    if (themeImages) ctx.drawImage(themeImages.board, 0, 0, cssSize, cssSize);
    ctx.strokeStyle = theme.line;
    for (let i = 0; i < boardSize; i += 1) {
      ctx.beginPath(); ctx.moveTo(coord(0), coord(i)); ctx.lineTo(coord(boardSize - 1), coord(i)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(coord(i), coord(0)); ctx.lineTo(coord(i), coord(boardSize - 1)); ctx.stroke();
    }

    ctx.fillStyle = theme.line; ctx.font = `${Math.max(10, grid * .3)}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let i = 0; i < boardSize; i++) {
      ctx.fillText(coordinateLabel('x',i), coord(i), padding * .43);
      ctx.fillText(coordinateLabel('y',i), padding * .43, coord(i));
    }
    const stars = boardSize === 19 ? [3, 9, 15] : boardSize === 13 ? [3, 6, 9] : [2, boardSize - 3];
    ctx.fillStyle = "rgba(35,20,8,.85)";
    for (const x of stars) for (const y of stars) { ctx.beginPath(); ctx.arc(coord(x), coord(y), 3, 0, Math.PI * 2); ctx.fill(); }

    if (!previewStones && effectiveOverlayMode === "ownership" && hasOwnership && analysis?.ownership) {
      const cellSize = Math.max(2, grid * 0.94);
      for (let y = 0; y < boardSize; y += 1) {
        for (let x = 0; x < boardSize; x += 1) {
          const value = normalizeOwnershipValue(analysis.ownership[y * boardSize + x]);
          const magnitude = Math.abs(value);
          if (magnitude < 0.015) continue;
          const alpha = 0.12 + magnitude * 0.42;
          ctx.fillStyle = value >= 0 ? `rgba(37,99,235,${alpha})` : `rgba(244,63,94,${alpha})`;
          ctx.fillRect(coord(x) - cellSize / 2, coord(y) - cellSize / 2, cellSize, cellSize);
        }
      }
    }

    for (const stone of previewStones ?? position.stones) {
      const cx = coord(stone.x); const cy = coord(stone.y); const radius = grid * 0.45;
      if (themeImages) {
        const extent = radius * theme.scale;
        ctx.save();
        if (themeId !== "baduktv") { ctx.shadowColor = "rgba(0,0,0,.32)"; ctx.shadowBlur = grid * .1; ctx.shadowOffsetY = grid * .06; }
        ctx.drawImage(themeImages[stone.color], cx - extent, cy - extent, extent * 2, extent * 2);
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = stone.color === "black" ? "#101010" : "#f5f5f2"; ctx.fill();
        ctx.strokeStyle = stone.color === "black" ? "#000" : "#b8b8b8"; ctx.stroke();
      }
      const moveNumber = previewStones && "moveNumber" in stone ? Number(stone.moveNumber) : numbers.get(pointKey(stone.x,stone.y));
      if (moveNumber && moveNumber > 0) {
        ctx.fillStyle = stone.color === "black" ? "#fff" : "#111";
        ctx.font = `600 ${Math.max(10, grid * .42)}px system-ui`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(String(moveNumber), cx, cy);
      }
    }

    if (!previewStones && position.last_move && isPoint(position.last_move.vertex) && !numbers.has(pointKey(position.last_move.vertex.point.x,position.last_move.vertex.point.y))) {
      const { x, y } = position.last_move.vertex.point;
      const cx = coord(x); const cy = coord(y);
      ctx.strokeStyle = position.last_move.color === "black" ? "#f3f3f3" : "#222";
      ctx.lineWidth = Math.max(2, grid * 0.07);
      ctx.beginPath(); ctx.arc(cx, cy, grid * 0.18, 0, Math.PI * 2); ctx.stroke();
    }

    if (!previewStones && effectiveOverlayMode === "policy" && hasPolicy) {
      drawPolicyOverlay(ctx, policyPoints, boardSize, coord, grid);
    } else if (!previewStones && showCandidates) {
      const topCandidates = analysis?.candidates.slice(0, 8) ?? [];
      const totalVisits = (analysis?.candidates ?? []).reduce((sum, candidate) => sum + candidate.visits, 0);
      for (const [index, candidate] of topCandidates.entries()) {
        if (!isPoint(candidate.vertex)) continue;
        const cx = coord(candidate.vertex.point.x); const cy = coord(candidate.vertex.point.y);
        const color = candidateColor(candidate, topCandidates[0], index === 0, totalVisits);
        // 半径随质量变差而增大（对齐 Java MoveRankDefinition.Rank.boardMarkRadiusFactor：0.10 → 0.19）
        const radius = grid * 0.47;
        const isSelected = selectedCandidateIndex === index;
        ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = .85;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (isSelected) {
          ctx.strokeStyle = "rgba(15,23,42,.86)";
          ctx.lineWidth = Math.max(2, grid * 0.08);
          ctx.beginPath(); ctx.arc(cx, cy, radius + grid * 0.1, 0, Math.PI * 2); ctx.stroke();
        }
        const winrate = position.to_play === "black" ? candidate.winrate_black : 1 - candidate.winrate_black;
        ctx.fillStyle = index === 0 ? "#fff" : "#171c12"; ctx.font = `600 ${Math.max(8, grid * .29)}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText((winrate * 100).toFixed(1), cx, cy - grid * .13);
        ctx.font = `${Math.max(7, grid * .23)}px system-ui`;
        ctx.fillText(candidate.visits >= 1000 ? `${(candidate.visits / 1000).toFixed(1)}k` : String(candidate.visits), cx, cy + grid * .19);
        ctx.fillStyle = "#594321"; ctx.font = `600 ${Math.max(7, grid * .24)}px system-ui`;
        ctx.fillText(String(index + 1), cx + grid * .36, cy - grid * .42);
      }
    }
    if (!previewStones) {
      // Java drawNextMoveOutlinesOnTop: main continuation is heavier than variations.
      nextMoves.forEach(({point, color}, index) => {
        if (occupiedPoints.has(pointKey(point.x, point.y))) return;
        const radius = grid * .47 + 2;
        const width = index === 0 ? Math.max(grid * .47 / 5.5, 3) : Math.max(grid * .47 / 11, 2);
        ctx.save();
        ctx.strokeStyle = color === "black" ? "#000" : "#fff";
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        ctx.setLineDash([width * 2.2, width * 1.7]);
        ctx.beginPath();
        ctx.arc(coord(point.x), coord(point.y), radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      });
    }
    if (!previewStones && hoverPoint && !occupiedPoints.has(pointKey(hoverPoint.x, hoverPoint.y))) {
      ctx.globalAlpha = .4;
      const color = editColor ?? position.to_play;
      if (themeImages) {
        const extent = grid * .45 * theme.scale;
        ctx.drawImage(themeImages[color], coord(hoverPoint.x) - extent, coord(hoverPoint.y) - extent, extent * 2, extent * 2);
      } else {
        ctx.fillStyle = color === "black" ? "#101010" : "#fff";
        ctx.beginPath(); ctx.arc(coord(hoverPoint.x), coord(hoverPoint.y), grid * .45, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }, [showCandidates, nextMoves, position, analysis, selectedCandidateIndex, effectiveOverlayMode, hasOwnership, hasPolicy, policyPoints, canvasSize, hoverPoint, previewStones, occupiedPoints, editColor, theme, themeId, themeImages, numbers, coordinateLabel]);

  return <div className="board-canvas" data-next-move={nextMoves[0] ? vertexLabel({point: nextMoves[0].point}, position.board_size) : undefined} data-board-theme={themeId} data-theme-ready={themeId === "classic" || !!themeImages}>
    <div className="board-surface" style={{background: "transparent"}}>
    <canvas
      ref={canvasRef}
      onClick={handleCanvasClick}
      onMouseDown={event=>{suppressClick.current=false; if(event.button!==0 || !canEdit || !onDragStone) return; const p=canvasEventToBoardPoint(event,position.board_size);dragStart.current=p && occupiedPoints.has(pointKey(p.x,p.y)) ? p : null;}}
      onMouseUp={event=>{const from=dragStart.current;dragStart.current=null;if(!from || !canEdit || !onDragStone) return;suppressClick.current=true;const to=canvasEventToBoardPoint(event,position.board_size);if(to && (to.x!==from.x || to.y!==from.y) && !occupiedPoints.has(pointKey(to.x,to.y))) {suppressClick.current=true;onDragStone(from,to);}}}
      onMouseMove={event => { const point = canvasEventToBoardPoint(event, position.board_size); setHoverPoint(previous => previous?.x === point?.x && previous?.y === point?.y ? previous : point); }}
      onMouseLeave={() => {setHoverPoint(null);dragStart.current=null;}}
      data-preview-moves={previewStones?.filter(stone => stone.moveNumber > 0).length ?? 0}
      style={{ display: "block", width: "100%", height: "100%", cursor: "default" }}
      aria-label={canEdit && editColor ? `围棋棋盘，正在编辑${editColor === "black" ? "黑棋" : "白棋"}着法` : "围棋棋盘"}
    />
    </div>
    <div className="board-tools-row">
    <div className="board-overlay-toggle" aria-label="棋盘显示层切换">
      <OverlayButton mode="candidates" label="候选点" active={effectiveOverlayMode === "candidates"} onClick={() => setOverlayMode("candidates")} />
      <OverlayButton mode="ownership" label="归属热力图" active={effectiveOverlayMode === "ownership"} disabled={!hasOwnership} onClick={() => setOverlayMode("ownership")} />
      {hasPolicy && <OverlayButton mode="policy" label="策略" active={effectiveOverlayMode === "policy"} onClick={() => setOverlayMode("policy")} />}
    </div>
    {controls}
    <label className="board-theme-picker">棋盘主题
      <select aria-label="棋盘主题" value={themeId} onChange={event => {
        const id = event.target.value as BoardThemeId; setThemeId(id);
        setSaveMessage(saveBoardTheme(id) ? "" : "本次主题已应用，无法保存到本机");
      }}>{boardThemes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
    </label>
    {(themeMessage || saveMessage) && <span className="board-theme-message" role="status">{themeMessage || saveMessage}</span>}
    </div>
    <div className="board-legend">{previewStones ? "候选变化预览 · 移开鼠标恢复棋盘" : effectiveOverlayMode === "ownership" ? "蓝色 · 黑方归属　红色 · 白方归属" : `${position.to_play === "black" ? "黑" : "白"}方候选胜率 · 计算量`}</div>
  </div>;
}

function canvasEventToBoardPoint(event: MouseEvent<HTMLCanvasElement>, boardSize: number): { x: number; y: number } | null {
  const rect = event.currentTarget.getBoundingClientRect();
  const cssSize = Math.min(rect.width, rect.height);
  if (cssSize <= 0 || boardSize < 2) return null;
  const offsetX = (rect.width - cssSize) / 2;
  const offsetY = (rect.height - cssSize) / 2;
  const padding = cssSize * 0.07;
  const grid = (cssSize - padding * 2) / (boardSize - 1);
  const boardX = event.clientX - rect.left - offsetX;
  const boardY = event.clientY - rect.top - offsetY;
  const x = Math.round((boardX - padding) / grid);
  const y = Math.round((boardY - padding) / grid);
  if (x < 0 || y < 0 || x >= boardSize || y >= boardSize) return null;
  const snapX = padding + x * grid;
  const snapY = padding + y * grid;
  const distance = Math.hypot(boardX - snapX, boardY - snapY);
  return distance <= grid * 0.42 ? { x, y } : null;
}

function pointKey(x: number, y: number): string {
  return `${x}:${y}`;
}

/**
 * 候选点质量分级，对齐 Java 主线 `featurecat/lizzie/analysis/MoveRankDefinition.java` 的 `Rank` 枚举。
 *
 * 色值取自 `Rank` 构造参数（`MoveRankDefinition.java:23-58`，`color` 一列，非 morandi 色）：
 * BEST (0,180,0) / GOOD (140,202,34) / NORMAL (180,180,0) /
 * INACCURACY (200,140,50) / MISTAKE (208,16,19) / BLUNDER (155,25,150)。
 *
 * `radiusFactor` 取自同处的 `boardMarkRadiusFactor`：0.10 / 0.10 / 0.1225 / 0.145 / 0.1675 / 0.19
 * 原 Java 半径参数保留用于分级定义；候选点在本工作区使用统一半径，容纳胜率与计算量。
 *
 * 阈值取自 `MoveRankDefinition` 的默认常量（`:10-19`）。注意 Java 的胜率单位是**百分点**
 * （-1 / -3 / -6 / -12 / -24），而本仓库内部统一用 **0..1 小数**，故此处除以 100。
 * 评分阈值（-0.5 / -1.5 / -3 / -6 / -12 目）单位一致，直接使用。
 * Java 默认 `moveRankEvaluationMode = AUTO`（`Config.java:1212`），即"评分或（严重级别及以上时的）胜率"，
 * 对应 `reachesThreshold` 的 AUTO 分支（`MoveRankDefinition.java:212-217`）。
 */
type CandidateRank = { fill: string; selectedFill: string; radiusFactor: number };

const CANDIDATE_RANKS: CandidateRank[] = [
  { fill: "rgba(0,180,0,.80)", selectedFill: "rgba(0,180,0,.92)", radiusFactor: 0.10 }, // BEST
  { fill: "rgba(140,202,34,.80)", selectedFill: "rgba(140,202,34,.92)", radiusFactor: 0.10 }, // GOOD
  { fill: "rgba(180,180,0,.80)", selectedFill: "rgba(180,180,0,.92)", radiusFactor: 0.1225 }, // NORMAL
  { fill: "rgba(200,140,50,.80)", selectedFill: "rgba(200,140,50,.92)", radiusFactor: 0.145 }, // INACCURACY
  { fill: "rgba(208,16,19,.80)", selectedFill: "rgba(208,16,19,.92)", radiusFactor: 0.1675 }, // MISTAKE
  { fill: "rgba(155,25,150,.80)", selectedFill: "rgba(155,25,150,.92)", radiusFactor: 0.19 } // BLUNDER
];

/** 级别 1..5 对应的胜率损失阈值（0..1 小数）与评分损失阈值（目）。数组下标 = level - 1。 */
const WIN_LOSS_THRESHOLDS = [1 / 100, 3 / 100, 6 / 100, 12 / 100, 24 / 100];
const SCORE_LOSS_THRESHOLDS = [0.5, 1.5, 3.0, 6.0, 12.0];

function classifyCandidateRank(
  winrateBlack: number | undefined,
  bestWinrate: number | null,
  scoreMeanBlack: number | undefined,
  bestScoreMean: number | null,
  toPlay: PlayerColor
): CandidateRank {
  // 无参照（只有一个候选或数据缺失）时按 BEST 处理，避免把正常点误标成坏点。
  if (bestWinrate === null || typeof winrateBlack !== "number" || !Number.isFinite(winrateBlack)) {
    return CANDIDATE_RANKS[0];
  }
  const winrateLoss = Math.max(0, (bestWinrate - winrateBlack) * (toPlay === "black" ? 1 : -1));
  const scoreLoss =
    typeof scoreMeanBlack === "number" && Number.isFinite(scoreMeanBlack) && bestScoreMean !== null
      ? Math.max(0, (bestScoreMean - scoreMeanBlack) * (toPlay === "black" ? 1 : -1))
      : null;
  // 自高到低匹配：level 5 → BLUNDER ... level 1 → GOOD；都不满足即 BEST。
  for (let level = 5; level >= 1; level -= 1) {
    const reachesWinrate = winrateLoss >= WIN_LOSS_THRESHOLDS[level - 1];
    const reachesScore = scoreLoss !== null && scoreLoss >= SCORE_LOSS_THRESHOLDS[level - 1];
    // AUTO 模式（Java 默认）：评分达标即达标；胜率单独达标仅在 level >= 4（MISTAKE 及以上）时计入。
    const reaches = reachesScore || (level >= 4 && reachesWinrate);
    if (reaches) return CANDIDATE_RANKS[level];
  }
  return CANDIDATE_RANKS[0];
}

function OverlayButton({ mode, label, active, disabled, onClick }: { mode?: OverlayMode; label: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return <button
    type="button"
    disabled={disabled}
    aria-pressed={active}
    data-overlay-mode={mode}
    onClick={onClick}
    className="board-overlay-button"
  >{label}</button>;
}

function normalizeOwnershipValue(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const normalized = Math.abs(value) > 1 ? value / 100 : value;
  return Math.max(-1, Math.min(1, normalized));
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

function drawPolicyOverlay(ctx: CanvasRenderingContext2D, points: PolicyPoint[], boardSize: number, coord: (n: number) => number, grid: number) {
  const maxPolicy = Math.max(points[0]?.value ?? 1, 1e-6);
  for (const [rank, point] of points.entries()) {
    const weight = Math.sqrt(point.value / maxPolicy);
    const cx = coord(point.x);
    const cy = coord(point.y);
    const radius = grid * (0.12 + weight * 0.32);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(20,184,166,${0.28 + weight * 0.58})`;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.lineWidth = Math.max(1.5, grid * 0.04);
    ctx.stroke();
    if (rank < 8) {
      ctx.fillStyle = "white";
      ctx.font = `${Math.max(10, grid * 0.26)}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(rank + 1), cx, cy);
      ctx.fillStyle = "rgba(0,0,0,.72)";
      ctx.font = `${Math.max(9, grid * 0.2)}px system-ui`;
      ctx.fillText(vertexLabel({ point: { x: point.x, y: point.y } }, boardSize), cx, cy + radius + 10);
    }
  }
}
