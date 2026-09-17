import type { MoveVertex } from "./types";
export type GameMode = "standard" | "human";
export type GameOptions = {
  source: "local" | "cloud" | "ssh";
  mode: GameMode;
  color: "black" | "white";
  seconds: number;
  visits: number;
  rank: string;
  humanModel: string;
  training: boolean;
  size: number;
  handicap: number;
  komi: number;
  rules: string;
  continuation: boolean;
};
export const defaultGameOptions: GameOptions = {
  source: "local",
  mode: "standard",
  color: "black",
  seconds: 3,
  visits: 800,
  rank: "rank_1d",
  humanModel: "",
  training: false,
  size: 19,
  handicap: 0,
  komi: 7.5,
  rules: "chinese",
  continuation: false,
};
export function parseEngineMove(
  value: string,
  size: number,
): MoveVertex | "resign" {
  const v = value.trim().toUpperCase();
  if (v === "PASS") return "pass";
  if (v === "RESIGN") return "resign";
  const x = "ABCDEFGHJKLMNOPQRSTUVWXYZ".indexOf(v[0]),
    row = Number(v.slice(1));
  if (x < 0 || x >= size || !/^\d+$/.test(v.slice(1)) || row < 1 || row > size)
    throw new Error("引擎返回了无效落点");
  return { point: { x, y: size - row } };
}
export function selectPlayMove(
  response: any,
  size: number,
  human: boolean,
  allowPass: boolean,
  random: number,
): MoveVertex | "resign" {
  const infos = Array.isArray(response.moveInfos) ? response.moveInfos : [];
  const top = infos.find((m: any) => m.order === 0) ?? infos[0];
  if (!human) {
    if (!top?.move) throw new Error("引擎未返回落点");
    return parseEngineMove(top.move, size);
  }
  if (allowPass && String(top?.move).toLowerCase() === "pass") return "pass";
  const policy = response.humanPolicy ?? response.rootInfo?.humanPolicy;
  if (!Array.isArray(policy) || policy.length !== size * size + 1)
    throw new Error("引擎未返回 HumanSL 策略，请检查人类模型与 KataGo 版本");
  const weights = policy.map((v: any, i: number) =>
    typeof v === "number" &&
    Number.isFinite(v) &&
    v > 0 &&
    (i < size * size || allowPass)
      ? v
      : 0,
  );
  const total = weights.reduce((a: number, b: number) => a + b, 0);
  if (!total) throw new Error("没有可用的人类策略落点");
  let remaining = Math.min(1 - Number.EPSILON, Math.max(0, random)) * total;
  for (let i = 0; i < weights.length; i++) {
    remaining -= weights[i];
    if (weights[i] > 0 && remaining < 0)
      return i === size * size
        ? "pass"
        : { point: { x: i % size, y: Math.floor(i / size) } };
  }
  throw new Error("人类策略采样失败");
}
