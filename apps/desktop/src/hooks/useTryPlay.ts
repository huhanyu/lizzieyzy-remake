import { useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { MoveVertex, PositionDto, SgfTreeDto } from "../domain/types";

export type TryPlayView = { session_id: string; sgf_text: string; node_id: string; position: PositionDto; tree: SgfTreeDto | null };
type SavedTrial = { sgf_text: string; node_id: string };

/** The original document remains owned by App; only an explicit save publishes this draft. */
export function useTryPlay(source: string, nodeId: string | null, report: (message: string) => void,
  commit: (result: SavedTrial) => Promise<void>) {
  const [trial, setTrial] = useState<TryPlayView | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await action(); }
    catch (error) { report(`试下失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { pending.current = false; setBusy(false); }
  }
  const begin = (firstMove?: MoveVertex) => run(async () => {
    if (!isTauri()) { report("试下需要 Tauri 桌面应用，浏览器仅供预览。"); return; }
    if (!nodeId) return;
    let next = await invoke<TryPlayView>("try_play_begin", { sgfText: source, nodeId });
    if (firstMove) {
      try { next = await invoke<TryPlayView>("try_play_move", { sessionId: next.session_id, vertex: firstMove }); }
      catch (error) {
        await invoke("try_play_finish", { sessionId: next.session_id, sgfText: source, save: false });
        throw error;
      }
    }
    setTrial(next); report("试下中：原棋谱保持不变，退出恢复原局面。");
  });
  const play = (vertex: MoveVertex) => run(async () => {
    if (!trial) return;
    const next = await invoke<TryPlayView>("try_play_move", { sessionId: trial.session_id, vertex });
    setTrial(next);
  });
  const finish = (save: boolean) => run(async () => {
    if (!trial) return;
    const saved = await invoke<SavedTrial | null>("try_play_finish", { sessionId: trial.session_id, sgfText: source, save });
    setTrial(null);
    if (saved) { await commit(saved); report("变化已加入棋谱，保存文件后可再次打开。"); }
    else report("已退出试下，恢复原局面。");
  });
  return { trial, busy, begin, play, finish };
}
