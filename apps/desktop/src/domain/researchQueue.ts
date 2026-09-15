import type { AnalysisFrameDto } from './types';
export type ResearchDocument = { id: string; name: string; sgfText: string; documentKey?: string };
export type ResearchResult = { document: ResearchDocument; frames: AnalysisFrameDto[]; profileId: string; completedAt: string };
/** Reject duplicate files and empty input before acquiring any engine resources. */
export function validateResearchDocuments(documents: readonly ResearchDocument[]) {
  if (!documents.length || documents.length > 100) throw new Error('请选择 1–100 份棋谱。');
  const ids = new Set<string>();
  for (const doc of documents) {
    if (!doc.id || ids.has(doc.id) || !doc.sgfText.trim() || doc.sgfText.length > 10_000_000) throw new Error('棋谱为空、重复或超过 10 MB。');
    ids.add(doc.id);
  }
}
/** Results always remain associated with their source document, never the currently selected file. */
export function researchExport(results: readonly ResearchResult[]): string {
  return JSON.stringify({ format:'lizzieyzy-research-queue-v1', results }, null, 2);
}
