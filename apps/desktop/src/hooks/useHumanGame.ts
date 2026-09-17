import { remoteGameMove } from "../api/remoteGame";
import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  appendSgfMove,
  parseSgfSummary,
  parseSgfTree,
  replaySgfPositionAtNode,
  updateSgfNodeProperties,
} from "../api/backend";
import { newGameSgf, DEFAULT_GAME_INFO } from "../domain/documentEditing";
import { buildLivePosition } from "../domain/livePosition";
import { selectPlayMove, type GameOptions } from "../domain/humanGame";
import type {
  EngineProfileDto,
  MoveVertex,
  PositionDto,
} from "../domain/types";
type Snapshot = {
  sgfText: string;
  nodeId: string;
  position: PositionDto;
  newDocument?: boolean;
};
type Props = {
  sgfText: string;
  nodeId: string | null;
  profile: EngineProfileDto | null;
  prepare: (options: GameOptions) => Promise<string | null>;
  commit: (s: Snapshot) => Promise<void>;
  message: (s: string) => void;
};
export function useHumanGame(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [state, setState] = useState<{
    options: GameOptions;
    phase: "preparing" | "human" | "thinking" | "error" | "ended";
    status: string;
  } | null>(null);
  const session = useRef<{
    id: string;
    generation: number;
    options: GameOptions;
    history: Snapshot[];
    request: string | null;
    locked: boolean;
    remoteJob: string | null;
    abort: AbortController | null;
    remotePending: Promise<unknown> | null;
  } | null>(null);
  const publish = (
    phase: NonNullable<typeof state>["phase"],
    status: string,
  ) => {
    const s = session.current;
    if (s) setState({ options: s.options, phase, status });
  };
  async function cancel() {
    const s = session.current;
    if (!s) return;
    s.generation++;
    s.abort?.abort();
    await s.remotePending?.catch(() => {});
    const id = s.request;
    s.request = null;
    if (id && s.options.source === "local" && isTauri())
      await invoke("human_game_cancel", { id });
  }
  async function append(vertex: MoveVertex) {
    const s = session.current;
    if (!s) throw new Error("对局已结束");
    const before = s.history.at(-1)!;
    const generation = s.generation;
    const result = await appendSgfMove(
      before.sgfText,
      before.nodeId,
      before.position.to_play,
      vertex,
    );
    const position = await replaySgfPositionAtNode(
      result.sgf_text,
      result.new_node_id,
    );
    if (position.errors.length) throw new Error(position.errors.join("；"));
    if (session.current !== s || s.generation !== generation) return false;
    const next = {
      sgfText: result.sgf_text,
      nodeId: result.new_node_id,
      position,
    };
    await latest.current.commit(next);
    s.history.push(next);
    return true;
  }
  async function end(result: string, status: string) {
    const s = session.current;
    if (!s) return;
    await cancel();
    const last = s.history.at(-1)!;
    if (result) {
      const tree = await parseSgfTree(last.sgfText);
      if (tree) {
        const updated = await updateSgfNodeProperties(
          last.sgfText,
          s.options.continuation ? last.nodeId : tree.root_id,
          s.options.continuation
            ? [
                {
                  key: "C",
                  values: [
                    (tree.nodes.find((n) => n.id === last.nodeId)?.comment ??
                      "") + `\n人机续弈结果：${result}`,
                  ],
                },
              ]
            : [{ key: "RE", values: [result] }],
        );
        const next = { ...last, sgfText: updated.sgf_text };
        await latest.current.commit(next);
        s.history[s.history.length - 1] = next;
      }
    }
    publish("ended", status);
  }
  async function think() {
    const s = session.current;
    if (!s) return;
    const last = s.history.at(-1)!;
    if (last.position.to_play === s.options.color) {
      publish("human", "轮到你落子");
      return;
    }
    const generation = s.generation,
      id = `${s.id}-${generation}-${s.history.length}`;
    s.request = id;
    publish("thinking", "AI 正在思考…");
    try {
      const profile = latest.current.profile;
      if (!profile && s.options.source === "local")
        throw new Error("请先配置本地 KataGo");
      const [game, tree] = await Promise.all([
        parseSgfSummary(last.sgfText),
        parseSgfTree(last.sgfText),
      ]);
      const position = buildLivePosition(
        game,
        last.position,
        tree,
        last.nodeId,
      );
      // initialPlayer describes the root before moves, not the current player.
      const root = tree
        ? await replaySgfPositionAtNode(last.sgfText, tree.root_id)
        : last.position;
      if (
        session.current !== s ||
        s.generation !== generation ||
        s.request !== id
      )
        return;
      s.abort = new AbortController();
      const pending =
        s.options.source !== "local"
          ? remoteGameMove(
              s.remoteJob!,
              position,
              s.options.seconds,
              s.options.visits,
              s.abort.signal,
            )
          : invoke("human_game_move", {
              request: {
                ...position,
                player: root.to_play,
                komi: game.summary.komi ?? 7.5,
                id,
                profile,
                maxVisits: s.options.mode === "human" ? 32 : s.options.visits,
                maxSeconds: s.options.seconds,
                humanRank: s.options.mode === "human" ? s.options.rank : null,
                humanModel: s.options.humanModel || null,
              },
            });
      if (s.options.source !== "local") s.remotePending = pending;
      const response = await pending;
      s.remotePending = null;
      if (
        session.current !== s ||
        s.generation !== generation ||
        s.request !== id
      )
        return;
      s.request = null;
      const node = tree?.nodes.find((n) => n.id === last.nodeId);
      const allowPass =
        node?.vertex === "pass" ||
        last.position.move_number >
          (last.position.board_size * last.position.board_size) / 2;
      const random = crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
      const move = selectPlayMove(
        response,
        last.position.board_size,
        s.options.mode === "human",
        allowPass,
        random,
      );
      if (move === "resign") {
        await end(
          s.options.color === "black" ? "B+R" : "W+R",
          "AI 已认输，可保存棋谱并复盘",
        );
        return;
      }
      s.locked = true;
      const applied = await append(move);
      s.locked = false;
      if (applied) {
        if (move === "pass" && node?.vertex === "pass")
          await end("", "双方连续停一手。请确认终局结果后保存，或返回复盘。");
        else
          publish(
            "human",
            move === "pass" ? "AI 停一手，轮到你" : "轮到你落子",
          );
      }
    } catch (e) {
      if (session.current === s && s.generation === generation) {
        s.request = null;
        s.locked = false;
        publish("error", e instanceof Error ? e.message : String(e));
      }
    }
  }
  async function start(options: GameOptions) {
    if (session.current) return;
    if (!isTauri()) throw new Error("人机对弈需在桌面应用中运行");
    if (options.source === "local" && !latest.current.profile)
      throw new Error("请先配置本地 KataGo");
    if (options.source !== "local" && options.mode === "human")
      throw new Error("HumanSL 陪练请使用本地人类模型，远端使用自身配置");
    if (options.mode === "human" && !options.humanModel.trim())
      throw new Error("请选择 HumanSL 模型文件");
    const s = {
      id: crypto.randomUUID(),
      generation: 0,
      options,
      history: [] as Snapshot[],
      request: null as string | null,
      locked: true,
      remoteJob: null as string | null,
      abort: null as AbortController | null,
      remotePending: null as Promise<unknown> | null,
    };
    session.current = s;
    publish("preparing", "准备对局…");
    try {
      s.remoteJob = await latest.current.prepare(options);
      const text = options.continuation
        ? latest.current.sgfText
        : newGameSgf({
            ...DEFAULT_GAME_INFO,
            size: options.size,
            handicap: options.handicap,
            komi: options.komi,
            rules: options.rules,
            black: options.color === "black" ? "我" : "AI",
            white: options.color === "white" ? "我" : "AI",
          });
      const tree = await parseSgfTree(text);
      if (!tree) throw new Error("棋谱为空");
      const nodeId = options.continuation
        ? (latest.current.nodeId ?? tree.root_id)
        : tree.root_id;
      const position = await replaySgfPositionAtNode(text, nodeId);
      if (position.errors.length) throw new Error(position.errors.join("；"));
      const snapshot = { sgfText: text, nodeId, position };
      await latest.current.commit({
        ...snapshot,
        newDocument: !options.continuation,
      });
      s.history = [snapshot];
      s.locked = false;
      await think();
    } catch (e) {
      session.current = null;
      setState(null);
      throw e;
    }
  }
  async function play(vertex: MoveVertex) {
    const s = session.current;
    if (!s || s.locked || s.request || state?.phase !== "human") return;
    s.locked = true;
    try {
      const last = s.history.at(-1)!;
      const tree = await parseSgfTree(last.sgfText);
      const previous = tree?.nodes.find((n) => n.id === last.nodeId)?.vertex;
      if (await append(vertex)) {
        if (vertex === "pass" && previous === "pass")
          await end("", "双方连续停一手，请确认终局结果或返回复盘");
        else {
          s.locked = false;
          await think();
        }
      }
    } catch (e) {
      publish("error", e instanceof Error ? e.message : String(e));
    } finally {
      s.locked = false;
    }
  }
  async function undo() {
    const s = session.current;
    if (!s || s.locked || !s.history.length) return;
    let index = s.history.length - 2;
    while (index >= 0 && s.history[index].position.to_play !== s.options.color)
      index--;
    if (index < 0) {
      latest.current.message("还没有可以撤回的玩家落子");
      return;
    }
    s.locked = true;
    try {
      await cancel();
      const snapshot = s.history[index];
      await latest.current.commit(snapshot);
      s.history = s.history.slice(0, index + 1);
      publish("human", "已悔棋，轮到你");
    } finally {
      s.locked = false;
    }
  }
  async function finish() {
    const s = session.current;
    if (!s || s.locked) return;
    await cancel();
    if (isTauri()) await invoke("human_game_cancel", { id: s.id });
    session.current = null;
    setState(null);
    latest.current.message("对局已保留在棋谱中，可保存并复盘。");
  }
  useEffect(
    () => () => {
      const s = session.current;
      session.current = null;
      s?.abort?.abort();
      if (s && s.options.source === "local" && isTauri())
        void invoke("human_game_cancel", { id: s.request ?? s.id });
    },
    [],
  );
  return {
    state,
    active: !!state,
    hideHints: !!state && !state.options.training,
    start,
    play,
    undo,
    finish,
    retry: think,
    resign: async () => {
      if (session.current?.locked) return;
      await end(
        state?.options.color === "black" ? "W+R" : "B+R",
        "你已认输，可保存棋谱并复盘",
      );
    },
  };
}
