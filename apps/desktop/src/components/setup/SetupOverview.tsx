import { CheckCircle, Gauge, Info, TrendUp, UserCircle } from '@phosphor-icons/react';
import { formatAssetSize, installedModel, setupPlans } from '../../domain/setupPlan';
import type { useOneClickSetup } from '../../hooks/useOneClickSetup';

type Controller = ReturnType<typeof useOneClickSetup>;
export function SetupOverview({ controller: c, disabled, onModels, onBenchmark }: {
  controller: Controller; disabled: boolean; onModels: () => void; onBenchmark: () => void;
}) {
  const frozen = disabled || c.busy;
  return <>
    <header className="setup-heading"><div><h1>为你的电脑准备好分析引擎</h1><p>选择适合的配置，完成模型下载与设置。</p></div>
      <span className="setup-device">{c.hardware ? `${c.hardware.gpus[0] || c.hardware.arch} · ${c.hardware.os}` : '设备信息待检测'}</span>
    </header>
    <div className="setup-recommendations" role="group" aria-label="分析方案">
      {setupPlans.map((plan, index) => {
        const model = c.catalog.find(item => item.purpose === plan.id);
        return <button key={plan.id} className={`setup-plan ${c.plan === plan.id ? 'selected' : ''}`} disabled={frozen || !model}
          aria-pressed={c.plan === plan.id} onClick={() => c.setPlan(plan.id)}>
          <div className="setup-plan-title"><div className="setup-stones" aria-hidden="true"><img src={`/themes/photorealistic/${index === 2 ? 'white' : 'black'}.png`} /><img src={`/themes/photorealistic/${index === 2 ? 'black' : 'white'}.png`} /></div><div><h2>{plan.title}</h2><span>{plan.subtitle}</span></div>{c.plan === plan.id && <CheckCircle weight="fill" size={23} />}</div>
          <p>{plan.description}</p><span className="setup-tag">{plan.tag}</span>
          <small>{model ? `${formatAssetSize(model.bytes)} · ${installedModel(model, c.assets) ? '已下载' : '按需下载'}` : '目录加载中'}</small>
        </button>;
      })}
    </div>
    <section className="setup-section"><div className="setup-section-heading"><h2>当前引擎配置</h2><button className="setup-link" onClick={onModels}>查看模型</button></div>
      <div className="setup-current">
        <div><img src="/themes/photorealistic/black.png" alt="" /><div><h3>KataGo <span className="setup-tag">{c.ready ? '资源就绪' : '待检查'}</span></h3><p>{c.current?.profile.name || '尚未配置本地引擎'}</p></div></div>
        <div><img src="/themes/photorealistic/white.png" alt="" /><div><h3>分析模型</h3><p title={c.current?.profile.model_path || ''}>{c.assets.find(asset => asset.path === c.current?.profile.model_path)?.name || c.current?.profile.model_path?.split(/[\\/]/).pop() || '尚未选择模型'}</p></div></div>
      </div>
      <div className="setup-current-note"><Info size={18} /><span>下载并验证完成后保存配置，下次开始分析时使用。</span></div>
    </section>
    <div className="setup-bottom-grid"><section className="setup-section"><h2>按需添加</h2>
      <label className="setup-addon"><TrendUp size={27} /><span><strong>走势快速补算</strong><small>下载轻量模型，创建独立的补算配置。</small></span><input type="checkbox" role="switch" aria-label="走势快速补算" checked={c.quick} disabled={frozen || !c.catalog.some(m => m.purpose === 'quick')} onChange={e => c.setQuick(e.target.checked)} /></label>
      <label className="setup-addon"><UserCircle size={27} /><span><strong>人类风格模型</strong><small>下载 HumanSL 资源；本次仅安装，不自动启用。</small></span><input type="checkbox" role="switch" aria-label="人类风格模型" checked={c.human} disabled={frozen || !c.catalog.some(m => m.purpose === 'human')} onChange={e => c.setHuman(e.target.checked)} /></label>
    </section><section className="setup-section setup-speed"><Gauge size={28} /><h2>速度优化</h2><p>使用当前模型进行实际测速，获取适合设备的线程数建议。</p><button onClick={onBenchmark}>开始测速</button></section></div>
  </>;
}
