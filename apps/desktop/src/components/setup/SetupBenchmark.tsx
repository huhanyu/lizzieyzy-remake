import { useEffect, useRef, useState } from 'react';
import { applyBenchmark, cancelBenchmark, onBenchmarkProgress, startBenchmark, type BenchmarkProgress } from '../../api/setupBenchmark';
import { isSetupDesktop } from '../../api/oneClickSetup';
import type { EngineProfileDto } from '../../domain/types';

export function SetupBenchmark({ profile, disabled, onBusy, onApplied }: { profile?: EngineProfileDto; disabled: boolean; onBusy: (busy: boolean) => void; onApplied: () => void }) {
  const [running, setRunning] = useState(false), [lines, setLines] = useState<string[]>([]);
  const [recommendation, setRecommendation] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [completedId, setCompletedId] = useState<string | null>(null);
  const active = useRef<string | null>(null), mounted = useRef(true), busy = useRef(false);
  const listener = useRef(() => {});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; listener.current(); if (active.current) void cancelBenchmark(active.current).catch(() => {}); }; }, []);
  async function start() {
    if (!profile || busy.current || disabled) return;
    busy.current = true; setRunning(true); onBusy(true); setLines([]); setRecommendation(null); setCompletedId(null); setStatus('正在启动测速…');
    const early: BenchmarkProgress[] = []; let id: string | null = null;
    let unsubscribe = () => {};
    const receive = (event: BenchmarkProgress) => {
      if (!id) { early.push(event); return; }
      if (event.jobId !== id || !mounted.current) return;
      setLines(values => [...values, event.line].slice(-80));
      if (event.phase !== 'running') {
        active.current = null; busy.current = false; setRunning(false); onBusy(false); unsubscribe();
        setRecommendation(event.recommendedThreads);
        if (event.phase === 'complete') setCompletedId(event.jobId);
        setStatus(event.phase === 'complete' ? '测速完成' : event.phase === 'cancelled' ? '测速已取消' : '测速失败，请查看日志');
      }
    };
    try {
      unsubscribe = await onBenchmarkProgress(receive);
      listener.current = unsubscribe;
      id = await startBenchmark({ ...profile, model_path: profile.model_path ?? null, config_path: profile.config_path ?? null, working_dir: profile.working_dir ?? null, backend: profile.backend === 'kata_go_analysis' ? 'kata_go_analysis' : 'kata_go_gtp' });
      active.current = id; setStatus('测速进行中，可能需要数分钟…');
      early.forEach(receive);
    } catch (error) { unsubscribe(); busy.current = false; setRunning(false); onBusy(false); setStatus(String(error)); }
  }
  async function apply() {
    if (!completedId || disabled || busy.current) return;
    busy.current = true; onBusy(true);
    try {
      await applyBenchmark(completedId);
      window.dispatchEvent(new Event('engine-profiles-changed'));
      setCompletedId(null); setStatus('推荐线程数已保存到独立配置文件，下次开始分析时生效。'); onApplied();
    } catch (error) { setStatus(String(error)); }
    finally { busy.current = false; onBusy(false); }
  }
  return <section className="setup-section setup-benchmark"><h2>智能提升算棋速度</h2><p>用当前模型测试不同线程数。请先停止分析，测速期间不要运行其他占用算力的任务。</p>
    <p>当前配置：{profile?.name || '尚未配置'}</p>
    <button className="setup-primary" disabled={disabled || running || !profile?.model_path || !isSetupDesktop()} onClick={() => void start()}>开始实际测速</button>
    {running && <button onClick={() => { if (active.current) void cancelBenchmark(active.current).catch(error => setStatus(String(error))); }}>取消测速</button>}
    <p role="status">{status}</p>{recommendation && <p className="setup-recommendation-result">建议线程数 <strong>{recommendation}</strong></p>}
    {completedId && <button disabled={disabled || running} onClick={() => void apply()}>应用推荐线程数</button>}
    {lines.length > 0 && <details open><summary>测速日志</summary><pre>{lines.join('\n')}</pre></details>}
  </section>;
}
