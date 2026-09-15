/** Bounded attempts per user connection intent; a stable 30s connection replenishes it. */
export function cloudRetryDelay(attempt: number): number | null {
  return Number.isInteger(attempt) && attempt >= 0 && attempt < 5 ? Math.min(1000 * 2 ** attempt, 16000) : null;
}
