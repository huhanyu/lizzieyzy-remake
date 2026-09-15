import type { ManagedAsset } from '../api/engineTools';
import type { EngineProfilesSettingsDto } from './types';

export type ModelPurpose = 'balanced' | 'deep' | 'light' | 'quick' | 'human';
export type SetupModel = {
  id: string; name: string; purpose: ModelPurpose; url: string;
  sha256: string; bytes: number; description: string; compatibility?: string;
};
export const setupPlans = [
  { id: 'balanced', title: '综合推荐', subtitle: '日常分析与复盘', description: '在分析质量与响应速度之间取得平衡。', tag: '推荐使用' },
  { id: 'deep', title: '深入研究', subtitle: '复杂局面的深入分析', description: '使用较大的模型，需要更多计算资源。', tag: '适合研究' },
  { id: 'light', title: '轻量流畅', subtitle: '更快响应', description: '较小模型，适合快速复盘与日常打谱。', tag: '轻量运行' },
] as const;

export function installedModel(model: SetupModel, assets: ManagedAsset[]) {
  return assets.find(asset => asset.kind === 'model' && asset.sha256.toLowerCase() === model.sha256.toLowerCase());
}

export function selectedModels(catalog: SetupModel[], plan: string, quick: boolean, human: boolean) {
  const purposes = [plan, ...(quick ? ['quick'] : []), ...(human ? ['human'] : [])];
  return purposes.map(purpose => {
    const model = catalog.find(item => item.purpose === purpose);
    if (!model) throw new Error('所选模型暂不可用，请刷新目录或选择其他方案。');
    return model;
  });
}

export function pendingDownloadBytes(models: SetupModel[], assets: ManagedAsset[]) {
  const pending = new Map(models.filter(model => !installedModel(model, assets)).map(model => [model.sha256, model.bytes]));
  return [...pending.values()].reduce((sum, bytes) => sum + bytes, 0);
}

/** Build one atomic settings write after every selected download has passed validation. */
export function configuredProfiles(settings: EngineProfilesSettingsDto, main: ManagedAsset, quick?: ManagedAsset): EngineProfilesSettingsDto {
  const current = settings.profiles.find(item => item.id === settings.selected_profile_id);
  if (!current?.profile.engine_path || !current.profile.config_path) throw new Error('请先在高级设置中配置本地 KataGo 引擎与配置文件。');
  // The quick profile is a secondary consumer, never overwrite it with a main selection.
  const mainId = current.id === 'one-click-quick' ? 'one-click-main' : current.id;
  const mainRecord = { ...current, id: mainId, max_visits: current.id === 'one-click-quick' ? 800 : current.max_visits,
    profile: { ...current.profile, name: current.id === 'one-click-quick' ? '主分析模型' : current.profile.name, model_path: main.path } };
  const profiles = settings.profiles.map(item => item.id === mainId ? mainRecord : item);
  if (!profiles.some(item => item.id === mainId)) profiles.push(mainRecord);
  if (quick) {
    const id = 'one-click-quick';
    const record = { id, max_visits: 200, profile: { ...current.profile, name: '走势快速补算', model_path: quick.path } };
    const index = profiles.findIndex(item => item.id === id);
    if (index < 0) profiles.push(record); else profiles[index] = record;
  }
  return { ...settings, selected_profile_id: mainId, profiles };
}

export const formatAssetSize = (bytes: number) => bytes >= 1073741824
  ? `${(bytes / 1073741824).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(1)} MB`;
