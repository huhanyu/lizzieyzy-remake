import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { captureHuman40, human40Moves, type HumanCapture, type HumanPolicies } from '../domain/strength/human40';
import type { ReviewScope } from '../domain/reviewStatistics';
import * as api from '../api/strengthPolicy';

type Phase = 'idle' | 'preparing' | 'missing-model' | 'downloading' | 'running' | 'ready' | 'error' | 'cancelled';
export function useHumanStrength(enabled: boolean, scope: ReviewScope) {
  const captured = useMemo(() => {
    if (!enabled) return { capture: null, error: '' };
    try { return { capture: captureHuman40(scope), error: '' }; }
    catch (error) { return { capture: null, error: String(error instanceof Error ? error.message : error) }; }
  }, [enabled, scope]);
  const current = useRef<HumanCapture | null>(captured.capture);
  current.current = captured.capture;
  const generation = useRef(0), job = useRef<string | null>(null);
  const [state, setState] = useState<{ phase: Phase; error: string; done: number; total: number }>({ phase: 'idle', error: '', done: 0, total: 0 });
  const [result, setResult] = useState<{ key: string; policies: HumanPolicies } | null>(null);
  const stop = useCallback(() => {
    generation.current++;
    const id = job.current; job.current = null;
    if (id) {
      void api.cancelStrengthPolicies(id).catch(() => {});
      void api.cancelStrengthDownload(id).catch(() => {});
    }
  }, []);
  const start = useCallback(async (download = false) => {
    const capture = current.current;
    if (!capture) return;
    stop();
    const version = generation.current, id = crypto.randomUUID();
    const active = () => version === generation.current && current.current?.key === capture.key;
    job.current = id;
    setState({ phase: 'preparing', error: '', done: 0, total: capture.request.turns.length });
    let unlisten: (() => void) | undefined;
    try {
      const availability = await api.strengthPolicyStatus();
      if (!active()) return;
      if (!availability.engineAvailable) throw new Error('未找到本地 KataGo，请通过现有引擎设置安装后重试');
      if (!availability.humanAvailable) {
        if (!download) {
          setState(s => ({ ...s, phase: 'missing-model' }));
          return;
        }
        setState(s => ({ ...s, phase: 'downloading' }));
        await api.downloadStrengthHumanModel(id);
        if (!active()) return;
      }
      unlisten = await api.listenStrengthPolicies(progress => {
        if (active() && progress.id === id) setState(s => ({ ...s, phase: 'running', done: progress.done, total: progress.total }));
      });
      if (!active()) return;
      setState(s => ({ ...s, phase: 'running' }));
      const completed = await api.runStrengthPolicies(id, capture.request);
      if (!active()) return;
      setResult({ key: capture.key, policies: completed.policies });
      setState(s => ({ ...s, phase: 'ready', done: s.total }));
    } catch (error) {
      if (active()) setState(s => ({ ...s, phase: 'error', error: String(error instanceof Error ? error.message : error) }));
    } finally {
      unlisten?.();
      if (job.current === id) job.current = null;
    }
  }, [stop]);
  const runLatest = useRef(start); runLatest.current = start;
  // Streaming visit/candidate updates do not restart policy extraction. The feature calculation
  // below reuses completed policies; newly analyzed positions can be added with Refresh.
  const key = captured.capture?.key ?? '';
  useEffect(() => {
    stop(); setResult(null);
    if (enabled && key) void runLatest.current();
    else setState({ phase: 'idle', error: '', done: 0, total: 0 });
    return stop;
  }, [enabled, key, stop]);
  const enriched = useMemo(() => {
    if (!captured.capture || result?.key !== captured.capture.key) return { moves: [], error: '' };
    try { return { moves: human40Moves(captured.capture, result.policies), error: '' }; }
    catch (error) { return { moves: [], error: String(error instanceof Error ? error.message : error) }; }
  }, [captured.capture, result]);
  const cancel = useCallback(() => {
    stop();
    setState(s => ({ ...s, phase: 'cancelled' }));
  }, [stop]);
  return { ...state, error: captured.error || enriched.error || state.error, moves: enriched.moves,
    busy: ['preparing', 'downloading', 'running'].includes(state.phase),
    canStart: !!captured.capture, start, cancel };
}
