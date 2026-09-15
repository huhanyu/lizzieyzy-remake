import { useState } from "react";
import { queryGtpConsole } from "../api/engineTools";
export function GtpConsole({ disabled = false }: { disabled?: boolean }) {
  const [command, setCommand] = useState("name");
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<string[]>([]);
  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await queryGtpConsole(command);
      setEntries((prev) => [...prev, `> ${command}\n${response}`].slice(-30));
    } catch (e) {
      setEntries((prev) => [...prev, `> ${command}\n${String(e)}`].slice(-30));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="engine-search-controls">
      <summary>GTP 查询控制台</summary>
      <p>
        查询会暂停分析并保留连接。仅允许只读命令；落子和参数修改请使用对应界面。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          aria-label="GTP 查询命令"
          value={command}
          maxLength={128}
          onChange={(e) => setCommand(e.target.value)}
          list="gtp-queries"
        />
        <datalist id="gtp-queries">
          {[
            "name",
            "version",
            "showboard",
            "get_komi",
            "kata-get-rules",
            "kata-get-param numSearchThreads",
            "kata-get-models",
            "list_commands",
          ].map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <button disabled={disabled || busy}>{busy ? "查询中…" : "发送"}</button>
        <button type="button" onClick={() => setEntries([])}>
          清空
        </button>
      </form>
      <pre
        aria-live="polite"
        style={{
          maxHeight: 240,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          fontSize: 12,
        }}
      >
        {entries.join("\n")}
      </pre>
    </details>
  );
}
