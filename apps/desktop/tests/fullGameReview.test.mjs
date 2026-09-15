import test from 'node:test';
import assert from 'node:assert/strict';
import {planFullGameReview,ScanFrameGate,analyzedVisits} from '../src/domain/fullGameReview.ts';
const tree={root_id:'r',nodes:[{id:'r',child_ids:['a']},{id:'a',parent_id:'r',move_number:1,child_ids:['b','v']},{id:'b',parent_id:'a',move_number:2,child_ids:[]},{id:'v',parent_id:'a',move_number:2,child_ids:[]}]};
test('range includes parent baseline, only mainline and coarse before deep',()=>{
 const plan=planFullGameReview(tree,{from:2,to:2,visits:100,coarseFirst:true});
 assert.deepEqual(plan.map(t=>[t.nodeId,t.visits]),[['a',32],['b',32],['a',100],['b',100]]);
});
test('frame before ACK replays only acknowledged generation and exact job/turn',()=>{
 let accepted=[],done=0;
 const gate=new ScanFrameGate('j',{turn:2,visits:100},f=>accepted.push(f),()=>done++);
 const payload=(generation,job='j',turn=2)=>({job_id:job,generation,turn,frame:{turn,visits:100}});
 gate.consume(payload(1));gate.consume(payload(2,'other'));gate.consume(payload(2,'j',1));gate.consume(payload(2));
 assert.equal(accepted.length,0);gate.acknowledge(2);assert.equal(accepted.length,1);assert.equal(done,1);
 gate.consume(payload(2));assert.equal(done,1);
});
test('closed gate ignores queued ACK',()=>{
 let count=0;const gate=new ScanFrameGate('j',{turn:2,visits:100},()=>count++,()=>count++);
 gate.consume({job_id:'j',generation:1,turn:2,frame:{turn:2,visits:100}});gate.close();gate.acknowledge(1);assert.equal(count,0);
});
test('coverage excludes other document and unbound frames',()=>{
 assert.equal(analyzedVisits([{node_id:JSON.stringify(['doc','a']),visits:20},{node_id:JSON.stringify(['other','a']),visits:200},{turn:1,visits:300}],'doc').get('a'),20);
});
test('invalid or endless range and budgets rejected',()=>{
 for(const options of [{from:0,to:Infinity,visits:32},{from:0,to:2,visits:NaN},{from:3,to:2,visits:100},{from:0,to:2,visits:0}]) assert.throws(()=>planFullGameReview(tree,options));
});
test('all-branch scope preserves distinct sibling node identities at the same move number',()=>{
 const plan=planFullGameReview(tree,{from:1,to:2,visits:32,coarseFirst:false,allBranches:true});
 assert.deepEqual(plan.map(t=>t.nodeId),['r','a','b','v']);
 assert.equal(plan.filter(t=>t.turn===2).length,2);
});
