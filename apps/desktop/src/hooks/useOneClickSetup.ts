import { useEffect, useRef, useState } from 'react';
import { checkEngineAssets, loadEngineProfilesSettings } from '../api/backend';
import { cancelManagedDownload, detectEngineHardware, installManagedAsset, listManagedAssets, listenAssetProgress, type AssetProgress, type HardwareInfo, type ManagedAsset } from '../api/engineTools';
import { cancelSetupProbe, probeSetupModel } from '../api/setupBenchmark';
import { applySetupProfiles, isSetupDesktop, loadSetupCatalog } from '../api/oneClickSetup';
import { selectedModels, type SetupModel } from '../domain/setupPlan';
import { runSetupWorkflow } from '../domain/setupWorkflow';
import type { EngineProfilesSettingsDto } from '../domain/types';

export function useOneClickSetup(disabled: boolean) {
  const [catalog, setCatalog] = useState<SetupModel[]>([]);
  const [assets, setAssets] = useState<ManagedAsset[]>([]);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [settings, setSettings] = useState<EngineProfilesSettingsDto | null>(null);
  const [ready, setReady] = useState(false);
  const [plan, setPlan] = useState('balanced');
  const [quick, setQuick] = useState(false), [human, setHuman] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<AssetProgress | null>(null);
  const [taskName, setTaskName] = useState('');
  const mounted = useRef(true), running = useRef(false), cancelled = useRef(false);
  const probeId = useRef<string | null>(null);
  const activeId = useRef<string | null>(null), disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const current = settings?.profiles.find(item => item.id === settings.selected_profile_id);

  async function refresh() {
    setLoading(true);
    try {
      const [models, profiles] = await Promise.all([loadSetupCatalog(), loadEngineProfilesSettings()]);
      if (!mounted.current) return;
      setCatalog(models); setSettings(profiles);
      if (isSetupDesktop()) {
        const [device, installed] = await Promise.all([detectEngineHardware(), listManagedAssets()]);
        if (!mounted.current) return;
        setHardware(device); setAssets(installed);
        const profile = profiles.profiles.find(item => item.id === profiles.selected_profile_id)?.profile;
        const checks = profile ? await checkEngineAssets(profile) : [];
        if (mounted.current) setReady(checks.length > 0 && checks.filter(item => item.required && item.label !== 'model').every(item => item.exists));
      }
    } catch (error) { if (mounted.current) setStatus(String(error)); }
    finally { if (mounted.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    let unlisten = () => {};
    void listenAssetProgress(value => { if (mounted.current && value.id === activeId.current) setProgress(value); })
      .then(fn => { if (mounted.current) unlisten = fn; else fn(); }).catch(error => { if (mounted.current) setStatus(String(error)); });
    return () => { mounted.current = false; cancelled.current = true; unlisten(); if (probeId.current) void cancelSetupProbe(probeId.current).catch(() => {}); if (activeId.current) void cancelManagedDownload(activeId.current).catch(() => {}); };
  }, []);

  async function cancel() {
    cancelled.current = true;
    setStatus('正在取消，已完成的下载会保留。');
    if (probeId.current) await cancelSetupProbe(probeId.current).catch(() => {});
    if (activeId.current) await cancelManagedDownload(activeId.current).catch(() => {});
  }

  async function installAndConfigure() {
    if (running.current || disabledRef.current || !isSetupDesktop()) return;
    running.current = true; cancelled.current = false; setBusy(true); setStatus('正在检查当前配置…');
    try {
      const selected = selectedModels(catalog, plan, quick, human);
      const saved = await runSetupWorkflow(selected, {
        load: loadEngineProfilesSettings, save: applySetupProfiles, list: listManagedAssets,
        assertAvailable: () => {
          if (cancelled.current || !mounted.current) throw new Error('已取消配置，未切换模型。');
          if (disabledRef.current) throw new Error('引擎正在使用。下载已保留，请结束分析后重新应用。');
        },
        check: async (profile, includeModel) => {
          const checks = await checkEngineAssets(profile);
          if (checks.some(item => item.required && (includeModel || item.label !== 'model') && !item.exists)) throw new Error('引擎资源检查失败，请在高级设置中检查文件。');
        },
        probe: async profile => {
          const id = crypto.randomUUID(); probeId.current = id;
          try { return await probeSetupModel({ ...profile, model_path: profile.model_path ?? null, config_path: profile.config_path ?? null, working_dir: profile.working_dir ?? null, backend: 'kata_go_gtp' }, id); }
          finally { probeId.current = null; }
        },
        onValidating: () => { if (mounted.current) setStatus('正在实际加载模型，验证引擎兼容性…'); },
        onInstalled: assets => { if (mounted.current) setAssets(assets); },
        install: async model => {
          const id = crypto.randomUUID(); activeId.current = id;
          setTaskName(model.name); setProgress(null); setStatus(`正在下载 ${model.name}…`);
          try { return await installManagedAsset({ id, name: model.name, kind: 'model', url: model.url, sha256: model.sha256 }); }
          finally { activeId.current = null; }
        },
      });
      if (mounted.current) {
        setSettings(saved); setReady(true);
        setStatus(`配置已保存，下次开始分析时使用新模型。${quick ? '已创建独立的“走势快速补算”配置。' : ''}${human ? '人类风格模型已下载，尚未启用。' : ''}`);
      }
    } catch (error) { if (mounted.current) setStatus(cancelled.current ? '已取消，未切换配置；已下载的完整资源可复用。' : String(error)); }
    finally { activeId.current = null; running.current = false; if (mounted.current) { setBusy(false); setTaskName(''); } }
  }
  return { catalog, assets, hardware, settings, current, ready, plan, setPlan, quick, setQuick, human, setHuman, status, busy, loading, progress, taskName, refresh, cancel, installAndConfigure };
}
