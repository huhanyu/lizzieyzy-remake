import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoFillHistory, quickCurveOptions } from '../src/domain/analysisPolicy.ts';
import { planFullGameReview } from '../src/domain/fullGameReview.ts';
test('remote connections never schedule automatic history, even with local opt-in', () => {
  for (const source of ['ssh','cloud']) for (const enabled of [true,false]) assert.equal(shouldAutoFillHistory(source,enabled),false);
  assert.equal(shouldAutoFillHistory('local',false),false);
  assert.equal(shouldAutoFillHistory('local',true),true);
});
test('quick curve visits each position once at 1v without a deep pass', () => {
  const tree={root_id:'r',nodes:[{id:'r',parent_id:null,move_number:0,child_ids:['a']},{id:'a',parent_id:'r',move_number:1,child_ids:[]}]};
  const plan=planFullGameReview(tree,quickCurveOptions(1));
  assert.deepEqual(plan.map(p=>[p.turn,p.visits]),[[0,1],[1,1]]);
});
