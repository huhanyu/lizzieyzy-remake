import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('../src/hooks/useCloudCompute.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(start = async () => 'job') {
  const timers = new Map(); let timerId = 0; let stops = 0; let starts = 0; let activated = 0; let cleanup;
  const module = { exports: {} };
  vm.runInNewContext(source, { exports: module.exports, require: (name) => {
    if (name === 'react') return { useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}], useEffect: (fn) => { cleanup = fn(); } };
    if (name === '@tauri-apps/api/core') return { isTauri: () => true, invoke: async () => { ++starts; return start(); } };
    if (name === '../domain/cloudRetry') return { cloudRetryDelay: (n) => n < 5 ? 1000 * 2 ** n : null };
    throw new Error(name);
  }, setTimeout: (fn, delay) => { const id=++timerId; timers.set(id, {fn, delay}); return id; }, clearTimeout: (id) => timers.delete(id) });
  const hook = module.exports.useCloudCompute({ canStart: () => true, prepare: async () => {}, position: () => ({boardSize:19,turn:0}), activate: () => ++activated, stop: async () => { ++stops; } });
  async function tick() { const next=[...timers].sort((a,b)=>a[1].delay-b[1].delay)[0]; if (!next) return false; timers.delete(next[0]); next[1].fn(); for(let i=0;i<15;i++) await Promise.resolve(); return true; }
  return {hook,tick,timers,cleanup:()=>cleanup?.(),stats:()=>({starts,stops,activated})};
}
test('disconnect cancels scheduled recovery; stale allocation cannot activate', async () => {
  let release; const h=harness(()=>new Promise((resolve)=>{release=resolve;}));
  const connecting=h.hook.connect(); for(let i=0;i<5;i++) await Promise.resolve();
  const disconnecting=h.hook.disconnect(); release('late'); await connecting; await disconnecting;
  assert.equal(h.stats().activated,0); assert.equal(h.timers.size,0); assert.ok(h.stats().stops>=1);
});
test('unexpected termination retries five times with a bounded backoff then stops', async () => {
  let fail=false; const h=harness(async()=>{if(fail)throw new Error('transport');return 'job';});
  await h.hook.connect(); fail=true; h.hook.ended();
  const delays=[]; while(h.timers.size) {delays.push([...h.timers.values()][0].delay); await h.tick();}
  assert.deepEqual(delays,[1000,2000,4000,8000,16000]); assert.equal(h.stats().starts,6);
});
test('manual disconnect and selecting local do not reconnect', async () => {
  const h=harness(); await h.hook.connect(); h.hook.ended(); await h.hook.disconnect();
  assert.equal(h.timers.size,0); h.hook.ended(); assert.equal(h.timers.size,0);
  await h.hook.connect(); h.hook.ended(); h.hook.selectLocal(); assert.equal(h.timers.size,0);
});
test('initial startup failure is not retried and unmount cancels recovery', async () => {
  const h=harness(async()=>{throw new Error('permission');}); await assert.rejects(h.hook.connect()); assert.equal(h.timers.size,0);
  const ok=harness(); await ok.hook.connect(); ok.hook.ended(); ok.cleanup(); assert.equal(ok.timers.size,0);
});
