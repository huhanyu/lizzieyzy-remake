import {useEffect,useState} from 'react';
import {DEFAULT_GAME_INFO,flattenPosition,gameInfoFromTree,newGameSgf,type GameInfo} from '../domain/documentEditing';
import {copySgf,editGameInformation,exchangeColors,readClipboardSgf,validateEditedSgf,type BoardEditTool} from '../api/documentOperations';
import type {PositionDto,SgfTreeDto} from '../domain/types';
import type {RecentDocument} from '../domain/documentHistory';
import {SUPPORTED_GAME_RULES} from '../domain/positionMetrics';
import './DocumentTools.css';
export type DocumentCommit={sgfText:string;newDocument:boolean;nodeId?:string|null};
type Props={
  sgfText:string;tree:SgfTreeDto|null;position:PositionDto;disabled?:boolean;
  onCommit:(change:DocumentCommit)=>Promise<void>;
  boardTool:BoardEditTool;onBoardToolChange:(tool:BoardEditTool)=>void;
  canUndo:boolean;canRedo:boolean;onUndo:()=>Promise<void>;onRedo:()=>Promise<void>;
  recentDocuments:readonly RecentDocument[];onOpenRecent:(path:string)=>Promise<void>;onRemoveRecent:(path:string)=>void;
};
export function DocumentTools(props:Props){
  const [section,setSection]=useState<'new'|'info'|'tools'>('tools');
  const [info,setInfo]=useState<GameInfo>(DEFAULT_GAME_INFO),[paste,setPaste]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{if(section==='info'&&props.tree)setInfo(gameInfoFromTree(props.tree));else if(section==='new')setInfo(DEFAULT_GAME_INFO);},[section,props.tree]);
  async function run(work:()=>Promise<unknown>){if(busy)return;setBusy(true);setMessage('');try{await work();}catch(error){setMessage(error instanceof Error?error.message:String(error));}finally{setBusy(false);}}
  const commit=(sgfText:string,newDocument=false)=>props.onCommit({sgfText,newDocument});
  const field=(key:keyof GameInfo,label:string,type='text')=><label>{label}<input type={type} value={info[key]} onChange={e=>setInfo(old=>({...old,[key]:type==='number'?Number(e.target.value):e.target.value}))}/></label>;
  return <section className="document-tools" aria-label="棋谱与编辑">
    <nav aria-label="棋谱工具分类">{([['tools','棋谱操作'],['new','新建对局'],['info','对局信息']] as const).map(([id,label])=><button key={id} aria-pressed={section===id} onClick={()=>setSection(id)}>{label}</button>)}</nav>
    <fieldset disabled={busy||props.disabled}>
      {section==='new'||section==='info'?<>
        <div className="document-info-grid">
          {section==='new'&&<>{field('size','棋盘大小','number')}{field('handicap','让子（0 或 2–9）','number')}</>}
          {field('komi','贴目','number')}
          <label>规则<select value={info.rules} onChange={e=>setInfo(old=>({...old,rules:e.target.value}))}>{!SUPPORTED_GAME_RULES.some(rule=>rule.value===info.rules)&&<option value={info.rules}>{info.rules}</option>}{SUPPORTED_GAME_RULES.map(rule=><option key={rule.value} value={rule.value}>{rule.label}</option>)}</select></label>
          {field('black','黑方')}{field('white','白方')}{field('event','比赛')}{field('date','日期')}{field('result','结果（如 B+R）')}
        </div>
        <button disabled={section==='info'&&!props.tree} onClick={()=>void run(async()=>{
          if(section==='new')await commit(newGameSgf(info),true);
          else if(props.tree)await commit(await editGameInformation(props.sgfText,props.tree,info));
          setMessage(section==='new'?'已新建对局':'对局信息已更新');
        })}>{section==='new'?'创建对局':'保存对局信息'}</button>
      </>:<>
        <div className="document-actions"><button disabled={!props.canUndo} onClick={()=>void run(props.onUndo)}>撤销</button><button disabled={!props.canRedo} onClick={()=>void run(props.onRedo)}>重做</button><button onClick={()=>void run(async()=>{await copySgf(props.sgfText);setMessage('棋谱已复制');})}>复制 SGF</button><button onClick={()=>void run(async()=>setPaste(await readClipboardSgf()))}>粘贴 SGF</button></div>
        <label className="document-paste">粘贴棋谱<textarea value={paste} onChange={e=>setPaste(e.target.value)} placeholder="粘贴完整 SGF，导入后建立新棋谱"/></label>
        <button disabled={!paste.trim()} onClick={()=>void run(async()=>commit(await validateEditedSgf(paste),true))}>导入粘贴内容</button>
        <div className="document-actions" role="group" aria-label="棋盘编辑模式">{([['play','普通落子'],['insert','插入一手'],['setup-black','摆黑子'],['setup-white','摆白子'],['setup-erase','擦除摆子']] as const).map(([tool,title])=><button key={tool} aria-pressed={props.boardTool===tool} onClick={()=>props.onBoardToolChange(tool)}>{title}</button>)}</div>
        <p>插入：先选中原有一手，再点击棋盘，在它之前加入当前方棋子。摆子：回到根节点后操作；所有后续分支仍需合法。</p>
        <div className="document-actions"><button disabled={!props.tree} onClick={()=>void run(async()=>{if(props.tree)await commit(await exchangeColors(props.tree));})}>交换黑白</button><button onClick={()=>void run(async()=>commit(flattenPosition(props.position,{...(props.tree?gameInfoFromTree(props.tree):DEFAULT_GAME_INFO),result:''}),true))}>当前局面另建棋谱</button></div>
        <p>交换黑白同时交换棋手与结果、反转贴目，移除固定让子标记；原分支保留。当前局面另建棋谱只保留盘面与行棋方。</p>
        <details><summary>最近打开的棋谱（{props.recentDocuments.length}）</summary>{props.recentDocuments.length?props.recentDocuments.map(file=><div className="recent-document" key={file.path}><button title={file.path} onClick={()=>void run(()=>props.onOpenRecent(file.path))}>{file.name}</button><button aria-label={`移除最近记录 ${file.name}`} onClick={()=>props.onRemoveRecent(file.path)}>×</button></div>):<p>暂无最近文件</p>}</details>
      </>}
    </fieldset>
    {message&&<p role="status">{message}</p>}
  </section>;
}
