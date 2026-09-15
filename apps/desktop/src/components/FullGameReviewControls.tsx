import { useState } from 'react';
import type { FullGameReviewController } from '../hooks/useFullGameReview';
type Props = { controller: FullGameReviewController; maxTurn: number; connected: boolean };
export function FullGameReviewControls({controller,maxTurn,connected}: Props) {
  const [fromText,setFrom] = useState("1"), [to,setTo] = useState<string | null>(null);
  const from = Number(fromText), end = to === null ? maxTurn : Number(to);
  const [visitsText,setVisits] = useState("1000"), [coarseFirst,setCoarse] = useState(true), [incremental,setIncremental] = useState(true);
  const [allBranches, setAllBranches] = useState(false);
  const {progress} = controller, running = progress.status === 'running';
  return <section aria-label="全盘分析">
    <strong>全盘分析</strong>
    <fieldset disabled={running} className="statistics-controls">
      <label>从 <input aria-label="分析起始手数" type="number" min={1} max={maxTurn} value={fromText} onChange={e=>setFrom(e.target.value)}/></label>
      <label>至 <input aria-label="分析结束手数" type="number" min={from} max={maxTurn} value={to ?? maxTurn} onChange={e=>setTo(e.target.value)}/></label>
      <label>每局面计算量 <input aria-label="全盘每局面计算量" type="number" min={32} step={100} value={visitsText} onChange={e=>setVisits(e.target.value)}/></label>
      <label><input type="checkbox" checked={allBranches} onChange={e=>setAllBranches(e.target.checked)}/>包含所有棋谱分支</label>
      <label><input type="checkbox" checked={coarseFirst} onChange={e=>setCoarse(e.target.checked)}/>先粗扫补齐走势</label>
      <label><input type="checkbox" checked={incremental} onChange={e=>setIncremental(e.target.checked)}/>只补缺失或不足</label>
    </fieldset>
    <div className="statistics-controls">
      {running ? <button onClick={()=>void controller.pause().catch(() => undefined)}>暂停</button> : <button disabled={!connected || !maxTurn || from < 1 || !Number.isFinite(from) || Number(visitsText) < 32 || !Number.isFinite(Number(visitsText)) || from > Math.min(end,maxTurn)} onClick={()=>void controller.start({from,to:Math.min(end,maxTurn),visits:Number(visitsText),coarseFirst,incremental,allBranches})}>开始全盘分析</button>}
      {(progress.status === 'paused' || progress.status === 'error') && <button disabled={!connected} onClick={()=>void controller.resume()}>继续</button>}
      {(running || progress.status === 'paused' || progress.status === 'error') && <button onClick={()=>void controller.cancel().catch(() => undefined)}>取消</button>}
      <span role="status">{progress.status === 'complete' ? '分析完成' : progress.status === 'paused' ? '已暂停' : progress.status === 'idle' ? connected ? '准备就绪' : '请先连接引擎' : `${progress.phase} · 第 ${progress.turn} 手`} {progress.total ? `${progress.completed}/${progress.total}` : ''}</span>
    </div>
    {progress.total > 0 && <progress max={progress.total} value={progress.completed} aria-label="全盘分析进度"/>}
    {progress.error && <p role="alert">{progress.error}</p>}
    <p className="statistics-note">复用已连接的本地或云引擎，按主线或全部分支逐节点补齐。粗扫每局面 32 次，再深度分析；暂停保留进度，完成返回当前局面。</p>
  </section>;
}
