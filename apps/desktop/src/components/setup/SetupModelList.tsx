import { formatAssetSize, installedModel, type SetupModel } from '../../domain/setupPlan';
import type { ManagedAsset } from '../../api/engineTools';

export function SetupModelList({ models, assets, onSelect, disabled }: { models: SetupModel[]; assets: ManagedAsset[]; disabled: boolean; onSelect: (model: SetupModel) => void }) {
  return <><header className="setup-heading"><div><h1>模型管理</h1><p>官方固定版本目录 · 下载时自动校验完整性</p></div></header>
    <div className="setup-model-list">{models.map(model => <article key={model.id}>
      <div><h2>{model.name}</h2><p>{model.description}</p><small>{model.compatibility}</small></div>
      <div><span>{formatAssetSize(model.bytes)}</span><small>{installedModel(model, assets) ? '已下载' : '未下载'}</small><button disabled={disabled} onClick={() => onSelect(model)}>选择{['quick', 'human'].includes(model.purpose) ? '模块' : '方案'}</button></div>
    </article>)}</div>
  </>;
}
