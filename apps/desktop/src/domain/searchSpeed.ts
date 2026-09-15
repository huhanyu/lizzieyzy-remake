/** All timestamps are from the same monotonic clock (performance.now). */
export type SearchSpeedInput = {
  jobId: string | null | undefined;
  generation: string | number | null | undefined;
  visits: number;
  active: boolean;
};
type Sample = { time: number; visits: number };
export type SearchSpeedState = {
  identity: string;
  started: number;
  lastTime: number;
  lastVisits: number;
  active: boolean;
  samples: Sample[];
};
export type SearchSpeedResult = { visitsPerSecond: number | null; elapsedSeconds: number };
const WINDOW_MS = 3000;
const MIN_SPAN_MS = 500;

/** Tick regularly, including when no frame arrives, so an idle stream's rate
 * decays to zero. Equal counts never count as new work. A counter reset starts
 * a new epoch; its initial visits are a baseline, never a synthetic increment. */
export function updateSearchSpeed(previous: SearchSpeedState | null, input: SearchSpeedInput, now: number): { state: SearchSpeedState; result: SearchSpeedResult } {
  const identity = JSON.stringify([input.jobId ?? null, input.generation ?? null]);
  const time = Number.isFinite(now) ? now : previous?.lastTime ?? 0;
  const valid = Number.isFinite(input.visits) && input.visits >= 0;
  const active = input.active && !!input.jobId && valid;
  const visits = valid ? input.visits : previous?.lastVisits ?? 0;
  const reset = !previous || previous.identity !== identity || time < previous.lastTime
    || visits < previous.lastVisits || (active && !previous.active);
  let state: SearchSpeedState;
  if (reset) {
    state = { identity, started: time, lastTime: time, lastVisits: visits, active, samples: [{ time, visits }] };
  } else {
    state = { ...previous, active, lastTime: time, lastVisits: visits, samples: previous.samples.slice() };
    if (active) {
      const last = state.samples.at(-1);
      if (last?.time === time) state.samples[state.samples.length - 1] = { time, visits };
      else state.samples.push({ time, visits });
      // Keep one anchor immediately before the window boundary for interpolation.
      while (state.samples.length > 2 && state.samples[1].time <= time - WINDOW_MS) state.samples.shift();
    } else {
      // Freeze elapsed at the transition to inactive and discard speed history.
      state.samples = [];
    }
  }
  const elapsedSeconds = active ? Math.max(0, (time - state.started) / 1000)
    : previous?.identity === identity ? Math.max(0, ((previous.active ? time : previous.lastTime) - previous.started) / 1000) : 0;
  // Freeze the epoch endpoint on repeated inactive ticks.
  if (!active && previous && !previous.active && !reset) state.lastTime = previous.lastTime;
  if (!active || state.samples.length < 2) return { state, result: { visitsPerSecond: null, elapsedSeconds } };
  const first = state.samples[0];
  const boundary = Math.max(first.time, time - WINDOW_MS);
  const second = state.samples[1];
  const baseline = first.time < boundary && second.time > first.time
    ? first.visits + (second.visits - first.visits) * (boundary - first.time) / (second.time - first.time)
    : first.visits;
  const span = time - boundary;
  return { state, result: {
    visitsPerSecond: span >= MIN_SPAN_MS ? Math.max(0, (visits - baseline) * 1000 / span) : null,
    elapsedSeconds,
  } };
}
