import { useEffect, useRef, useState } from 'react';
import { loadEngineProfilesSettings } from '../api/backend';
import type { EngineProfileRecordDto } from '../domain/types';
import { researchExport, type ResearchDocument } from '../domain/researchQueue';
import type { ResearchQueueController } from '../hooks/useResearchQueue';
export function ResearchQueuePanel({controller,current,disabled=false,onQuickCurve,curveBusy=false}: {controller:ResearchQueueController;current:ResearchDocument|null;disabled?:boolean;onQuickCurve:(profile:EngineProfileRecordDto)=>void;curveBusy?:boolean}) {
  const [profiles,setProfiles]=useState<EngineProfileRecordDto[]>([]),[selected,setSelected]=useState(''),[visits,setVisits]=useState('800');
  const [files,setFiles]=useState<ResearchDocument[]>([]),[message,setMessage]=useState('');
  const fileInput=useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    const reload = () => { void loadEngineProfilesSettings().then(settings => {
      if (!active) return;
      const available = settings.profiles.filter(item => ['kata_go_gtp', 'kata_go_analysis'].includes(item.profile.backend));
      setProfiles(available); setSelected(current => available.some(item => item.id === current) ? current : available[0]?.id ?? '');
    }).catch(() => { if (active) setMessage('无法读取本地引擎配置。'); }); };
    reload(); window.addEventListener('engine-profiles-changed', reload);
    return () => { active = false; window.removeEventListener('engine-profiles-changed', reload); };
  }, []);
  const busy=controller.busyRef.current,profile=profiles.find(p=>p.id===selected),budget=Number(visits);
  function download(){const blob=new Blob([researchExport(controller.results)],{type:'application/json'}),url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='lizzieyzy-analysis-results.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return <section className="research-queue-panel" aria-label="研究队列">
    <strong>批量分析与轻量补线</strong>
    <fieldset disabled={busy||disabled} className="statistics-controls">
      <label>独立分析配置<select aria-label="研究队列引擎" value={selected} onChange={e=>setSelected(e.target.value)}>{profiles.map(p=><option key={p.id} value={p.id}>{p.profile.name}</option>)}</select></label>
      <label>每局面计算量<input type="number" min="1" value={visits} onChange={e=>setVisits(e.target.value)}/></label>
      <input ref={fileInput} hidden type="file" multiple accept=".sgf" onChange={async e=>{const list=Array.from(e.target.files??[]);try{if(list.length>100||list.some(f=>f.size>10_000_000))throw new Error('最多 100 份，每份不超过 10 MB。');setFiles(await Promise.all(list.map(async(f,i)=>({id:`${i}:${f.name}`,name:f.name,sgfText:await f.text()}))));setMessage('');}catch(error){setMessage(String(error));}}}/>
      <button onClick={()=>fileInput.current?.click()}>选择多份棋谱</button>
      <button disabled={!profile||!files.length||!Number.isInteger(budget)||budget<1} onClick={()=>profile&&void controller.start(files,profile,budget)}>开始队列（{files.length} 份）</button>
      <button disabled={!profile||!current||curveBusy} onClick={()=>profile&&current&&onQuickCurve(profile)}>所选配置后台 1v 补线</button>
    </fieldset>
    <p className="statistics-note">轻量模型请先在引擎设置中创建独立配置。批量队列暂停前景分析，结束后恢复；1v 后台补线独立运行，完成即退出；遇到分析或保存错误会停下并保留已完成结果供导出；批量结果按棋谱单独保存，不覆盖当前显示。</p>
    <div className="statistics-controls">{busy&&<button onClick={()=>void controller.cancel()}>取消并等待引擎停止</button>}{controller.results.length>0&&<button onClick={download}>导出全部结果</button>}</div>
    <p role="status">{{idle:'准备就绪',acquiring:'正在让出前景算力',running:'分析中',cancelling:'等待取消确认',restoring:'恢复前景分析',complete:'队列完成',error:'队列停止'}[controller.state.status]} · {controller.state.completed}/{controller.state.total} {controller.state.name} {controller.state.expected?`· ${controller.state.positions}/${controller.state.expected} 局面`:''}</p>
    {controller.state.expected>0&&<progress max={controller.state.expected} value={controller.state.positions} aria-label="当前棋谱分析进度"/>}
    <ol>{controller.results.map(r=><li key={r.document.id}>{r.document.name} · {r.frames.length} 个局面 · 可导出</li>)}</ol>
    {(message||controller.state.error)&&<p role="alert">{message||controller.state.error}</p>}
  </section>;
}
