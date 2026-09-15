import type { ScanOptions } from './fullGameReview';
export type AnalysisSource = 'local' | 'ssh' | 'cloud';
export const QUICK_CURVE_VISITS = 1;
/** Remote sessions never automatically leave the foreground position. */
export function shouldAutoFillHistory(source: AnalysisSource, enabled: boolean): boolean {
  return source === 'local' && enabled;
}
export function quickCurveOptions(to: number): ScanOptions {
  return {from: 1, to, visits: QUICK_CURVE_VISITS, coarseFirst: false, incremental: true};
}
