import test from 'node:test';
import assert from 'node:assert/strict';
import { updateSearchSpeed } from '../src/domain/searchSpeed.ts';
const input = (visits, extra={}) => ({jobId:'job', generation:1, visits, active:true, ...extra});
test('baseline visits are excluded and minimum measurement span is 500ms', () => {
  let a=updateSearchSpeed(null,input(10000),0);
  assert.equal(a.result.visitsPerSecond,null);
  a=updateSearchSpeed(a.state,input(10100),250);
  assert.equal(a.result.visitsPerSecond,null);
  a=updateSearchSpeed(a.state,input(10200),500);
  assert.equal(a.result.visitsPerSecond,400);
  assert.equal(a.result.elapsedSeconds,.5);
});
test('duplicate stale counts add no work and speed expires within sliding window', () => {
  let a=updateSearchSpeed(null,input(0),0);
  a=updateSearchSpeed(a.state,input(300),1000);
  assert.equal(a.result.visitsPerSecond,300);
  for(let time=1250;time<=4000;time+=250) a=updateSearchSpeed(a.state,input(300),time);
  assert.equal(a.result.visitsPerSecond,0);
});
test('job, generation, counter decrease and reactivation each reset the baseline', () => {
  for(const changed of [input(200,{jobId:'other'}),input(200,{generation:2}),input(10)]) {
    let a=updateSearchSpeed(null,input(100),0);
    a=updateSearchSpeed(a.state,input(200),1000);
    a=updateSearchSpeed(a.state,changed,2000);
    assert.equal(a.result.visitsPerSecond,null);
    assert.equal(a.result.elapsedSeconds,0);
  }
  let a=updateSearchSpeed(null,input(100),0);
  a=updateSearchSpeed(a.state,input(200),1000);
  a=updateSearchSpeed(a.state,input(200,{active:false}),2000);
  assert.equal(a.result.visitsPerSecond,null);
  a=updateSearchSpeed(a.state,input(200),3000);
  assert.equal(a.result.elapsedSeconds,0);
});
test('window interpolates boundary rather than keeping old bursts indefinitely', () => {
  let a=updateSearchSpeed(null,input(0),0);
  a=updateSearchSpeed(a.state,input(100),1000);
  a=updateSearchSpeed(a.state,input(100),3500);
  assert.ok(Math.abs(a.result.visitsPerSecond-50/3)<1e-9);
});
test('invalid samples and clock reversal cannot manufacture a speed', () => {
  let a=updateSearchSpeed(null,input(0),1000);
  a=updateSearchSpeed(a.state,input(100),1500);
  a=updateSearchSpeed(a.state,input(NaN),2000);
  assert.equal(a.result.visitsPerSecond,null);
  a=updateSearchSpeed(a.state,input(100),500);
  assert.equal(a.result.visitsPerSecond,null);
});

test('inactive elapsed freezes at deactivation and does not keep growing', () => {
  let a=updateSearchSpeed(null,input(0),0);
  a=updateSearchSpeed(a.state,input(100),1000);
  a=updateSearchSpeed(a.state,input(100,{active:false}),2000);
  assert.equal(a.result.elapsedSeconds,2);
  a=updateSearchSpeed(a.state,input(100,{active:false}),5000);
  assert.equal(a.result.elapsedSeconds,2);
});
