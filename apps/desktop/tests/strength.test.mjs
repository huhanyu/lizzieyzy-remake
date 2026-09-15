import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { predictStrength } from "../src/domain/strength/model.ts";
import { strengthSummary } from "../src/domain/strength/features.ts";
import { qualityRank, strengthSample } from "../src/domain/strength/samples.ts";
const json = (p) =>
  JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
const booster = json("../public/models/xgboost20tun_booster.json"),
  calibrator = json("../public/models/xgboost20tun_residual_calibrator.json");
test("40 Java scorer vectors reproduce calibrated predictions within 1e-12", () => {
  for (const row of json("./fixtures/strength-java-golden.json"))
    assert.ok(
      Math.abs(
        predictStrength(row.features, booster, calibrator) - row.prediction,
      ) < 1e-12,
    );
});
test("Java AUTO boundaries and strict first choice are independent", () => {
  assert.equal(qualityRank(0, 0.49), 0);
  assert.equal(qualityRank(0, 0.5), 1);
  assert.equal(qualityRank(0, 1.5), 2);
  assert.equal(qualityRank(6, 0.1), 0);
  assert.equal(qualityRank(12, 0.1), 4);
  assert.equal(qualityRank(24, 0.1), 5);
  assert.equal(qualityRank(6, null), 3);
});
test("empty samples cannot produce a model rating; full29 features remain finite", () => {
  assert.equal(strengthSummary([]), null);
  const sample = {
    first: true,
    rank: 0,
    loss: 0,
    scoreLoss: 0,
    winrateLoss: 0,
    complexity: 0,
    weight: 0.05,
    quality: 0,
    best: "pass",
    visits: 100,
  };
  const s = strengthSummary(
    [60, 61, 160, 161].map((turn) => ({ turn, strength: sample })),
  );
  assert.equal(s.features.length, 29);
  assert.ok(s.features.every(Number.isFinite));
  assert.equal(s.first, 1);
  assert.equal(s.good, 1);
  assert.equal(s.features[7], 1);
});
test("candidate comparison uses mover perspective and refuses cross-job pairing", () => {
  const p = (x) => ({ point: { x, y: 0 } }),
    top = {
      vertex: p(0),
      winrate_black: 0.3,
      score_mean_black: -2,
      visits: 100,
      pv: [],
    };
  const before = {
    job_id: "a",
    visits: 100,
    candidates: [
      top,
      { ...top, vertex: p(1), score_mean_black: -1, winrate_black: 0.4 },
    ],
    winrate_black: 0.3,
    score_mean_black: -2,
  };
  const after = { ...before };
  const node = { color: "white", vertex: p(1) };
  assert.equal(strengthSample(node, before, after).scoreLoss, 1);
  assert.equal(strengthSample(node, before, { ...after, job_id: "b" }), null);
});
test("Java full aggregation, phase features and resulting predictions agree", () => {
  for (const row of json("./fixtures/strength-java-aggregate.json")) {
    const summary = strengthSummary(row.moves);
    assert.ok(Math.abs(summary.match - row.match) < 1e-12);
    assert.ok(Math.abs(summary.good - row.good) < 1e-12);
    assert.ok(
      Math.abs(
        predictStrength(summary.features, booster, calibrator) - row.prediction,
      ) < 1e-12,
    );
  }
});
