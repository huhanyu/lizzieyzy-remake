import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchOnlineKifu } from "../api/onlineKifu";
import { importProviderPayload } from "../api/providers";
import {
  chessId,
  readKifuList,
  type KifuEntry,
  type KifuSource,
} from "../domain/onlineKifu";
import type { ProviderImportResult } from "../domain/providers";
import "./OnlineKifuImport.css";
type Props = {
  disabled: boolean;
  documentKey: string;
  onImport: (result: ProviderImportResult) => Promise<boolean>;
};
export function OnlineKifuImport({ disabled, documentKey, onImport }: Props) {
  const [open, setOpen] = useState(false),
    [source, setSource] = useState<KifuSource>("fox"),
    [query, setQuery] = useState(""),
    [direct, setDirect] = useState(""),
    [entries, setEntries] = useState<KifuEntry[]>([]),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [next, setNext] = useState({
      uid: "",
      cursor: "",
      hasMore: false,
      query: "",
    });
  const dialog = useRef<HTMLDialogElement>(null),
    generation = useRef(0),
    key = useRef(documentKey);
  key.current = documentKey;
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  function close() {
    generation.current++;
    setBusy(false);
    setOpen(false);
  }
  async function search(more = false) {
    const token = ++generation.current;
    setBusy(true);
    setStatus("正在查询棋谱…");
    try {
      const input = more ? (source === "fox" ? next.uid : next.query) : query;
      const response = await fetchOnlineKifu(
        source,
        "list",
        input,
        more ? next.cursor : "0",
      );
      if (token !== generation.current) return;
      const page = readKifuList(response.payload);
      setEntries((old) =>
        more
          ? [
              ...new Map(
                [...old, ...page.entries].map((e) => [e.id, e]),
              ).values(),
            ]
          : page.entries,
      );
      setNext({
        ...page,
        query: more ? next.query : query,
        uid: page.uid || input,
        hasMore: page.hasMore && page.cursor !== next.cursor,
      });
      setStatus(
        page.entries.length
          ? `找到 ${page.entries.length} 份棋谱`
          : "没有找到棋谱，请检查账号或 UID。",
      );
    } catch (e) {
      if (token === generation.current) setStatus(message(e));
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  async function download(input: string) {
    const token = ++generation.current,
      original = key.current;
    setBusy(true);
    setStatus("正在下载棋谱…");
    try {
      const id = chessId(input),
        response = await fetchOnlineKifu(source, "game", id);
      if (token !== generation.current) return;
      const result = await importProviderPayload({
        provider: "fox",
        payload: response.payload,
        source_id: id,
        metadata: {
          source_id: id,
          title: `${source === "fox" ? "野狐" : "腾讯"}棋谱 ${id}`,
          extra: { platform: source },
        },
      });
      if (token !== generation.current) return;
      if (original !== key.current)
        throw new Error("当前棋谱已切换，请重新选择要导入的棋谱。");
      if (await onImport(result)) close();
      else setStatus("已取消导入。");
    } catch (e) {
      if (token === generation.current) setStatus(message(e));
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}>
        腾讯／野狐棋谱
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className="online-kifu-dialog"
          aria-labelledby="online-kifu-title"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <section>
            <header>
              <h2 id="online-kifu-title">导入在线棋谱</h2>
              <button aria-label="关闭在线棋谱" onClick={close}>
                ×
              </button>
            </header>
            <div className="online-kifu-controls">
              <select
                aria-label="棋谱平台"
                disabled={busy}
                value={source}
                onChange={(e) => {
                  generation.current++;
                  setSource(e.target.value as KifuSource);
                  setEntries([]);
                  setNext({ uid: "", cursor: "", hasMore: false, query: "" });
                  setStatus("");
                }}
              >
                <option value="fox">野狐围棋</option>
                <option value="tencent">腾讯围棋</option>
              </select>
              <input
                aria-label="棋手账号或 UID"
                placeholder={
                  source === "fox" ? "昵称或数字 UID" : "账号或数字 UID"
                }
                value={query}
                disabled={busy}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy && query.trim()) void search();
                }}
              />
              <button
                disabled={busy || !query.trim()}
                onClick={() => void search()}
              >
                查询棋谱
              </button>
            </div>
            <div className="online-kifu-controls">
              <input
                aria-label="棋谱 ID 或分享链接"
                placeholder="棋谱 ID 或包含 chessid 的分享链接"
                value={direct}
                onChange={(e) => setDirect(e.target.value)}
                disabled={busy}
              />
              <button
                disabled={busy || !direct.trim()}
                onClick={() => void download(direct)}
              >
                直接导入
              </button>
            </div>
            <p role="status">
              {status || "查询棋手历史对局，选择棋谱导入后即可复盘。"}
            </p>
            <div className="online-kifu-list">
              <table>
                <thead>
                  <tr>
                    <th>黑方</th>
                    <th>白方</th>
                    <th>时间</th>
                    <th>手数</th>
                    <th>结果</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td>{e.black}</td>
                      <td>{e.white}</td>
                      <td>{e.date}</td>
                      <td>{e.moves}</td>
                      <td>{e.result}</td>
                      <td>
                        <button
                          disabled={busy}
                          onClick={() => void download(e.id)}
                        >
                          导入
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {next.hasMore && (
              <button disabled={busy} onClick={() => void search(true)}>
                加载更多棋谱
              </button>
            )}
          </section>
        </dialog>,
        document.body,
      )}
    </>
  );
}
function message(error: unknown) {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return String(error);
}
