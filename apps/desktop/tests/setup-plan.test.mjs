import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configuredProfiles, installedModel, pendingDownloadBytes, selectedModels } from '../src/domain/setupPlan.ts';
const catalog = JSON.parse(readFileSync(new URL('../src/domain/modelCatalog.json', import.meta.url)));
const asset = (purpose, path = '/managed/model.bin.gz') => ({id:purpose,kind:'model',name:purpose,path,sha256:catalog.find(m => m.purpose === purpose).sha256,source:'official',bytes:100});
const settings = {selected_profile_id:'main',profiles:[{id:'main',max_visits:800,profile:{name:'My engine',engine_path:'/katago',model_path:'/old-model',config_path:'/config',backend:'kata_go_gtp'}}]};
test('plan includes only explicitly selected modules and fails closed on unavailable selection', () => {
  assert.deepEqual(selectedModels(catalog,'balanced',false,false).map(m => m.purpose),['balanced']);
  assert.deepEqual(selectedModels(catalog,'light',true,true).map(m => m.purpose),['light','quick','human']);
  assert.throws(() => selectedModels([], 'balanced', false, false));
});
test('reuse is based on checksum, not model display name; shared quick weights count once', () => {
  const light = catalog.find(m=>m.purpose==='light');
  assert.ok(installedModel(light,[asset('light')]));
  assert.equal(installedModel(light,[{...asset('deep'),name:light.name}]),undefined);
  assert.equal(pendingDownloadBytes(selectedModels(catalog,'light',true,false),[]), light.bytes);
  assert.equal(pendingDownloadBytes(selectedModels(catalog,'light',true,false),[asset('light')]),0);
});
test('configuration preserves previous settings and creates one independent quick profile', () => {
  const before=JSON.stringify(settings);
  const next=configuredProfiles(settings,asset('balanced'),asset('quick','/quick-model'));
  assert.equal(JSON.stringify(settings),before);
  assert.equal(next.selected_profile_id,'main');
  assert.equal(next.profiles[0].profile.config_path,'/config');
  assert.equal(next.profiles[1].profile.model_path,'/quick-model');
  assert.equal(next.profiles[1].max_visits,200);
  assert.equal(configuredProfiles(next,asset('light'),asset('quick')).profiles.length,2);
});
test('missing active engine/config prevents applying a partial setup', () => {
  assert.throws(()=>configuredProfiles({...settings,selected_profile_id:'missing'},asset('light')));
  assert.throws(()=>configuredProfiles({...settings,profiles:[{...settings.profiles[0],profile:{...settings.profiles[0].profile,config_path:null}}]},asset('light')));
});

const { runSetupWorkflow } = await import('../src/domain/setupWorkflow.ts');
function fakeIO(overrides={}) {
  const calls={saved:0,installed:0,probed:0};
  const io={ load:async()=>structuredClone(settings),save:async (expected,s)=>{assert.deepEqual(expected,settings);calls.saved++;return s;},list:async()=>[],install:async m=>{calls.installed++;return {...asset(m.purpose),path:'/managed/'+m.sha256};},check:async()=>{},probe:async()=>{calls.probed++;},assertAvailable:()=>{},onInstalled:()=>{},onValidating:()=>{},...overrides};
  return {io,calls};
}
test('download or compatibility failure never writes settings',async()=>{
  for(const overrides of [{install:async()=>{throw Error('offline');}},{probe:async()=>{throw Error('unsupported model');}}]) {
    const {io,calls}=fakeIO(overrides); await assert.rejects(runSetupWorkflow(selectedModels(catalog,'balanced',false,false),io)); assert.equal(calls.saved,0);
  }
});
test('cancel after download preserves completed asset without applying settings',async()=>{
  let cancelled=false;const {io,calls}=fakeIO({onInstalled:()=>{cancelled=true;},assertAvailable:()=>{if(cancelled)throw Error('cancelled');}});
  await assert.rejects(runSetupWorkflow(selectedModels(catalog,'balanced',false,false),io));assert.equal(calls.installed,1);assert.equal(calls.saved,0);assert.equal(calls.probed,0);
});
test('concurrent advanced settings changes are not overwritten',async()=>{
  let reads=0;const {io,calls}=fakeIO({load:async()=>++reads===1?structuredClone(settings):{...structuredClone(settings),selected_profile_id:'other'}});
  await assert.rejects(runSetupWorkflow(selectedModels(catalog,'balanced',false,false),io),/发生变化/);assert.equal(calls.saved,0);
});
test('same primary and quick model download and probe only once, then commit together',async()=>{
  const {io,calls}=fakeIO();const next=await runSetupWorkflow(selectedModels(catalog,'light',true,false),io);
  assert.equal(calls.installed,1);assert.equal(calls.probed,1);assert.equal(calls.saved,1);assert.equal(next.profiles.length,2);
});

test('starting from quick profile keeps it independent of a different main model', () => {
  const quickSettings={selected_profile_id:'one-click-quick',profiles:[{...settings.profiles[0],id:'one-click-quick',max_visits:200}]};
  const next=configuredProfiles(quickSettings,asset('balanced','/main'),asset('quick','/quick'));
  assert.equal(next.selected_profile_id,'one-click-main');
  assert.equal(next.profiles.find(p=>p.id==='one-click-main').profile.model_path,'/main');
  assert.equal(next.profiles.find(p=>p.id==='one-click-quick').profile.model_path,'/quick');
  assert.equal(configuredProfiles({...next,selected_profile_id:'one-click-quick'},asset('deep'),asset('quick')).profiles.length,2);
});
