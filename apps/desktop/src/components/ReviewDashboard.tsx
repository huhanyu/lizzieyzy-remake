import { useEffect, useMemo, useState } from 'react';
import { useReviewSnapshot } from '../hooks/useReviewSnapshot';
import { reviewMoves, type ReviewMove, type ReviewScope } from '../domain/reviewStatistics';
import { loadStrengthModel } from '../domain/strength/model';
import { loadHuman40Model } from '../domain/strength/human40';
import { useHumanStrength } from '../hooks/useHumanStrength';
import { ArrowClockwise, DownloadSimple, Stop } from '@phosphor-icons/react';
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
    [modelId, setModelId] = useState<'xgboost20tun' | 'humansl40'>(() => {
      try { return localStorage.getItem('lizzie-strength-model') === 'humansl40' ? 'humansl40' : 'xgboost20tun'; }
      catch { return 'xgboost20tun'; }
    }),
    [humanModel, setHumanModel] = useState<Awaited<ReturnType<typeof loadHuman40Model>> | null>(null),
    [model, setModel] = useState<Awaited<
      ReturnType<typeof loadStrengthModel>
    > | null>(null),
    [error, setError] = useState("");
  const snapshot = useReviewSnapshot(scope);
  const all = useMemo(() => reviewMoves(snapshot), [snapshot]);
  const human = useHumanStrength(modelId === 'humansl40', snapshot);
  const scored = modelId === 'humansl40' ? human.moves : all;
  const moves = useMemo(
    () =>
      scored.filter(
        (m) =>
          phase === "all" ||
          (phase === "opening" && m.turn <= 60) ||
          (phase === "middle" && m.turn > 60 && m.turn <= 160) ||
          (phase === "end" && m.turn > 160),
      ),
    [scored, phase],
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
    setError('');
    if (modelId === 'humansl40') {
      loadHuman40Model().then(m => { if (active) setHumanModel(m); })
        .catch(e => { if (active) setError(String(e)); });
      return () => { active = false; };
    }
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
  }, [mode, modelId]);
  const select = (m: ReviewMove, before = false) => {
    const id = before ? m.parentId : m.nodeId;
    if (id && onNodeSelect) onNodeSelect(id);
    else onMoveSelect?.(before ? Math.max(0, m.turn - 1) : m.turn);
  };
  return (
    <div className="review-dashboard">
      <div className="statistics-controls">
        <select aria-label="棋力模型" value={modelId} onChange={e => {
          const id = e.target.value === 'humansl40' ? 'humansl40' : 'xgboost20tun';
          setModelId(id);
          try { localStorage.setItem('lizzie-strength-model', id); } catch { /* Optional preference only. */ }
        }}>
          <option value="xgboost20tun">XGBoost 20TUN</option>
          <option value="humansl40">HumanSL 40</option>
        </select>
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
          有效样本 {moves.filter((m) => m.strength).length}/{all.filter(m => phase === 'all' || (phase === 'opening' && m.turn <= 60) || (phase === 'middle' && m.turn > 60 && m.turn <= 160) || (phase === 'end' && m.turn > 160)).length} 手
        </small>
        {modelId === 'humansl40' && (human.busy ?
          <button type="button" className="strength-icon-button" title="取消补算" aria-label="取消补算" onClick={human.cancel}><Stop size={16}/></button> :
          <button type="button" className="strength-icon-button" title="刷新测评" aria-label="刷新测评" disabled={!human.canStart} onClick={() => void human.start()}><ArrowClockwise size={16}/></button>)}
      </div>
      {modelId === 'humansl40' && <div className="strength-status" aria-live="polite">
        {human.phase === 'missing-model' && <button type="button" onClick={() => void human.start(true)}><DownloadSimple size={16}/>下载所需模型 · 99 MB</button>}
        {human.busy && <><progress max={human.total || 1} value={human.phase === 'running' ? human.done : undefined}/><span>{human.phase === 'downloading' ? '正在下载 HumanSL 模型' : human.phase === 'preparing' ? '正在准备补充数据' : `HumanSL 补算 ${human.done}/${human.total}`}</span></>}
        {human.phase === 'cancelled' && <span>已取消，已完成的策略缓存保留</span>}
        {human.error && <span role="alert">{human.error}</span>}
      </div>}
      {mode === "summary" && (
        <>
          <div className="strength-table-scroll"><table className="review-summary-table"><thead><tr><th>棋手</th><th>预估棋力</th><th>损失/目</th><th>一选</th><th>好手</th><th>{modelId === 'humansl40' ? '9d 难度' : '难度'}</th>{modelId === 'humansl40' && <th>策略覆盖</th>}</tr></thead><tbody>
            {(["black", "white"] as const).map((c, i) => (
              <SideSummary
                key={c}
                moves={sideMoves[i]}
                color={c === "black" ? "黑方" : "白方"}
                model={model}
                modelId={modelId}
                humanModel={humanModel}
              />
            ))}
          </tbody></table></div>
          {error && <p role="alert">{error}</p>}
          <p className="statistics-note">
            {modelId === 'humansl40' ? '实验性单盘评估 · 前 210 手 · 低段尚未充分验证。难度仅统计策略覆盖 ≥90% 的局面；无可靠数据时留空。'
              : '按 Java 棋力模型计算；难度为局面复杂度，不是人类策略概率。未分析手数不计入分母。'}
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
