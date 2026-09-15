import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { cloudRetryDelay } from "../domain/cloudRetry";

type Options = {
  canStart: () => boolean;
  prepare: () => Promise<void>;
  position: () => { boardSize: number; turn: number };
  activate: (jobId: string) => void;
  stop: () => Promise<void>;
};

/** One cloud connection intent owns startup, bounded recovery and its cancellation. */
export function useCloudCompute(options: Options) {
  const latest = useRef(options); latest.current = options;
  const mounted = useRef(true);
  const selected = useRef<"local" | "cloud">("local");
  const [source, setSource] = useState<"local" | "cloud">("local");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reconnectStatus, setReconnectStatus] = useState("");
  const pending = useRef<Promise<void> | null>(null);
  const stopping = useRef<Promise<void> | null>(null);
  const intent = useRef(0);
  const wanted = useRef(false);
  const attempts = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stableTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function clearTimers() {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (stableTimer.current) clearTimeout(stableTimer.current);
    retryTimer.current = null; stableTimer.current = null;
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; wanted.current = false; ++intent.current; clearTimers(); }; }, []);
  function cancelIntent() { wanted.current = false; ++intent.current; clearTimers(); if (mounted.current) setReconnectStatus(""); }
  function selectLocal() { cancelIntent(); selected.current = "local"; setSource("local"); }
  function scheduleRecovery() {
    if (!mounted.current || !wanted.current || selected.current !== "cloud" || retryTimer.current) return;
    const delay = cloudRetryDelay(attempts.current);
    if (delay === null) { wanted.current = false; setReconnectStatus("自动重连已停止，请手动连接"); return; }
    const epoch = intent.current;
    setReconnectStatus(`${delay / 1000} 秒后重连（${attempts.current + 1}/5）`);
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      if (!wanted.current || epoch !== intent.current || !mounted.current) return;
      // Waiting for a previous allocation must not overlap another allocation.
      if (pending.current || stopping.current) { void (pending.current ?? stopping.current)?.finally(() => scheduleRecovery()).catch(() => {}); return; }
      ++attempts.current;
      void start(epoch).catch(() => scheduleRecovery());
    }, delay);
  }
  function ended() {
    if (stableTimer.current) clearTimeout(stableTimer.current);
    if (mounted.current) setConnected(false);
    scheduleRecovery();
  }
  async function start(epoch: number) {
    if (pending.current || stopping.current) return;
    if (!isTauri() || !latest.current.canStart()) throw new Error("云算力当前无法启动");
    setBusy(true);
    const task = (async () => {
      let created = false;
      try {
        await latest.current.prepare();
        if (!wanted.current || epoch !== intent.current) return;
        const jobId = await invoke<string>("zhizi_start_live_review", { ...latest.current.position(), intervalCentisec: 10 });
        if (!jobId) throw new Error("云算力未返回会话");
        created = true;
        if (!mounted.current || !wanted.current || epoch !== intent.current) { await latest.current.stop(); return; }
        latest.current.activate(jobId);
        setConnected(true); setReconnectStatus("");
        stableTimer.current = setTimeout(() => { if (epoch === intent.current) attempts.current = 0; }, 30000);
      } catch (error) {
        if (created) await latest.current.stop();
        throw error;
      }
    })();
    pending.current = task;
    try { await task; }
    catch (error) { if (mounted.current) setConnected(false); throw error; }
    finally { pending.current = null; if (mounted.current && !stopping.current) setBusy(false); }
  }
  async function connect() {
    if (pending.current || stopping.current) return;
    clearTimers(); ++intent.current; wanted.current = true; attempts.current = 0;
    selected.current = "cloud"; setSource("cloud");
    try { await start(intent.current); }
    catch (error) { cancelIntent(); throw error; } // Initial auth/entitlement failures are not retried.
  }
  async function disconnect() {
    cancelIntent();
    if (stopping.current) return stopping.current;
    if (selected.current === "local" && !pending.current) return;
    setBusy(true);
    const task = (async () => {
      await pending.current?.catch(() => {});
      await latest.current.stop();
      if (mounted.current) setConnected(false);
    })();
    stopping.current = task;
    try { await task; }
    finally { stopping.current = null; if (mounted.current) setBusy(false); }
  }
  return { source, sourceRef: selected, connected, busy, reconnectStatus, connect, disconnect, ended, selectLocal,
    isPending: () => pending.current !== null || stopping.current !== null };
}
