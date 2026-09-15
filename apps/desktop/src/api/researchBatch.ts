import { cancelKataGoAnalysis, startKataGoGameAnalysis } from './backend';
import { listenToResearchEvents } from './researchEvents';
import type { AnalysisFrameDto, EngineProfileDto } from '../domain/types';
type Terminal = { job_id: string; frames?: AnalysisFrameDto[]; message?: string; cancelled?: boolean };
/** Listener is installed before allocation; early terminal responses are keyed by the actual job. */
export async function runResearchBatch(profile: EngineProfileDto, sgfText: string, visits: number, callbacks: {
  onJob: (jobId:string)=>void; onProgress: (completed:number,total:number)=>void; isCancelled: ()=>boolean;
}, transport = {start: startKataGoGameAnalysis, cancel: cancelKataGoAnalysis}): Promise<AnalysisFrameDto[] | null> {
  let job: string | null = null;
  const early = new Map<string, Terminal>();
  let resolve!: (value: AnalysisFrameDto[] | null)=>void, reject!: (reason: Error)=>void;
  const terminal = new Promise<AnalysisFrameDto[] | null>((yes,no)=>{resolve=yes;reject=no;});
  void terminal.catch(() => {}); // a terminal failure may arrive before the start IPC resolves
  const receive = (event: Terminal) => {
    if (!job) { early.set(event.job_id,event); if(early.size>64)early.delete(early.keys().next().value!); return; }
    if (event.job_id !== job) return;
    if (event.cancelled) resolve(null);
    else if (event.frames) resolve(event.frames);
    else reject(new Error(event.message || '批量分析失败'));
  };
  const unlisten = await listenToResearchEvents({
    onProgress: event => {if(event.job_id===job)callbacks.onProgress(event.completed,event.expected);},
    onComplete: receive, onError: receive, onCancelled: event=>receive({...event,cancelled:true}),
  });
  try {
    job = await transport.start({...profile,backend:'kata_go_analysis'},sgfText,visits);
    callbacks.onJob(job);
    const buffered=early.get(job); early.clear(); if(buffered)receive(buffered);
    if (callbacks.isCancelled()) await transport.cancel(job).catch(() => undefined);
    // Cancellation does not release the GPU slot until the backend terminal event confirms it.
    return await terminal;
  } finally { unlisten(); }
}
