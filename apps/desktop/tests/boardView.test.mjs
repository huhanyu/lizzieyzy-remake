import test from 'node:test';
import assert from 'node:assert/strict';
import {transformPoint,transformPosition,transformAnalysis,stoneMoveNodes,visibleMoveNumbers} from '../src/domain/boardView.ts';
const views=Array.from({length:8},(_,i)=>({turns:i%4,mirror:i>=4}));
test('all eight orientations map every point bijectively and inverse restores original',()=>{
 for(const size of [9,13,19])for(const view of views){
   const seen=new Set();
   for(let y=0;y<size;y++)for(let x=0;x<size;x++){
     const point={x,y},mapped=transformPoint(point,size,view);
     assert.deepEqual(transformPoint(mapped,size,view,true),point);
     assert.ok(mapped.x>=0&&mapped.x<size&&mapped.y>=0&&mapped.y<size);
     seen.add(`${mapped.x}:${mapped.y}`);
   }
   assert.equal(seen.size,size*size);
 }
});
test('ownership and policy transform with stones, preserve policy pass tail and source arrays',()=>{
 const size=9,ownership=Array.from({length:size*size},(_,i)=>i),policy=[...ownership,0.12345];
 const frame={visits:123,winrate_black:.65,score_mean_black:3,candidates:[],ownership,policy};
 for(const view of views){
   const result=transformAnalysis(frame,size,view);
   for(let y=0;y<size;y++)for(let x=0;x<size;x++){
     const p=transformPoint({x,y},size,view);
     assert.equal(result.ownership[p.y*size+p.x],y*size+x);
     assert.equal(result.policy[p.y*size+p.x],y*size+x);
   }
   assert.equal(result.policy.at(-1),.12345);assert.equal(result.visits,123);assert.equal(result.winrate_black,.65);
 }
 assert.deepEqual(ownership,Array.from({length:81},(_,i)=>i));assert.equal(policy[81],.12345);
});
test('PV, candidate and last move use same orientation including pass',()=>{
 const source={x:2,y:5},position={board_size:9,stones:[{...source,color:'black'}],last_move:{vertex:{point:source},color:'black',move_number:3},to_play:'white'};
 const frame={candidates:[{vertex:{point:source},pv:[{point:source},'pass',{point:{x:0,y:1}}]}],ownership:null};
 for(const view of views){
   const pos=transformPosition(position,view),f=transformAnalysis(frame,9,view);
   assert.deepEqual(pos.last_move.vertex,f.candidates[0].vertex);
   assert.deepEqual(f.candidates[0].pv[0],pos.last_move.vertex);
   assert.equal(f.candidates[0].pv[1],'pass');
   assert.deepEqual({x:pos.stones[0].x,y:pos.stones[0].y},pos.last_move.vertex.point);
 }
 assert.equal(transformAnalysis(undefined,9,views[0]),undefined);
});
const node=(id,parent_id,number,color,point,properties=[])=>({id,parent_id,move_number:number,color,vertex:point?{point}:null,properties});
test('stone numbering uses latest surviving placement after capture/reoccupation, excludes siblings and removed stones',()=>{
 const tree={root_id:'r',nodes:[node('r',null,0,null,null),node('a','r',1,'black',{x:0,y:0}),node('b','a',2,'white',{x:1,y:0}),node('c','b',3,'white',{x:0,y:0}),node('other','b',3,'black',{x:0,y:0})]};
 const result=stoneMoveNodes(tree,'c',{stones:[{x:0,y:0,color:'white'},{x:1,y:0,color:'white'}]});
 assert.deepEqual(result.get('0:0'),{nodeId:'c',number:3});assert.deepEqual(result.get('1:0'),{nodeId:'b',number:2});assert.equal(result.size,2);
 assert.equal(stoneMoveNodes(tree,'b',{stones:[{x:1,y:0,color:'white'}]}).has('0:0'),false);
});
test('setup ranges reset provenance but a later real move receives a number',()=>{
 const tree={root_id:'r',nodes:[node('r',null,0,null,null),node('a','r',1,'black',{x:0,y:0}),node('setup','a',1,null,null,[{key:'AB',values:['aa:cc']}]),node('b','setup',2,'white',{x:3,y:3})]};
 const result=stoneMoveNodes(tree,'b',{stones:[{x:0,y:0,color:'black'},{x:1,y:1,color:'black'},{x:3,y:3,color:'white'}]});
 assert.equal(result.has('0:0'),false);assert.equal(result.has('1:1'),false);assert.deepEqual(result.get('3:3'),{nodeId:'b',number:2});
});
test('number modes off, all, last and recent select their exact windows',()=>{
 const provenance=new Map([['a',{number:1}],['b',{number:8}],['c',{number:9}],['d',{number:10}]]);
 assert.deepEqual([...visibleMoveNumbers(provenance,10,'off',3)],[]);
 assert.equal(visibleMoveNumbers(provenance,10,'all',3).size,4);
 assert.deepEqual([...visibleMoveNumbers(provenance,10,'last',3)],[['d',10]]);
 assert.deepEqual([...visibleMoveNumbers(provenance,10,'recent',3)],[['b',8],['c',9],['d',10]]);
 assert.deepEqual([...visibleMoveNumbers(provenance,10,'recent',0)],[['d',10]]);
 assert.equal(visibleMoveNumbers(provenance,11,'last',3).size,0); // last move was a pass
});
