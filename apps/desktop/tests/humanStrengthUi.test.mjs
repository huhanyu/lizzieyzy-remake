import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import * as human from '../src/domain/strength/human40.ts';
import * as model from '../src/domain/strength/model.ts';
import * as features from '../src/domain/strength/features.ts';
import * as statistics from '../src/domain/reviewStatistics.ts';
import * as format from '../src/components/review/format.ts';
const require=createRequire(import.meta.url),ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const booster=JSON.parse(fs.readFileSync(new URL('../public/models/humansl40_booster.json',import.meta.url),'utf8'));
function component(path,dependencies,globals={}){
  const code=ts.transpileModule(fs.readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const module={exports:{}};
  vm.runInNewContext(code,{exports:module.exports,...globals,require:name=>dependencies[name]??require(name)});
  return module.exports;
}
const {SideSummary}=component('../src/components/review/SideSummary.tsx',{'../../domain/strength/features':features,'../../domain/strength/model':model,'../../domain/strength/human40':human,'./format':format});
function fixture(){
  const root={id:'root',depth:0,properties:[],child_ids:['n1']};
  const nodes=[root,...Array.from({length:12},(_,i)=>({id:`n${i+1}`,parent_id:i?`n${i}`:'root',depth:i+1,move_number:i+1,
    color:i%2?'white':'black',vertex:'pass',properties:[],child_ids:i<11?[`n${i+2}`]:[]}))];
  const frame={job_id:'ordinary',visits:100,winrate_black:.5,score_mean_black:0,candidates:[{vertex:'pass',winrate_black:.5,score_mean_black:0,policy_prior:1,visits:100,pv:[]}]};
  const scope={documentKey:'sgf',tree:{root_id:'root',nodes},selectedNodeId:'root',frames:nodes.map((n,i)=>({...frame,turn:i,node_id:JSON.stringify(['sgf',n.id])}))};
  const capture=human.captureHuman40(scope);
  const policies=Object.fromEntries(Array.from({length:12},(_,i)=>[i,Object.fromEntries(human.HUMAN_PROFILES.map(p=>[p,[...Array(361).fill(0),1]]))]));
  return{scope,moves:human.human40Moves(capture,policies)};
}
function render(complete){
  const {scope,moves}=fixture();let calls=0;
  const react={...React,useState(initial){calls++;return React.useState(calls===3?booster:initial);}};
  const {ReviewDashboard}=component('../src/components/ReviewDashboard.tsx',{
    '@phosphor-icons/react':{ArrowClockwise:()=>null,DownloadSimple:()=>null,Stop:()=>null},
    react,'../hooks/useReviewSnapshot':{useReviewSnapshot:s=>s},'../domain/reviewStatistics':statistics,
    '../domain/strength/model':model,'../domain/strength/human40':human,
    '../hooks/useHumanStrength':{useHumanStrength:()=>({moves:complete?moves:[],phase:complete?'ready':'missing-model',busy:false,canStart:true,error:'',start(){},cancel(){}})},
    './review/SideSummary':{SideSummary},'./review/MatchTimeline':{MatchTimeline:()=>null},
    './review/QualityDistribution':{QualityDistribution:()=>null},'./review/MistakeTimeline':{MistakeTimeline:()=>null},
  },{localStorage:{getItem:()=> 'humansl40'}});
  return renderToStaticMarkup(React.createElement(ReviewDashboard,{scope,mode:'summary'}));
}
test('original assessment table exposes both models and completed HumanSL results without model settings',()=>{
  const html=render(true);
  assert.match(html,/aria-label="棋力模型"/);assert.match(html,/XGBoost 20TUN/);assert.match(html,/HumanSL 40/);
  assert.match(html,/策略覆盖/);assert.match(html,/9d 难度/);assert.match(html,/职业标尺/);
  assert.doesNotMatch(html,/裁判模型|模型路径|固定 σ/);assert.match(html,/刷新测评/);
});
test('missing dependency offers a download in place and cannot display a fabricated rating',()=>{
  const html=render(false);
  assert.match(html,/下载所需模型/);assert.match(html,/99 MB/);
  assert.doesNotMatch(html,/职业标尺/);assert.match(html,/至少 6 手完整分析后测评/);
});
