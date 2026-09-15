import {useState} from 'react';
import {addRecentDocument,type RecentDocument} from '../domain/documentHistory';
const KEY='lizzie.recent-documents.v1';
function read():RecentDocument[]{try{const data:unknown=JSON.parse(localStorage.getItem(KEY)??'[]');return Array.isArray(data)?data.filter(e=>typeof e?.path==='string'&&typeof e?.name==='string'&&Number.isFinite(e?.openedAt)).slice(0,12):[];}catch{return [];}}
export function useRecentDocuments(){
  const [documents,setDocuments]=useState(read);
  const update=(transform:(entries:RecentDocument[])=>RecentDocument[])=>setDocuments(previous=>{
    const entries=transform(previous);try{localStorage.setItem(KEY,JSON.stringify(entries));}catch{/* history remains available for this session */}return entries;
  });
  return {documents,remember:(path:string,name=path.split('/').at(-1)??path)=>update(entries=>addRecentDocument(entries,{path,name,openedAt:Date.now()})),remove:(path:string)=>update(entries=>entries.filter(e=>e.path!==path)),clear:()=>update(()=>[])};
}
