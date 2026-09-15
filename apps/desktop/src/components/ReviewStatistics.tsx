import { useMemo, useState } from 'react';
import { DEFAULT_MATCH_POLICY } from '../domain/positionMetrics';
import { filterMistakes, reviewMoves, summarizeMoves, type LossMetric, type ReviewScope } from '../domain/reviewStatistics';
import type { PlayerColor } from '../domain/types';

type Props = ReviewScope & { mode: 'match' | 'mistakes'; onNodeSelect?: (id: string) => void; onMoveSelect?: (turn: number) => void };
const number = (value: number | null, unit = '') => value === null ? '—' : `${value.toFixed(1)}${unit}`;
export function ReviewStatistics({ mode, onNodeSelect, onMoveSelect, ...scope }: Props) {
  const [policy, setPolicy] = useState(DEFAULT_MATCH_POLICY);
  const [color, setColor] = useState<PlayerColor | 'both'>('both');
  const [metric, setMetric] = useState<LossMetric>('winrateLoss');
  const [threshold, setThreshold] = useState(5);
  const [sort, setSort] = useState<'loss' | 'turn'>('loss');
  const moves = useMemo(() => reviewMoves(scope, policy), [scope.tree, scope.documentKey, scope.selectedNodeId, scope.frames, scope.analysisJobId, policy]);
  const mistakes = useMemo(() => filterMistakes(moves, color, metric, threshold, sort), [moves, color, metric, threshold, sort]);
  const select = (nodeId: string, turn: number) => onNodeSelect ? onNodeSelect(nodeId) : onMoveSelect?.(turn);
  if (!scope.tree) return <div className="analysis-module-empty">载入棋谱并分析后显示统计</div>;
  return <div className="review-statistics">
    {mode === 'match' ? <>
      <div className="statistics-controls">
        <label>候选前 <input aria-label="吻合候选数量" type="number" min={1} max={20} value={policy.topN} onChange={e => setPolicy(p => ({...p, topN: Math.max(1, Math.min(20, Number(e.target.value) || 1))}))}/> 位</label>
        <label>相对计算量 ≥ <input aria-label="吻合相对计算量百分比" type="number" min={0} max={100} value={Math.round(policy.relativeVisits * 100)} onChange={e => setPolicy(p => ({...p, relativeVisits: Math.max(0, Math.min(100, Number(e.target.value))) / 100}))}/> %</label>
      </div>
      <table><thead><tr><th>棋手</th><th>吻合度</th><th>已分析</th><th>平均掉胜率</th><th>平均损失目数</th></tr></thead><tbody>
        {(['black', 'white'] as const).map(side => { const stats = summarizeMoves(moves, side); return <tr key={side}><th>{side === 'black' ? '黑方' : '白方'}</th><td>{number(stats.match, '%')}</td><td>{stats.analyzed}/{stats.total}</td><td title={`有效前后局面 ${stats.winrate.count} 手`}>{number(stats.winrate.value, ' pp')}</td><td title={`有效前后局面 ${stats.score.count} 手`}>{number(stats.score.value, ' 目')}</td></tr>; })}
      </tbody></table>
      <p className="statistics-note">统计当前分支及其后续主线。吻合度需落子前候选结果，停一手不计；平均损失仅计同一分析任务的真实前后局面，负值表示改善。未分析局面不计入分母。</p>
    </> : <>
      <div className="statistics-controls">
        <select aria-label="问题手棋手" value={color} onChange={e => setColor(e.target.value as typeof color)}><option value="both">双方</option><option value="black">黑方</option><option value="white">白方</option></select>
        <select aria-label="问题手指标" value={metric} onChange={e => {setMetric(e.target.value as LossMetric); setThreshold(e.target.value === 'winrateLoss' ? 5 : 1);}}><option value="winrateLoss">掉胜率</option><option value="scoreLoss">损失目差</option></select>
        <label>≥ <input aria-label="问题手阈值" type="number" min={0} step={0.5} value={threshold} onChange={e => setThreshold(Math.max(0, Number(e.target.value) || 0))}/>{metric === 'winrateLoss' ? ' pp' : ' 目'}</label>
        <select aria-label="问题手排序" value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="loss">损失从大到小</option><option value="turn">按手数</option></select>
      </div>
      <div className="mistake-overview" aria-label="当前分支问题手概览">{moves.map(m => {
        const value = m[metric], visible = color === 'both' || m.color === color;
        const severity = !visible || value === null ? 'unknown' : value < threshold ? 'normal' : value >= threshold * 2 ? 'major' : 'minor';
        return <button key={m.nodeId} type="button" data-severity={severity} aria-label={`第 ${m.turn} 手${m.color === 'black' ? '黑' : '白'}，损失 ${number(value, metric === 'winrateLoss' ? ' 个百分点' : ' 目')}`} title={`第 ${m.turn} 手 · ${number(value)}`} onClick={() => select(m.nodeId, m.turn)}/>;
      })}</div>
      <small className="statistics-note">灰：无数据或已筛除 · 青：低于阈值 · 黄：达到阈值 · 橙：达到两倍阈值</small>
      <div className="mistake-list">{mistakes.length ? mistakes.map(m => <button key={m.nodeId} type="button" onClick={() => select(m.nodeId, m.turn)}><span>第 {m.turn} 手 · {m.color === 'black' ? '黑方' : '白方'}</span><span>掉胜率 {number(m.winrateLoss, ' pp')}</span><span>损失 {number(m.scoreLoss, ' 目')}</span></button>) : <p className="statistics-note">{moves.some(m => m[metric] !== null) ? '已分析局面中没有符合筛选条件的问题手。' : '尚无完整前后局面分析，请先运行全盘分析。'}</p>}</div>
    </>}
  </div>;
}
