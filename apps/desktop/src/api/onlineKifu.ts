import { invoke, isTauri } from "@tauri-apps/api/core";
import { kifuRequest, type KifuSource } from "../domain/onlineKifu";
import type { ProviderFetchResult } from "../domain/providers";
export async function fetchOnlineKifu(
  source: KifuSource,
  action: "list" | "game",
  input: string,
  cursor = "0",
) {
  if (!isTauri())
    throw new Error("在线棋谱查询请使用桌面应用；浏览器预览不连接棋谱服务。");
  return invoke<ProviderFetchResult>("fetch_online_kifu", {
    request: kifuRequest(source, action, input, cursor),
  });
}
