import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './AnalysisLayoutDemo.css';

type Panel = 'limit' | 'review' | 'parameters' | null;
/** Layout experiment only: recorded board data remains untouched; no engine commands. */
export function AnalysisLayoutDemo({maxMove, currentMove}: {maxMove: number; currentMove: number}) {
  const [panel,setPanel] = useState<Panel>(null);
  const root = useRef<HTMLDivElement>(null);
  const [limit,setLimit] = useState('不限');
  const [mode,setMode] = useState('深度复盘');
  const [range,setRange] = useState('全盘');
  const [from,setFrom] = useState('1'), [to,setTo] = useState(String(maxMove));
  const [budget,setBudget] = useState('1000'), [incremental,setIncremental] = useState(true);
  const [wide,setWide] = useState('0.04'), [pda,setPda] = useState('0');
  const [applied,setApplied] = useState({wide:'0.04',pda:'0'});
  const [task,setTask] = useState<{status:'running'|'paused'|'done';done:number;total:number;label:string} | null>(null);
  const [menu,setMenu] = useState<{x:number;y:number;point:string}|null>(null);
  const [restriction,setRestriction] = useState<{mode:string;points:string[]}|null>(null);
  const [host,setHost] = useState<Element|null>(null), [boardHost,setBoardHost] = useState<Element|null>(null);
  useEffect(()=> {
    document.body.classList.add('analysis-layout-demo');
    setHost(document.querySelector('.legacy-right-pane'));
    setBoardHost(document.querySelector('.board-tools-row'));
    const close = (e:PointerEvent) => {if(!root.current?.contains(e.target as Node)) setPanel(null); if(!(e.target as Element).closest?.('.demo-context'))setMenu(null);};
    const key = (e:KeyboardEvent)=>{if(e.key==='Escape'){setPanel(null);setMenu(null);}};
    const context = (e:MouseEvent)=>{
      const canvas=e.target as HTMLCanvasElement;
      if(!canvas.matches('.board-surface canvas'))return;
      const rect=canvas.getBoundingClientRect(), step=rect.width*.86/18;
      const x=Math.round((e.clientX-rect.left-rect.width*.07)/step), y=Math.round((e.clientY-rect.top-rect.height*.07)/step);
      if(x<0||x>18||y<0||y>18)return;
      e.preventDefault();setPanel(null);setMenu({x:Math.max(8,Math.min(e.clientX,innerWidth-240)),y:Math.max(8,Math.min(e.clientY,innerHeight-240)),point:'ABCDEFGHJKLMNOPQRST'[x]+(19-y)});
    };
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',key);document.addEventListener('contextmenu',context);
    return ()=>{document.body.classList.remove('analysis-layout-demo');document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',key);document.removeEventListener('contextmenu',context);};
  },[]);
  useEffect(()=>{
    if(task?.status!=='running')return;
    const timer=setInterval(()=>setTask(t=>t?{...t,done:Math.min(t.total,t.done+1),status:t.done+1>=t.total?'done':'running'}:t),650);
    return ()=>clearInterval(timer);
  },[task?.status]);
  const toggle=(next:Panel)=>setPanel(p=>p===next?null:next);
  function start(){
    const begin=range==='全盘'?1:range==='从当前手'?Math.max(1,currentMove):Number(from);
    const end=range==='自选范围'?Number(to):maxMove;
    if(!Number.isInteger(begin)||!Number.isInteger(end)||begin<1||end>maxMove||begin>end||Number(budget)<32)return;
    setTask({status:'running',done:0,total:end-begin+2,label:`${mode} · ${begin}–${end} 手`});setPanel(null);
  }
  function restrict(kind:string){if(!menu)return;setRestriction(previous=>({mode:kind,points:previous?.mode===kind?[...new Set([...previous.points,menu.point])]:[menu.point]}));setMenu(null);}
  return <>
    <div className="demo-toolbar" ref={root}>
      <button aria-expanded={panel==='limit'} onClick={()=>toggle('limit')}>{limit} ▾</button>
      <button className="demo-review-trigger" aria-expanded={panel==='review'} onClick={()=>toggle('review')}>全盘分析 ▾</button>
      <button aria-expanded={panel==='parameters'} onClick={()=>toggle('parameters')}>分析参数</button>
      {Number(applied.pda)!==0&&<button className="demo-active" onClick={()=>toggle('parameters')}>PDA {Number(applied.pda)>0?'+':''}{applied.pda}</button>}
      <span className="demo-label">布局演示</span>
      {panel&&<section className={`demo-popover demo-${panel}`} aria-label={panel==='review'?'全盘分析设置':panel==='parameters'?'快捷分析参数':'搜索限额'}>
        <header><strong>{panel==='review'?'全盘分析':panel==='parameters'?'分析参数':'单局面搜索限额'}</strong><button aria-label="关闭快捷面板" onClick={()=>setPanel(null)}>关闭</button></header>
        {panel==='limit'?<><p>达到任一上限后暂停，连接保留。</p><div className="demo-choices">{['不限','2秒/手','5秒/手','10秒/手','1000次/手','1万次/手'].map(v=><button key={v} className={limit===v?'selected':''} onClick={()=>{setLimit(v);setPanel(null);}}>{v}</button>)}</div><small>演示选择效果，不改变回放数据。</small></>:panel==='parameters'?<>
          <label>搜索广度<input aria-label="演示搜索广度" type="number" min="0" max="5" step="0.01" value={wide} onChange={e=>setWide(e.target.value)}/></label>
          <label>激进度 PDA<input aria-label="演示PDA" type="number" min="-3" max="3" step="0.1" value={pda} onChange={e=>setPda(e.target.value)}/></label>
          <p>线程数留在「引擎设置」。非默认 PDA 会在顶栏保持提示。</p><footer><button onClick={()=>{setWide('0.04');setPda('0');}}>恢复默认</button><button className="primary" onClick={()=>{setApplied({wide,pda});setPanel(null);}}>应用演示</button></footer>
        </>:<>
          <div className="demo-choices">{['快速补齐','深度复盘'].map(v=><button key={v} className={mode===v?'selected':''} onClick={()=>setMode(v)}>{v}</button>)}</div>
          <p>{mode==='深度复盘'?'先快速补齐走势，再逐手加深计算。':'用较小计算量补齐尚未分析的局面。'}</p>
          <label>分析范围<select value={range} onChange={e=>setRange(e.target.value)}><option>全盘</option><option>从当前手</option><option>自选范围</option></select></label>
          {range==='自选范围'&&<div className="demo-range"><input aria-label="演示起始手" type="number" min="1" max={maxMove} value={from} onChange={e=>setFrom(e.target.value)}/><span>至</span><input aria-label="演示结束手" type="number" min="1" max={maxMove} value={to} onChange={e=>setTo(e.target.value)}/></div>}
          {mode==='深度复盘'&&<label>每局面计算量<input aria-label="演示计算量" type="number" min="32" value={budget} onChange={e=>setBudget(e.target.value)}/></label>}
          <label className="demo-check"><input type="checkbox" checked={incremental} onChange={e=>setIncremental(e.target.checked)}/>只补缺失或不足的局面</label>
          <footer><small>模拟任务，不消耗算力</small><button className="primary" disabled={task?.status==='running'} onClick={start}>开始演示</button></footer>
        </>}
      </section>}
    </div>
    {host&&createPortal(<div className={`demo-task ${task?'has-task':''}`}>
      {task?<><div><strong>{task.status==='done'?'补算完成':task.status==='paused'?'补算已暂停':task.label}</strong><small>模拟进度 · {task.done}/{task.total} 局面</small></div><progress value={task.done} max={task.total}/>{task.status!=='done'&&<button onClick={()=>setTask(t=>t?{...t,status:t.status==='running'?'paused':'running'}:t)}>{task.status==='running'?'暂停':'继续'}</button>}<button onClick={()=>setTask(null)}>{task.status==='done'?'收起':'取消'}</button></>:<span>试试顶栏「全盘分析」，或在棋盘交叉点上右键。</span>}
    </div>,host)}
    {boardHost&&restriction&&createPortal(<button className="demo-restriction" onClick={()=>setRestriction(null)} title={restriction.points.join('、')}>{restriction.mode} {restriction.points.join('、')} · 清除</button>,boardHost)}
    {menu&&createPortal(<div className="demo-context" role="menu" style={{left:menu.x,top:menu.y}}><strong>{menu.point} · 分析选点</strong><button role="menuitem" onClick={()=>restrict('只分析')}>只分析此点</button><button role="menuitem" onClick={()=>restrict('只分析')}>增加分析此点</button><button role="menuitem" onClick={()=>restrict('排除')}>排除此点</button><button role="menuitem" onClick={()=>{setRestriction(null);setMenu(null);}}>清除全部限制</button><small>布局演示 · 不影响回放</small></div>,document.body)}
  </>;
}
