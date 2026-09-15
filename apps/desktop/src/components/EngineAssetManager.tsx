import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cleanupManagedDownloads,
  cancelManagedDownload,
  detectEngineHardware,
  importManagedAsset,
  installManagedAsset,
  listManagedAssets,
  listenAssetProgress,
  loadEngineCatalog,
  removeManagedAsset,
  type ManagedAsset,
  type AssetProgress,
  type HardwareInfo,
  type ReleaseCatalog,
} from "../api/engineTools";
export function EngineAssetManager({
  onUseAsset,
  disabled = false,
}: {
  onUseAsset?: (asset: ManagedAsset) => void;
  disabled?: boolean;
}) {
  const [assets, setAssets] = useState<ManagedAsset[]>([]);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [catalog, setCatalog] = useState<ReleaseCatalog | null>(null);
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState<"engine" | "model">("engine");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [sha, setSha] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [progress, setProgress] = useState<AssetProgress | null>(null);
  const refresh = async () => setAssets(await listManagedAssets());
  useEffect(() => {
    let alive = true;
    let cleanup = () => {};
    Promise.all([detectEngineHardware(), listManagedAssets()])
      .then(([h, a]) => {
        if (alive) {
          setHardware(h);
          setAssets(a);
        }
      })
      .catch((e) => {
        if (alive) setStatus(String(e));
      });
    listenAssetProgress((p) => {
      if (alive) setProgress(p);
    }).then((fn) => {
      if (alive) cleanup = fn;
      else fn();
    });
    return () => {
      alive = false;
      cleanup();
    };
  }, []);
  async function install() {
    const id = crypto.randomUUID();
    setActive(id);
    setProgress(null);
    setStatus("开始下载并校验…");
    try {
      const asset = await installManagedAsset({
        id,
        name,
        url,
        sha256: sha,
        kind,
      });
      await refresh();
      setStatus(`已安装 ${asset.name}`);
    } catch (e) {
      setStatus(String(e));
    } finally {
      setActive(null);
    }
  }
  async function importFile() {
    try {
      const path = await open({
        multiple: false,
        directory: false,
        title:
          kind === "engine" ? "导入本地 KataGo 可执行文件" : "导入模型文件",
      });
      if (typeof path === "string") {
        setStatus("正在复制并校验本地资源…");
        await importManagedAsset(path, kind);
        await refresh();
        setStatus("本地资源已导入");
      }
    } catch (e) {
      setStatus(String(e));
    }
  }
  return (
    <details className="engine-search-controls">
      <summary>引擎与模型安装管理</summary>
      {hardware && (
        <p>
          {hardware.os} · {hardware.arch} · {hardware.threads} 个逻辑处理器
          <br />
          {hardware.gpus?.length ? hardware.gpus.join(" / ") : "GPU 型号未识别"}
          <br />
          {hardware.suggestedBackend}
        </p>
      )}
      <button
        disabled={!!active}
        onClick={() =>
          void cleanupManagedDownloads()
            .then((n) => setStatus(`已清理 ${n} 个未完成下载`))
            .catch((e) => setStatus(String(e)))
        }
      >
        清理未完成下载
      </button>{" "}
      <button
        onClick={() =>
          void loadEngineCatalog()
            .then((c) => {
              setCatalog(c);
              setStatus(`官方版本 ${c.version}`);
            })
            .catch((e) => setStatus(String(e)))
        }
      >
        检查官方更新
      </button>
      {catalog && (
        <label>
          官方安装包
          <select
            aria-label="官方 KataGo 安装包"
            defaultValue=""
            onChange={(e) => {
              const a = catalog.assets.find((v) => v.url === e.target.value);
              if (a) {
                setKind("engine");
                setName(a.name);
                setUrl(a.url);
                setSha(a.sha256 ?? "");
              }
            }}
          >
            <option value="">按系统和 GPU 选择（不自动下载）</option>
            {catalog.assets.map((a) => (
              <option key={a.url} value={a.url}>
                {a.name} · {(a.bytes / 1048576).toFixed(0)} MB
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="search-controls-grid">
        <label>
          类型
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "engine" | "model")}
          >
            <option value="engine">KataGo 引擎 ZIP</option>
            <option value="model">模型 .bin.gz</option>
          </select>
        </label>
        <label>
          名称
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <label>
        官方下载地址
        <input
          aria-label="资源下载地址"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label>
        发布方 SHA-256
        <input
          aria-label="资源 SHA-256"
          value={sha}
          onChange={(e) => setSha(e.target.value.trim())}
        />
      </label>
      <p>
        模型下载来源：katagotraining.org/networks/。校验通过后安装到应用受管目录；更新保留旧版本，可确认新版本后删除旧资源。
      </p>
      <button
        disabled={!!active || !name || !url || !/^[a-f\d]{64}$/i.test(sha)}
        onClick={() => void install()}
      >
        下载并安装
      </button>{" "}
      <button disabled={!!active} onClick={() => void importFile()}>
        导入本地{kind === "engine" ? "引擎" : "模型"}
      </button>
      {active && (
        <button
          onClick={() =>
            void cancelManagedDownload(active)
              .then(() => setStatus("正在取消…"))
              .catch((e) => setStatus(String(e)))
          }
        >
          取消下载
        </button>
      )}
      {active && progress?.id === active && (
        <p>
          {(progress.received / 1048576).toFixed(1)} MB{" "}
          {progress.total
            ? `/ ${(progress.total / 1048576).toFixed(1)} MB`
            : ""}
        </p>
      )}
      <p role="status">{status}</p>
      <ul style={{ paddingLeft: 18 }}>
        {assets.map((a) => (
          <li key={a.id}>
            {a.name} · {(a.bytes / 1048576).toFixed(1)} MB{" "}
            {onUseAsset && (
              <button disabled={disabled} onClick={() => onUseAsset(a)}>
                使用
              </button>
            )}{" "}
            <button
              disabled={disabled}
              onClick={() =>
                void removeManagedAsset(a.id)
                  .then(refresh)
                  .catch((e) => setStatus(String(e)))
              }
            >
              删除受管资源
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
