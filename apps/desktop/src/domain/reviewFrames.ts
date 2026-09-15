import type { AnalysisFrameDto, SgfTreeDto } from "./types";

/** Keep distinct branches even when they share a turn; replace the current position
 * with its newest accepted stream sample (which can restart at fewer visits). */
export function retainLiveFrame(frames: AnalysisFrameDto[], frame: AnalysisFrameDto): AnalysisFrameDto[] {
  return [...frames.filter(old => old.node_id !== frame.node_id), frame];
}

/** Compose only frames belonging to the displayed document and mainline. */
export function reviewChartFrames(batch: AnalysisFrameDto[], live: AnalysisFrameDto[], text: string,
  tree: SgfTreeDto | null, selectedNodeId: string | null): AnalysisFrameDto[] {
  const mainlineIds = new Set(tree?.nodes.filter(node => node.is_mainline).map(node => node.id));
  const viewingMainline = selectedNodeId === null || mainlineIds.has(selectedNodeId);
  const pathIds = new Set<string>();
  let cursor = tree?.nodes.find(node => node.id === selectedNodeId);
  while (cursor && !pathIds.has(cursor.id)) {
    pathIds.add(cursor.id);
    cursor = tree?.nodes.find(node => node.id === cursor?.parent_id);
  }
  const acceptedLive = live.filter(frame => {
    try {
      const [document, nodeId] = JSON.parse(frame.node_id ?? "null");
      return document === text && (viewingMainline ? mainlineIds.has(nodeId) : pathIds.has(nodeId));
    } catch { return false; }
  });
  const result = new Map<number, AnalysisFrameDto>();
  for (const frame of [...(viewingMainline ? batch : []), ...acceptedLive]) {
    // A fresh live session must agree with the board, even before it catches up in visits.
    result.set(frame.turn, frame);
  }
  return [...result.values()].sort((a, b) => a.turn - b.turn);
}

/** Rebind only unchanged node ancestry after an explicit append operation.
 * Rules, komi, setup stones and all ancestor properties must remain identical.
 * Never use this for opening a different document. */
export function rebindAppendedFrames(frames: AnalysisFrameDto[], oldText: string, oldTree: SgfTreeDto | null,
  newText: string, newTree: SgfTreeDto | null): AnalysisFrameDto[] {
  function signature(tree: SgfTreeDto | null, id: string): string | null {
    const path = []; const seen = new Set<string>();
    let node = tree?.nodes.find(n => n.id === id);
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      path.push([node.color, node.vertex, node.properties]);
      if (node.id === tree?.root_id) return JSON.stringify(path);
      const parent = node.parent_id;
      node = tree?.nodes.find(n => n.id === parent);
    }
    return null;
  }
  return frames.flatMap(frame => {
    try {
      const key = JSON.parse(frame.node_id ?? 'null');
      if (!Array.isArray(key) || key[0] !== oldText) return [];
      const before = signature(oldTree, key[1]);
      if (!before || before !== signature(newTree, key[1])) return [];
      return [{...frame, node_id: JSON.stringify([newText, ...key.slice(1)])}];
    } catch { return []; }
  });
}
