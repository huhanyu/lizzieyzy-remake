import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewMoves, summarizeMoves, filterMistakes} from '../src/domain/reviewStatistics.ts';
const point = x => ({point:{x,y:3}});
const node = (id,parent_id,color,turn,children=[]) => ({id,parent_id,color,move_number:turn,depth:turn,vertex:point(turn),child_ids:children});
const tree={root_id:'r',nodes:[{id:'r',child_ids:['b']},node('b','r','black',1,['w','v']),node('w','b','white',2),node('v','b','white',2)]};
const frame=(id,wr,score,job='j',doc='d',candidates=[])=>({node_id:JSON.stringify([doc,id]),job_id:job,visits:100,winrate_black:wr,score_mean_black:score,candidates});
const calc=frames=>reviewMoves({tree,selectedNodeId:'b',documentKey:'d',frames});
test('branch report includes continuation but never same-turn sibling; loss uses mover perspective',()=>{
 const moves=calc([frame('r',.5,0),frame('b',.4,-2),frame('w',.6,1),frame('v',0,-99)]);
 assert.deepEqual(moves.map(m=>m.nodeId),['b','w']);
 assert.equal(moves[0].scoreLoss,2);assert.equal(moves[1].scoreLoss,3);
 assert.ok(Math.abs(moves[1].winrateLoss-20)<1e-8);
 assert.deepEqual(filterMistakes(moves,'both','scoreLoss',1,'loss').map(m=>m.nodeId),['w','b']);
 assert.deepEqual(filterMistakes(moves,'black','scoreLoss',1,'turn').map(m=>m.nodeId),['b']);
});
test('different job, document and missing before/after cannot fabricate loss',()=>{
 assert.equal(calc([frame('r',.5,0),frame('b',.4,-2,'other')])[0].scoreLoss,null);
 assert.equal(calc([frame('r',.5,0),frame('b',.4,-2,'j','other')])[0].scoreLoss,null);
 assert.equal(summarizeMoves(calc([]),'black').score.value,null);
});
test('match policy changes candidate rank and visit cutoff; coverage not total is denominator',()=>{
 const candidates=[{vertex:point(9),visits:100},{vertex:point(1),visits:19}];
 const input={tree,selectedNodeId:'b',documentKey:'d',frames:[frame('r',.5,0,'j','d',candidates)]};
 assert.equal(reviewMoves(input)[0].matched,false);
 assert.equal(reviewMoves(input,{topN:2,relativeVisits:.19})[0].matched,true);
 assert.equal(reviewMoves(input,{topN:1,relativeVisits:0})[0].matched,false);
 assert.equal(summarizeMoves(reviewMoves(input),'white').match,null);
});
test('signed averages retain improvements and omit incomplete pairs',()=>{
 const moves=calc([frame('r',.5,0),frame('b',.6,2)]);
 assert.equal(summarizeMoves(moves,'black').score.value,-2);
 assert.equal(summarizeMoves(moves,'white').score.count,0);
});
