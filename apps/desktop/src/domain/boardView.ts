import type { AnalysisFrameDto, MoveVertex, PointDto, PositionDto, SgfTreeDto } from './types';
export type BoardOrientation = { turns: number; mirror: boolean };
export type NumberMode = 'off' | 'all' | 'last' | 'recent';
export function transformPoint(point: PointDto, size: number, view: BoardOrientation, inverse = false): PointDto {
  let {x,y} = point;
  const turns = ((view.turns % 4) + 4) % 4;
  if (!inverse && view.mirror) x = size - 1 - x;
  for (let i=0; i<(inverse ? (4-turns)%4 : turns); i++) [x,y] = [size-1-y,x];
  if (inverse && view.mirror) x = size-1-x;
  return {x,y};
}
export function transformVertex(vertex: MoveVertex, size: number, view: BoardOrientation): MoveVertex {
  return vertex === 'pass' ? vertex : {point:transformPoint(vertex.point,size,view)};
}
export function transformPosition(position: PositionDto, view: BoardOrientation): PositionDto {
  return {...position, stones:position.stones.map(s=>({...s,...transformPoint(s,position.board_size,view)})),last_move:position.last_move ? {...position.last_move,vertex:transformVertex(position.last_move.vertex,position.board_size,view)} : null};
}
export function transformAnalysis(frame: AnalysisFrameDto | undefined, size: number, view: BoardOrientation): AnalysisFrameDto | undefined {
  if (!frame) return;
  const grid = (values: number[] | null | undefined) => {
    if (!values || values.length < size*size) return values;
    const result = [...values];
    for (let y=0;y<size;y++) for(let x=0;x<size;x++) { const p=transformPoint({x,y},size,view); result[p.y*size+p.x]=values[y*size+x]; }
    return result;
  };
  return {...frame,ownership:grid(frame.ownership),policy:grid(frame.policy),candidates:frame.candidates.map(c=>({...c,vertex:transformVertex(c.vertex,size,view),pv:c.pv.map(v=>transformVertex(v,size,view))}))};
}
/** The latest ancestor at an occupied coordinate is the surviving move; setup edits reset that provenance. */
export function stoneMoveNodes(tree: SgfTreeDto | null | undefined, nodeId: string | null | undefined, position: PositionDto): Map<string,{nodeId:string;number:number}> {
  const result = new Map<string,{nodeId:string;number:number}>();
  if (!tree || !nodeId) return result;
  const nodes=new Map(tree.nodes.map(n=>[n.id,n])), seen=new Set<string>();
  const remaining=new Map(position.stones.map(s=>[`${s.x}:${s.y}`,s.color]));
  let node=nodes.get(nodeId);
  while(node && !seen.has(node.id)) {
    seen.add(node.id);
    if(node.vertex && node.vertex!=='pass') {
      const key=`${node.vertex.point.x}:${node.vertex.point.y}`;
      if(remaining.get(key)===node.color && node.move_number!=null) result.set(key,{nodeId:node.id,number:node.move_number});
      remaining.delete(key);
    }
    for(const prop of node.properties) if(['AB','AW','AE'].includes(prop.key)) for(const value of prop.values) {
      const [a,b=a]=value.split(':');
      if(a.length!==2 || b.length!==2) continue;
      for(let x=a.charCodeAt(0)-97;x<=b.charCodeAt(0)-97;x++) for(let y=a.charCodeAt(1)-97;y<=b.charCodeAt(1)-97;y++) remaining.delete(`${x}:${y}`);
    }
    node=node.parent_id ? nodes.get(node.parent_id) : undefined;
  }
  return result;
}
export function visibleMoveNumbers(provenance: Map<string,{number:number}>, current: number, mode: NumberMode, recent: number): Map<string,number> {
  return new Map([...provenance].filter(([,v])=>mode==='all'||mode==='last'&&v.number===current||mode==='recent'&&v.number>current-Math.max(1,recent)).map(([key,v])=>[key,v.number]));
}
