import type { ManagedAsset } from '../api/engineTools';
import type { EngineProfileDto, EngineProfilesSettingsDto } from './types';
import { configuredProfiles, installedModel, type SetupModel } from './setupPlan.ts';

export type SetupWorkflowIO = {
  load: () => Promise<EngineProfilesSettingsDto>;
  save: (expected: EngineProfilesSettingsDto, settings: EngineProfilesSettingsDto) => Promise<EngineProfilesSettingsDto>;
  list: () => Promise<ManagedAsset[]>;
  install: (model: SetupModel) => Promise<ManagedAsset>;
  check: (profile: EngineProfileDto, includeModel: boolean) => Promise<void>;
  probe: (profile: EngineProfileDto) => Promise<unknown>;
  assertAvailable: () => void;
  onInstalled: (assets: ManagedAsset[]) => void;
  onValidating: () => void;
};

/** Download independently; commit the new profile set only after every validation succeeds. */
export async function runSetupWorkflow(models: SetupModel[], io: SetupWorkflowIO) {
  io.assertAvailable();
  const before = await io.load();
  const current = before.profiles.find(item => item.id === before.selected_profile_id);
  if (!current?.profile.engine_path || !current.profile.config_path) throw new Error('请先在高级设置中配置本地引擎与配置文件。');
  await io.check(current.profile, false);
  let installed = await io.list();
  const resolved = new Map<string, ManagedAsset>();
  for (const model of models) {
    io.assertAvailable();
    let asset = installedModel(model, installed);
    if (!asset) {
      asset = await io.install(model);
      installed = [...installed, asset];
      io.onInstalled(installed);
    }
    resolved.set(model.purpose, asset);
  }
  io.assertAvailable();
  const main = models.find(model => !['quick', 'human'].includes(model.purpose));
  if (!main) throw new Error('请选择主分析方案。');
  const next = configuredProfiles(before, resolved.get(main.purpose)!, resolved.get('quick'));
  io.onValidating();
  const changed = [next.profiles.find(item => item.id === next.selected_profile_id)!, ...(resolved.has('quick') ? next.profiles.filter(item => item.id === 'one-click-quick') : [])];
  const validated = new Set<string>();
  for (const record of changed) {
    io.assertAvailable();
    await io.check(record.profile, true);
    // Main and quick can use the same file: one actual load is sufficient.
    const key = JSON.stringify([record.profile.engine_path, record.profile.config_path, record.profile.model_path, record.profile.working_dir]);
    if (!validated.has(key)) { await io.probe(record.profile); validated.add(key); }
  }
  io.assertAvailable();
  if (JSON.stringify(await io.load()) !== JSON.stringify(before)) throw new Error('引擎配置在下载期间发生变化。下载已保留，请重新确认并应用。');
  io.assertAvailable();
  return io.save(before, next);
}
