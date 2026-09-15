# Five review modules migration

Java source: PlayerStrengthEstimator, MoveRankDefinition, XGBoostStrengthModel, XGBoost20TunResidualCalibrator in the companion Java checkout.
Bundled booster and calibrator copied unchanged into apps/desktop/public/models. No Python/JVM/native XGBoost dependency at runtime. Models load once; streaming review snapshots coalesce every 500 ms. Documents, selected nodes, jobs and tree changes bypass coalescing.

## Verification
- 40 synthetic full29 vectors evaluated by freshly compiled Java scorer and calibrator. TypeScript predictions agree within 1e-12.
- Four synthetic 70-move sample sets evaluated by freshly compiled Java Accumulator. TypeScript full aggregation, match/good rates and predictions agree within 1e-12. Samples cross 60/160 phase boundaries and include missing score values.
- 17 targeted tests pass: model parity, quality boundaries, missing samples, perspective, cross-job, document and branch isolation.
- Synthetic browser QA (clearly labeled) confirmed model loading and nonempty measurements; it is not a real-game accuracy evaluation. Temporary QA entry removed.
- Actual recorded browser page shows five module tabs. Recorded data covers one position only, so missing full-game statistics correctly remain unknown.
- Native app live analysis and final nonempty compact table/bar/arrow interactions still require acceptance. Do not equate bundling with native UI verification.

## Semantics
- Java model uses its original 29 feature order and 20 selected indices; model phase boundaries remain 60/160.
- First choice is strict rank zero. Model good rate uses score-equivalent loss <1.2; display quality uses Java AUTO defaults. They must not be substituted for one another.
- Missing policy uses Java top-two loss complexity fallback, not visit share or fabricated human policy.
- Rank sigma is the original fixed 0.92, not a new confidence interval.
- Problem timeline uses Java quality classification with Zhangqi presentation/filtering; defaults to top 10, optional top 20, deduplicates consecutive same-color blunders with the same best move, jumps to parent node.
- Six quality bars compare absolute counts using common maximum; percentages use separate black/white denominators.
- Display classifies only complete same-job samples bound to the active document/branch. 1v samples are not proof of deep-review accuracy.
