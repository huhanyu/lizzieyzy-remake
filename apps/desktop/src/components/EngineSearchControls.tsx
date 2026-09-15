import { useState } from "react";
import type { LiveEngineParameters, LiveSearchOptions } from "../api/liveControls";
import "./EngineSearchControls.css";

type Props = {
  value: LiveSearchOptions;
  onChange: (value: LiveSearchOptions) => void;
  onApplyParameters: (parameters: LiveEngineParameters) => Promise<void>;
  disabled?: boolean;
  cloud?: boolean;
  serverConfig?: boolean;
};
/** Separate presentation of search policy from engine/session ownership. */
export function EngineSearchControls({ value, onChange, onApplyParameters, disabled = false, cloud = false, serverConfig = false }: Props) {
  const [threads, setThreads] = useState("");
  const [wide, setWide] = useState("");
  const [pda, setPda] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [vertices, setVertices] = useState(value.restriction?.vertices.join(", ") ?? "");
  const [mode, setMode] = useState<"all" | "allow" | "avoid">(value.restriction?.mode ?? "all");
  function changeRestriction(nextMode: typeof mode, text: string) {
    setMode(nextMode);
    setVertices(text);
    onChange({ ...value, restriction: nextMode === "all" ? undefined : {
      mode: nextMode, vertices: [...new Set(text.toUpperCase().split(/[\s,，]+/).filter(Boolean))]
    } });
  }
  async function applyParameters() {
    const parameters: LiveEngineParameters = {
      ...(threads && !cloud ? { numSearchThreads: Number(threads) } : {}),
      ...(wide ? { analysisWideRootNoise: Number(wide) } : {}),
      ...(pda ? { playoutDoublingAdvantage: Number(pda) } : {})
    };
    if (Object.keys(parameters).length === 0) { setStatus("请输入至少一项参数"); return; }
    setPending(true); setStatus("等待引擎确认…");
    try { await onApplyParameters(parameters); setStatus("引擎已确认应用参数"); }
    catch (error) { setStatus(String(error)); }
    finally { setPending(false); }
  }
  return <details className="engine-search-controls">
    <summary>实时分析设置</summary>
    <div className="search-controls-grid">
      <label>计算量上限<input aria-label="实时计算量上限" type="number" min="1" step="100" placeholder="不限" value={value.maxVisits ?? ""}
        onChange={(e) => onChange({ ...value, maxVisits: e.target.value ? Number(e.target.value) : undefined })} /></label>
      <label>时间上限 / 秒<input aria-label="实时时间上限" type="number" min="0.1" max="86400" step="1" placeholder="不限" value={value.maxSeconds ?? ""}
        onChange={(e) => onChange({ ...value, maxSeconds: e.target.value ? Number(e.target.value) : undefined })} /></label>
      <label>选点范围<select aria-label="分析选点范围" value={mode} onChange={(e) => changeRestriction(e.target.value as typeof mode, vertices)}>
        <option value="all">全部合法选点</option><option value="allow">只分析指定点</option><option value="avoid">排除指定点</option>
      </select></label>
      {mode !== "all" && <label>坐标<input aria-label="限定选点坐标" placeholder="D4, Q16" value={vertices} onChange={(e) => changeRestriction(mode, e.target.value)} /></label>}
    </div>
    <p>限额与选点范围在下次开始分析时生效；达到任一限额后暂停并保留连接。限定范围仅作用于首手。</p>
    <fieldset disabled={serverConfig} className="search-controls-grid">
      {!cloud && <label>线程数<input aria-label="搜索线程数" type="number" min="1" max="256" placeholder="保持当前" value={threads} onChange={(e) => setThreads(e.target.value)} /></label>}
      <label>搜索广度<input aria-label="搜索广度" type="number" min="0" max="5" step="0.01" placeholder="保持当前" value={wide} onChange={(e) => setWide(e.target.value)} /></label>
      <label>激进度（PDA）<input aria-label="激进度 PDA" type="number" min="-3" max="3" step="0.1" placeholder="保持当前" value={pda} onChange={(e) => setPda(e.target.value)} /></label>
    </fieldset>
    <p>{serverConfig ? "线程数、广度与 PDA 沿用远程服务端配置；本机测速及 Apple 调优不应用到远程。" : cloud ? "共享云算力线程数由服务端管理；其他参数以服务端实际确认为准。" : "留空保留引擎当前参数。更改参数可能清除当前搜索树。"}</p>
    <button type="button" disabled={disabled || pending || serverConfig} onClick={() => void applyParameters()}>{pending ? "应用中…" : "应用引擎参数"}</button>
    <span className="search-controls-status" role="status">{status}</span>
  </details>;
}
