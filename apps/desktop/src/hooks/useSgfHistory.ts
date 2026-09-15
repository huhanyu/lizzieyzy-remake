import {useEffect,useRef,useState} from 'react';
import {DocumentHistory,type DocumentSnapshot} from '../domain/documentHistory';
type Input=DocumentSnapshot&{documentId:string;initiallySaved?:boolean;onRestore:(snapshot:DocumentSnapshot)=>Promise<void>};
export function useSgfHistory(input:Input){
  const owner=useRef(input.documentId),history=useRef(new DocumentHistory(input,input.initiallySaved));
  const restoring=useRef(false),latest=useRef(input);latest.current=input;
  const [,refresh]=useState(0);
  useEffect(()=>{
    if(owner.current!==input.documentId){owner.current=input.documentId;history.current=new DocumentHistory(input,input.initiallySaved);refresh(n=>n+1);return;}
    if(!restoring.current){history.current.observe(input);refresh(n=>n+1);}
  },[input.sgfText,input.nodeId,input.documentId,input.initiallySaved]);
  async function move(direction:-1|1){
    if(restoring.current)return;
    // Include a just-committed edit before React's passive observe effect runs.
    history.current.observe(latest.current);
    const target=history.current.peek(direction),documentId=latest.current.documentId;
    if(!target)return;restoring.current=true;
    try{await latest.current.onRestore(target);if(documentId===latest.current.documentId)history.current.move(direction);}
    finally{restoring.current=false;refresh(n=>n+1);}
  }
  return {canUndo:history.current.canUndo,canRedo:history.current.canRedo,dirty:history.current.dirty,
    undo:()=>move(-1),redo:()=>move(1),markSaved:(text?:string)=>{history.current.markSaved(text);refresh(n=>n+1);}};
}
