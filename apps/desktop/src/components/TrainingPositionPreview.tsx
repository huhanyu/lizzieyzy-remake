import { useEffect,useState } from 'react';
import { isTauriRuntime,replaySgfPositionAtNode,replaySgfPositions } from '../api/backend';
import type { PositionDto } from '../domain/types';

// No analysis overlays or future moves: preview the exact training start.
export function TrainingPositionPreview({sgfText,nodeId,turn}:{sgfText:string;nodeId:string;turn:number}){
  const [position,setPosition]=useState<PositionDto|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    let active=true;setPosition(null);setError('');
    const load=isTauriRuntime()?replaySgfPositionAtNode(sgfText,nodeId):replaySgfPositions(sgfText).then(items=>items.find(p=>p.move_number===turn)??null);
    void load.then(p=>{if(active){if(!p||p.move_number!==turn||p.errors.length)throw new Error('起点棋盘无法还原');setPosition(p);}}).catch(e=>{if(active)setError(String(e));});
    return()=>{active=false;};
  },[sgfText,nodeId,turn]);
  if(!position)return <div className="training-preview-placeholder" role="status">{error?'棋盘预览加载失败':'加载棋盘…'}</div>;
  const size=position.board_size,step=160/(size-1),xy=(n:number)=>12+n*step;
  const stars=size===19?[3,9,15]:size===13?[3,6,9]:size===9?[2,4,6]:[];
  const last=position.last_move?.vertex;
  return <svg className="training-preview" viewBox="0 0 184 184" role="img" aria-label={`第 ${turn+1} 手前训练起点，${size} 路棋盘，${position.to_play==='black'?'黑':'白'}方行棋`}>
    <rect width="184" height="184" rx="5" fill="#d9b77a"/>
    {Array.from({length:size},(_,i)=><g key={i} stroke="#664c2f" strokeWidth=".6"><line x1={12} y1={xy(i)} x2={172} y2={xy(i)}/><line x1={xy(i)} y1={12} x2={xy(i)} y2={172}/></g>)}
    {stars.flatMap(x=>stars.map(y=><circle key={`${x}:${y}`} cx={xy(x)} cy={xy(y)} r="1.5" fill="#664c2f"/>))}
    {position.stones.map(s=><circle key={`${s.x}:${s.y}`} cx={xy(s.x)} cy={xy(s.y)} r={step*.46} fill={s.color==='black'?'#222':'#fafafa'} stroke={s.color==='black'?'#111':'#888'} strokeWidth=".6"/>)}
    {last&&typeof last==='object'&&position.stones.some(s=>s.x===last.point.x&&s.y===last.point.y)&&<circle cx={xy(last.point.x)} cy={xy(last.point.y)} r={step*.15} fill="#d34c36"/>}
  </svg>;
}
