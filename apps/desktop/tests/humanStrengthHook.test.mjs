import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const source=ts.transpileModule(fs.readFileSync(new URL('../src/hooks/useHumanStrength.ts',import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const tick=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function harness(available=true){
  const cells=[],effects=[],pending=[],calls={cancel:[],download:0,run:0};let index=0,id=0,scope={capture:{key:'A',request:{turns:[0]},positions:[1]}};
  const same=(a,b)=>a&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
  const react={
    useRef(value){const n=index++;return cells[n]??={current:value};},
    useState(value){const n=index++;if(!(n in cells))cells[n]=value;return[cells[n],v=>{cells[n]=typeof v==='function'?v(cells[n]):v;}];},
    useMemo(fn,deps){const n=index++;if(!same(cells[n]?.deps,deps))cells[n]={deps,value:fn()};return cells[n].value;},
    useCallback(fn,deps){return react.useMemo(()=>fn,deps);},
    useEffect(fn,deps){const n=index++;if(!same(cells[n]?.deps,deps)){effects.push(()=>{cells[n]?.cleanup?.();cells[n]={deps,cleanup:fn()};});}},
  };
  const api={strengthPolicyStatus:async()=>({engineAvailable:true,humanAvailable:available}),
    cancelStrengthPolicies:async id=>{calls.cancel.push(id);},cancelStrengthDownload:async()=>{},
    downloadStrengthHumanModel:async()=>{calls.download++;available=true;},
    listenStrengthPolicies:async fn=>()=>{},
    runStrengthPolicies:async(id,request)=>{calls.run++;return new Promise(resolve=>pending.push({id,request,resolve}));},
  };
  const module={exports:{}};
  vm.runInNewContext(source,{exports:module.exports,crypto:{randomUUID:()=>`job-${++id}`},require:name=>{
    if(name==='react')return react;
    if(name==='../api/strengthPolicy')return api;
    if(name==='../domain/strength/human40')return{captureHuman40:s=>s.capture,human40Moves:(c,p)=>c.positions.map(n=>({game:c.key,n}))};
    throw new Error(name);
  }});
  const render=(enabled=true,next=scope)=>{scope=next;index=0;const hook=module.exports.useHumanStrength(enabled,scope);while(effects.length)effects.shift()();return hook;};
  return{render,pending,calls,unmount(){for(const cell of cells)cell?.cleanup?.();}};
}
test('HumanSL download requires an explicit click; cancel does not accept a late result',async()=>{
  const h=harness(false);h.render();await tick();let view=h.render();
  assert.equal(view.phase,'missing-model');assert.equal(h.calls.download,0);
  const start=view.start(true);await tick();assert.equal(h.calls.download,1);assert.equal(h.calls.run,1);
  h.render().cancel();h.pending[0].resolve({policies:{}});await start;view=h.render();
  assert.equal(view.phase,'cancelled');assert.equal(view.moves.length,0);assert.ok(h.calls.cancel.includes('job-2'));
  h.unmount();
});
test('document change cancels the old task and cannot receive its late prediction',async()=>{
  const h=harness();h.render();await tick();
  h.render(true,{capture:{key:'B',request:{turns:[0]},positions:[2]}});await tick();
  h.pending[0].resolve({policies:{}});await tick();assert.equal(h.render().moves.length,0);
  h.pending[1].resolve({policies:{}});await tick();const view=h.render();
  assert.equal(view.phase,'ready');assert.equal(view.moves[0].game,'B');assert.ok(h.calls.cancel.includes('job-1'));
  h.unmount();
});
test('ordinary streaming updates recompute from policies without restarting supplementary search',async()=>{
  const h=harness();h.render();await tick();h.pending[0].resolve({policies:{}});await tick();
  const view=h.render(true,{capture:{key:'A',request:{turns:[0,1]},positions:[1,2]}});
  assert.equal(view.moves.length,2);assert.equal(h.calls.run,1);h.unmount();
});
test('disabled model never calls the HumanSL backend; unmount cancels active work',async()=>{
  const h=harness();h.render(false);await tick();assert.equal(h.calls.run,0);
  h.render(true);await tick();h.unmount();assert.ok(h.calls.cancel.includes('job-1'));
  h.pending[0].resolve({policies:{}});await tick();
});
