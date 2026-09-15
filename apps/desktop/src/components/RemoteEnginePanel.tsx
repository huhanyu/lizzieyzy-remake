import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { RemoteEngineConfig } from "../api/engineTools";
type Props = {
  onConnect: (config: RemoteEngineConfig) => Promise<void>;
  disabled?: boolean;
};
export function RemoteEnginePanel({ onConnect, disabled = false }: Props) {
  const [config, setConfig] = useState<RemoteEngineConfig>({
    host: "",
    enginePath: "katago",
    modelPath: "",
    configPath: "",
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const field = (
    key: keyof RemoteEngineConfig,
    label: string,
    placeholder = "",
  ) => (
    <label>
      {label}
      <input
        value={config[key] ?? ""}
        placeholder={placeholder}
        onChange={(e) =>
          setConfig({
            ...config,
            [key]:
              key === "port"
                ? e.target.value
                  ? Number(e.target.value)
                  : undefined
                : e.target.value,
          })
        }
      />
    </label>
  );
  async function connect() {
    setBusy(true);
    setStatus("正在通过系统 SSH 连接…");
    try {
      await onConnect(config);
      setStatus("SSH 引擎已启动，等待局面分析回执");
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="engine-search-controls">
      <summary>自建 SSH 算力</summary>
      <div className="search-controls-grid">
        {field("host", "主机 / SSH 配置别名", "my-katago")}
        {field("port", "端口（默认 22）")}
        {field("user", "用户名（可沿用 SSH 配置）")}
        {field("enginePath", "远程 KataGo 路径")}
        {field("modelPath", "远程模型路径")}
        {field("configPath", "远程配置路径")}
      </div>
      <button
        type="button"
        onClick={async () => {
          const path = await open({
            multiple: false,
            directory: false,
            title: "选择 SSH 私钥（可选）",
          });
          if (typeof path === "string")
            setConfig({ ...config, identityFile: path });
        }}
      >
        选择私钥
      </button>{" "}
      {config.identityFile && (
        <span>
          已选择私钥{" "}
          <button
            onClick={() => setConfig({ ...config, identityFile: undefined })}
          >
            清除
          </button>
        </span>
      )}
      <p>
        使用系统 SSH
        配置、ssh-agent／钥匙串；不存储密码。首次连接前请在终端确认服务器主机密钥并验证密钥登录。远程引擎和模型需已安装。
      </p>
      <button
        disabled={
          disabled ||
          busy ||
          !config.host ||
          !config.modelPath ||
          !config.configPath
        }
        onClick={() => void connect()}
      >
        {busy ? "连接中…" : "连接 SSH 引擎"}
      </button>
      <p role="status">{status}</p>
    </details>
  );
}
