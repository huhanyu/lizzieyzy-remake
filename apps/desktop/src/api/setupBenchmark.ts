import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
export type BenchmarkProgress = {
  jobId: string;
  phase: 'running' | 'complete' | 'cancelled' | 'failed';
  line: string;
  recommendedThreads: number | null;
};
export type BenchmarkProfile = {
  name: string; engine_path: string; model_path: string | null;
  config_path: string | null; working_dir: string | null;
  backend: 'kata_go_gtp' | 'kata_go_analysis';
};
/** Subscribe before starting. Filter by returned jobId; preserve a bounded log buffer. */
export const onBenchmarkProgress = (callback: (event: BenchmarkProgress) => void) =>
  listen<BenchmarkProgress>('setup-benchmark-progress', event => callback(event.payload));
/** Refuses any occupied analysis slot. Does not stop analysis or change configuration. */
export async function startBenchmark(profile: BenchmarkProfile): Promise<string> {
  if (!isTauri()) throw new Error('请在桌面应用中运行真实 KataGo 测速');
  return invoke('setup_benchmark_start', { profile });
}
export const cancelBenchmark = (jobId: string) => invoke<boolean>('setup_benchmark_cancel', { jobId });

/** Real model load and GTP handshake; resolves with the engine version. */
export const probeSetupModel = (profile: BenchmarkProfile, id?: string) => invoke<string>("setup_model_probe", { profile, id: id ?? null });
export const cancelSetupProbe = (id: string) => invoke<boolean>("setup_model_probe_cancel", { id });

/** Copies configuration into managed storage and persists only a still-current trusted result. */
export const applyBenchmark = (jobId: string) => invoke<{ selected_profile_id: string; profiles: { id: string; profile: BenchmarkProfile; max_visits: number }[] }>("setup_benchmark_apply", { jobId });
