import type { LegacyConfigMigrationApplyDto, LegacyConfigMigrationPreviewDto } from "../api/backend";
import type { AppPreferences, BoardTheme, ReviewMode } from "../domain/preferences";

type Props = {
  preferences: AppPreferences;
  status: string;
  disabled?: boolean;
  onChange: (preferences: AppPreferences) => void;
  legacyConfigPath: string;
  legacyConfigStatus: string;
  legacyConfigPreview: LegacyConfigMigrationPreviewDto | null;
  legacyConfigApplyResult: LegacyConfigMigrationApplyDto | null;
  isLegacyConfigMigrating?: boolean;
  onLegacyConfigPathChange: (path: string) => void;
  onPreviewLegacyConfigMigration: () => void;
  onApplyLegacyConfigMigration: () => void;
};

export function PreferencesPanel({
  preferences,
  status,
  disabled = false,
  onChange,
  legacyConfigPath,
  legacyConfigStatus,
  legacyConfigPreview,
  legacyConfigApplyResult,
  isLegacyConfigMigrating = false,
  onLegacyConfigPathChange,
  onPreviewLegacyConfigMigration,
  onApplyLegacyConfigMigration
}: Props) {
  function update(patch: Partial<AppPreferences>) {
    onChange({ ...preferences, ...patch });
  }

  const canRunMigration = !disabled && !isLegacyConfigMigrating && legacyConfigPath.trim().length > 0;
  const migratedFields = legacyConfigApplyResult?.migratedFields ?? legacyConfigPreview?.migratedFields ?? [];
  const warnings = legacyConfigApplyResult?.warnings ?? legacyConfigPreview?.warnings ?? [];
  const targetCategories = legacyConfigTargetCategories(legacyConfigPreview, legacyConfigApplyResult);
  const unsupportedHints = migrationWarningHints(warnings, "unsupported");
  const deprecatedHints = migrationWarningHints(warnings, "deprecated");
  const skippedTargets = legacyConfigApplyResult ? migrationSkippedTargets(legacyConfigApplyResult) : [];

  return (
    <section className="preferences-panel" aria-label="Application preferences" data-testid="preferences-panel">
      <div className="preferences-header">
        <h2>设置偏好</h2>
        <span>{status}</span>
      </div>
      <div className="preferences-grid">
        <Toggle label="候选点推荐" testId="candidates" checked={preferences.showCandidates} disabled={disabled} onChange={(checked) => update({ showCandidates: checked })} />
        <Toggle label="目数领地预测" testId="ownership" checked={preferences.showOwnership} disabled={disabled} onChange={(checked) => update({ showOwnership: checked })} />
        <Toggle label="策略选点分布" testId="policy" checked={preferences.showPolicy} disabled={disabled} onChange={(checked) => update({ showPolicy: checked })} />
        <Toggle label="自动加载缓存" testId="auto-load-cache" checked={preferences.autoLoadCache} disabled={disabled} onChange={(checked) => update({ autoLoadCache: checked })} />
        <Toggle label="自动保存分析" testId="auto-save-analysis" checked={preferences.autoSaveAnalysis} disabled={disabled} onChange={(checked) => update({ autoSaveAnalysis: checked })} />
        <label>
          <span>候选点显示上限</span>
          <input
            data-testid="preferences-candidate-limit"
            type="number"
            min={1}
            max={20}
            step={1}
            value={preferences.candidateLimit}
            disabled={disabled}
            onChange={(event) => update({ candidateLimit: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>默认计算量 (Visits)</span>
          <input
            data-testid="preferences-default-visits"
            type="number"
            min={1}
            step={1}
            value={preferences.defaultMaxVisits}
            disabled={disabled}
            onChange={(event) => update({ defaultMaxVisits: Number(event.target.value) })}
          />
        </label>
        <label>
          <span>复盘深度模式</span>
          <select data-testid="preferences-review-mode" value={preferences.reviewMode} disabled={disabled} onChange={(event) => update({ reviewMode: event.target.value as ReviewMode })}>
            <option value="quick">快速模式 (Quick)</option>
            <option value="deep">深度模式 (Deep)</option>
          </select>
        </label>
        <label>
          <span>棋盘主题风格</span>
          <select data-testid="preferences-board-theme" value={preferences.boardTheme} disabled={disabled} onChange={(event) => update({ boardTheme: event.target.value as BoardTheme })}>
            <option value="classic">经典木纹</option>
            <option value="high-contrast">高对比度</option>
          </select>
        </label>
      </div>
      <section className="legacy-config-migration" aria-label="Legacy Java/Swing config migration">
        <div className="preferences-header">
          <h3>导入旧版配置 (Java/Swing)</h3>
          <span>{legacyConfigStatus}</span>
        </div>
        <label>
          <span>旧版配置文件路径</span>
          <input
            data-testid="legacy-config-path-input"
            type="text"
            value={legacyConfigPath}
            disabled={disabled || isLegacyConfigMigrating}
            placeholder="/path/to/legacy/config"
            onChange={(event) => onLegacyConfigPathChange(event.target.value)}
          />
        </label>
        <div className="legacy-config-actions" aria-label="Legacy config migration actions">
          <button type="button" data-testid="legacy-config-preview" disabled={!canRunMigration} onClick={onPreviewLegacyConfigMigration}>预览配置</button>
          <button type="button" data-testid="legacy-config-apply" disabled={!canRunMigration || legacyConfigPreview === null} onClick={onApplyLegacyConfigMigration}>应用迁移</button>
        </div>
        <div className="migration-result" data-testid="legacy-config-scope-boundary">
          <strong>作用域限定说明</strong>
          <span>仅支持将旧版配置键映射至 Next 偏好设置及引擎配置。其余无关设置不会被覆盖，路径无效时严格保持防写保护。</span>
        </div>
        {(legacyConfigPreview || legacyConfigApplyResult) ? (
          <div className="migration-result" data-testid="legacy-config-target-categories">
            <strong>目标配置分类</strong>
            {targetCategories.length > 0 ? (
              <ul>
                {targetCategories.map((category) => <li key={category}>{category === "preferences" ? "设置偏好" : category === "engine profiles" ? "引擎配置" : category}</li>)}
              </ul>
            ) : <span>在旧版配置中未检测到可写入的偏好设置或引擎配置分类。</span>}
          </div>
        ) : null}
        {migratedFields.length > 0 ? (
          <div className="migration-result" data-testid="legacy-config-migrated-fields">
            <strong>已迁移字段</strong>
            <ul>
              {migratedFields.map((field) => <li key={field}>{field}</li>)}
            </ul>
          </div>
        ) : null}
        {(legacyConfigPreview || legacyConfigApplyResult) ? (
          <div className="migration-result" data-testid="legacy-config-unsupported-hints">
            <strong>不支持或已废弃键提示</strong>
            {unsupportedHints.length || deprecatedHints.length ? (
              <ul>
                {unsupportedHints.map((hint) => <li key={`unsupported-${hint}`}>不支持: {hint}</li>)}
                {deprecatedHints.map((hint) => <li key={`deprecated-${hint}`}>已废弃: {hint}</li>)}
              </ul>
            ) : <span>预览未报告任何不支持或已废弃的键。</span>}
          </div>
        ) : null}
        {warnings.length > 0 ? (
          <div className="migration-result" data-testid="legacy-config-warnings">
            <strong>提示与警告</strong>
            <ul>
              {warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </div>
        ) : null}
        {legacyConfigApplyResult ? (
          <div className="migration-result" data-testid="legacy-config-apply-status">
            <strong>{legacyConfigApplyResult.status === "failed" ? "应用失败" : "应用成功"}</strong>
            <span>
              偏好设置 {migrationWriteStatus(legacyConfigApplyResult, legacyConfigApplyResult.preferencesWritten)}；引擎配置 {migrationWriteStatus(legacyConfigApplyResult, legacyConfigApplyResult.engineProfilesWritten)}。
            </span>
          </div>
        ) : null}
        {legacyConfigApplyResult ? (
          <div className="migration-result" data-testid="legacy-config-skipped-targets">
            <strong>跳过或未写入项</strong>
            {skippedTargets.length > 0 ? (
              <ul>
                {skippedTargets.map((target) => <li key={target}>{target}</li>)}
              </ul>
            ) : <span>未报告任何跳过或未写入项。</span>}
          </div>
        ) : null}
        {legacyConfigApplyResult ? (
          <div className="migration-result" data-testid="legacy-config-safety-status">
            <strong>迁移安全检查</strong>
            <span>{migrationSafetySummary(legacyConfigApplyResult)}</span>
            {legacyConfigApplyResult.errorMessage ? <span role="alert">{legacyConfigApplyResult.errorMessage}</span> : null}
          </div>
        ) : null}
        {legacyConfigApplyResult?.writtenPathLabels.length ? (
          <div className="migration-result" data-testid="legacy-config-written-path-labels">
            <strong>已写入目标</strong>
            <ul>
              {legacyConfigApplyResult.writtenPathLabels.map((label) => <li key={label}>{label}</li>)}
            </ul>
          </div>
        ) : null}
        {legacyConfigApplyResult?.rollbackPaths.length ? (
          <div className="migration-result" data-testid="legacy-config-rollback-paths">
            <strong>回滚路径</strong>
            <ul>
              {legacyConfigApplyResult.rollbackPaths.map((path) => <li key={path}>{path}</li>)}
            </ul>
          </div>
        ) : null}
        {legacyConfigApplyResult?.rollbackErrors.length ? (
          <div className="migration-result" data-testid="legacy-config-rollback-errors">
            <strong>回滚错误</strong>
            <ul>
              {legacyConfigApplyResult.rollbackErrors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          </div>
        ) : null}
      </section>
    </section>
  );
}

function legacyConfigTargetCategories(preview: LegacyConfigMigrationPreviewDto | null, applyResult: LegacyConfigMigrationApplyDto | null): string[] {
  const categories: string[] = [];
  if (preview?.preferences || applyResult?.preferencesWritten || hasMigratedField(applyResult?.migratedFields ?? preview?.migratedFields ?? [], "preference")) {
    categories.push("preferences");
  }
  if (preview?.engineProfiles || applyResult?.engineProfilesWritten || hasMigratedField(applyResult?.migratedFields ?? preview?.migratedFields ?? [], "engine")) {
    categories.push("engine profiles");
  }
  return categories;
}

function hasMigratedField(fields: string[], token: string): boolean {
  return fields.some((field) => field.toLowerCase().includes(token));
}

function migrationWarningHints(warnings: string[], token: "unsupported" | "deprecated"): string[] {
  return warnings
    .filter((warning) => warning.toLowerCase().includes(token))
    .map((warning) => warning.replace(/^unsupported legacy config key was ignored:\s*/i, "").trim())
    .slice(0, 8);
}

function migrationSkippedTargets(result: LegacyConfigMigrationApplyDto): string[] {
  const skipped: string[] = [];
  if (!result.preferencesWritten) skipped.push(result.status === "failed" && result.noWriteOnError ? "偏好设置: 发生错误后未保留写入" : "偏好设置: 未检测到支持的目标");
  if (!result.engineProfilesWritten) skipped.push(result.status === "failed" && result.noWriteOnError ? "引擎配置: 发生错误后未保留写入" : "引擎配置: 未检测到支持的目标");
  if (result.status === "failed" && result.noWriteOnError && result.writtenPathLabels.length === 0) {
    skipped.push("无效配置防写保护: 未写入任何目标文件");
  }
  return skipped;
}

function migrationSafetySummary(result: LegacyConfigMigrationApplyDto): string {
  const status = result.status === "failed" ? "失败" : "已应用";
  const transactional = result.transactional ? "事务性写入" : "非事务性写入";
  const errorProtection = result.noWriteOnError ? "已启用防写保护" : "出错前可能已写入";
  const rollback = result.rollbackPerformed
    ? result.rollbackSucceeded
      ? "回滚成功"
      : "回滚失败"
    : "无需回滚";
  return `状态: ${status}；${transactional}；${errorProtection}；${rollback}。`;
}

function migrationWriteStatus(result: LegacyConfigMigrationApplyDto, writeTouched: boolean): string {
  if (result.status !== "failed") {
    return writeTouched ? "已写入" : "未变动";
  }
  if (!writeTouched) {
    return "未变动";
  }
  if (result.rollbackPerformed && result.rollbackSucceeded) {
    return "写入后已成功回滚";
  }
  return result.rollbackPerformed ? "尝试写入但回滚失败" : "已尝试写入";
}

function Toggle({ label, testId, checked, disabled, onChange }: { label: string; testId?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  const tid = testId ?? label.toLowerCase().replaceAll(" ", "-");
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" data-testid={`preferences-toggle-${tid}`} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}
