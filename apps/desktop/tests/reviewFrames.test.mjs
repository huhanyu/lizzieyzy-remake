import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewChartFrames } from '../src/domain/reviewFrames.ts';
const tree = { nodes: [{ id: 'root', is_mainline: true }, { id: 'main', is_mainline: true }, { id: 'branch', is_mainline: false }] };
const f = (turn, visits, doc = 'current', node = 'main') => ({turn, visits, node_id: JSON.stringify([doc, node, {}])});
test('real-time updates retain other analyzed moves and reject older document/branch frames', () => {
  const a = f(0, 100), b = f(1, 100), update = f(1, 200);
  assert.deepEqual(reviewChartFrames([a,b], [update, f(0,999,'old'), f(1,999,'current','branch')], 'current', tree, 'main'), [a, update]);
});
test('branch chart never substitutes mainline positions with identical move numbers', () => {
  const branch = f(1,50,'current','branch');
  assert.deepEqual(reviewChartFrames([f(1,200)], [f(1,100),branch], 'current', tree, 'branch'), [branch]);
});
test('fresh live sample matches the board even below batch visits; invalid identities are ignored', () => {
  const baseline=f(1,200);
  const live=f(1,20);
  assert.deepEqual(reviewChartFrames([baseline],[live,{turn:1,visits:999,node_id:'garbage'}], 'current',tree,'main'),[live]);
});

test('stream history preserves sibling positions, updates revisits, and supplies adjacent loss and curves', async () => {
  const {retainLiveFrame}=await import('../src/domain/reviewFrames.ts');
  const {calculatePositionMetrics}=await import('../src/domain/positionMetrics.ts');
  const {chartPoints,chartSegments}=await import('../src/domain/winrateChart.ts');
  const tree={root_id:'r',nodes:[{id:'r',is_mainline:true},{id:'b',parent_id:'r',is_mainline:true,color:'black',vertex:{point:{x:1,y:1}}},{id:'w',parent_id:'b',is_mainline:true,color:'white',vertex:{point:{x:2,y:2}}},{id:'v',parent_id:'b',is_mainline:false,color:'white',vertex:{point:{x:3,y:3}}}]};
  let history=[];
  for (const [node,turn,wr,score] of [['b',1,.4,-2],['w',2,.6,1],['v',2,.5,0]]) history=retainLiveFrame(history,{...f(turn,100,'doc',node),job_id:'session',winrate_black:wr,score_mean_black:score,candidates:[]});
  assert.equal(history.length,3);
  const chart=reviewChartFrames([],history,'doc',tree,'w');
  assert.equal(chartSegments(chartPoints(chart),'winrate')[0].length,2);
  assert.equal(chartSegments(chartPoints(chart),'score')[0].length,2);
  const loss=calculatePositionMetrics({documentKey:'doc',tree,selectedNodeId:'w',frames:history});
  assert.ok(Math.abs(loss.winrateLoss-20)<1e-9);assert.equal(loss.scoreLoss,3);
  assert.deepEqual(reviewChartFrames([],history,'doc',tree,'v').map(x=>JSON.parse(x.node_id)[1]),['b','v']);
  history=retainLiveFrame(history,{...history[0],visits:5});
  assert.equal(history.length,3);assert.equal(history.at(-1).visits,5);
});
test('append retains only unchanged ancestry and rebinds document identity', async () => {
  const {rebindAppendedFrames}=await import('../src/domain/reviewFrames.ts');
  const old={root_id:'r',nodes:[{id:'r',properties:[{key:'KM',values:['7.5']}]},{id:'b',parent_id:'r',properties:[{key:'B',values:['dd']}]}]};
  const next={...old,nodes:[...old.nodes,{id:'w',parent_id:'b',properties:[{key:'W',values:['pp']}]}]};
  const frames=[f(1,100,'old','b')];
  assert.equal(JSON.parse(rebindAppendedFrames(frames,'old',old,'new',next)[0].node_id)[0],'new');
  const changed={...next,nodes:[{...old.nodes[0],properties:[{key:'KM',values:['6.5']}]},...next.nodes.slice(1)]};
  assert.deepEqual(rebindAppendedFrames(frames,'old',old,'new',changed),[]);
});
