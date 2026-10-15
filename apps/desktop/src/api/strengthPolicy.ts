import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { installManagedAsset, cancelManagedDownload } from './engineTools';
import catalog from '../domain/modelCatalog.json';
import type { HumanPolicies, PolicyRequest } from '../domain/strength/human40';

export type StrengthPolicyProgress = { id: string; done: number; total: number };
export type StrengthAvailability = { engineAvailable: boolean; humanAvailable: boolean };
export async function strengthPolicyStatus() {
  if (!isTauri()) throw new Error('HumanSL 补算需在桌面应用中运行');
  return invoke<StrengthAvailability>('strength_policy_status');
}
export const runStrengthPolicies = (id: string, request: PolicyRequest) =>
  invoke<{ policies: HumanPolicies }>('strength_policy_run', { id, request });
export const cancelStrengthPolicies = (id: string) => invoke<void>('strength_policy_cancel', { id });
export const listenStrengthPolicies = (callback: (progress: StrengthPolicyProgress) => void) =>
  listen<StrengthPolicyProgress>('strength://policy-progress', e => callback(e.payload));
export async function downloadStrengthHumanModel(id: string) {
  const entry = catalog.find(e => e.purpose === 'human');
  if (!entry) throw new Error('缺少 HumanSL 下载目录');
  return installManagedAsset({ id, name: entry.name, kind: 'model', sha256: entry.sha256, url: entry.url });
}
export const cancelStrengthDownload = cancelManagedDownload;
