import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePositionMetrics, javaMoveMatch } from '../src/domain/positionMetrics.ts';
const point = (x,y) => ({point:{x,y}});
const root = {id:'r',parent_id:null};
const black = {id:'b',parent_id:'r',color:'black',vertex:point(3,3)};
const white = {id:'w',parent_id:'b',color:'white',vertex:point(4,4)};
const sibling = {id:'s',parent_id:'b',color:'white',vertex:point(5,5)};
const tree = {root_id:'r',nodes:[root,black,white,sibling]};
const frame = (id, wr, score, candidates = [], job='job') => ({node_id:JSON.stringify(['doc',id]),job_id:job,visits:100,winrate_black:wr,score_mean_black:score,candidates});
const candidate = (vertex, visits) => ({vertex,visits});
const calc = (frames, selectedNodeId='w') => calculatePositionMetrics({documentKey:'doc',tree,selectedNodeId,frames});
test('losses use real mover perspective for black and white, including improvements', () => {
  const frames=[frame('r',.5,0),frame('b',.4,-2),frame('w',.6,1)];
  assert.ok(Math.abs(calc(frames,'b').winrateLoss-10)<1e-9);
  assert.equal(calc(frames,'b').scoreLoss,2);
  assert.ok(Math.abs(calc(frames).winrateLoss-20)<1e-9);
  assert.equal(calc(frames).scoreLoss,3);
  assert.ok(calc([frame('b',.6,1),frame('w',.4,-2)]).winrateLoss<0);
});
test('missing, old-document, sibling, unbound and different-job frames never substitute parent/current', () => {
  for (const bad of [frame('s',.8,9),{...frame('w',.8,9),node_id:JSON.stringify(['old','w'])},{...frame('w',.8,9),node_id:null},frame('w',.8,9,[],'other')]) {
    assert.equal(calc([frame('b',.5,0),bad]).winrateLoss,null);
  }
  assert.equal(calc([]).matchPercent,null);
  assert.equal(calc([frame('b',.5,0)]).winrateLoss,null);
});
test('Java matching is top three AND relative visits threshold; missing candidates remain unknown', () => {
  const cs=[candidate(point(1,1),100),candidate(point(4,4),20),candidate(point(2,2),40),candidate(point(5,5),100)];
  assert.equal(javaMoveMatch(white,frame('b',.5,0,cs)),true);
  assert.equal(javaMoveMatch(sibling,frame('b',.5,0,cs)),false);
  assert.equal(javaMoveMatch(white,frame('b',.5,0,[cs[0],candidate(point(4,4),19)])),false);
  assert.equal(javaMoveMatch(white,frame('b',.5,0)),null);
  assert.equal(javaMoveMatch({...white,vertex:'pass'},frame('b',.5,0,cs)),null);
});
test('branch rate uses only ancestry and reports analyzed coverage', () => {
  const result=calc([frame('r',.5,0,[candidate(point(3,3),100)]),frame('b',.5,0,[candidate(point(4,4),100)]),frame('w',.5,0)]);
  assert.equal(result.totalMoves,2); assert.equal(result.analyzed,2); assert.equal(result.matchPercent,100);
  const partial=calc([frame('b',.5,0,[candidate(point(4,4),100)])]);
  assert.equal(partial.totalMoves,2); assert.equal(partial.analyzed,1); assert.equal(partial.matchPercent,100);
});
test('zero visits, NaN and broken ancestry do not manufacture numbers', () => {
  assert.equal(calc([{...frame('b',.5,0),visits:0},frame('w',.6,1)]).scoreLoss,null);
  assert.equal(calc([frame('b',NaN,0),frame('w',.6,1)]).winrateLoss,null);
  const broken={...tree,nodes:[{...white,parent_id:'w'}]};
  assert.equal(calculatePositionMetrics({documentKey:'doc',tree:broken,selectedNodeId:'w',frames:[]}).matchPercent,null);
});

test('batch binding maps unique mainline nodes only and never picks a same-turn variation', async () => {
  const { bindBatchFramesToNodes } = await import('../src/domain/positionMetrics.ts');
  const batchTree={root_id:'r',nodes:[{id:'r',is_mainline:true},{id:'m',move_number:1,is_mainline:true},{id:'v',move_number:1,is_mainline:false}]};
  const bound=bindBatchFramesToNodes('doc',batchTree,[{turn:0},{turn:1},{turn:2}]);
  assert.deepEqual(bound.map(f=>JSON.parse(f.node_id)[1]),['r','m']);
  batchTree.nodes.push({id:'ambiguous',move_number:1,is_mainline:true});
  assert.equal(bindBatchFramesToNodes('doc',batchTree,[{turn:1}]).length,0);
});
test('rule names preserve unknown strings and identify the actual default', async () => {
  const { gameRulesLabel }=await import('../src/domain/positionMetrics.ts');
  assert.equal(gameRulesLabel(null),'中国规则（默认）');
  assert.equal(gameRulesLabel('Japanese'),'日本规则');
  assert.equal(gameRulesLabel('custom-rule'),'custom-rule');
});
test('black and white agreement keep separate denominators and unknown coverage', () => {
  const result=calc([frame('r',.5,0,[candidate(point(3,3),100)]),frame('b',.5,0,[candidate(point(1,1),100)]),frame('w',.5,0)]);
  assert.deepEqual(result.black,{matchPercent:100,matched:1,analyzed:1,totalMoves:1});
  assert.deepEqual(result.white,{matchPercent:0,matched:0,analyzed:1,totalMoves:1});
  const partial=calc([frame('b',.5,0,[candidate(point(4,4),100)])]);
  assert.deepEqual(partial.black,{matchPercent:null,matched:0,analyzed:0,totalMoves:1});
  assert.equal(partial.white.matchPercent,100);
});
