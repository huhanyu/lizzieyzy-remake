import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { captureHuman40, human40Moves, human40Summary, predictHuman40, humanFeatureNames, HUMAN_PROFILES, trainingRound } from '../src/domain/strength/human40.ts';
const booster = JSON.parse(fs.readFileSync(new URL('../public/models/humansl40_booster.json', import.meta.url), 'utf8'));
const policy = () => [...Array(361).fill(0), 1];
function capture(count = 12) {
  const frame = {job_id:'ordinary',visits:100,score_mean_black:0,winrate_black:.5,
    candidates:[{vertex:'pass',score_mean_black:0,winrate_black:.5,policy_prior:1,visits:100,pv:[]}]};
  return { key:'game',request:{},positions:Array.from({length:count},(_,i)=>({nodeId:`n${i+1}`,turn:i+1,
    color:i%2?'white':'black',vertex:'pass',before:structuredClone(frame),after:structuredClone(frame)})) };
}
const policies = n => Object.fromEntries(Array.from({length:n},(_,i)=>[String(i),Object.fromEntries(HUMAN_PROFILES.map(p=>[p,policy()]))]));
test('40-feature booster and missing-value routing are independent of the calibrated 20TUN model',()=>{
  assert.deepEqual(booster.learner.feature_names,humanFeatureNames);
  const moves=human40Moves(capture(),policies(12)), summary=human40Summary(moves);
  assert.equal(summary.features.length,40);
  assert.ok(Number.isFinite(predictHuman40(summary.features,booster)));
  const missing=[...summary.features];missing[29]=NaN;
  assert.ok(Number.isFinite(predictHuman40(missing,booster)));
  assert.equal(predictHuman40(summary.features.slice(1),booster),null);
  assert.equal(predictHuman40(missing,{learner:{...booster.learner,feature_names:[]}}),null);
  assert.equal(trainingRound(1.25,1),1.2);assert.equal(trainingRound(1.35,1),1.4);
});
test('reused candidates determine loss and difficulty; policies cannot overwrite primary analysis',()=>{
  const c=capture(), before=JSON.stringify(c);
  const moves=human40Moves(c,policies(12));
  assert.equal(JSON.stringify(c),before);
  assert.equal(moves.length,12);assert.equal(moves[0].strength.loss,0);
  assert.equal(human40Summary(moves).coverage,1);
  assert.equal(human40Summary(moves).difficulty,0);
  const partial=policies(12);delete partial['2'];
  assert.equal(human40Moves(c,partial).length,11);
});
test('unknown human mass remains NaN rather than zero difficulty',()=>{
  const c=capture(), p=policies(12);
  for(const profiles of Object.values(p))for(const name of HUMAN_PROFILES){profiles[name][0]=.8;profiles[name][361]=.2;}
  const s=human40Summary(human40Moves(c,p));
  assert.ok(Number.isNaN(s.difficulty));assert.ok(Math.abs(s.coverage-.2)<1e-12);
  assert.ok(Number.isNaN(s.features[29]));assert.ok(Number.isFinite(predictHuman40(s.features,booster)));
});
test('white losses use black-perspective frames and strict first choice is separate from good moves',()=>{
  const c=capture();
  c.positions[1].before.candidates.unshift({vertex:{point:{x:0,y:0}},score_mean_black:-2,winrate_black:.6,policy_prior:0,visits:100,pv:[]});
  const m=human40Moves(c,policies(12))[1];
  assert.equal(m.strength.loss,2);assert.equal(m.strength.first,false);assert.equal(m.strength.rank,1);
});
test('capture uses only bound, paired, same-job frames on the selected ancestry and rejects setup',()=>{
  const root={id:'root',depth:0,child_ids:['n1'],properties:[{key:'SZ',values:['19']}]};
  const nodes=[root,...Array.from({length:12},(_,i)=>({id:`n${i+1}`,parent_id:i?`n${i}`:'root',child_ids:i<11?[`n${i+2}`]:[],
    move_number:i+1,depth:i+1,color:i%2?'white':'black',vertex:'pass',properties:[]}))];
  const f=capture().positions[0].before;
  const scope={documentKey:'sgf',tree:{root_id:'root',nodes},selectedNodeId:'root',frames:nodes.map((n,i)=>({...f,turn:i,node_id:JSON.stringify(['sgf',n.id])}))};
  const captured=captureHuman40(scope);assert.equal(captured.positions.length,12);assert.equal(captured.request.endNodeId,'n12');
  assert.throws(()=>captureHuman40({...scope,frames:scope.frames.map((f,i)=>({...f,job_id:String(i)}))}),/分析不足/);
  root.properties.push({key:'AB',values:['dd']});assert.throws(()=>captureHuman40(scope),/摆子/);
});

function vertex(coordinate){if(coordinate.toLowerCase()==='pass')return 'pass';return{point:{x:'ABCDEFGHJKLMNOPQRST'.indexOf(coordinate[0]),y:19-Number(coordinate.slice(1))}};}
test('private full-game Java/Python feature and prediction parity', {skip:!process.env.HUMANSL40_PARITY_FIXTURES},()=>{
  for(const path of JSON.parse(process.env.HUMANSL40_PARITY_FIXTURES)){
    const raw=JSON.parse(fs.readFileSync(path,'utf8'));
    const frame=(base,color)=>{
      const sign=color==='B'?1:-1;
      return{job_id:'reference',visits:base.rootInfo.visits,score_mean_black:sign*(base.rootInfo.scoreMean??base.rootInfo.scoreLead),
        winrate_black:color==='B'?base.rootInfo.winrate:1-base.rootInfo.winrate,
        candidates:[...base.moveInfos].sort((a,b)=>a.order-b.order).map(m=>({vertex:vertex(m.move),score_mean_black:sign*(m.scoreMean??m.scoreLead),winrate_black:color==='B'?m.winrate:1-m.winrate,
          visits:m.visits,policy_prior:m.prior,pv:[]}))};
    };
    const c={positions:raw.moves.map(([color,move],i)=>({nodeId:String(i),turn:i+1,color:color==='B'?'black':'white',vertex:vertex(move),
      before:frame(raw.base_analyses[i],color),after:frame(raw.base_analyses[i+1],raw.moves[i+1]?.[0]??(color==='B'?'W':'B'))}))};
    const p=Object.fromEntries(raw.moves.map((_,i)=>[i,Object.fromEntries(HUMAN_PROFILES.map(profile=>[profile,raw.human_policies[profile][i]]))]));
    const moves=human40Moves(c,p);
    for(const [index,color]of['black','white'].entries()){
      const s=human40Summary(moves.filter(m=>m.color===color));
      s.features.forEach((value,j)=>raw.expected_features[index][j]===null?assert.ok(Number.isNaN(value),humanFeatureNames[j]):
        assert.ok(Math.abs(value-raw.expected_features[index][j])<1e-9,`${path} ${color} ${humanFeatureNames[j]} ${value} != ${raw.expected_features[index][j]}`));
      assert.ok(Math.abs(predictHuman40(s.features,booster)-raw.expected_ranks[index])<2e-5);
    }
  }
});
