import { useEffect,useRef,useState } from 'react';
import { cancelTolerance,listenTolerance,loadTolerance,startTolerance } from '../api/toleranceReview';
import { isTauriRuntime } from '../api/backend';
import { documentHash,mergeEvent,terminal } from '../domain/tolerance/metrics';
import type { Report,Request,ReviewConfig } from '../domain/tolerance/types';
type Options={sgfText:string;nodeId:string|null;acquire:()=>Promise<void>;release:(safe:boolean,mode:Request['mode'])=>Promise<void>};
export function useToleranceReview(options:Options){
  const latest=useRef(options);latest.current=options;
  const mounted=useRef(true),busyRef=useRef(false),job=useRef<string|null>(null),cancelled=useRef(false);
  const [busy,setBusy]=useState(false),[report,setReport]=useState<Report|null>(null),[error,setError]=useState('');
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;cancelled.current=true;if(job.current)void cancelTolerance(job.current).catch(()=>{});};},[]);
  useEffect(()=>{let disposed=false;setReport(null);setError('');if(isTauriRuntime()&&!busyRef.current)void loadTolerance(options.sgfText).then(r=>{if(!disposed)setReport(r);}).catch(e=>{if(!disposed)setError(String(e));});return()=>{disposed=true;};},[options.sgfText]);
  async function start(mode:Request['mode'],config:ReviewConfig,alternatives:string[]=[]){
    if(busyRef.current)return;
    if(!isTauriRuntime()){setError('请在桌面应用中启动 HumanSL 分析。');return;}
    const captured={...latest.current};if(!captured.nodeId){setError('请选择棋谱节点');return;}
    busyRef.current=true;setBusy(true);cancelled.current=false;setError('');
    const id=`tolerance-${crypto.randomUUID()}`;job.current=id;
    let acquired=false,started=false,safe=true,unlisten:(()=>void)|undefined;
    try {
      const hash=await documentHash(captured.sgfText);
      const request:Request={sgfText:captured.sgfText,anchorNodeId:captured.nodeId,mode,config:structuredClone(config),alternatives};
      setReport({format:'lizzieyzy-tolerance-v1',algorithm:'human-loss-v1',jobId:id,documentHash:hash,request,identity:null,status:'starting',phase:'等待算力',completed:0,total:0,queryCount:0,cacheHits:0,positions:[],branches:[],error:null,cleanupConfirmed:false,updatedAt:0});
      let finish!:(safe:boolean)=>void;
      const done=new Promise<boolean>(r=>{finish=r;});
      unlisten=await listenTolerance(event=>{
        if(event.jobId!==id||event.documentHash!==hash)return;
        if(mounted.current&&latest.current.sgfText===captured.sgfText)setReport(r=>r?mergeEvent(r,event):r);
        if(terminal(event.status))finish(event.cleanupConfirmed);
      });
      await captured.acquire();acquired=true;
      if(cancelled.current)return;
      safe=false;await startTolerance(id,request);started=true;
      if(cancelled.current)await cancelTolerance(id);
      // Poll is recovery for lost terminal events; disk snapshots never release an active registry slot.
      const timer=setInterval(()=>{void loadTolerance(captured.sgfText).then(r=>{if(r?.jobId===id&&terminal(r.status)){if(mounted.current&&latest.current.sgfText===captured.sgfText)setReport(r);finish(r.cleanupConfirmed);}}).catch(()=>{});},3000);
      try {safe=await done;}finally{clearInterval(timer);}
      const saved=await loadTolerance(captured.sgfText);if(mounted.current&&latest.current.sgfText===captured.sgfText&&saved?.jobId===id)setReport(saved);
    }catch(e){if(mounted.current)setError(String(e));if(started)await cancelTolerance(id).catch(()=>{});}
    finally{
      unlisten?.();job.current=null;
      if(acquired){try{await captured.release(safe,mode);}catch(e){if(mounted.current)setError(String(e));}}
      busyRef.current=false;if(mounted.current){setBusy(false);if(cancelled.current)setReport(r=>r&&!terminal(r.status)?{...r,status:'cancelled'}:r);}
    }
  }
  async function cancel(){cancelled.current=true;if(job.current)await cancelTolerance(job.current).catch(e=>setError(String(e)));}
  return {busy,busyRef,report,error,start,cancel};
}
export type ToleranceController=ReturnType<typeof useToleranceReview>;
