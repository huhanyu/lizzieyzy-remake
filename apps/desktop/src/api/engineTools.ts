import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
export type RemoteEngineConfig = {
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
  enginePath: string;
  modelPath: string;
  configPath: string;
};
export type ManagedAsset = {
  id: string;
  name: string;
  kind: "engine" | "model";
  sha256: string;
  source: string;
  path: string;
  bytes: number;
};
export type AssetInstall = Pick<
  ManagedAsset,
  "id" | "name" | "kind" | "sha256"
> & { url: string };
export type AssetProgress = {
  id: string;
  received: number;
  total?: number;
  phase: string;
};
export type HardwareInfo = {
  os: string;
  arch: string;
  threads: number;
  gpus: string[];
  suggestedBackend: string;
};
export type ReleaseCatalog = {
  version: string;
  url: string;
  modelsUrl: string;
  assets: { name: string; url: string; bytes: number; sha256: string | null }[];
};
async function native<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) throw new Error("请在桌面应用中使用引擎工具");
  return invoke<T>(command, args);
}
export const startRemoteLiveReview = (
  config: RemoteEngineConfig,
  boardSize: number,
  turn: number,
  intervalCentisec = 10,
) =>
  native<string>("ssh_start_live_review", {
    config,
    boardSize,
    turn,
    intervalCentisec,
  });
export const queryGtpConsole = (command: string) =>
  native<string>("katago_console_query", { command });
export const detectEngineHardware = () =>
  native<HardwareInfo>("engine_hardware");
export const loadEngineCatalog = () =>
  native<ReleaseCatalog>("engine_release_catalog");
export const listManagedAssets = () =>
  native<ManagedAsset[]>("engine_assets_list");
export const installManagedAsset = (request: AssetInstall) =>
  native<ManagedAsset>("engine_asset_install", { request });
export const importManagedAsset = (source: string, kind: "engine" | "model") =>
  native<ManagedAsset>("engine_asset_import", { source, kind });
export const cancelManagedDownload = (id: string) =>
  native<void>("engine_asset_cancel", { id });
export const removeManagedAsset = (id: string) =>
  native<void>("engine_asset_remove", { id });
export async function listenAssetProgress(
  callback: (p: AssetProgress) => void,
) {
  if (!isTauri()) return () => {};
  return listen<AssetProgress>("engine://asset-progress", (e) =>
    callback(e.payload),
  );
}

export const cleanupManagedDownloads = () =>
  native<number>("engine_asset_cleanup");
