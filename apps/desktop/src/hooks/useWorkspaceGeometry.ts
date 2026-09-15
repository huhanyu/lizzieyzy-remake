import { useLayoutEffect, type RefObject } from "react";

/** Size the square first; keep the analysis column readable on ultrawide displays. */
export function useWorkspaceGeometry(ref: RefObject<HTMLElement>, showTree = false) {
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const measure = () => {
      if (host.clientWidth <= 800) {
        host.style.removeProperty("--board-side");
        host.style.removeProperty("--analysis-width");
        return;
      }
      const style = getComputedStyle(host);
      const width = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const gap = parseFloat(style.columnGap) || 14;
      const tools = host.querySelector<HTMLElement>(".board-tools-row");
      const navigation = host.querySelector<HTMLElement>(".legacy-timeline");
      const controls = (tools?.offsetHeight || 36) + (navigation?.offsetHeight || 54) + 4;
      const treeSpace = showTree ? 160 + gap : 0;
      const side = Math.max(1, Math.floor(Math.min(height - controls, width - treeSpace - 340 - gap)));
      const panel = Math.min(620, Math.max(340, width - treeSpace - side - gap));
      host.style.setProperty("--board-side", `${side}px`);
      host.style.setProperty("--analysis-width", `${panel}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    const tools = host.querySelector(".board-tools-row");
    if (tools) observer.observe(tools);
    measure();
    return () => observer.disconnect();
  }, [ref, showTree]);
}
