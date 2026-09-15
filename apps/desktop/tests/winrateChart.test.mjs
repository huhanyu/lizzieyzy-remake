import test from 'node:test';
import assert from 'node:assert/strict';
import { chartPoints, chartSegments, scoreExtent, chartReadout } from '../src/domain/winrateChart.ts';
const f = (turn, winrate, score, node_id = `n${turn}`) => ({ turn, winrate_black: winrate, score_mean_black: score, visits: 100, node_id });
test('black-relative DTO values are preserved across odd and even turns without komi adjustment', () => {
  assert.deepEqual(chartPoints([f(2, .2, -5.5), f(1, .7, 3.5)]), [
    { turn: 1, winrate: .7, score: 3.5 }, { turn: 2, winrate: .2, score: -5.5 },
  ]);
});
test('missing moves and independently missing metrics split each curve without zero filling', () => {
  const points = chartPoints([f(0, .5, 0), f(1, NaN, 2), f(2, .7, NaN), f(4, .8, 5)]);
  assert.deepEqual(chartSegments(points, 'winrate').map(s => s.map(p => p.turn)), [[0], [2], [4]]);
  assert.deepEqual(chartSegments(points, 'score').map(s => s.map(p => p.turn)), [[0, 1], [4]]);
  assert.equal(points[1].winrate, null);
  assert.equal(points[2].score, null);
});
test('same-turn branch collisions are omitted and explicit node eligibility excludes other branches', () => {
  const input = [f(1, .5, 0, 'main'), f(1, .9, 10, 'branch'), f(2, .6, 2, 'main2')];
  assert.deepEqual(chartPoints(input).map(p => p.turn), [2]);
  assert.equal(chartPoints(input, ['main'])[0].winrate, .5);
  assert.deepEqual(chartPoints(input, []), []);
});
test('latest same-position sample wins, and unvisited or invalid probabilities are not invented', () => {
  const points = chartPoints([f(1, .3, 1), {...f(1, .6, 2), visits: 1}, {...f(2, .5, 0), visits: 0}, f(3, 12, -2)]);
  assert.equal(points[0].winrate, .6);
  assert.deepEqual(points.map(p => p.turn), [1,3]);
  assert.equal(points[1].winrate, null);
});
test('score axis is symmetric, readable and never clips; missing readout is explicit', () => {
  assert.equal(scoreExtent(chartPoints([f(0, .5, -23)])), 50);
  assert.equal(scoreExtent([]), 5);
  assert.equal(chartReadout(undefined), '黑胜率 暂无 · 黑目差 暂无');
  assert.equal(chartReadout({turn: 2, winrate: .55, score: -2.5}), '黑胜率 55.0% · 黑目差 -2.5 目');
});
