import type { GameDto, MoveVertex, PositionDto, SgfTreeDto, SgfTreeNodeDto } from "./types";

export function gtpVertex(vertex: MoveVertex, size: number): string {
  if (vertex === "pass") return "pass";
  return `${"ABCDEFGHJKLMNOPQRSTUVWXYZ"[vertex.point.x]}${size - vertex.point.y}`;
}

export function buildLivePosition(game: GameDto, position: PositionDto, tree: SgfTreeDto | null, nodeId: string | null) {
  if (position.errors.length) throw new Error(position.errors.join("；"));
  const size = position.board_size;
  const path: SgfTreeNodeDto[] = [];
  const nodes = new Map(tree?.nodes.map(node => [node.id, node]));
  let node = nodeId ? nodes.get(nodeId) : undefined;
  const seen = new Set<string>();
  while (node && !seen.has(node.id)) {
    path.unshift(node); seen.add(node.id);
    node = node.parent_id ? nodes.get(node.parent_id) : undefined;
  }
  // A setup edit halfway through a game resets history. Until this is represented explicitly by
  // the backend, report it instead of silently analysing the mainline or inventing move history.
  if (path.slice(1).some(item => item.properties.some(prop => ["AB", "AW", "AE"].includes(prop.key)))) {
    throw new Error("暂不支持棋谱中途重新摆子的实时分析，请将该局面另存为起始摆子棋谱。");
  }
  const root = tree?.nodes.find(item => item.id === tree.root_id);
  const handicap = Number(root?.properties.find(prop => prop.key === "HA")?.values[0] ?? 0);
  const moves = path.length
    ? path.flatMap(item => item.color && item.vertex != null ? [item.color === "black" ? "B" : "W", gtpVertex(item.vertex, size)] : [])
    : game.moves.filter(move => move.move_number <= position.move_number).flatMap(move => [move.color === "black" ? "B" : "W", gtpVertex(move.vertex, size)]);
  const setup = (game.summary.initial_stones ?? []).flatMap(stone => [stone.color === "black" ? "B" : "W", gtpVertex({ point: stone }, size)]);
  const rawRules = (game.summary.rules ?? "chinese").trim().toLowerCase().replace(/ rules$/, "");
  const aliases: Record<string, string> = { "中国": "chinese", "中国规则": "chinese", cn: "chinese", zh: "chinese", "日本": "japanese", "日本规则": "japanese", jp: "japanese", ja: "japanese", "韩国": "korean", "韩国规则": "korean", kr: "korean", ko: "korean", "tromp taylor": "tromp-taylor", tt: "tromp-taylor" };
  const rules = aliases[rawRules] ?? (["chinese", "japanese", "korean", "tromp-taylor", "chinese-ogs", "chinese-kgs", "aga", "bga", "new-zealand"].includes(rawRules) ? rawRules : "chinese");
  return { moves, setup, rules, handicap: handicap >= 2 ? handicap : undefined, boardSize: size,
    turn: position.move_number, player: position.to_play, komi: game.summary.komi };
}
