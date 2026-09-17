import {
  listenToLiveReviewEvents,
  setLiveReviewPosition,
  type LiveReviewFramePayload,
} from "./backend";
import { listenToLiveReviewPaused, pauseLiveReview } from "./liveControls";
import { gtpVertex, buildLivePosition } from "../domain/livePosition";
/** One request owns the paused live transport. No engine configuration is overwritten. */
export async function remoteGameMove(
  jobId: string,
  p: ReturnType<typeof buildLivePosition>,
  seconds: number,
  visits: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new Error("对弈请求已取消");
  let generation: number | null = null,
    latest: LiveReviewFramePayload | null = null,
    done = false;
  const early: LiveReviewFramePayload[] = [];
  let earlyPause: number | null = null;
  let resolve!: (v: unknown) => void, reject!: (e: Error) => void;
  const result = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  void result.catch(() => {});
  const fail = (message: string) => {
    if (!done) {
      done = true;
      reject(new Error(message));
    }
  };
  const complete = () => {
    if (done) return;
    if (!latest?.frame.candidates.length) {
      fail("远端尚未返回有效落点，请重试");
      return;
    }
    done = true;
    resolve({
      moveInfos: latest.frame.candidates.map((c, i) => ({
        order: i,
        move: gtpVertex(c.vertex, p.boardSize),
      })),
    });
  };
  const frame = (f: LiveReviewFramePayload) => {
    if (f.job_id !== jobId || f.turn !== p.turn) return;
    if (generation === null) {
      if (early.length < 100) early.push(f);
      return;
    }
    if (f.generation === generation) latest = f;
  };
  const off = await listenToLiveReviewEvents({
    onFrame: frame,
    onEnded: (e) => {
      if (e.job_id === jobId) fail("远端连接已结束：" + e.reason);
    },
  });
  let offPaused: () => void = () => {};
  try {
    offPaused = await listenToLiveReviewPaused((e) => {
      if (e.job_id !== jobId || e.reason !== "limit") return;
      if (generation === null) earlyPause = e.generation;
      else if (e.generation === generation) complete();
    });
  } catch (error) {
    off();
    throw error;
  }
  const abort = () => fail("对弈请求已取消");
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => fail("远端响应超时，请检查连接后重试"),
    (seconds + 45) * 1000,
  );
  try {
    if (signal.aborted) throw new Error("对弈请求已取消");
    generation = await setLiveReviewPosition(
      p.moves,
      p.turn,
      10,
      p.player,
      p.komi,
      p.boardSize,
      p.setup,
      p.rules,
      p.handicap,
      { maxSeconds: seconds, maxVisits: visits },
    );
    early.forEach(frame);
    if (earlyPause === generation) complete();
    if (signal.aborted) abort();
    return await result;
  } finally {
    clearTimeout(timer);
    off();
    offPaused();
    signal.removeEventListener("abort", abort);
    await pauseLiveReview().catch(() => {});
  }
}
