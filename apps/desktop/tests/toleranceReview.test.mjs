import test from 'node:test';
import assert from 'node:assert/strict';
import {lossSummary,mergeEvent,documentHash,terminal} from '../src/domain/tolerance/metrics.ts';
const d={candidates:[{probability:.2,scoreLoss:0,winLossPp:0},{probability:.3,scoreLoss:2,winLossPp:12},{probability:.5,scoreLoss:null,winLossPp:null}]};
test('probability remains unconditional and thresholds can change without new search',()=>{
  assert.deepEqual(lossSummary(d,'score',1,2),{good:.2,tail:.3,expected:.6,unknown:.5});
  assert.equal(lossSummary(d,'score',2,3).good,.5);
  assert.equal(lossSummary(d,'win',5,10).tail,.3);
});
test('events never cross documents/jobs and deeper results replace one node only',()=>{
  const r={jobId:'a',documentHash:'h',positions:[{input:{nodeId:'n',turn:1},stage:'screen'}],branches:[]};
  assert.equal(mergeEvent(r,{jobId:'b',documentHash:'h'}),r);assert.equal(mergeEvent(r,{jobId:'a',documentHash:'old'}),r);
  const changed=mergeEvent(r,{jobId:'a',documentHash:'h',position:{input:{nodeId:'n',turn:1},stage:'deep'}});
  assert.equal(changed.positions.length,1);assert.equal(changed.positions[0].stage,'deep');assert.equal(r.positions[0].stage,'screen');
});
test('SGF identity includes rules komi history and complete branch text',async()=>{
  assert.notEqual(await documentHash('(;KM[6.5])'),await documentHash('(;KM[7.5])'));
  assert.equal(await documentHash('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(terminal('cancelled'));assert.ok(!terminal('running'));
});
