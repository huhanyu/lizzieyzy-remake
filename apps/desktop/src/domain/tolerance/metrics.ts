import type { Distribution, Report, ReviewEvent } from './types.ts';
export function lossSummary(d:Distribution,metric:'score'|'win',safe:number,bad:number){
  const get=(c:Distribution['candidates'][number])=>metric==='score'?c.scoreLoss:c.winLossPp;
  let good=0,tail=0,expected=0,known=0;
  for(const c of d.candidates){const loss=get(c);if(loss===null)continue;known+=c.probability;if(loss<=safe)good+=c.probability;if(loss>=bad)tail+=c.probability;expected+=c.probability*loss;}
  return {good,tail,expected,unknown:Math.max(0,1-known)};
}
export function mergeEvent(report:Report,event:ReviewEvent):Report{
  if(report.jobId!==event.jobId||report.documentHash!==event.documentHash)return report;
  const {position,branch,...progress}=event;
  const positions=position ? [...report.positions.filter(p=>p.input.nodeId!==position.input.nodeId),position].sort((a,b)=>a.input.turn-b.input.turn) : report.positions;
  const branches=branch ? [...report.branches.filter(b=>b.rootMove!==branch.rootMove||b.opponentReply!==branch.opponentReply),branch] : report.branches;
  return {...report,...progress,positions,branches};
}
export function terminal(status:string){return ['complete','failed','cancelled','interrupted'].includes(status);}
export async function documentHash(text:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
