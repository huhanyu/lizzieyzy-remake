export type DocumentSnapshot = {sgfText:string; nodeId:string|null};
/** One history per opened document; navigation updates selection without adding undo entries. */
export class DocumentHistory {
  private entries:DocumentSnapshot[];
  private index=0;
  private saved:string|null;
  constructor(initial:DocumentSnapshot,saved=true){this.entries=[initial];this.saved=saved?initial.sgfText:null;}
  get current(){return this.entries[this.index];}
  get canUndo(){return this.index>0;}
  get canRedo(){return this.index<this.entries.length-1;}
  get dirty(){return this.current.sgfText!==this.saved;}
  observe(snapshot:DocumentSnapshot){
    if(snapshot.sgfText===this.current.sgfText){this.entries[this.index]=snapshot;return;}
    this.entries.splice(this.index+1);this.entries.push(snapshot);this.index++;
    let bytes=this.entries.reduce((sum,e)=>sum+e.sgfText.length*2,0);
    while(this.entries.length>1&&(this.entries.length>100||bytes>8*1024*1024)){bytes-=this.entries.shift()!.sgfText.length*2;this.index--;}
  }
  peek(direction:-1|1){return this.entries[this.index+direction]??null;}
  move(direction:-1|1){if(this.peek(direction))this.index+=direction;}
  markSaved(text=this.current.sgfText){this.saved=text;}
}
export type RecentDocument={path:string;name:string;openedAt:number};
export function addRecentDocument(list:readonly RecentDocument[],entry:RecentDocument):RecentDocument[]{
  return [entry,...list.filter(item=>item.path!==entry.path)].slice(0,12);
}
