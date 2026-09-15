import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type LiveSearchOptions = {
  restriction?: { mode: "allow" | "avoid"; vertices: string[] };
  maxVisits?: number;
  maxSeconds?: number;
};
export type LiveEngineParameters = {
  numSearchThreads?: number;
  analysisWideRootNoise?: number;
  playoutDoublingAdvantage?: number;
};
export type LivePausedPayload = { job_id: string; generation: number; reason: "limit" | "console" };
/** Pause retains the current process/cloud allocation. Explicit stop still releases it. */
export async function pauseLiveReview(): Promise<number> {
  if (!isTauri()) throw new Error("请在桌面应用中控制引擎");
  return invoke<number>("katago_live_review_pause");
}
/** Parameters are acknowledged by the engine, not optimistically marked as applied. */
export async function configureLiveReview(parameters: LiveEngineParameters): Promise<number> {
  if (!isTauri()) throw new Error("请在桌面应用中设置引擎");
  const bounds: Record<keyof LiveEngineParameters, [number, number]> = {
    numSearchThreads: [1, 256], analysisWideRootNoise: [0, 5], playoutDoublingAdvantage: [-3, 3]
  };
  for (const [key, value] of Object.entries(parameters)) {
    const [min, max] = bounds[key as keyof LiveEngineParameters];
    if (!Number.isFinite(value) || value < min || value > max || (key === "numSearchThreads" && !Number.isInteger(value))) {
      throw new Error("参数超出有效范围，请检查后重试");
    }
  }
  return invoke<number>("katago_live_review_configure", { parameters });
}
export async function listenToLiveReviewPaused(onPaused: (payload: LivePausedPayload) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<LivePausedPayload>("katago://live-review-paused", (event) => onPaused(event.payload));
}
