import { useEffect, useRef, useState } from 'react';
import { cancelKataGoAnalysis, parseSgfSummary } from '../api/backend';
import { computeGameCacheKey, saveAnalysisCache } from '../api/analysisCache';
import { runResearchBatch } from '../api/researchBatch';
import { validateResearchDocuments, type ResearchDocument, type ResearchResult } from '../domain/researchQueue';
import type { EngineProfileRecordDto } from '../domain/types';
import type { JsonValue } from '../domain/cache';

type Options = {
  /** Confirm foreground session has stopped, preserve its settings for release(). */
  acquire: () => Promise<void>;
  /** Restore only after the last batch terminal event, and only if the user still wants it. */
  release: () => Promise<void>;
  onCurrentResult?: (result: ResearchResult) => void | Promise<void>;
};
type State = { status: 'idle'|'acquiring'|'running'|'cancelling'|'restoring'|'complete'|'error'; name: string; completed: number; total: number; positions: number; expected: number; error?: string };
const initial: State = {status:'idle',name:'',completed:0,total:0,positions:0,expected:0};
export function useResearchQueue(options: Options) {
  const latest=useRef(options); latest.current=options;
  const mounted=useRef(true), busyRef=useRef(false), cancelled=useRef(false), job=useRef<string|null>(null);
  const running=useRef<Promise<void>|null>(null);
  const [state,setState]=useState<State>(initial), [results,setResults]=useState<ResearchResult[]>([]);
  const update=(patch:Partial<State>)=>{if(mounted.current)setState(value=>({...value,...patch}));};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;cancelled.current=true;if(job.current)void cancelKataGoAnalysis(job.current).catch(()=>{});};},[]);
  async function start(documents: ResearchDocument[], profile: EngineProfileRecordDto, visits: number, applyCurrent = false) {
    if(busyRef.current)return;
    try { validateResearchDocuments(documents); if(!Number.isInteger(visits)||visits<1)throw new Error('计算量必须为正整数。'); if(!['kata_go_gtp','kata_go_analysis'].includes(profile.profile.backend))throw new Error('请选择本地 KataGo 配置。'); }
    catch(error){update({status:'error',error:String(error)});return;}
    busyRef.current=true;cancelled.current=false;setResults([]);setState({...initial,status:'acquiring',total:documents.length});
    // Freeze document text/profile at submission; later UI edits cannot mutate an active queue.
    const frozen=documents.map(d=>({...d})), selected={...profile,profile:{...profile.profile}};
    const lifecycle={...latest.current};
    const task=(async()=>{
      let acquired=false, failure:string|undefined;
      try {
        await lifecycle.acquire(); acquired=true;
        for(let index=0;index<frozen.length&&!cancelled.current;index++) {
          const document=frozen[index];update({status:'running',name:document.name,completed:index,positions:0,expected:0});
          const game=await parseSgfSummary(document.sgfText);
          if(cancelled.current)break;
          const frames=await runResearchBatch(selected.profile,document.sgfText,visits,{
            onJob:id=>{job.current=id;},onProgress:(positions,expected)=>update({positions,expected}),isCancelled:()=>cancelled.current,
          });
          job.current=null;
          if(!frames||cancelled.current)break;
          const result:ResearchResult={document,frames,profileId:selected.id,completedAt:new Date().toISOString()};
          // Never reuse currentCacheKey: every queued document computes its own content identity.
          // Keep completed results exportable even if the disk/cache operation subsequently fails.
          if(mounted.current)setResults(old=>[...old,result]);
          const key=await computeGameCacheKey(document.sgfText);
          await saveAnalysisCache({gameKey:key.gameKey,sgfHash:key.sgfHash,profileId:selected.id,engineKind:'katago',source:'katago',moveCount:game.summary.move_count,analyzedMoveCount:new Set(frames.map(f=>f.turn)).size,payload:{frames,problems:[]} as unknown as JsonValue});
          if(applyCurrent&&mounted.current&&!cancelled.current)await latest.current.onCurrentResult?.(result);
          update({completed:index+1});
        }
      } catch(error){failure=error instanceof Error?error.message:'研究队列失败';}
      finally {
        job.current=null;
        // runResearchBatch resolves only after process-exit confirmation, including cancellation.
        if(acquired&&mounted.current){update({status:'restoring'});try{await lifecycle.release();}catch{failure='分析已结束，但前景引擎恢复失败，请手动连接。';}}
        busyRef.current=false;update({status:failure?'error':cancelled.current?'idle':'complete',error:failure});
      }
    })();running.current=task;
    try{await task;}finally{running.current=null;}
  }
  async function cancel() {
    cancelled.current=true;if(!busyRef.current)return;update({status:'cancelling'});
    if(job.current) {try{await cancelKataGoAnalysis(job.current);}catch{update({error:'取消请求失败，等待当前引擎任务结束后恢复。'});}}
    await running.current;
  }
  return {state,results,busyRef,start,cancel};
}
export type ResearchQueueController=ReturnType<typeof useResearchQueue>;
