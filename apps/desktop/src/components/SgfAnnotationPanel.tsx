import { useEffect, useMemo, useState } from "react";
import type { SgfPropertyUpdate } from "../api/backend";
import type { SgfTreeNodeDto } from "../domain/types";

type Props = {
  selectedNode: SgfTreeNodeDto | null;
  disabled?: boolean;
  isSaving?: boolean;
  error?: string | null;
  onSaveAnnotations?: (nodeId: string, updates: SgfPropertyUpdate[]) => void;
};

type AnnotationField = {
  key: string;
  label: string;
  placeholder: string;
};

const annotationFields: AnnotationField[] = [
  { key: "TR", label: "三角形 (TR)", placeholder: "dd, pp" },
  { key: "SQ", label: "正方形 (SQ)", placeholder: "dc, qc" },
  { key: "CR", label: "圆圈 (CR)", placeholder: "jj" },
  { key: "MA", label: "叉号 (MA)", placeholder: "pq" },
  { key: "SL", label: "选中 (SL)", placeholder: "cc, qq" },
  { key: "LB", label: "文本标签 (LB)", placeholder: "dd:A, pp:B" },
  { key: "AR", label: "箭头 (AR)", placeholder: "dd:pp" },
  { key: "LN", label: "连线 (LN)", placeholder: "dc:qc" }
];

export function SgfAnnotationPanel({ selectedNode, disabled = false, isSaving = false, error = null, onSaveAnnotations }: Props) {
  const selectedDraft = useMemo(() => buildAnnotationDraft(selectedNode), [selectedNode]);
  const [draft, setDraft] = useState<Record<string, string[]>>(selectedDraft);
  const [addDraft, setAddDraft] = useState<Record<string, string>>({});
  const updates = useMemo(() => buildAnnotationUpdates(selectedNode, draft), [selectedNode, draft]);

  useEffect(() => {
    setDraft(selectedDraft);
    setAddDraft({});
  }, [selectedDraft, selectedNode?.id]);

  function handleTextChange(key: string, value: string) {
    setDraft((current) => ({ ...current, [key]: parseAnnotationValues(value) }));
  }

  function handleAddValue(key: string) {
    const values = parseAnnotationValues(addDraft[key] ?? "");
    if (values.length === 0) return;
    setDraft((current) => ({ ...current, [key]: mergeAnnotationValues(current[key] ?? [], values) }));
    setAddDraft((current) => ({ ...current, [key]: "" }));
  }

  function handleRemoveValue(key: string, value: string) {
    setDraft((current) => ({ ...current, [key]: (current[key] ?? []).filter((item) => item !== value) }));
  }

  function handleClear(key: string) {
    setDraft((current) => ({ ...current, [key]: [] }));
  }

  function handleSave() {
    if (!selectedNode || updates.length === 0) return;
    onSaveAnnotations?.(selectedNode.id, updates);
  }

  return (
    <section className="sgf-annotation-editor" aria-label="SGF node annotations" data-testid="sgf-annotation-editor">
      <div className="sgf-properties-header">
        <div>
          <h3>棋盘标注</h3>
          <span>在选定节点上设置 TR 三角形、SQ 正方形、CR 圆圈、MA 叉号、SL 选中、LB 标签、AR 箭头、LN 连线</span>
        </div>
      </div>
      <div className="sgf-property-grid">
        {annotationFields.map((field) => {
          const values = draft[field.key] ?? [];
          const textValue = values.join("\n");
          return (
            <div key={field.key} className="sgf-property-field">
              <span>{field.key} {field.label}</span>
                <textarea
                  data-testid={`sgf-annotation-${field.key.toLowerCase()}-values`}
                  value={textValue}
                onChange={(event) => handleTextChange(field.key, event.target.value)}
                disabled={!selectedNode || disabled || isSaving || !onSaveAnnotations}
                spellCheck={false}
                aria-label={`${field.key} 标注值`}
                placeholder={field.placeholder}
              />
              <span className="sgf-comment-note">
                {values.length > 0 ? values.join(", ") : "无标注值"}
              </span>
              <div className="sgf-node-actions" aria-label={`${field.key} 标注值控制`}>
                  <input
                    data-testid={`sgf-annotation-${field.key.toLowerCase()}-add-input`}
                    value={addDraft[field.key] ?? ""}
                  onChange={(event) => setAddDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                  disabled={!selectedNode || disabled || isSaving || !onSaveAnnotations}
                  spellCheck={false}
                  aria-label={`添加 ${field.key} 标注值`}
                  placeholder={field.placeholder}
                />
                  <button type="button" data-testid={`sgf-annotation-${field.key.toLowerCase()}-add`} onClick={() => handleAddValue(field.key)} disabled={!selectedNode || disabled || isSaving || !onSaveAnnotations}>
                  添加
                </button>
                  <button type="button" data-testid={`sgf-annotation-${field.key.toLowerCase()}-clear`} onClick={() => handleClear(field.key)} disabled={!selectedNode || disabled || isSaving || !onSaveAnnotations || values.length === 0}>
                  清空
                </button>
              </div>
              {values.length > 0 && (
                <div className="sgf-node-actions" aria-label={`${field.key} 已有标注值`}>
                  {values.map((value) => (
                      <button key={value} type="button" data-testid={`sgf-annotation-${field.key.toLowerCase()}-remove`} onClick={() => handleRemoveValue(field.key, value)} disabled={!selectedNode || disabled || isSaving || !onSaveAnnotations}>
                      移除 {value}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="sgf-properties-note">标注值支持逗号或换行分隔的 SGF 坐标。LB/AR/LN 使用冒号语法（如 dd:A、dd:pp）。留空对应字段将删除该标注属性。</p>
      {error ? <p className="sgf-comment-note" role="alert">{error}</p> : null}
      <button type="button" data-testid="sgf-annotations-save" onClick={handleSave} disabled={!selectedNode || disabled || isSaving || !onSaveAnnotations || updates.length === 0}>
        {isSaving ? "正在保存..." : "保存标注"}
      </button>
    </section>
  );
}

function buildAnnotationDraft(node: SgfTreeNodeDto | null): Record<string, string[]> {
  const draft: Record<string, string[]> = {};
  for (const field of annotationFields) draft[field.key] = node ? propertyValues(node, field.key) : [];
  return draft;
}

function buildAnnotationUpdates(node: SgfTreeNodeDto | null, draft: Record<string, string[]>): SgfPropertyUpdate[] {
  if (!node) return [];
  return annotationFields.flatMap((field) => {
    const previous = propertyValues(node, field.key);
    const next = draft[field.key] ?? [];
    return areValuesEqual(previous, next) ? [] : [{ key: field.key, values: next }];
  });
}

function propertyValues(node: SgfTreeNodeDto, key: string): string[] {
  return node.properties.find((property) => property.key.toUpperCase() === key)?.values ?? [];
}

function parseAnnotationValues(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeAnnotationValues(current: string[], added: string[]): string[] {
  return Array.from(new Set([...current, ...added]));
}

function areValuesEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
