import { invoke, isTauri } from '@tauri-apps/api/core';
import catalog from '../domain/modelCatalog.json';
import type { SetupModel } from '../domain/setupPlan';

export const isSetupDesktop = isTauri;
export async function loadSetupCatalog(): Promise<SetupModel[]> {
  // The browser can inspect the same catalog, but never simulates installation.
  return isTauri() ? invoke<SetupModel[]>('engine_model_catalog') : catalog as SetupModel[];
}

export async function applySetupProfiles(expected: import('../domain/types').EngineProfilesSettingsDto, settings: import('../domain/types').EngineProfilesSettingsDto) {
  if (!isTauri()) throw new Error('请在桌面应用中应用模型配置');
  const saved = await invoke<import('../domain/types').EngineProfilesSettingsDto>('setup_apply_profiles', { expected, settings });
  window.dispatchEvent(new Event('engine-profiles-changed'));
  return saved;
}
