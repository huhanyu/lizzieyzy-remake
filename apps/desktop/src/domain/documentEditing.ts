import type { PlayerColor, PointDto, PositionDto, SgfPropertyDto, SgfTreeDto, SgfTreeNodeDto } from './types';

export type GameInfo = { size: number; handicap: number; komi: number; rules: string; black: string; white: string; event: string; date: string; result: string };
export const DEFAULT_GAME_INFO: GameInfo = { size:19, handicap:0, komi:7.5, rules:'chinese', black:'', white:'', event:'', date:'', result:'' };
const escapeValue = (value: string) => value.replace(/\\/g,'\\\\').replace(/\]/g,'\\]');
const propertyText = (properties: readonly SgfPropertyDto[]) => properties.map(p => {
  if (!/^[A-Z]+$/.test(p.key) || !p.values.length) throw new Error('棋谱属性无效');
  return p.key + p.values.map(value => `[${escapeValue(value)}]`).join('');
}).join('');
const prop = (key: string, value: string | number): SgfPropertyDto => ({key,values:[String(value)]});
export function pointToSgf(point: PointDto, size: number): string {
  if (![point.x,point.y].every(Number.isInteger) || point.x < 0 || point.y < 0 || point.x >= size || point.y >= size) throw new Error('落点超出棋盘');
  return String.fromCharCode(97+point.x,97+point.y);
}
/** Expand SGF compressed point lists before a single-point setup edit. */
export function expandSetupPoints(values: readonly string[], size: number): string[] {
  const points=new Set<string>();
  const parse=(value:string):PointDto=>{
    if(!/^[a-z]{2}$/.test(value))throw new Error('初始摆子坐标无效');
    const point={x:value.charCodeAt(0)-97,y:value.charCodeAt(1)-97};pointToSgf(point,size);return point;
  };
  for(const value of values){
    const parts=value.split(':');if(parts.length>2)throw new Error('初始摆子范围无效');
    const first=parse(parts[0]),last=parts.length===2?parse(parts[1]):first;
    if(first.x>last.x||first.y>last.y)throw new Error('初始摆子范围顺序无效');
    for(let x=first.x;x<=last.x;x++)for(let y=first.y;y<=last.y;y++)points.add(pointToSgf({x,y},size));
  }
  return [...points];
}
export function handicapPoints(size: number, count: number): PointDto[] {
  if (!Number.isInteger(count) || count < 0 || count > 9 || count === 1) throw new Error('让子支持 0 或 2–9 子');
  if (!count) return [];
  if (size < 9 || size % 2 === 0) throw new Error('固定让子需要至少 9 路的奇数棋盘');
  const low=size >= 13 ? 3 : 2, high=size-1-low, mid=(size-1)/2;
  const corners=[{x:high,y:low},{x:low,y:high},{x:high,y:high},{x:low,y:low}];
  if(count<=4)return corners.slice(0,count);
  const edges=[{x:low,y:mid},{x:high,y:mid},{x:mid,y:low},{x:mid,y:high}];
  return [...corners,...edges.slice(0,count===5?0:count<=7?2:4),...(count%2?[{x:mid,y:mid}]:[])];
}
export function infoProperties(info: GameInfo): SgfPropertyDto[] {
  if (!Number.isInteger(info.size) || info.size < 2 || info.size > 25 || !Number.isFinite(info.komi)) throw new Error('棋盘大小需为 2–25，贴目需为有限数字');
  return [prop('SZ',info.size),prop('KM',info.komi),prop('RU',info.rules),prop('PB',info.black),prop('PW',info.white),prop('EV',info.event),prop('DT',info.date),prop('RE',info.result)];
}
export function newGameSgf(info: GameInfo): string {
  const points=handicapPoints(info.size,info.handicap);
  const properties=[prop('GM',1),prop('FF',4),prop('CA','UTF-8'),...infoProperties(info)];
  if(points.length)properties.push(prop('HA',points.length),{key:'AB',values:points.map(p=>pointToSgf(p,info.size))},prop('PL','W'));
  return `(;${propertyText(properties)})`;
}
/** Serializes the complete authoritative tree, retaining unknown properties and all variations. */
export function serializeTree(tree: SgfTreeDto): string {
  const nodes=new Map(tree.nodes.map(n=>[n.id,n])), seen=new Set<string>();
  const chunks:string[]=[];
  const stack:({id:string}|{text:string})[]=[{text:')'},{id:tree.root_id},{text:'('}];
  while(stack.length){
    const work=stack.pop()!;
    if('text' in work){chunks.push(work.text);continue;}
    const node=nodes.get(work.id);
    if(!node || seen.has(node.id))throw new Error('棋谱树缺失节点或存在循环');
    seen.add(node.id); chunks.push(';'+propertyText(node.properties));
    for(const child of node.child_ids)if(nodes.get(child)?.parent_id!==node.id)throw new Error('棋谱分支父子关系错误');
    if(node.child_ids.length===1)stack.push({id:node.child_ids[0]});
    else for(let i=node.child_ids.length-1;i>=0;i--)stack.push({text:')'},{id:node.child_ids[i]},{text:'('});
  }
  if(seen.size!==tree.nodes.length)throw new Error('棋谱含未连接分支，拒绝丢弃');
  return chunks.join('');
}
export function replaceRootProperties(tree: SgfTreeDto, updates: readonly SgfPropertyDto[]): string {
  const keys=new Set(updates.map(p=>p.key));
  return serializeTree({...tree,nodes:tree.nodes.map(n=>n.id!==tree.root_id?n:{...n,properties:[...n.properties.filter(p=>!keys.has(p.key)),...updates.filter(p=>p.values.length)]})});
}
export function flattenPosition(position: PositionDto, info: GameInfo): string {
  if(position.errors.length)throw new Error(position.errors.join('；'));
  const tree:SgfTreeDto={root_id:'r',nodes:[{id:'r',child_ids:[],variation_index:0,depth:0,is_mainline:true,properties:[prop('GM',1),prop('FF',4),prop('CA','UTF-8'),...infoProperties({...info,size:position.board_size}),prop('PL',position.to_play==='black'?'B':'W'),...(['black','white'] as const).flatMap(color=>{
    const points=position.stones.filter(s=>s.color===color).map(s=>pointToSgf(s,position.board_size));return points.length?[{key:color==='black'?'AB':'AW',values:points}]:[];
  })]}]};
  return serializeTree(tree);
}
export function insertMove(tree: SgfTreeDto, beforeNodeId: string, color: PlayerColor, vertex: PointDto | 'pass', size: number): string {
  const target=tree.nodes.find(n=>n.id===beforeNodeId);
  if(!target || !target.properties.some(p=>p.key==='B'||p.key==='W'))throw new Error('请选择一手已有棋步，在其之前插入');
  let id='inserted';while(tree.nodes.some(n=>n.id===id))id+='-';
  const inserted:SgfTreeNodeDto={...target,id,child_ids:[target.id],properties:[prop(color==='black'?'B':'W',vertex==='pass'?'':pointToSgf(vertex,size))]};
  if(!target.parent_id){
    // SGF permits the first move in the root. Split root metadata/setup from that move first.
    let rootId=id+'-root';while(tree.nodes.some(n=>n.id===rootId))rootId+='-';
    const rootKeys=new Set(['GM','FF','CA','AP','ST','SZ','KM','RU','HA','PB','PW','BR','WR','BT','WT','EV','DT','RE','GN','RO','PC','TM','OT','SO','US','CP','AN','AB','AW','AE','PL']);
    const newRoot:SgfTreeNodeDto={...target,id:rootId,parent_id:null,child_ids:[id],properties:target.properties.filter(p=>rootKeys.has(p.key))};
    return serializeTree({root_id:rootId,nodes:[newRoot,{...inserted,parent_id:rootId},...tree.nodes.map(n=>n.id===target.id?{...n,parent_id:id,properties:n.properties.filter(p=>!rootKeys.has(p.key))}:n)]});
  }

  return serializeTree({...tree,nodes:[...tree.nodes.map(n=>n.id===target.id?{...n,parent_id:id}:n.id===target.parent_id?{...n,child_ids:n.child_ids.map(child=>child===target.id?id:child)}:n),inserted]});
}
export function swapColors(tree: SgfTreeDto): string {
  const swaps:Record<string,string>={B:'W',W:'B',AB:'AW',AW:'AB',PB:'PW',PW:'PB',BR:'WR',WR:'BR',BT:'WT',WT:'BT',BL:'WL',WL:'BL',OB:'OW',OW:'OB',TB:'TW',TW:'TB'};
  return serializeTree({...tree,nodes:tree.nodes.map(n=>({...n,properties:n.properties.filter(p=>p.key!=='HA').map(p=>{
    if(p.key==='PL')return {...p,values:p.values.map(v=>v==='B'?'W':v==='W'?'B':v)};
    if(p.key==='RE')return {...p,values:p.values.map(v=>v.replace(/^[BW](?=\+)/,c=>c==='B'?'W':'B'))};
    if(p.key==='KM')return {...p,values:p.values.map(v=>Number.isFinite(Number(v))?String(-Number(v)):v)};
    return {...p,key:swaps[p.key]??p.key};
  })}))});
}
export function gameInfoFromTree(tree:SgfTreeDto): GameInfo {
  const props=tree.nodes.find(n=>n.id===tree.root_id)?.properties??[];
  const value=(key:string)=>props.find(p=>p.key===key)?.values[0]??'';
  return {size:Number(value('SZ'))||19,komi:value('KM')?Number(value('KM')):7.5,handicap:Number(value('HA'))||0,rules:value('RU')||'chinese',black:value('PB'),white:value('PW'),event:value('EV'),date:value('DT'),result:value('RE')};
}

export function findStonePlacement(tree:SgfTreeDto,nodeId:string,coordinate:string,size:number):{nodeId:string;color:PlayerColor;kind:'move'|'setup'}|null{
  const nodes=new Map(tree.nodes.map(n=>[n.id,n])),seen=new Set<string>();
  let node=nodes.get(nodeId);
  while(node){
    if(seen.has(node.id))throw new Error('棋谱分支存在循环');seen.add(node.id);
    for(const [key,color] of [['B','black'],['W','white']] as const)if(node.properties.some(p=>p.key===key&&p.values.includes(coordinate)))return {nodeId:node.id,color,kind:'move'};
    if(expandSetupPoints(node.properties.filter(p=>p.key==='AE').flatMap(p=>p.values),size).includes(coordinate))return null;
    for(const [key,color] of [['AB','black'],['AW','white']] as const)if(expandSetupPoints(node.properties.filter(p=>p.key===key).flatMap(p=>p.values),size).includes(coordinate))return {nodeId:node.id,color,kind:'setup'};
    node=node.parent_id?nodes.get(node.parent_id):undefined;
  }
  return null;
}
