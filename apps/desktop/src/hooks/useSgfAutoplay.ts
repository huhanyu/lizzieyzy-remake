import {useEffect,useRef,useState} from 'react';
import type {SgfTreeDto} from '../domain/types';
export function useSgfAutoplay(input:{tree:SgfTreeDto|null;nodeId:string|null;documentKey:string;disabled:boolean;onSelect:(id:string)=>Promise<void>}) {
  const [playing,setPlaying]=useState(false),[seconds,setSeconds]=useState(1);
  const latest=useRef(input);latest.current=input;
  const expected=useRef<string|null>(input.nodeId);
  const epoch=useRef(0);
  useEffect(()=>{epoch.current++;setPlaying(false);},[input.documentKey,input.disabled]);
  useEffect(()=>{if(playing && input.nodeId!==expected.current){epoch.current++;setPlaying(false);}},[input.nodeId,playing]);
  useEffect(()=>{
    if(!playing || input.disabled)return;
    const token=++epoch.current;let timer:ReturnType<typeof setTimeout>;
    async function tick(){
      if(token!==epoch.current)return;
      const {tree,nodeId,onSelect}=latest.current;
      const node=tree?.nodes.find(n=>n.id===nodeId),next=node?.child_ids[0];
      if(!next){setPlaying(false);return;}
      expected.current=next;
      try{await onSelect(next);}catch{setPlaying(false);return;}
      if(token===epoch.current)timer=setTimeout(()=>void tick(),seconds*1000);
    }
    timer=setTimeout(()=>void tick(),seconds*1000);
    return()=>{epoch.current++;clearTimeout(timer);};
  },[playing,seconds,input.disabled]);
  return {playing,seconds,setSeconds,toggle:()=>{expected.current=latest.current.nodeId;setPlaying(p=>!p);},stop:()=>{epoch.current++;setPlaying(false);}};
}
