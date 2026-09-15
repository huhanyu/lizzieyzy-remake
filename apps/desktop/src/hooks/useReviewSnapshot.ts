import { useEffect, useRef, useState } from "react";
import type { ReviewScope } from "../domain/reviewStatistics";
/** Coalesce streaming updates without postponing them forever; document changes bypass the timer. */
export function useReviewSnapshot(scope: ReviewScope) {
  const latest = useRef(scope);
  latest.current = scope;
  const [snapshot, setSnapshot] = useState(scope);
  useEffect(() => {
    const timer = window.setInterval(
      () =>
        setSnapshot((old) => {
          const next = latest.current;
          return old.frames === next.frames &&
            old.tree === next.tree &&
            old.selectedNodeId === next.selectedNodeId &&
            old.documentKey === next.documentKey &&
            old.analysisJobId === next.analysisJobId
            ? old
            : next;
        }),
      500,
    );
    return () => window.clearInterval(timer);
  }, []);
  return snapshot.documentKey === scope.documentKey &&
    snapshot.tree === scope.tree &&
    snapshot.selectedNodeId === scope.selectedNodeId &&
    snapshot.analysisJobId === scope.analysisJobId
    ? snapshot
    : scope;
}
