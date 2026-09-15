import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { loadEngineProfilesSettings, isTauriRuntime } from '../api/backend';
import { runResearchBatch } from '../api/researchBatch';
import type { AnalysisFrameDto, EngineProfileDto, EngineProfileRecordDto } from '../domain/types';
const cancel = (jobId: string) => invoke<void>('cancel_background_curve', {jobId});
export function useBackgroundCurve(document: string, imported?: { text: string; id: number }) {
  const [result,setResult]=useState<{document:string;frames:AnalysisFrameDto[]}|null>(null);
  const [status,setStatus]=useState(''), [busy,setBusy]=useState(false);
  const active=useRef(false), mounted=useRef(true), cancelled=useRef(false), job=useRef<string|null>(null);
  const current=useRef(document); current.current=document;
  const stop=async()=>{cancelled.current=true;if(job.current)await cancel(job.current);};
  useEffect(()=>{void stop().catch(()=>{});setResult(null);setStatus('');},[document]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;void stop().catch(()=>{});};},[]);
  const handledImport = useRef<number | null>(null);
  useEffect(() => {
    if (!imported || imported.text !== document || handledImport.current === imported.id || active.current) return;
    handledImport.current = imported.id;
    if (isTauriRuntime()) void start();
  }, [imported, document, busy]);

  async function start(requested?: EngineProfileRecordDto) {
    if(active.current)return;
    if(!isTauriRuntime()){setStatus('后台补线需要桌面应用。');return;}
    active.current=true;cancelled.current=false;setBusy(true);setStatus('准备本地 1v 补线…');
    const submitted=document;
    try {
      const settings=await loadEngineProfilesSettings();
      const selected=requested ?? settings.profiles.find(p=>p.id==='one-click-quick') ?? settings.profiles.find(p=>p.id===settings.selected_profile_id);
      if(!selected)throw new Error('请先在一键设置中安装走势快速补算模型。');
      if(cancelled.current)return;
      const frames=await runResearchBatch(selected.profile,submitted,1,{
        onJob:id=>{job.current=id;},isCancelled:()=>cancelled.current,
        onProgress:(n,total)=>{if(mounted.current&&current.current===submitted)setStatus(`本地 1v 补线 ${n}/${total}`);}
      },{start:(profile:EngineProfileDto,sgfText:string)=>invoke<string>('start_background_curve',{profile,sgfText}),cancel});
      if(mounted.current&&current.current===submitted){
        if(frames&&!cancelled.current){setResult({document:submitted,frames});setStatus('1v 曲线已生成，后台进程已退出。');}
        else setStatus('补线已取消。');
      }
    } catch(e){if(mounted.current&&current.current===submitted)setStatus(String(e));}
    finally {job.current=null;active.current=false;if(mounted.current)setBusy(false);}
  }
  return {frames:result?.document===document?result.frames:[],busy,status,start,cancel:stop};
}
