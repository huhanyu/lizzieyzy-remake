import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(path,deps){if(deps['./backend']?.listenToKataGoAnalysisEvents)deps['./researchEvents']={listenToResearchEvents:deps['./backend'].listenToKataGoAnalysisEvents};const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>deps[name],setTimeout,clearTimeout,Date});return exports;}
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
test('batch accepts early own-job completion, rejects other file results',async()=>{
 let handlers,unlistened=0;
 const {runResearchBatch}=load('../src/api/researchBatch.ts',{'./backend':{
  listenToKataGoAnalysisEvents:async h=>{handlers=h;return()=>unlistened++;},
  startKataGoGameAnalysis:async()=>{handlers.onComplete({job_id:'other',frames:[{turn:99}]});handlers.onComplete({job_id:'own',frames:[{turn:1}]});return 'own';},cancelKataGoAnalysis:async()=>{}
 }});
 const frames=await runResearchBatch({},'(;)',32,{onJob:()=>{},onProgress:()=>{},isCancelled:()=>false});
 assert.equal(frames[0].turn,1);assert.equal(unlistened,1);
});
test('cancel request does not release batch until terminal cancellation event',async()=>{
 let handlers,cancelled=0,done=false;
 const {runResearchBatch}=load('../src/api/researchBatch.ts',{'./backend':{
  listenToKataGoAnalysisEvents:async h=>{handlers=h;return()=>{};},startKataGoGameAnalysis:async()=>'job',cancelKataGoAnalysis:async()=>{cancelled++;}
 }});
 const work=runResearchBatch({},'(;)',32,{onJob:()=>{},onProgress:()=>{},isCancelled:()=>true}).then(v=>{done=true;return v;});
 await flush();assert.equal(cancelled,1);assert.equal(done,false);
 handlers.onCancelled({job_id:'old'});await flush();assert.equal(done,false);
 handlers.onCancelled({job_id:'job'});assert.equal(await work,null);
});
test('queue serializes files, uses each content cache key and restores after all jobs',async()=>{
 const order=[],keys=[];let active=0;
 const hook=load('../src/hooks/useResearchQueue.ts',{
  react:{useRef:v=>({current:v}),useState:v=>[v,()=>{}],useEffect:fn=>fn()},
  '../api/backend':{parseSgfSummary:async()=>({summary:{move_count:2}}),cancelKataGoAnalysis:async()=>{}},
  '../api/analysisCache':{computeGameCacheKey:async text=>({gameKey:text,sgfHash:text}),saveAnalysisCache:async value=>{keys.push(value.gameKey);}},
  '../api/researchBatch':{runResearchBatch:async(_,text)=>{assert.equal(active++,0);order.push(text);await Promise.resolve();active--;return [{turn:0}];}},
  '../domain/researchQueue':{validateResearchDocuments:()=>{}}
 }).useResearchQueue({acquire:async()=>{order.push('stop');},release:async()=>{order.push('restore');}});
 await hook.start([{id:'a',name:'a',sgfText:'first'},{id:'b',name:'b',sgfText:'second'}],{id:'p',profile:{backend:'kata_go_gtp'}},32);
 assert.deepEqual(order,['stop','first','second','restore']);assert.deepEqual(keys,['first','second']);assert.equal(hook.busyRef.current,false);
});

test('partial event installation failure removes successfully installed listeners',async()=>{
 const {installResearchListeners}=load('../src/api/researchEvents.ts',{'@tauri-apps/api/event':{}});
 let removed=0;
 await assert.rejects(installResearchListeners([Promise.resolve(()=>removed++),Promise.reject(new Error('listener')),Promise.resolve(()=>removed++)]));
 assert.equal(removed,2);
});
test('completed results remain exportable after cache persistence fails and foreground restores',async()=>{
 let retained=[],restored=0,stateIndex=0;
 const hook=load('../src/hooks/useResearchQueue.ts',{
  react:{useRef:v=>({current:v}),useState:v=>{const i=stateIndex++;return[v,next=>{if(i===1)retained=typeof next==='function'?next(retained):next;}];},useEffect:fn=>fn()},
  '../api/backend':{parseSgfSummary:async()=>({summary:{move_count:2}}),cancelKataGoAnalysis:async()=>{}},
  '../api/analysisCache':{computeGameCacheKey:async()=>({gameKey:'a',sgfHash:'a'}),saveAnalysisCache:async()=>{throw new Error('disk full');}},
  '../api/researchBatch':{runResearchBatch:async()=>[{turn:0}]},
  '../domain/researchQueue':{validateResearchDocuments:()=>{}}
 }).useResearchQueue({acquire:async()=>{},release:async()=>{restored++;}});
 await hook.start([{id:'a',name:'a',sgfText:'first'}],{id:'p',profile:{backend:'kata_go_gtp'}},32);
 assert.equal(retained.length,1);assert.equal(restored,1);assert.equal(hook.busyRef.current,false);
});
