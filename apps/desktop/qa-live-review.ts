// Separate development entry: never imported by the application or its production build.
// Launch with the existing runtime_smoke_report environment gate and this dev URL.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadEngineProfilesSettings } from "./src/api/backend";
import type { LiveReviewFramePayload } from "./src/api/backend";

const reportPath = new URLSearchParams(location.search).get("report") ?? "/tmp/codex-katago-acceptance/native.json";
const received: Array<LiveReviewFramePayload & { receivedAt: number }> = [];
const ended: unknown[] = [];
const checks: Array<{ name: string; status: string; evidence?: unknown; error?: string }> = [];
const started = performance.now();
let jobId = "";
let boardSize = 19;
let profile: Awaited<ReturnType<typeof loadEngineProfilesSettings>>["profiles"][number]["profile"];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function display() {
  document.querySelector("#result")!.textContent = JSON.stringify({ checks, frameCount: received.length, ended }, null, 2);
}
async function check(name: string, action: () => Promise<unknown>) {
  try { checks.push({ name, status: "pass", evidence: await action() }); }
  catch (error) { checks.push({ name, status: "fail", error: String(error) }); }
  display();
}
async function start(size: number) {
  boardSize = size;
  jobId = await invoke<string>("katago_start_live_review", {
    profile: { ...profile, backend: "kata_go_gtp" }, boardSize, turn: 0, intervalCentisec: 10
  });
  assert(jobId, "Empty live job id");
  return jobId;
}
async function position(komi: number, player = "black", turn = 0, moves: string[] = [], extra = {}) {
  return invoke<number>("katago_live_review_set_position", {
    moves, turn, intervalCentisec: 10, player, komi, boardSize,
    rules: "chinese", setup: [], ...extra
  });
}
function matching(generation: number) {
  return received.filter(frame => frame.job_id === jobId && frame.generation === generation);
}
async function frames(generation: number, minimum = 5, visits = 30, timeout = 45000) {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const values = matching(generation);
    if (values.length >= minimum && values.at(-1)!.frame.visits >= visits) return values;
    await sleep(50);
  }
  throw new Error(`Timed out: job=${jobId} generation=${generation}, frames=${matching(generation).length}, ended=${JSON.stringify(ended)}`);
}
function summary(values: ReturnType<typeof matching>) {
  return values.map(value => ({ job: value.job_id, generation: value.generation, turn: value.turn,
    toPlay: value.to_play, visits: value.frame.visits, winrate: value.frame.winrate_black,
    score: value.frame.score_mean_black, ownership: value.frame.ownership?.length,
    receivedAt: value.receivedAt }));
}

const unlistenFrame = await listen<LiveReviewFramePayload>("katago://live-review-frame", ({ payload }) => {
  received.push({ ...payload, receivedAt: performance.now() - started });
});
const unlistenEnd = await listen("katago://live-review-ended", ({ payload }) => ended.push(payload));
try {
  await check("real_runtime_and_profile", async () => {
    assert("__TAURI_INTERNALS__" in window, "Must run inside real Tauri, never browser fallback");
    const settings = await loadEngineProfilesSettings();
    profile = (settings.profiles.find(item => item.id === settings.selected_profile_id) ?? settings.profiles[0]).profile;
    assert(profile.engine_path && profile.model_path && profile.config_path, "Missing engine assets");
    return { engine: profile.engine_path, model: profile.model_path, config: profile.config_path };
  });
  await check("nineteen_board_stream_converges", async () => {
    await start(19);
    const generation = await position(7.5);
    const values = await frames(generation, 8, 100);
    assert(values.every(value => value.turn === 0 && value.frame.turn === 0), "Mismatched turn");
    assert(values.every(value => value.frame.ownership?.length === 361), "Missing 19x19 ownership");
    assert(values.at(-1)!.frame.visits > values[0].frame.visits, "Visits did not increase");
    assert(values.at(-1)!.frame.candidates.length > 0, "No candidates");
    return summary(values);
  });
  await check("black_perspective_for_both_players", async () => {
    await start(9);
    const results = [];
    for (const player of ["black", "white"]) {
      const generation = await position(50, player, 2, ["B", "D4", "W", "F6"]);
      const values = await frames(generation, 5, 100);
      assert(values.every(value => value.frame.winrate_black < 0.1 && value.frame.score_mean_black < -15), "Black perspective inverted");
      assert(values.every(value => value.to_play === player), "Wrong side to play metadata");
      const ownership = values.at(-1)!.frame.ownership!;
      assert(ownership.length === 81 && ownership[48] > 0 && ownership[32] < 0, "Ownership sign or coordinates inverted");
      results.push({ player, frames: summary(values), blackD4: ownership[48], whiteF6: ownership[32] });
    }
    return results;
  });
  await check("same_turn_different_position_no_stale_frames", async () => {
    const results = [];
    for (const komi of [-50, 50, -50, 50]) {
      const generation = await position(komi, "white", 2, ["B", "D4", "W", "F6"]);
      const values = await frames(generation, 5, 60);
      assert(values.every(value => komi > 0 ? value.frame.winrate_black < 0.1 : value.frame.winrate_black > 0.9), "Old komi result tagged with the new generation");
      results.push({ komi, frames: summary(values) });
    }
    return results;
  });
  await check("rapid_position_requests_latest_wins", async () => {
    let generation = 0;
    for (let index = 0; index < 12; index++) generation = await position(index % 2 ? 50 : -50, "black", index);
    const values = await frames(generation, 5, 60);
    assert(values.every(value => value.turn === 11 && value.frame.winrate_black < 0.1), "Superseded request leaked");
    return summary(values);
  });
  await check("setup_stones_and_board_size_survive_position_change", async () => {
    const generation = await position(50, "white", 0, [], { setup: ["B", "D4", "W", "F6"] });
    const values = await frames(generation, 5, 100);
    const ownership = values.at(-1)!.frame.ownership!;
    assert(ownership.length === 81 && ownership[48] > 0.4 && ownership[32] < -0.4,
      "Initial setup stones were lost or coordinates inverted");
    assert(values.every(value => value.to_play === "white" && value.turn === 0), "Setup side to play was lost");
    boardSize = 13;
    const resized = await frames(await position(7.5, "black", 0, [], { rules: "japanese" }), 5, 60);
    assert(resized.every(value => value.frame.ownership?.length === 169), "Board change retained old board size");
    boardSize = 9;
    await frames(await position(7.5), 5, 60);
    return { setup: summary(values), blackD4: ownership[48], whiteF6: ownership[32], resized: summary(resized) };
  });
  await check("handicap_and_following_moves_preserve_stones", async () => {
    const values = await frames(await position(0.5, "white", 2, ["W", "G7", "B", "C3"], {
      setup: ["B", "C7", "B", "G3"], handicap: 2
    }), 5, 100);
    const ownership = values.at(-1)!.frame.ownership!;
    assert(ownership.length === 81 && ownership[20] > 0.4 && ownership[60] > 0.4 && ownership[56] > 0.4,
      "Handicap or following black move was lost");
    assert(ownership[24] < -0.4, "Following white move was lost or changed to black");
    assert(values.every(value => value.to_play === "white" && value.turn === 2), "Wrong handicap turn metadata");
    return { frames: summary(values), ownershipAtStones: [ownership[20], ownership[60], ownership[56], ownership[24]] };
  });
  await check("handicap_same_size_branch_switch_reinitializes_board", async () => {
    const results = [];
    for (const vertex of ["E5", "F5", "E5"]) {
      const values = await frames(await position(0.5, "black", 3,
        ["W", "G7", "B", "C3", "W", vertex], { setup: ["B", "C7", "B", "G3"], handicap: 2 }), 5, 100);
      const ownership = values.at(-1)!.frame.ownership!;
      const whiteIndex = vertex === "E5" ? 40 : 41;
      assert(ownership[20] > 0.4 && ownership[60] > 0.4 && ownership[whiteIndex] < -0.4,
        "Handicap branch stones do not match the requested position");
      assert(values.every(value => value.to_play === "black" && value.turn === 3), "Wrong branch turn metadata");
      results.push({ vertex, frames: summary(values), whiteOwnership: ownership[whiteIndex] });
    }
    return results;
  });
  await check("invalid_position_cannot_silently_analyze_partial_board", async () => {
    const endedBefore = ended.length;
    let rejected = false;
    let generation: number | null = null;
    try { generation = await position(7.5, "white", 1, ["B", "Z99"]); }
    catch { rejected = true; }
    const until = performance.now() + 5000;
    while (!rejected && ended.length === endedBefore && performance.now() < until) await sleep(50);
    assert(rejected || ended.length > endedBefore, "Illegal vertex was not reported");
    if (generation !== null) assert(matching(generation).length === 0, "Invalid position produced normal analysis frames");
    await start(9);
    await frames(await position(7.5), 5, 60);
    return { rejectedAtCommand: rejected, ended: ended.slice(endedBefore) };
  });
  await check("stop_quiets_stream_and_restart_works", async () => {
    await invoke("katago_live_review_stop");
    await sleep(300);
    const count = received.length;
    await sleep(600);
    assert(received.length === count, "Frames continued after stop");
    const previousJob = jobId;
    await start(19);
    const generation = await position(7.5);
    const values = await frames(generation, 5, 60);
    assert(jobId !== previousJob, "Restart reused old job id");
    assert(values.every(value => value.frame.ownership?.length === 361), "Restart has wrong board size");
    await invoke("katago_live_review_stop");
    return { oldJob: previousJob, newJob: jobId, frames: summary(values) };
  });
  await check("sample_game_visual_capture", async () => {
    const sgfText = "(;GM[1]FF[4]SZ[19]KM[7.5];B[pd];W[dd];B[pp];W[dp];B[jq];W[qj];B[nc];W[fc];B[qf];W[cn];B[cp];W[do];B[co];W[dn];B[fq];W[eq];B[fp];W[gp];B[gq];W[hp])";
    const game = await invoke<import("./src/domain/types").GameDto>("parse_sgf_summary", { sgfText });
    const positions = await invoke<import("./src/domain/types").PositionDto[]>("replay_sgf_positions", { sgfText });
    const current = positions.at(-1)!;
    const moves = game.moves.flatMap(move => [move.color === "black" ? "B" : "W", move.vertex === "pass" ? "pass" : `${"ABCDEFGHJKLMNOPQRSTUVWXYZ"[move.vertex.point.x]}${19 - move.vertex.point.y}`]);
    await start(19);
    const values = await frames(await position(7.5, current.to_play, 20, moves), 20, 500);
    assert(values.every(value => value.frame.ownership?.length === 361), "Sample has no heatmap");
    return { position: current, frames: values.map(value => value.frame), summaries: summary(values) };
  });
} finally {
  await invoke("katago_live_review_stop").catch(() => {});
  unlistenFrame(); unlistenEnd();
  const report = { schema: "codex.native-live-review-acceptance.v1", status: checks.every(check => check.status === "pass") ? "pass" : "fail",
    checks, ended, frames: received, elapsedMs: performance.now() - started };
  await invoke("runtime_smoke_report", { reportPath, reportJson: JSON.stringify(report, null, 2) });
  display();
}
