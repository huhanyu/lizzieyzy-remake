import { createContext, useContext, useState, useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import type { SgfTreeDto, SgfTreeNodeDto } from "../domain/types";
import { vertexLabel } from "../domain/board";

export const SgfGraphFitContext = createContext(false);

type PositionedNode = { node: SgfTreeNodeDto; column: number; row: number; parent: string | null };

// A subtree owns its lanes. Sibling subtrees therefore never overlap, even
// when a later variation is longer than the main line.
export function layoutSgfGraph(tree: SgfTreeDto): PositionedNode[] {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const visited = new Set<string>();
  const result: PositionedNode[] = [];
  let nextColumn = 0;
  const visit = (id: string, row: number, column: number, parent: string | null): void => {
    const node = byId.get(id);
    if (!node || visited.has(id)) return;
    visited.add(id);
    result.push({ node, row, column, parent });
    nextColumn = Math.max(nextColumn, column + 1);
    node.child_ids.forEach((child, index) => visit(child, row + 1, index === 0 ? column : nextColumn, id));
  };
  visit(tree.root_id, 0, 0, null);
  for (const node of tree.nodes) if (!visited.has(node.id)) visit(node.id, 0, nextColumn, null);
  return result;
}

export function SgfNodeGraph({ tree, selectedNodeId, boardSize, onSelectNode }: {
  tree: SgfTreeDto; selectedNodeId: string | null; boardSize: number; onSelectNode: (id: string) => void;
}) {
  const fit = useContext(SgfGraphFitContext);
  const [bounds, setBounds] = useState({width:160,height:600});
  const nodes = useMemo(() => layoutSgfGraph(tree), [tree]);
  const byId = useMemo(() => new Map(nodes.map(item => [item.node.id, item])), [nodes]);
  const activePath = useMemo(() => {
    const path = new Set<string>();
    let id = selectedNodeId;
    while (id && !path.has(id)) { path.add(id); id = byId.get(id)?.parent ?? null; }
    return path;
  }, [byId, selectedNodeId]);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fit || !viewport.current) return;
    const host = viewport.current;
    const observer = new ResizeObserver(() => setBounds({width:host.clientWidth,height:host.clientHeight}));
    observer.observe(host);
    setBounds({width:host.clientWidth,height:host.clientHeight});
    return () => observer.disconnect();
  }, [fit]);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (fit) return;
    const button = selectedNodeId ? buttons.current.get(selectedNodeId) : null;
    const container = viewport.current;
    if (!button || !container) return;
    const top = button.offsetTop, left = button.offsetLeft;
    if (top < container.scrollTop || top + 24 > container.scrollTop + container.clientHeight) container.scrollTop = Math.max(0, top - container.clientHeight / 2);
    if (left < container.scrollLeft || left + 24 > container.scrollLeft + container.clientWidth) container.scrollLeft = Math.max(0, left - container.clientWidth / 2);
  }, [selectedNodeId, nodes, fit]);
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, item: PositionedNode) => {
    let target: string | undefined;
    if (event.key === "ArrowUp") target = item.parent ?? undefined;
    if (event.key === "ArrowDown") target = item.node.child_ids.find(id => byId.has(id));
    if (event.key === "Home") target = tree.root_id;
    if (event.key === "End") {
      let end = item;
      const seen = new Set<string>();
      while (end.node.child_ids[0] && !seen.has(end.node.id)) {
        seen.add(end.node.id);
        const next = byId.get(end.node.child_ids[0]);
        if (!next) break;
        end = next;
      }
      target = end.node.id;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const peers = nodes.filter(n => n.row === item.row).sort((a, b) => a.column - b.column);
      target = peers[peers.indexOf(item) + (event.key === "ArrowLeft" ? -1 : 1)]?.node.id;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) event.preventDefault();
    if (target) { onSelectNode(target); buttons.current.get(target)?.focus({ preventScroll: true }); }
  };
  const inset = 20;
  const columns = Math.max(1, ...nodes.map(n => n.column));
  const rows = Math.max(1, ...nodes.map(n => n.row));
  const gapX = fit ? Math.min(24, Math.max(1,(bounds.width - inset * 2) / columns)) : 24;
  const gapY = fit ? Math.min(24, Math.max(1,(bounds.height - inset * 2) / rows)) : 24;
  const hitWidth = Math.min(24,gapX), hitHeight = Math.min(24,gapY);
  const width = Math.max(fit ? bounds.width : 160, ...nodes.map(n => n.column * gapX + inset * 2));
  const height = Math.max(fit ? bounds.height : 120, ...nodes.map(n => n.row * gapY + inset * 2));
  return <div ref={viewport} className="sgf-node-graph" data-testid="sgf-tree-list" aria-label="棋谱分支图" style={{ overflow: fit ? "hidden" : "auto", minHeight: 120, maxHeight: 280, position: "relative" }}>
    <div className="sgf-node-graph-surface" style={{ position: "relative", width, height, margin: "0 auto" }}>
      <svg width={width} height={height} aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {nodes.map(item => {
          const parent = item.parent ? byId.get(item.parent) : null;
          if (!parent) return null;
          const x1 = parent.column * gapX + inset, y1 = parent.row * gapY + inset;
          const x2 = item.column * gapX + inset, y2 = item.row * gapY + inset;
          return <path key={item.node.id} d={`M ${x1} ${y1} L ${x2 === x1 ? x1 : x2 - gapX / 2} ${y1} L ${x2} ${y2}`} fill="none" stroke={activePath.has(item.node.id) ? "#d7dfe0" : "#586166"} strokeWidth="1.25" />;
        })}
      </svg>
      {nodes.map(item => {
        const { node } = item;
        const selected = node.id === selectedNodeId;
        const label = node.color && node.vertex ? `第 ${node.move_number ?? 0} 手 ${node.color === "black" ? "黑" : "白"} ${vertexLabel(node.vertex, boardSize)}` : "根节点";
        return <button key={node.id} ref={element => { if (element) buttons.current.set(node.id, element); else buttons.current.delete(node.id); }}
          type="button" className={`sgf-graph-node${selected ? " is-selected" : ""}${activePath.has(node.id) ? " is-active-path" : ""}`}
          style={{ position: "absolute", left: item.column * gapX + inset - hitWidth / 2, top: item.row * gapY + inset - hitHeight / 2, width: hitWidth, height: hitHeight, padding: 0, border: 0, background: "transparent", display: "grid", placeItems: "center" }}
          title={`${label}${node.comment ? ` · ${node.comment}` : ""}`} aria-label={`${label}${selected ? "，当前节点" : ""}`}
          aria-current={selected ? "true" : undefined} tabIndex={selected || (!selectedNodeId && node.id === tree.root_id) ? 0 : -1}
          data-testid="sgf-tree-node" data-sgf-node-id={node.id} data-sgf-move-number={node.move_number ?? ""} data-sgf-variation-index={node.variation_index} data-sgf-mainline={String(node.is_mainline)}
          onClick={() => onSelectNode(node.id)} onKeyDown={event => keyDown(event, item)}>
          <span aria-hidden="true" style={{ display: "block", width: selected ? 9 : Math.min(7,gapY*.7), height: selected ? 9 : Math.min(7,gapY*.7), borderRadius: node.id === tree.root_id ? 1 : "50%", transform: node.id === tree.root_id ? "rotate(45deg)" : undefined, background: activePath.has(node.id) ? "#e4e9e9" : "#697277", outline: selected ? "2px solid #1bc7c3" : undefined, outlineOffset: 3 }} />
        </button>;
      })}
    </div>
  </div>;
}
