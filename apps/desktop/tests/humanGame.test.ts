import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseEngineMove,selectPlayMove} from '../src/domain/humanGame.ts';
test('GTP coordinates reject invalid and preserve pass/resign',()=>{assert.deepEqual(parseEngineMove('T19',19),{point:{x:18,y:0}});assert.throws(()=>parseEngineMove('I3',19));assert.equal(parseEngineMove('pass',19),'pass');assert.equal(parseEngineMove('RESIGN',19),'resign');});
test('standard move follows explicit order zero, not incoming list ordering',()=>assert.deepEqual(selectPlayMove({moveInfos:[{order:1,move:'D4'},{order:0,move:'Q16'}]},19,false,false,0),{point:{x:15,y:3}}));
test('HumanSL samples human policy, excluding illegal and early pass',()=>{const humanPolicy=[-1,0,.2,.8,100];const r={humanPolicy,moveInfos:[{order:0,move:'A2'}]};assert.deepEqual(selectPlayMove(r,2,true,false,.1),{point:{x:0,y:1}});assert.deepEqual(selectPlayMove(r,2,true,false,.9),{point:{x:1,y:1}});assert.throws(()=>selectPlayMove({policy:humanPolicy},2,true,false,0));});
test('HumanSL accepts ending pass only when permitted',()=>assert.equal(selectPlayMove({humanPolicy:[0,0,0,0,1],moveInfos:[{order:0,move:'pass'}]},2,true,true,.3),'pass'));
