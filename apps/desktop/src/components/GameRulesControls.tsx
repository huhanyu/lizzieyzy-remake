import { useEffect, useState } from "react";
import { gameRulesLabel, SUPPORTED_GAME_RULES } from "../domain/positionMetrics";
import "./PositionSummary.css";

export type GameRulesControlsProps = {
  rules?: string | null;
  komi: number;
  disabled?: boolean;
  onApply: (rules: string, komi: number) => Promise<void>;
};
export function GameRulesControls({ rules, komi, disabled = false, onApply }: GameRulesControlsProps) {
  const initialRule = rules?.trim().toLowerCase() || "chinese";
  const [draftRules, setDraftRules] = useState(initialRule);
  const [draftKomi, setDraftKomi] = useState(String(komi));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraftRules(initialRule); setDraftKomi(String(komi)); setError(null); }, [initialRule, komi]);
  const supported = SUPPORTED_GAME_RULES.some(rule => rule.value === draftRules);
  const numericKomi = Number(draftKomi);
  const valid = supported && draftKomi.trim() !== "" && Number.isFinite(numericKomi);
  async function apply(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || busy || !valid) return;
    setBusy(true); setError(null);
    try { await onApply(draftRules, numericKomi); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  return <form className="game-rules-controls" onSubmit={apply} aria-label="修改规则和贴目">
    <label>规则<select value={draftRules} disabled={disabled || busy} onChange={event => setDraftRules(event.target.value)}>
      {!supported && <option value={draftRules} disabled>{gameRulesLabel(draftRules)}（请选择支持的规则）</option>}
      {SUPPORTED_GAME_RULES.map(rule => <option key={rule.value} value={rule.value}>{rule.label}</option>)}
    </select></label>
    <label>贴目<input type="number" step="0.5" value={draftKomi} disabled={disabled || busy} onChange={event => setDraftKomi(event.target.value)} /></label>
    <button type="submit" disabled={disabled || busy || !valid}>{busy ? "应用中…" : "应用规则与贴目"}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
