import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { SgfPropertyUpdate } from "../api/backend";
import { vertexLabel } from "../domain/board";
import type { MoveVertex, PlayerColor, SgfTreeDto, SgfTreeNodeDto } from "../domain/types";
import { SgfAnnotationPanel } from "./SgfAnnotationPanel";
import { SgfNodeGraph } from "./SgfNodeGraph";

type Props = {
  tree: SgfTreeDto | null;
  selectedNodeId: string | null;
  currentMove: number;
  onSelectNode: (nodeId: string) => void;
  onSaveComment: (nodeId: string, comment: string) => void;
  onSaveProperties?: (nodeId: string, updates: SgfPropertyUpdate[]) => void;
  onSaveAnnotations?: (nodeId: string, updates: SgfPropertyUpdate[]) => void;
  onDeleteNode?: (nodeId: string) => void;
  onReorderNode?: (nodeId: string, targetIndex: number) => void;
  canDelete?: boolean;
  canReorder?: boolean;
  commentDraft?: string;
  onCommentDraftChange?: (comment: string) => void;
  commentReadOnly?: boolean;
  isCommentSaving?: boolean;
  isPropertySaving?: boolean;
  isAnnotationSaving?: boolean;
  isNodeDeleting?: boolean;
  isNodeReordering?: boolean;
  commentActionLabel?: string;
  commentNote?: string;
  annotationError?: string | null;
  isLoading?: boolean;
  parseError?: string | null;
  boardSize?: number;
  moveEditMode?: MoveEditMode;
  canEditSelectedMove?: boolean;
  onMoveEditModeChange?: (mode: MoveEditMode) => void;
  onEditSelectedMovePass?: () => void;
  isMoveEditing?: boolean;
};

type MoveEditMode = "append" | "edit";

const activeModeButtonStyle: CSSProperties = {
  borderColor: "#fb923c",
  background: "#fff7ed",
  color: "#7c2d12"
};

export function SgfTreePanel({
  tree,
  selectedNodeId,
  onSelectNode,
  onSaveComment,
  onSaveProperties,
  onSaveAnnotations,
  onDeleteNode,
  onReorderNode,
  canDelete = true,
  canReorder = true,
  commentDraft,
  onCommentDraftChange,
  commentReadOnly = false,
  isCommentSaving = false,
  isPropertySaving = false,
  isAnnotationSaving = false,
  isNodeDeleting = false,
  isNodeReordering = false,
  commentActionLabel = "Save Comment",
  commentNote,
  annotationError = null,
  isLoading = false,
  parseError = null,
  boardSize = 19,
  moveEditMode = "append",
  canEditSelectedMove = false,
  onMoveEditModeChange,
  onEditSelectedMovePass,
  isMoveEditing = false
}: Props) {
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return tree?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [selectedNodeId, tree]);
  const selectedComment = selectedNode?.comment ?? "";
  const [localDraft, setLocalDraft] = useState(selectedComment);
  const draftValue = commentDraft ?? localDraft;
  const isSelectedRoot = Boolean(selectedNode && tree?.root_id === selectedNode.id);
  const propertyFields = useMemo(() => getPropertyFields(isSelectedRoot), [isSelectedRoot]);
  const selectedPropertyDraft = useMemo(() => buildPropertyDraft(selectedNode, propertyFields), [selectedNode, propertyFields]);
  const [propertyDraft, setPropertyDraft] = useState<Record<string, string>>(selectedPropertyDraft);
  const propertyUpdates = useMemo(
    () => buildPropertyUpdates(selectedNode, propertyFields, propertyDraft),
    [selectedNode, propertyFields, propertyDraft]
  );
  const canDeleteSelectedNode = Boolean(canDelete && selectedNode && !isSelectedRoot && !isLoading && !isNodeDeleting && onDeleteNode);
  const siblingState = useMemo(() => getSiblingState(tree, selectedNode), [tree, selectedNode]);
  const canMoveSelectedNodeUp = Boolean(canReorder && onReorderNode && !isLoading && !isNodeReordering && siblingState.canMoveUp);
  const canMoveSelectedNodeDown = Boolean(canReorder && onReorderNode && !isLoading && !isNodeReordering && siblingState.canMoveDown);
  const moveEditState = getMoveEditState({ selectedNode, canEditSelectedMove });
  const canChangeMoveEditMode = Boolean(!isLoading && !isMoveEditing && onMoveEditModeChange);
  const canUseEditMode = Boolean(canChangeMoveEditMode && canEditSelectedMove);
  const canPassSelectedMove = Boolean(!isLoading && !isMoveEditing && moveEditMode === "edit" && canEditSelectedMove && onEditSelectedMovePass);

  useEffect(() => {
    setLocalDraft(selectedComment);
  }, [selectedComment, selectedNodeId]);

  useEffect(() => {
    setPropertyDraft(selectedPropertyDraft);
  }, [selectedPropertyDraft, selectedNodeId]);

  const handleDraftChange = (value: string) => {
    setLocalDraft(value);
    onCommentDraftChange?.(value);
  };

  const handlePropertyDraftChange = (key: string, value: string) => {
    setPropertyDraft((current) => ({ ...current, [key]: value }));
  };

  const handleSaveComment = () => {
    if (!selectedNode) return;
    onSaveComment(selectedNode.id, draftValue);
  };

  const handleSaveProperties = () => {
    if (!selectedNode || !onSaveProperties || propertyUpdates.length === 0) return;
    onSaveProperties(selectedNode.id, propertyUpdates);
  };

  const handleDeleteNode = () => {
    if (!canDeleteSelectedNode || !selectedNode || !onDeleteNode) return;
    onDeleteNode(selectedNode.id);
  };

  const handleMoveSelectedNode = (direction: -1 | 1) => {
    if ((direction < 0 && !canMoveSelectedNodeUp) || (direction > 0 && !canMoveSelectedNodeDown)) return;
    if (!selectedNode || !onReorderNode || siblingState.index < 0) return;
    const targetIndex = siblingState.index + direction;
    if (targetIndex < 0 || targetIndex >= siblingState.count) return;
    onReorderNode(selectedNode.id, targetIndex);
  };

  const handleMoveEditModeChange = (mode: MoveEditMode) => {
    if (!canChangeMoveEditMode) return;
    if (mode === "edit" && !canEditSelectedMove) return;
    onMoveEditModeChange?.(mode);
  };

  const handleEditSelectedMovePass = () => {
    if (!canPassSelectedMove) return;
    onEditSelectedMovePass?.();
  };

  const status = getPanelStatus({ tree, isLoading, parseError });

  return (
    <aside className="sgf-tree-panel" aria-label="SGF tree and comments" data-testid="sgf-tree-panel">
      <header className="sgf-tree-header">
        <div>
          <h2>棋谱分支</h2>
          <span>{status ? status.label : `${tree?.nodes.length.toLocaleString() ?? 0} 个节点`}</span>
        </div>
        {selectedNode ? <strong title={selectedNode.id}>{formatNodeMove(selectedNode, boardSize)}</strong> : <strong>未选节点</strong>}
      </header>

      {status ? <div className={`sgf-tree-state ${status.kind}`} role={status.kind === "sgf-tree-error" ? "alert" : "status"} data-testid="sgf-tree-state">
        <strong>{status.title}</strong>
        <span>{status.message}</span>
      </div> : tree ? <SgfNodeGraph tree={tree} selectedNodeId={selectedNodeId} boardSize={boardSize} onSelectNode={onSelectNode} /> : null}

      {selectedNode && siblingState.index > 0 && <button className="sgf-promote-main" disabled={!canMoveSelectedNodeUp}
        onClick={() => onReorderNode?.(selectedNode.id, 0)}>设为主分支</button>}

      <details className="sgf-node-details"><summary>注释与节点编辑</summary>

      <section className="sgf-comment-editor" aria-label="Node comment">
        <div className="sgf-comment-header">
          <div>
            <h3>节点注释</h3>
            <span>{selectedNode ? formatNodeMove(selectedNode, boardSize) : "请选择节点"}</span>
          </div>
          <div className="sgf-node-actions" aria-label="Selected node actions">
            <button
                type="button"
                className="sgf-reorder-node-button"
                data-testid="sgf-node-move-up"
                onClick={() => handleMoveSelectedNode(-1)}
              disabled={!canMoveSelectedNodeUp}
              title={siblingState.help}
            >
              上移分支
            </button>
            <button
                type="button"
                className="sgf-reorder-node-button"
                data-testid="sgf-node-move-down"
                onClick={() => handleMoveSelectedNode(1)}
              disabled={!canMoveSelectedNodeDown}
              title={siblingState.help}
            >
              下移分支
            </button>
              <button type="button" className="sgf-delete-node-button" data-testid="sgf-node-delete" onClick={handleDeleteNode} disabled={!canDeleteSelectedNode}>
              {isNodeDeleting ? "删除中..." : "删除节点"}
            </button>
          </div>
        </div>
        <div
          aria-label="Move edit mode"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: 8,
            alignItems: "center",
            minWidth: 0,
            padding: "7px 8px",
            border: "1px solid #d2d8e0",
            borderRadius: 4,
            background: "#eef2f6"
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 12 }}>落子模式</h3>
            <p className="sgf-comment-note" title={moveEditState.help}>{moveEditState.label}</p>
          </div>
          <div className="sgf-node-actions" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button
                type="button"
                className="sgf-reorder-node-button"
                data-testid="sgf-tree-mode-append"
                onClick={() => handleMoveEditModeChange("append")}
              disabled={!canChangeMoveEditMode}
              aria-pressed={moveEditMode === "append"}
              title={canChangeMoveEditMode ? "追加模式" : "落子模式不可用"}
              style={moveEditMode === "append" ? activeModeButtonStyle : undefined}
            >
              追加
            </button>
            <button
                type="button"
                className="sgf-reorder-node-button"
                data-testid="sgf-tree-mode-edit"
                onClick={() => handleMoveEditModeChange("edit")}
              disabled={!canUseEditMode}
              aria-pressed={moveEditMode === "edit"}
              title={canEditSelectedMove ? "修改当前选定的着法" : moveEditState.help}
              style={moveEditMode === "edit" ? activeModeButtonStyle : undefined}
            >
              修改
            </button>
            <button
                type="button"
                className="sgf-reorder-node-button"
                data-testid="sgf-tree-edit-pass"
                onClick={handleEditSelectedMovePass}
              disabled={!canPassSelectedMove}
              title={canPassSelectedMove ? "将当前着法改为虚手停一手" : "可在修改模式下使用"}
            >
              {isMoveEditing ? "保存中..." : "停一手"}
            </button>
          </div>
        </div>
        <p className="sgf-variation-order-note">{siblingState.label}</p>
          <textarea
            data-testid="sgf-comment-textarea"
            value={draftValue}
          onChange={(event) => handleDraftChange(event.target.value)}
          disabled={!selectedNode || isLoading || commentReadOnly}
          spellCheck={false}
          aria-label="Selected SGF node comment"
          placeholder={selectedNode ? "该节点暂无注释。" : "选择节点后可编辑注释。"}
        />
        {commentNote ? <p className="sgf-comment-note">{commentNote}</p> : null}
          <button type="button" data-testid="sgf-comment-save" onClick={handleSaveComment} disabled={!selectedNode || isLoading || commentReadOnly || isCommentSaving || draftValue === selectedComment}>
          {isCommentSaving ? "保存中..." : commentActionLabel}
        </button>
      </section>

      <SgfAnnotationPanel
        selectedNode={selectedNode}
        disabled={isLoading}
        isSaving={isAnnotationSaving}
        error={annotationError}
        onSaveAnnotations={onSaveAnnotations}
      />

      <section className="sgf-properties-editor" aria-label="SGF node properties" data-testid="sgf-properties-editor">
        <div className="sgf-properties-header">
          <div>
            <h3>节点属性 (Properties)</h3>
            <span>当前选中节点的 SGF 属性详情</span>
          </div>
        </div>
        <div className="sgf-property-grid">
          {propertyFields.map((field) => {
            const value = propertyDraft[field.key] ?? "";
            return (
              <label key={field.key} className="sgf-property-field">
                <span>{field.label}</span>
                {field.multiline ? (
                    <textarea
                      data-testid={`sgf-property-${field.key.toLowerCase()}`}
                      value={value}
                    onChange={(event) => handlePropertyDraftChange(field.key, event.target.value)}
                    disabled={!selectedNode || isLoading || isPropertySaving || !onSaveProperties}
                    spellCheck={false}
                    aria-label={`${field.key} SGF property values`}
                    placeholder={field.placeholder}
                  />
                ) : (
                    <input
                      data-testid={`sgf-property-${field.key.toLowerCase()}`}
                      value={value}
                    onChange={(event) => handlePropertyDraftChange(field.key, event.target.value)}
                    disabled={!selectedNode || isLoading || isPropertySaving || !onSaveProperties}
                    spellCheck={false}
                    aria-label={`${field.key} SGF property value`}
                    placeholder={field.placeholder}
                  />
                )}
              </label>
            );
          })}
        </div>
        <p className="sgf-properties-note">标记字段支持以逗号或换行分隔的 SGF 坐标。留空将删除该属性。</p>
          <button
            type="button"
            data-testid="sgf-properties-save"
          onClick={handleSaveProperties}
          disabled={!selectedNode || isLoading || isPropertySaving || !onSaveProperties || propertyUpdates.length === 0}
        >
          {isPropertySaving ? "保存中..." : "保存属性"}
        </button>
      </section>
      </details>
    </aside>
  );
}

type PropertyField = {
  key: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
  multiValue?: boolean;
};

const nodePropertyFields: PropertyField[] = [
  { key: "N", label: "N 节点名称", placeholder: "例如定式选择" }
];

const rootPropertyFields: PropertyField[] = [
  { key: "PB", label: "PB 黑方棋手", placeholder: "黑方姓名" },
  { key: "PW", label: "PW 白方棋手", placeholder: "白方姓名" },
  { key: "KM", label: "KM 贴目", placeholder: "7.5" },
  { key: "RE", label: "RE 对局结果", placeholder: "黑中盘胜 B+R" }
];

function getPropertyFields(isRoot: boolean): PropertyField[] {
  return isRoot ? [...rootPropertyFields, ...nodePropertyFields] : nodePropertyFields;
}

function getSiblingState(tree: SgfTreeDto | null, node: SgfTreeNodeDto | null) {
  const disabled = { index: -1, count: 0, canMoveUp: false, canMoveDown: false };
  if (!tree || !node) {
    return { ...disabled, label: "选择同级分支以调整顺序。分支 1 为主干。", help: "选择带有兄弟节点的分支以调整顺序。" };
  }
  if (tree.root_id === node.id || node.parent_id === null || node.parent_id === undefined) {
    return { ...disabled, label: "根节点无同级分支。分支 1 为主干。", help: "根节点无法调整分支顺序。" };
  }
  const parent = tree.nodes.find((candidate) => candidate.id === node.parent_id) ?? null;
  const siblingIds = parent?.child_ids ?? [];
  const index = siblingIds.indexOf(node.id);
  if (!parent || index < 0) {
    return { ...disabled, label: "当前节点同级顺序不可用。", help: "选中的节点在父节点的子节点列表中缺失。" };
  }
  if (siblingIds.length < 2) {
    return { ...disabled, index, count: siblingIds.length, label: "当前分支只有一个同级节点。分支 1 为主干。", help: "至少需要两个同级节点才可调序。" };
  }
  const positionLabel = `分支 ${index + 1} / 共 ${siblingIds.length} 个`;
  return {
    index,
    count: siblingIds.length,
    canMoveUp: index > 0,
    canMoveDown: index < siblingIds.length - 1,
    label: `${positionLabel}。分支 1 为主干。`,
    help: `${positionLabel}。调整同级顺序，第 1 个位置成为主干。`
  };
}

function getMoveEditState({ selectedNode, canEditSelectedMove }: { selectedNode: SgfTreeNodeDto | null; canEditSelectedMove: boolean }) {
  if (!selectedNode) return { label: "请选择节点", help: "选择着法节点后可启用“修改”。" };
  if (canEditSelectedMove) return { label: "可修改选定着法", help: "在修改模式下，点击棋盘将替换选中的着法。" };
  if (!selectedNode.color || !selectedNode.vertex) return { label: "选中节点无着法", help: "仅着法节点可使用修改功能。" };
  return { label: "选定着法已锁定", help: "此选定着法暂不可在此编辑。" };
}

function buildPropertyDraft(node: SgfTreeNodeDto | null, fields: PropertyField[]): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const field of fields) {
    if (!node) {
      draft[field.key] = "";
      continue;
    }
    const values = propertyValues(node, field.key);
    draft[field.key] = field.multiValue ? values.join("\n") : values[0] ?? "";
  }
  return draft;
}

function buildPropertyUpdates(node: SgfTreeNodeDto | null, fields: PropertyField[], draft: Record<string, string>): SgfPropertyUpdate[] {
  if (!node) return [];
  return fields.flatMap((field) => {
    const previous = normalizeComparablePropertyValues(propertyValues(node, field.key), field);
    const next = parsePropertyValues(draft[field.key] ?? "", field);
    return arePropertyValuesEqual(previous, next) ? [] : [{ key: field.key, values: next }];
  });
}

function propertyValues(node: SgfTreeNodeDto, key: string): string[] {
  return node.properties.find((property) => property.key.toUpperCase() === key)?.values ?? [];
}

function parsePropertyValues(value: string, field: PropertyField): string[] {
  if (!field.multiValue) {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeComparablePropertyValues(values: string[], field: PropertyField): string[] {
  return field.multiValue ? values : values.slice(0, 1);
}

function arePropertyValuesEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getPanelStatus({ tree, isLoading, parseError }: { tree: SgfTreeDto | null; isLoading: boolean; parseError: string | null }) {
  if (isLoading) return null;
  if (parseError) return { kind: "sgf-tree-error", title: "解析错误", label: "解析失败", message: parseError };
  if (!tree) return { kind: "sgf-tree-empty", title: "无分支树", label: "空", message: "打开或解析 SGF 文件以显示分支树。" };
  if (tree.nodes.length === 0) return { kind: "sgf-tree-empty", title: "空分支树", label: "空", message: "解析后的 SGF 树没有节点。" };
  return null;
}

function formatNodeMove(node: SgfTreeNodeDto, boardSize: number): string {
  if (!node.vertex || !node.color) return node.move_number ? `第 ${node.move_number} 手` : "根节点";
  return `${node.move_number ?? "-"} ${colorLabel(node.color)} ${formatVertex(node.vertex, boardSize)}`;
}

function formatVertex(vertex: MoveVertex, boardSize: number): string {
  return vertexLabel(vertex, boardSize).toUpperCase();
}

function colorLabel(color: PlayerColor): string {
  return color === "black" ? "B" : "W";
}

