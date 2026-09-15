import { useEffect, useRef, type RefObject } from 'react';

/** One step per wheel notch; trackpad gestures need deliberate renewed motion. */
export function useBoardWheel(container: RefObject<HTMLElement>, move: number, max: number, disabled: boolean, select: (move: number) => void) {
  const latest = useRef({move,max,disabled,select}); latest.current = {move,max,disabled,select};
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let total = 0, direction = 0, lastEvent = 0, lastStep = -Infinity, lastMagnitude = 0;
    const wheel = (event: WheelEvent) => {
      if (!(event.target instanceof HTMLCanvasElement) || event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      const state = latest.current;
      if (state.disabled || !event.deltaY) return;
      const now = performance.now(), sign = Math.sign(event.deltaY);
      const magnitude = Math.abs(event.deltaY) * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? 120 : 1);
      const fresh = now - lastEvent > 180 || sign !== direction;
      if (fresh) { total = 0; lastMagnitude = 0; lastStep = -Infinity; }
      lastEvent = now; direction = sign;
      // Ignore the decaying tail after a step, rather than scheduling delayed moves.
      const decaying = magnitude < lastMagnitude && now - lastStep < 240;
      lastMagnitude = magnitude;
      if (decaying || now - lastStep < 100) return;
      total += magnitude;
      if (total < 60) return;
      total = 0; lastStep = now;
      const next = Math.max(0, Math.min(state.max, state.move + sign));
      if (next !== state.move) { latest.current.move = next; state.select(next); }
    };
    element.addEventListener('wheel', wheel, {passive:false});
    return () => element.removeEventListener('wheel', wheel);
  }, [container]);
}
