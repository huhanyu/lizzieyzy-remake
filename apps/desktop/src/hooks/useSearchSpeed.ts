import { useEffect, useRef, useState } from "react";
import { updateSearchSpeed, type SearchSpeedInput, type SearchSpeedResult, type SearchSpeedState } from "../domain/searchSpeed";

/** Inputs must already pass the live job/generation guard. No wall clock is used. */
export function useSearchSpeed({ jobId, generation, visits, active }: SearchSpeedInput): SearchSpeedResult {
  const input = useRef<SearchSpeedInput>({ jobId, generation, visits, active });
  const history = useRef<SearchSpeedState | null>(null);
  const [result, setResult] = useState<SearchSpeedResult>({ visitsPerSecond: null, elapsedSeconds: 0 });
  useEffect(() => {
    input.current = { jobId, generation, visits, active };
    const next = updateSearchSpeed(history.current, input.current, performance.now());
    history.current = next.state;
    setResult(next.result);
  }, [jobId, generation, visits, active]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      const next = updateSearchSpeed(history.current, input.current, performance.now());
      history.current = next.state;
      setResult(next.result);
    }, 250);
    return () => window.clearInterval(timer);
  }, [active]);
  // Never expose the previous epoch's speed while the effect resets its history.
  const identity = JSON.stringify([jobId ?? null, generation ?? null]);
  if (history.current?.identity !== identity || visits < (history.current?.lastVisits ?? 0)) {
    return { visitsPerSecond: null, elapsedSeconds: 0 };
  }
  if (!active || !Number.isFinite(visits) || visits < 0) return { ...result, visitsPerSecond: null };
  return result;
}
