import type { ProviderFetchRequest } from "./providers";
export type KifuSource = "fox" | "tencent";
export type KifuEntry = {
  id: string;
  black: string;
  white: string;
  date: string;
  moves: string;
  result: string;
};
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
export function chessId(input: string): string {
  let id = input.trim().replace(/^chessid\s+/i, "");
  if (/^https?:\/\//i.test(id)) {
    const u = new URL(id);
    id = u.searchParams.get("chessid") ?? u.searchParams.get("chessId") ?? "";
  }
  if (!/^[\w-]{1,160}$/.test(id))
    throw new Error("请输入有效棋谱 ID，或包含 chessid 的分享链接。");
  return id;
}
export function kifuRequest(
  source: KifuSource,
  action: "list" | "game",
  input: string,
  cursor = "0",
): ProviderFetchRequest {
  input = input.trim();
  if (!input) throw new Error("请输入账号或棋谱 ID。");
  let url: string;
  if (source === "fox")
    url =
      action === "game"
        ? `chessid ${chessId(input)}`
        : cursor === "0"
          ? `user_name ${input}`
          : `uid ${input} ${cursor}`;
  else {
    const params = new URLSearchParams(
      action === "game"
        ? { chessid: chessId(input) }
        : {
            type: "7",
            lastCode: cursor,
            username: input,
            srcuid: /^\d+$/.test(input) ? input : "",
            txwqsession: "lizzieyzy-next",
            fetchnum: "100",
          },
    );
    url = `https://${action === "game" ? "happyapp.huanle.qq.com" : "cgi.huanle.qq.com"}/cgi-bin/CommonMobileCGI/${action === "game" ? "TXWQFetchChess" : "TXWQFetchChessList"}?${params}`;
  }
  return {
    provider: "fox",
    url,
    method: "get",
    headers: {},
    timeout_ms: 25000,
  };
}
export function readKifuList(payload: string) {
  const data = JSON.parse(payload);
  if (data.result !== undefined && Number(data.result) !== 0)
    throw new Error(text(data.resultstr) || "查询失败，请检查账号或 UID。");
  if (!Array.isArray(data.chesslist)) throw new Error("服务未返回棋谱列表。");
  const pick = (row: Record<string, unknown>, keys: string[]) =>
    keys.map((k) => text(row[k])).find(Boolean) || "—";
  const entries: KifuEntry[] = data.chesslist.flatMap(
    (r: Record<string, unknown>) => {
      const id = text(r.chessid);
      return id
        ? [
            {
              id,
              black: pick(r, [
                "blacknick",
                "blacknickname",
                "blackname",
                "blackenname",
              ]),
              white: pick(r, [
                "whitenick",
                "whitenickname",
                "whitename",
                "whiteenname",
              ]),
              date: pick(r, ["starttime", "endtime", "createtime", "time"]),
              moves: pick(r, ["movenum"]),
              result:
                text(r.resultstr) ||
                (["", "黑胜", "白胜", "和棋"][Number(r.winner)] ?? "—"),
            },
          ]
        : [];
    },
  );
  return {
    entries,
    uid: text(data.fox_uid),
    cursor: entries.at(-1)?.id ?? "",
    hasMore: entries.length > 0,
  };
}
