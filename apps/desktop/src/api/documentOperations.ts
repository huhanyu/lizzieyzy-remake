import {invoke} from '@tauri-apps/api/core';
import {isTauriRuntime,replaySgfPositionAtNode,editSgfMove,updateSgfNodeProperties} from './backend';
import {pointToSgf,serializeTree,expandSetupPoints,findStonePlacement,insertMove,swapColors,type GameInfo,infoProperties} from '../domain/documentEditing';
import type {PlayerColor,PointDto,SgfTreeDto} from '../domain/types';
export type BoardEditTool='play'|'insert'|'setup-black'|'setup-white'|'setup-erase';
function requireDesktop(){if(!isTauriRuntime())throw new Error('棋谱编辑请在桌面应用操作；浏览器简化棋谱不能安全保留完整分支。');}
/** Replay every changed node through the authoritative rules engine before committing any edit. */
export async function validateEditedSgf(sgfText:string):Promise<string>{
  requireDesktop();
  await invoke<void>('validate_sgf_tree_legality',{sgfText});
  return sgfText;
}
export async function editGameInformation(sgfText:string,tree:SgfTreeDto,info:GameInfo):Promise<string>{
  requireDesktop();
  // Existing games keep board size, handicap and setup unchanged; new game owns these controls.
  const updates=infoProperties(info).filter(p=>p.key!=='SZ');
  return (await updateSgfNodeProperties(sgfText,tree.root_id,updates)).sgf_text;
}
export async function exchangeColors(tree:SgfTreeDto):Promise<string>{requireDesktop();return validateEditedSgf(swapColors(tree));}
export async function applyBoardEdit(sgfText:string,tree:SgfTreeDto,nodeId:string,tool:BoardEditTool,point:PointDto,color:PlayerColor,size:number):Promise<string>{
  requireDesktop();
  if(tool==='insert')return validateEditedSgf(insertMove(tree,nodeId,color,point,size));
  if(tool==='play')throw new Error('普通落子应使用已有追加棋步接口');
  const root=tree.nodes.find(n=>n.id===tree.root_id);if(!root)throw new Error('缺少根节点');
  if(nodeId!==tree.root_id)throw new Error('请先回到根节点再编辑初始摆子；或使用“当前局面另建棋谱”。');
  const coordinate=pointToSgf(point,size);
  const values=(key:string)=>expandSetupPoints(root.properties.filter(p=>p.key===key).flatMap(p=>p.values),size).filter(v=>v!==coordinate);
  const black=values('AB'),white=values('AW');
  if(tool==='setup-black')black.push(coordinate);if(tool==='setup-white')white.push(coordinate);
  const result=await updateSgfNodeProperties(sgfText,tree.root_id,[{key:'AB',values:black},{key:'AW',values:white},{key:'HA',values:[]}]);
  return validateEditedSgf(result.sgf_text);
}
export async function copySgf(sgfText:string):Promise<void>{
  if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(sgfText);return;}
  const input=document.createElement('textarea');input.value=sgfText;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();
  try{if(!document.execCommand('copy'))throw new Error('复制不可用，请在棋谱源码中复制。');}finally{input.remove();}
}
export async function readClipboardSgf():Promise<string>{
  if(!navigator.clipboard?.readText)throw new Error('此环境无法直接读取剪贴板，请在下方粘贴框使用 ⌘V。');
  const text=await navigator.clipboard.readText();if(!text.trim())throw new Error('剪贴板为空');return text;
}

/** Move the most recent surviving placement on the selected ancestry, not a same-coordinate old capture. */
export async function dragStone(sgfText:string,tree:SgfTreeDto,nodeId:string,from:PointDto,to:PointDto,size:number):Promise<string>{
  requireDesktop();
  const source=pointToSgf(from,size),destination=pointToSgf(to,size);
  if(source===destination)return sgfText;
  const position=await replaySgfPositionAtNode(sgfText,nodeId);
  if(!position.stones.some(s=>s.x===from.x&&s.y===from.y))throw new Error('起点没有棋子，可能已被提走');
  if(position.stones.some(s=>s.x===to.x&&s.y===to.y))throw new Error('目标位置已有棋子');
  const placement=findStonePlacement(tree,nodeId,source,size);
  if(!placement)throw new Error('所选局面没有可拖动的棋子');
  if(placement.kind==='move'){
    if(placement.nodeId===tree.root_id){
      const key=placement.color==='black'?'B':'W';
      return validateEditedSgf(serializeTree({...tree,nodes:tree.nodes.map(n=>n.id===placement.nodeId?{...n,properties:n.properties.map(p=>p.key===key?{...p,values:[destination]}:p)}:n)}));
    }
    const result=await editSgfMove(sgfText,placement.nodeId,placement.color,{point:to});
    return validateEditedSgf(result.sgf_text);
  }
  const node=tree.nodes.find(n=>n.id===placement.nodeId)!;
  const key=placement.color==='black'?'AB':'AW';
  const values=expandSetupPoints(node.properties.filter(p=>p.key===key).flatMap(p=>p.values),size).map(value=>value===source?destination:value);
  const opposite=placement.color==='black'?'AW':'AB';
  if(expandSetupPoints(node.properties.filter(p=>p.key===opposite).flatMap(p=>p.values),size).includes(destination))throw new Error('目标位置已有棋子');
  const result=await updateSgfNodeProperties(sgfText,placement.nodeId,[{key,values:[...new Set(values)]},{key:'HA',values:[]}]);
  return validateEditedSgf(result.sgf_text);
}
