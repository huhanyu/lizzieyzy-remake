import { useEffect, useRef, useState, type ReactNode } from 'react';

export function AnalysisShortcuts({ source, disabled, quickBusy, onQuick, onCancelQuick, onSwitch, children }: {
  source: string; disabled: boolean; quickBusy: boolean;
  onQuick: () => Promise<void>; onCancelQuick: () => Promise<void>;
  onSwitch: (source: 'local' | 'cloud') => Promise<void>; children: ReactNode;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && menu.current) menu.current.open = false; };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('pointerdown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, []);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  async function switchTo(next: 'local' | 'cloud') {
    if (switching) return;
    setSwitching(true); setError('');
    try { await onSwitch(next); } catch (e) { setError(String(e)); }
    finally { setSwitching(false); }
  }
  return <div className="analysis-shortcuts">
    <button disabled={disabled} title="独立本地模型，每局面 1 次搜索" onClick={() => void (quickBusy ? onCancelQuick() : onQuick()).catch(e => setError(String(e)))}>{quickBusy ? '停止补线' : '快速补线'}</button>
    <details ref={menu} className="legacy-menu analysis-shortcuts-menu"><summary>全局分析</summary><div className="legacy-menu-popover analysis-shortcuts-popover">{children}</div></details>
    <div className="engine-source-switch" role="group" aria-label="切换分析引擎">
      <button disabled={disabled || switching} aria-pressed={source === 'local'} onClick={() => void switchTo('local')}>本地</button>
      <button disabled={disabled || switching} aria-pressed={source === 'cloud'} onClick={() => void switchTo('cloud')}>智子云</button>
    </div>
    {switching && <span role="status">切换中…</span>}
    {error && <span role="alert" title={error}>{error}</span>}
  </div>;
}
