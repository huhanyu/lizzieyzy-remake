import { useEffect, useRef, useState } from 'react';
import { ArrowClockwise, DownloadSimple, GearSix, Gauge, House, Info, Stack, X } from '@phosphor-icons/react';
import { isSetupDesktop } from '../../api/oneClickSetup';
import { formatAssetSize, installedModel, pendingDownloadBytes, selectedModels } from '../../domain/setupPlan';
import { useOneClickSetup } from '../../hooks/useOneClickSetup';
import { SetupOverview } from './SetupOverview';
import { SetupModelList } from './SetupModelList';
import { SetupBenchmark } from './SetupBenchmark';
import './OneClickSetup.css';

export function OneClickSetup({ disabled, onClose, onAdvanced, onPrepare }: { onPrepare?: () => Promise<void>; disabled: boolean; onClose: () => void; onAdvanced: () => void }) {
  const c = useOneClickSetup(disabled);
  const [preparing, setPreparing] = useState(false), [prepareError, setPrepareError] = useState('');
  const [tab, setTab] = useState('overview'), [details, setDetails] = useState(false), [benchmarkBusy, setBenchmarkBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const frozen = c.busy || benchmarkBusy || preparing;
  const isDesktop = isSetupDesktop();
  useEffect(() => { dialog.current?.showModal(); }, []);
  const models = c.catalog.length ? selectedModels(c.catalog, c.plan, c.quick, c.human) : [];
  const bytes = pendingDownloadBytes(models, c.assets);
  const navigation = [
    { id: 'overview', title: '总览', icon: House }, { id: 'models', title: '模型管理', icon: Stack },
    { id: 'speed', title: '速度优化', icon: Gauge }, { id: 'downloads', title: '下载任务', icon: DownloadSimple },
  ];
  return <dialog ref={dialog} className="one-click-setup" aria-label="一键设置" onCancel={event => { event.preventDefault(); if (!frozen) onClose(); }}>
    <aside className="setup-sidebar"><h2><GearSix weight="fill" size={28} />一键设置</h2><nav aria-label="设置模块">{navigation.map(({ id, title, icon: Icon }) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}><Icon size={23} />{title}{id === 'downloads' && c.busy && <span className="setup-dot" />}</button>)}</nav>
      <button className="setup-advanced" disabled={frozen} onClick={onAdvanced}><GearSix size={22} />高级设置</button></aside>
    <div className="setup-main"><div className="setup-window-actions"><button aria-label="刷新设置" title="刷新设置" disabled={frozen || c.loading} onClick={() => void c.refresh()}><ArrowClockwise size={18} /></button><button aria-label="关闭一键设置" disabled={frozen} onClick={onClose}><X size={20} /></button></div>
      <div className="setup-scroll">
        {!isDesktop && <p className="setup-preview-note">浏览器预览 · 可查看方案；下载、设备检测与测速请在桌面应用中使用。</p>}
        {disabled && <div className="setup-preview-note">当前分析或任务正在使用引擎。请结束任务后更换配置或测速。{onPrepare && <button disabled={preparing} onClick={async () => { setPreparing(true); setPrepareError(''); try { await onPrepare(); } catch(error) { setPrepareError(String(error)); } finally { setPreparing(false); } }}>{preparing ? '正在停止…' : '停止分析以配置'}</button>}{prepareError && <p role="alert">{prepareError}</p>}</div>}
        {tab === 'overview' && <SetupOverview controller={c} disabled={disabled || benchmarkBusy} onModels={() => setTab('models')} onBenchmark={() => setTab('speed')} />}
        {tab === 'models' && <SetupModelList models={c.catalog} assets={c.assets} disabled={disabled || frozen} onSelect={model => { if (model.purpose === 'quick') c.setQuick(true); else if (model.purpose === 'human') c.setHuman(true); else c.setPlan(model.purpose); setTab('overview'); }} />}
        <div hidden={tab !== 'speed'}><header className="setup-heading"><div><h1>速度优化</h1><p>基于当前设备与模型的实际表现</p></div></header><SetupBenchmark profile={c.current?.profile} disabled={disabled || c.busy} onBusy={setBenchmarkBusy} onApplied={() => void c.refresh()} /></div>
        {tab === 'downloads' && <><header className="setup-heading"><div><h1>下载任务</h1><p>复用已校验的资源，下载失败时不会切换配置。</p></div></header><section className="setup-section"><h2>{c.busy ? c.taskName || '正在检查配置' : '当前没有下载任务'}</h2>{c.busy && <><progress value={c.progress?.received ?? 0} max={c.progress?.total || 1} /><p>{formatAssetSize(c.progress?.received ?? 0)} / {c.progress?.total ? formatAssetSize(c.progress.total) : '等待服务器返回大小'}</p><button onClick={() => void c.cancel()}>取消下载</button></>}<p>已安装的受管模型：{c.assets.filter(asset => asset.kind === 'model').length} 个</p></section></>}
        {details && <section className="setup-section setup-download-details"><h2>本次配置清单</h2>{models.map(model => <div key={model.id}><strong>{model.name}</strong><span>{installedModel(model, c.assets) ? '复用已下载模型' : formatAssetSize(model.bytes)}</span><p>{model.compatibility}</p></div>)}<p>可选模型单独安装；所有资源完成校验后才应用主模型配置。</p></section>}
      </div>
      <footer className="setup-footer"><div className="setup-footer-message"><Info size={21} /><span role="status">{c.status || (isDesktop && !c.ready ? '请先在高级设置中检查本地引擎与配置文件。' : `预计下载 ${formatAssetSize(bytes)}，完成后校验并应用配置。`)}</span></div>
        <div className="setup-footer-actions"><button onClick={() => setDetails(value => !value)}>{details ? '收起详情' : '查看详情'}</button>{c.busy ? <button onClick={() => void c.cancel()}>取消配置</button> : <button className="setup-primary" disabled={!isDesktop || disabled || benchmarkBusy || c.loading || !models.length || !c.ready} onClick={() => void c.installAndConfigure()}>{bytes ? '下载并配置' : '应用配置'}</button>}</div>
      </footer>
    </div>
  </dialog>;
}
