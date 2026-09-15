import { clamp } from "./samples.ts";
import { featureIndices } from "./features.ts";
type Tree = {
  left_children: number[];
  right_children: number[];
  split_indices: number[];
  split_conditions: number[];
  default_left: number[];
};
export type Booster = {
  learner: {
    learner_model_param: { base_score: string; num_feature: string };
    gradient_booster: { model: { trees: Tree[] } };
  };
};
export type Calibrator = {
  final_calibrator: {
    spec: {
      gate_start: number;
      gate_full: number;
      correction_min: number;
      correction_max: number;
    };
    feature_order: string[];
    scaler_mean: number[];
    scaler_scale: number[];
    intercept: number;
    coefficients: number[];
  };
  quality_gate_thresholds: Record<string, number[]>;
};
export function predictStrength(
  full: number[],
  booster: Booster,
  calibration: Calibrator,
) {
  if (full.length !== 29 || full.some((n) => !Number.isFinite(n))) return null;
  const selected = featureIndices.map((i) => full[i]),
    learner = booster.learner;
  if (Number(learner.learner_model_param.num_feature) !== selected.length)
    return null;
  let value = Number(
    learner.learner_model_param.base_score.replace(/[\[\]]/g, ""),
  );
  for (const tree of learner.gradient_booster.model.trees) {
    let node = 0;
    while (tree.left_children[node] !== -1)
      node =
        selected[tree.split_indices[node]] < tree.split_conditions[node]
          ? tree.left_children[node]
          : tree.right_children[node];
    value += tree.split_conditions[node];
  }
  value = clamp(value, -1, 12);
  const c = calibration.final_calibrator,
    spec = c.spec;
  const features: Record<string, number> = {
    base_prediction: value,
    match_rate: full[7],
    first_choice_rate: full[0],
    top5_rate: full[2],
    weighted_loss_fit: full[10],
    difficulty_fit: full[18],
  };
  let correction = c.intercept;
  for (let i = 0; i < c.coefficients.length; i++) {
    const name = c.feature_order[i],
      x = name.startsWith("hinge_above_")
        ? Math.max(0, value - Number(name.slice(12)))
        : features[name];
    if (!Number.isFinite(x)) return null;
    correction +=
      (c.coefficients[i] * (x - c.scaler_mean[i])) / (c.scaler_scale[i] || 1);
  }
  const quality = Math.max(
    ...["match_rate", "top5_rate", "weighted_loss_fit"].map((name) => {
      const [a, b] = calibration.quality_gate_thresholds[name];
      return clamp((features[name] - a) / Math.max(b - a, 1e-9));
    }),
  );
  return clamp(
    value +
      clamp(
        (value - spec.gate_start) /
          Math.max(spec.gate_full - spec.gate_start, 1e-9),
      ) *
        quality *
        clamp(correction, spec.correction_min, spec.correction_max),
    -1,
    12,
  );
}
let bundle: Promise<[Booster, Calibrator]> | undefined;
export function loadStrengthModel() {
  return (bundle ??= Promise.all(
    ["xgboost20tun_booster", "xgboost20tun_residual_calibrator"].map(
      async (name) => {
        const response = await fetch(`/models/${name}.json`);
        if (!response.ok) throw new Error("棋力模型加载失败");
        return response.json();
      },
    ),
  ) as Promise<[Booster, Calibrator]>);
}
