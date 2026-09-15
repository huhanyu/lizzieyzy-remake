import { listen } from '@tauri-apps/api/event';
import type { AnalysisProgressPayload, AnalysisCompletePayload, AnalysisErrorPayload, KataGoAnalysisEventHandlers } from './backend';
/** Partial listener failure must remove successful registrations before rejecting. */
export async function installResearchListeners(registrations: Promise<() => void>[]): Promise<() => void> {
  const results=await Promise.allSettled(registrations);
  const installed=results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
  const cleanup=()=>{for(const dispose of installed)dispose();};
  if(results.some(r=>r.status==='rejected')){cleanup();throw new Error('无法安装完整分析事件监听，尚未启动引擎。');}
  return cleanup;
}
export function listenToResearchEvents(handlers:KataGoAnalysisEventHandlers) {
  return installResearchListeners([
    listen<AnalysisProgressPayload>('katago://analysis-progress',event=>handlers.onProgress?.(event.payload)),
    listen<AnalysisCompletePayload>('katago://analysis-complete',event=>handlers.onComplete?.(event.payload)),
    listen<AnalysisErrorPayload>('katago://analysis-error',event=>handlers.onError?.(event.payload)),
    listen<AnalysisErrorPayload>('katago://analysis-cancelled',event=>handlers.onCancelled?.(event.payload)),
  ]);
}
