import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { setLiveReviewPosition, replaySgfPositionAtNode } from '../api/backend';
import { buildLivePosition } from '../domain/livePosition';
import { analyzedVisits, planFullGameReview, ScanFrameGate, type ScanFrame, type ScanOptions, type ScanTarget } from '../domain/fullGameReview';
import type { AnalysisFrameDto, GameDto, PositionDto, SgfTreeDto } from '../domain/types';

type Input = {
  sgfText?: string; documentKey: string; configurationKey: string; jobId: string | null;
  game: GameDto | null; tree: SgfTreeDto | null; positions: readonly PositionDto[];
  frames: readonly AnalysisFrameDto[];
  /** Drain and invalidate any ordinary foreground set-position queue. */
  beforeStart: () => Promise<void>;
  onAccepted: (frame: AnalysisFrameDto) => void;
  /** Force a fresh foreground set-position after releasing busyRef. */
  onReturnToForeground: () => void | Promise<void>;
};
type Progress = { status: 'idle' | 'running' | 'paused' | 'complete' | 'error'; completed: number; total: number; turn: number; phase: string; error?: string };
const initial: Progress = {status:'idle', completed:0, total:0, turn:0, phase:''};
export function useFullGameReview(input: Input) {
  const latest = useRef(input); latest.current = input;
  const busyRef = useRef(false), version = useRef(0);
  const ownerJob = useRef<string | null>(null);
  const gate = useRef<ScanFrameGate | null>(null), wake = useRef<(() => void) | null>(null);
  const command = useRef<Promise<unknown>>(Promise.resolve());
  const plan = useRef<ScanTarget[]>([]), cursor = useRef(0), optionsRef = useRef<ScanOptions | null>(null);
  const [progress, setProgress] = useState<Progress>(initial);
  const release = () => { gate.current?.close(); gate.current = null; wake.current?.(); wake.current = null; };
  const halt = useCallback(async (status: 'paused' | 'idle', returnToForeground = false) => {
    const ticket = ++version.current; release();
    const wasBusy = busyRef.current;
    if (wasBusy) {
      await command.current.catch(() => undefined);
      if (ownerJob.current === latest.current.jobId) {
        try { await invoke<number>('katago_live_review_pause'); }
        catch (error) {
          if (ticket !== version.current) return;
          setProgress(p => ({...p,status:'error',error:`暂停未确认：${String(error)}`}));
          throw error; // retain exclusive ownership until stop is confirmed or this job ends
        }
      }
    }
    if (ticket !== version.current) return;
    busyRef.current = false;
    if (status === 'idle') { plan.current = []; cursor.current = 0; optionsRef.current = null; }
    setProgress(p => status === 'idle' ? initial : {...p, status});
    if (returnToForeground && wasBusy) await latest.current.onReturnToForeground();
    // Paused scan keeps the engine stopped; resume reissues its target.
  }, []);
  const run = useCallback(async () => {
    if (busyRef.current) return;
    const context = latest.current;
    if (!context.jobId || !context.game || !context.tree || !optionsRef.current) {
      setProgress(p => ({...p,status:'error',error:'请先连接引擎并载入棋谱。'})); return;
    }
    const ticket = ++version.current;
    busyRef.current = true; ownerJob.current = context.jobId;
    setProgress(p => ({...p,status:'running',error:undefined,total:plan.current.length}));
    try {
      await context.beforeStart();
      const coverage = optionsRef.current.incremental ? analyzedVisits(context.frames.filter(frame => frame.job_id === context.jobId), context.documentKey) : new Map<string, number>();
      const positionsByNode = new Map<string, PositionDto>();
      if (optionsRef.current.allBranches && !context.sgfText) throw new Error('全分支分析需要原始棋谱内容。');
      while (cursor.current < plan.current.length && ticket === version.current) {
        const target = plan.current[cursor.current];
        setProgress(p => ({...p,turn:target.turn,phase:target.phase === 'coarse' ? '快速粗扫' : '深度分析',completed:cursor.current}));
        if ((optionsRef.current.incremental || target.phase === 'deep') && (coverage.get(target.nodeId) ?? 0) >= target.visits) { cursor.current++; continue; }
        let position = positionsByNode.get(target.nodeId);
        if (!position) {
          position = context.sgfText ? await replaySgfPositionAtNode(context.sgfText, target.nodeId) : context.positions.find(p => p.move_number === target.turn);
          if (position) positionsByNode.set(target.nodeId, position);
        }
        if (ticket !== version.current) break;
        if (!position) throw new Error(`缺少第 ${target.turn} 手局面，已停止扫描。`);
        const request = buildLivePosition(context.game, position, context.tree, target.nodeId);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let rejectWait: (error: Error) => void = () => {};
        const finished = new Promise<void>((resolve, reject) => {
          rejectWait = reject;
          wake.current = resolve;
        });
        const targetGate = new ScanFrameGate(context.jobId, target, frame => {
          coverage.set(target.nodeId, Math.max(coverage.get(target.nodeId) ?? 0, frame.visits));
          context.onAccepted({...frame, node_id:JSON.stringify([context.documentKey,target.nodeId,position])});
        }, () => wake.current?.());
        gate.current = targetGate;
        try {
          command.current = setLiveReviewPosition(request.moves, request.turn, 10, request.player, request.komi, request.boardSize, request.setup, request.rules, request.handicap, {maxVisits: target.visits});
          const generation = await command.current as number;
          if (ticket !== version.current) break;
          timeout = setTimeout(() => rejectWait(new Error(`第 ${target.turn} 手等待分析超过 120 秒，可暂停后重试。`)), 120000);
          targetGate.acknowledge(generation);
          await finished;
          if (ticket !== version.current) break;
          cursor.current++;
        } finally { if (timeout) clearTimeout(timeout); targetGate.close(); if (gate.current === targetGate) release(); }
      }
      if (ticket !== version.current) return;
      // Stop the final target before releasing foreground ownership.
      command.current = invoke<number>('katago_live_review_pause'); await command.current;
      if (ticket !== version.current) return;
      busyRef.current = false;
      setProgress(p => ({...p,status:'complete',completed:plan.current.length}));
      await latest.current.onReturnToForeground();
    } catch (error) {
      if (ticket !== version.current) return;
      release();
      let stopped = context.jobId !== latest.current.jobId;
      if (!stopped) {
        try { await invoke<number>('katago_live_review_pause'); stopped = true; } catch { /* retain owner until explicit stop */ }
      }
      if (ticket !== version.current) return;
      busyRef.current = !stopped;
      setProgress(p => ({...p,status:'error',error:error instanceof Error ? error.message : '全盘分析失败'}));
    }
  }, []);
  const start = useCallback(async (options: ScanOptions) => {
    try { await halt('idle'); } catch { return; }
    if (busyRef.current) return;
    if (!latest.current.tree) return;
    optionsRef.current = options;
    try { plan.current = planFullGameReview(latest.current.tree, options); }
    catch (error) { optionsRef.current = null; plan.current = []; setProgress(p => ({...p,status:'error',error:String(error)})); return; }
    cursor.current = 0;
    await run();
  }, [halt,run]);
  const consumeFrame = useCallback((payload: ScanFrame): boolean => {
    if (!busyRef.current) return false;
    gate.current?.consume(payload); return true;
  }, []);
  useEffect(() => { void halt('idle').catch(() => undefined); }, [input.documentKey,input.configurationKey,input.jobId,halt]);
  useEffect(() => () => { version.current++; release(); busyRef.current = false; }, []);
  return {progress,busyRef,start,resume:run,pause:() => halt('paused'),cancel:(options?: {returnToForeground?: boolean}) => halt('idle', options?.returnToForeground ?? true),consumeFrame};
}
export type FullGameReviewController = ReturnType<typeof useFullGameReview>;
