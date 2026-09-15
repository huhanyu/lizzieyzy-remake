import { EngineAssetManager } from "./EngineAssetManager";
import type { ManagedAsset } from "../api/engineTools";
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { checkEngineAssets, loadEngineProfilesSettings, saveEngineProfilesSettings, validateRuntimeAssetLayout } from "../api/backend";
import type { RuntimeAssetValidationDto } from "../api/backend";
import type { AssetCheckDto, EngineProfileDto, EngineProfileRecordDto } from "../domain/types";

type Props = {
  disabled?: boolean;
  hideLegacyReview?: boolean;
  onAnalyzeGame: (profile: EngineProfileDto, maxVisits: number) => void | Promise<void>;
  onCancelAnalysis?: () => void | Promise<void>;
  /**
   * 切换实时复盘。传 `profile` 是为了复用当前配置里的引擎路径/权重/配置路径；
   * 实时复盘必须用 GTP 后端，调用方会把 `backend` 覆盖为 `kata_go_gtp`。
   */
  onToggleLiveReview?: (profile: EngineProfileDto) => void | Promise<void>;
  /** 实时复盘是否进行中，仅用于按钮文案与禁用态。 */
  isLiveReviewActive?: boolean;
  analysisProgress?: { completed: number; expected: number; turn: number; responseJsonl: string } | null;
  activeJobId?: string | null;
  reviewWorkflow?: {
    phase: string;
    source: string;
    message: string;
    sessionToken: string;
    activeJobId: string | null;
    completed: number;
    expected: number;
    currentTurn: number | null;
    progressVerified: boolean;
    cancelVerified: boolean;
    restartAfterCancelVerified: boolean;
    cacheRestoreVerified: boolean;
    engineFailureVerified: boolean;
    staleAnalysisPrevented: boolean;
  };
};

export function EngineSetupPanel({ hideLegacyReview = false, disabled = false, onAnalyzeGame, onCancelAnalysis, onToggleLiveReview, isLiveReviewActive = false, analysisProgress = null, activeJobId = null, reviewWorkflow }: Props) {
  const [profiles, setProfiles] = useState<EngineProfileRecordDto[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("default");
  const [profileName, setProfileName] = useState("Local KataGo");
  const [enginePath, setEnginePath] = useState("");
  const [modelPath, setModelPath] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [maxVisits, setMaxVisits] = useState("800");
  const [profileStatus, setProfileStatus] = useState("Loading profile...");
  const [assetChecks, setAssetChecks] = useState<AssetCheckDto[]>([]);
  const [runtimeAssetValidation, setRuntimeAssetValidation] = useState<RuntimeAssetValidationDto | null>(null);
  const [runtimeAssetStatus, setRuntimeAssetStatus] = useState("Checking bundled/runtime assets...");

  const visits = Number(maxVisits);
  const isAnalysisActive = activeJobId !== null;
  const missingRequiredAssets = assetChecks.filter((check) => check.required && !check.exists);
  const hasKnownMissingRequiredAssets = missingRequiredAssets.length > 0;
  const progressLabel = analysisProgress
    ? `已完成 ${analysisProgress.completed}/${analysisProgress.expected || "?"} 个局面，当前第 ${analysisProgress.turn} 手`
    : isAnalysisActive
      ? "正在启动分析..."
      : "";
  const progressPercent = analysisProgress && analysisProgress.expected > 0
    ? Math.min(100, Math.round((analysisProgress.completed / analysisProgress.expected) * 100))
    : 0;
  const canRun =
    !disabled &&
    enginePath.trim().length > 0 &&
    modelPath.trim().length > 0 &&
    configPath.trim().length > 0 &&
    Number.isFinite(visits) &&
    visits > 0 &&
    !hasKnownMissingRequiredAssets;
  const canSave = profileName.trim().length > 0 && Number.isFinite(visits) && visits > 0;
  const canDeleteProfile = selectedProfileId !== "default" && profiles.length > 1;
  const localAssetCheckStatus = assetChecks.length === 0
    ? "not-checked"
    : hasKnownMissingRequiredAssets
      ? "missing-required"
      : "ready";
  const runtimeAssetCheckStatus = runtimeAssetValidation
    ? runtimeAssetValidation.placeholders.length > 0 || runtimeAssetValidation.missing.length > 0
      ? "problems"
      : runtimeAssetValidation.layout.candidates.length > 0
        ? "ready"
        : "unavailable"
    : runtimeAssetStatus.startsWith("Runtime asset check failed")
      ? "error"
      : "checking";
  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;

  useEffect(() => {
    let isMounted = true;
    const reload = () => { void loadEngineProfilesSettings()
      .then((settings) => {
        if (!isMounted) return;
        const selected = settings.profiles.find((profile) => profile.id === settings.selected_profile_id) ?? settings.profiles[0];
        setProfiles(settings.profiles);
        setSelectedProfileId(selected?.id ?? "default");
        if (!selected) {
          setProfileStatus("默认配置已就绪。");
          return;
        }
        applyProfileRecord(selected);
        setProfileStatus(settings.profiles.length > 1 ? "配置方案已加载。" : "配置已加载。");
      })
      .catch((error: unknown) => {
        if (isMounted) setProfileStatus(`加载失败: ${errorMessage(error)}`);
      });
    };
    reload();
    window.addEventListener("engine-profiles-changed", reload);
    return () => {
      isMounted = false;
      window.removeEventListener("engine-profiles-changed", reload);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    validateRuntimeAssetLayout()
      .then((validation) => {
        if (!isMounted) return;
        setRuntimeAssetValidation(validation);
        setRuntimeAssetStatus(runtimeAssetSummary(validation));
      })
      .catch((error: unknown) => {
        if (isMounted) setRuntimeAssetStatus(`运行时资源检查失败: ${errorMessage(error)}`);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  function applyProfileRecord(record: EngineProfileRecordDto) {
    setProfileName(record.profile.name);
    setEnginePath(record.profile.engine_path);
    setModelPath(record.profile.model_path ?? "");
    setConfigPath(record.profile.config_path ?? "");
    setWorkingDir(record.profile.working_dir ?? "");
    setMaxVisits(String(record.max_visits));
    setAssetChecks([]);
  }

  function buildProfile(): EngineProfileDto {
    return {
      name: profileName.trim() || "Local KataGo",
      engine_path: enginePath.trim(),
      model_path: optionalPath(modelPath),
      config_path: optionalPath(configPath),
      working_dir: optionalPath(workingDir),
      backend: "kata_go_analysis"
    };
  }

  function buildProfileRecord(id = selectedProfileId): EngineProfileRecordDto {
    return {
      id,
      profile: buildProfile(),
      max_visits: Math.floor(visits)
    };
  }

  function updatePath(setter: (value: string) => void, value: string, message?: string) {
    setter(value);
    if (assetChecks.length > 0) {
      setAssetChecks([]);
      setProfileStatus("路径已修改，请重新检查配置资源。");
    } else if (message) {
      setProfileStatus(message);
    }
  }

  async function persistProfiles(nextProfiles: EngineProfileRecordDto[], selectedId: string, successMessage: string) {
    const saved = await saveEngineProfilesSettings({ selected_profile_id: selectedId, profiles: nextProfiles });
    const selected = saved.profiles.find((profile) => profile.id === saved.selected_profile_id) ?? saved.profiles[0];
    setProfiles(saved.profiles);
    setSelectedProfileId(saved.selected_profile_id);
    if (selected) applyProfileRecord(selected);
    setProfileStatus(successMessage);
  }

  async function handleSelectProfile(profileId: string) {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    setSelectedProfileId(profileId);
    applyProfileRecord(profile);
    setProfileStatus(`已选择配置: ${profile.profile.name}`);
    try {
      await saveEngineProfilesSettings({ selected_profile_id: profileId, profiles });
    } catch (error) {
      setProfileStatus(`配置已本地生效，但持久化保存失败: ${errorMessage(error)}`);
    }
  }

  async function handleAddProfile() {
    const id = `profile-${Date.now().toString(36)}`;
    const nextProfile: EngineProfileRecordDto = {
      ...buildProfileRecord(id),
      profile: {
        ...buildProfile(),
        name: nextProfileName(profiles)
      }
    };
    try {
      await persistProfiles([...profiles.map((profile) => profile.id === selectedProfileId ? buildProfileRecord(profile.id) : profile), nextProfile], id, "已添加新配置。");
    } catch (error) {
      setProfileStatus(`添加失败: ${errorMessage(error)}`);
    }
  }

  async function handleDeleteProfile() {
    if (!canDeleteProfile) return;
    const nextProfiles = profiles.filter((profile) => profile.id !== selectedProfileId);
    const nextSelected = nextProfiles.find((profile) => profile.id === "default")?.id ?? nextProfiles[0]?.id ?? "default";
    try {
      await persistProfiles(nextProfiles, nextSelected, "已删除配置。");
    } catch (error) {
      setProfileStatus(`删除失败: ${errorMessage(error)}`);
    }
  }

  async function handlePickPath(label: string, currentValue: string, directory: boolean, setter: (value: string) => void) {
    try {
      const selected = await open({
        title: `选择 ${label}`,
        directory,
        multiple: false,
        defaultPath: currentValue.trim() || undefined
      });
      const selectedPath = Array.isArray(selected) ? selected[0] : selected;
      if (!selectedPath) {
        setProfileStatus(`已取消选择 ${label}。`);
        return;
      }
      updatePath(setter, selectedPath, `已选择 ${label}，请点击“检查配置资源”。`);
    } catch (error) {
      setProfileStatus(`系统原生文件选择器不可用: ${errorMessage(error)}`);
    }
  }

  function handleAnalyzeGame() {
    if (hasKnownMissingRequiredAssets) {
      setProfileStatus(assetStatus(assetChecks));
      return;
    }
    if (!canRun) return;
    void onAnalyzeGame(buildProfile(), Math.floor(visits));
  }

  function handleToggleLiveReview() {
    // 停止时不做资源校验：即使配置已被改动，也必须能关掉正在跑的会话。
    if (!isLiveReviewActive && hasKnownMissingRequiredAssets) {
      setProfileStatus(assetStatus(assetChecks));
      return;
    }
    if (!isLiveReviewActive && !canRun) return;
    void onToggleLiveReview?.(buildProfile());
  }

  async function useManagedAsset(asset: ManagedAsset) {
    if (isAnalysisActive || isLiveReviewActive) { setProfileStatus("请先结束分析再更换资源。"); return; }
    const current = buildProfileRecord(selectedProfileId);
    current.profile = { ...current.profile, ...(asset.kind === "engine" ? { engine_path: asset.path } : { model_path: asset.path }) };
    const next = profiles.some(p => p.id === selectedProfileId) ? profiles.map(p => p.id === selectedProfileId ? current : p) : [...profiles, current];
    try { await persistProfiles(next, selectedProfileId, `已使用 ${asset.name} 并保存配置。`); }
    catch (error) { setProfileStatus(`应用资源失败：${errorMessage(error)}`); }
  }

  async function handleSaveProfile() {
    if (!canSave) return;
    try {
      const currentRecord = buildProfileRecord(selectedProfileId);
      const nextProfiles = profiles.some((profile) => profile.id === selectedProfileId)
        ? profiles.map((profile) => profile.id === selectedProfileId ? currentRecord : profile)
        : [...profiles, currentRecord];
      await persistProfiles(nextProfiles, selectedProfileId, "配置已保存。");
      setProfileStatus("配置已保存。");
    } catch (error) {
      setProfileStatus(`保存失败: ${errorMessage(error)}`);
    }
  }

  async function handleCheckAssets() {
    try {
      const checks = await checkEngineAssets(buildProfile());
      setAssetChecks(checks);
      setProfileStatus(assetStatus(checks));
    } catch (error) {
      setProfileStatus(`检查失败: ${errorMessage(error)}`);
    }
  }

  async function handleCheckRuntimeAssets() {
    setRuntimeAssetStatus("正在检查内置与运行时资源...");
    try {
      const validation = await validateRuntimeAssetLayout();
      setRuntimeAssetValidation(validation);
      setRuntimeAssetStatus(runtimeAssetSummary(validation));
    } catch (error) {
      setRuntimeAssetStatus(`运行时资源检查失败: ${errorMessage(error)}`);
    }
  }

  return (
    <section
      className="engine-setup-panel"
      aria-label="KataGo engine setup"
      data-testid="engine-setup-panel"
      data-profile-count={profiles.length}
      data-selected-profile-id={selectedProfileId}
      data-selected-profile-name={selectedProfile?.profile.name ?? profileName}
      data-engine-profile-status={profileStatus}
      data-local-asset-check-status={localAssetCheckStatus}
      data-runtime-asset-check-status={runtimeAssetCheckStatus}
      data-missing-required-asset-count={missingRequiredAssets.length}
      data-runtime-asset-candidate-count={runtimeAssetValidation?.layout.candidates.length ?? 0}
      data-runtime-asset-missing-count={runtimeAssetValidation?.missing.length ?? 0}
      data-runtime-asset-placeholder-count={runtimeAssetValidation?.placeholders.length ?? 0}
    >
      <div
        className="engine-run-row"
        aria-label="Installed app engine/profile proof"
        data-testid="engine-runtime-proof"
        data-profile-count={profiles.length}
        data-selected-profile-id={selectedProfileId}
        data-local-asset-check-status={localAssetCheckStatus}
        data-runtime-asset-check-status={runtimeAssetCheckStatus}
        data-can-run-katago={String(canRun)}
      >
        <strong>引擎运行时</strong>
        <span data-testid="engine-profile-runtime-status" data-profile-count={profiles.length} data-selected-profile-id={selectedProfileId}>
          {profiles.length > 0 ? `已加载 ${profiles.length} 个配置` : "配置加载中..."}
        </span>
        <span data-testid="engine-asset-check-runtime-status" data-local-asset-check-status={localAssetCheckStatus}>
          本地资源: {localAssetCheckStatus === "ready" ? "正常" : localAssetCheckStatus === "missing-required" ? "缺少必要文件" : "未检查"}
        </span>
        <span data-testid="engine-runtime-asset-check-status" data-runtime-asset-check-status={runtimeAssetCheckStatus}>
          运行时资源: {runtimeAssetCheckStatus === "ready" ? "正常" : runtimeAssetCheckStatus === "problems" ? "异常" : "检查中"}
        </span>
      </div>
      <div className="engine-run-row">
        <label>
          <span>配置方案</span>
          <select value={selectedProfileId} onChange={(event) => void handleSelectProfile(event.target.value)}>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.profile.name}</option>
            ))}
          </select>
        </label>
      </div>
      <details className="engine-local-management">
        <summary style={{ cursor: "pointer", padding: "10px 0" }}>本地引擎管理 · 路径与资源</summary>
        <div className="engine-run-row">
        <label>
          <span>配置名称</span>
          <input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Local KataGo" />
        </label>
        <button type="button" onClick={() => void handleAddProfile()} disabled={!canSave}>新增配置</button>
        <button type="button" onClick={() => void handleDeleteProfile()} disabled={!canDeleteProfile}>删除配置</button>
      </div>
      <div className="engine-run-row" aria-label="Bundled runtime asset status">
        <strong>内置与运行时资源</strong>
        <button type="button" data-testid="engine-runtime-assets-refresh" onClick={() => void handleCheckRuntimeAssets()} disabled={disabled} title="刷新运行时资源">刷新资源</button>
        <span className="message">{runtimeAssetStatus}</span>
      </div>
      {runtimeAssetValidation && (
        <p className="message">
          {runtimeAssetValidation.layout.resourceDir ? `资源目录: ${runtimeAssetValidation.layout.resourceDir}。 ` : "资源目录不可用。 "}
          {runtimeAssetValidation.layout.candidates.length > 0
            ? runtimeAssetValidation.checks.map((check) => `${check.status.toUpperCase()} ${check.source} ${check.label}: ${check.path}`).join(" | ")
            : "当前环境中未发现运行时资源。"}
        </p>
      )}
      {runtimeAssetValidation && runtimeAssetMessages(runtimeAssetValidation).length > 0 && (
        <p className="message">
          {runtimeAssetMessages(runtimeAssetValidation).join(" | ")}
        </p>
      )}
      <p className="message">
        本应用未内置庞大的 KataGo 权重模型。请在下方配置本地引擎二进制、模型权重及配置文件路径。
      </p>
      <div className="engine-run-row" aria-label="Local asset configuration">
        <strong>本地路径配置</strong>
      </div>
      <div className="engine-grid">
        <label>
          <span>KataGo 程序路径</span>
          <div className="path-input-row">
            <input data-testid="engine-path-input" value={enginePath} onChange={(event) => updatePath(setEnginePath, event.target.value)} placeholder="/path/to/katago" aria-invalid={isKnownMissing(assetChecks, "engine binary")} title={pathCheckTitle(assetChecks, "engine binary")} />
            <button type="button" className="path-picker-button" onClick={() => void handlePickPath("引擎程序", enginePath, false, setEnginePath)}>
              浏览...
            </button>
          </div>
        </label>
        <label>
          <span>权重模型文件 (.bin.gz)</span>
          <div className="path-input-row">
            <input data-testid="engine-model-input" value={modelPath} onChange={(event) => updatePath(setModelPath, event.target.value)} placeholder="/path/to/model.bin.gz" aria-invalid={isKnownMissing(assetChecks, "model")} title={pathCheckTitle(assetChecks, "model")} />
            <button type="button" className="path-picker-button" onClick={() => void handlePickPath("权重模型", modelPath, false, setModelPath)}>
              浏览...
            </button>
          </div>
        </label>
        <label>
          <span>配置文件 (.cfg)</span>
          <div className="path-input-row">
            <input data-testid="engine-config-input" value={configPath} onChange={(event) => updatePath(setConfigPath, event.target.value)} placeholder="/path/to/analysis.cfg" aria-invalid={isKnownMissing(assetChecks, "config")} title={pathCheckTitle(assetChecks, "config")} />
            <button type="button" className="path-picker-button" onClick={() => void handlePickPath("配置文件", configPath, false, setConfigPath)}>
              浏览...
            </button>
          </div>
        </label>
        <label>
          <span>工作目录 (选填)</span>
          <div className="path-input-row">
            <input data-testid="engine-working-dir-input" value={workingDir} onChange={(event) => updatePath(setWorkingDir, event.target.value)} placeholder="选填目录" aria-invalid={isKnownMissing(assetChecks, "working directory")} title={pathCheckTitle(assetChecks, "working directory")} />
            <button type="button" className="path-picker-button" onClick={() => void handlePickPath("工作目录", workingDir, true, setWorkingDir)}>
              浏览...
            </button>
          </div>
        </label>
      </div>
      <div className="engine-run-row">
        <button data-testid="engine-save-profile" onClick={() => void handleSaveProfile()} disabled={!canSave}>保存配置</button>
        <button data-testid="engine-check-assets" onClick={() => void handleCheckAssets()} disabled={disabled}>检查配置资源</button>
      </div>
      <p className="message">修改路径后请保存配置，顶栏分析会使用已保存的方案。</p>
      </details>
      {!hideLegacyReview && <div className="engine-run-row">
        <label>
          <span>整局复盘计算量 (Visits)</span>
          <input type="number" min={1} step={1} value={maxVisits} onChange={(event) => setMaxVisits(event.target.value)} />
        </label>
        <button data-testid="engine-analyze-game" onClick={handleAnalyzeGame} disabled={!canRun} title="复盘分析整盘棋的每一手">{isAnalysisActive ? "复盘中..." : "整局复盘"}</button>
        <button
          type="button"
          data-testid="engine-live-review-toggle"
          onClick={handleToggleLiveReview}
          disabled={!isLiveReviewActive && !canRun}
          title="选中某手后持续刷新胜率与候选点（使用 GTP 长驻会话）"
        >
          {isLiveReviewActive ? "停止实时分析" : "开始实时分析"}
        </button>
        {isAnalysisActive && <button data-testid="engine-cancel-analysis" onClick={() => void onCancelAnalysis?.()} disabled={!onCancelAnalysis}>取消分析</button>}

      </div>}
      {reviewWorkflow && !hideLegacyReview && (
        <section
          className="analysis-progress"
          aria-label="KataGo review workflow status"
          aria-live="polite"
          data-testid="katago-review-workflow-status"
          data-review-phase={reviewWorkflow.phase}
          data-review-source={reviewWorkflow.source}
          data-review-session-token={reviewWorkflow.sessionToken}
          data-active-job-id={reviewWorkflow.activeJobId ?? ""}
          data-progress-verified={String(reviewWorkflow.progressVerified)}
          data-cancel-verified={String(reviewWorkflow.cancelVerified)}
          data-restart-after-cancel-verified={String(reviewWorkflow.restartAfterCancelVerified)}
          data-cache-restore-verified={String(reviewWorkflow.cacheRestoreVerified)}
          data-engine-failure-verified={String(reviewWorkflow.engineFailureVerified)}
          data-stale-analysis-prevented={String(reviewWorkflow.staleAnalysisPrevented)}
        >
          <strong>{reviewStatusLabel(reviewWorkflow.phase, reviewWorkflow.source)}</strong>
          <span>{reviewWorkflow.message}</span>
          <span>
            {reviewWorkflow.completed}/{reviewWorkflow.expected || "?"} 个局面
            {reviewWorkflow.currentTurn !== null ? `，第 ${reviewWorkflow.currentTurn} 手` : ""}
            {reviewWorkflow.activeJobId ? ` (任务 ID: ${reviewWorkflow.activeJobId})` : ""}
          </span>
        </section>
      )}
      {(isAnalysisActive || analysisProgress) && (
        <div
          className="analysis-progress"
          aria-live="polite"
          data-testid="katago-analysis-progress"
          data-progress-verified={String(Boolean(analysisProgress))}
          data-active-job-id={activeJobId ?? ""}
          data-current-position={analysisProgress?.completed ?? 0}
          data-expected-positions={analysisProgress?.expected ?? 0}
        >
          <div className="analysis-progress-track">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          <span>{progressLabel}</span>
        </div>
      )}
      <EngineAssetManager onUseAsset={useManagedAsset} disabled={isAnalysisActive || isLiveReviewActive} />
      <p className="message">{profileStatus}</p>
      {assetChecks.length > 0 && (
        <p className="message">
          {assetChecks.map((check) => `${check.exists ? "正常" : "缺失"} ${check.label}${check.path ? `: ${check.path}` : ""}`).join(" | ")}
        </p>
      )}
    </section>
  );
}

function reviewStatusLabel(phase: string, source: string): string {
  if (phase === "cache-restored") return "已从缓存恢复复盘数据";
  if (phase === "cancelled") return "复盘已取消";
  if (phase === "error") return "复盘异常，需处理";
  if (phase === "completed") return source === "fake" ? "浏览器模拟复盘完成" : "KataGo 整局复盘完成";
  if (phase === "running") return source === "fake" ? "浏览器模拟复盘进行中..." : "KataGo 正在整局复盘...";
  if (phase === "cancelling") return "正在取消复盘...";
  if (phase === "starting") return "正在启动复盘...";
  return "复盘已就绪";
}

function optionalPath(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function assetStatus(checks: AssetCheckDto[]): string {
  const missingRequired = checks.filter((check) => check.required && !check.exists);
  if (missingRequired.length === 0) return "Assets ready.";
  return `Missing required: ${missingRequired.map((check) => `${check.label}${check.path ? ` (${check.path})` : ""}`).join(", ")}.`;
}

function runtimeAssetSummary(validation: RuntimeAssetValidationDto): string {
  const candidateCount = validation.layout.candidates.length;
  const missingCount = validation.missing.length;
  const placeholderCount = validation.placeholders.length;
  const problemCount = missingCount + placeholderCount;
  if (candidateCount === 0) {
    return validation.warnings[0] ?? "Runtime asset layout unavailable.";
  }
  if (problemCount === 0) return `Runtime asset layout visible: ${candidateCount} candidates.`;
  return `Runtime asset layout visible: ${candidateCount} candidates, ${missingCount} missing, ${placeholderCount} placeholder.`;
}

function runtimeAssetMessages(validation: RuntimeAssetValidationDto): string[] {
  const messages = [
    ...validation.warnings,
    ...validation.placeholders.map((placeholder) => placeholder.message)
  ];
  return Array.from(new Set(messages.filter((message) => message.trim().length > 0)));
}

function isKnownMissing(checks: AssetCheckDto[], label: string): boolean {
  return checks.some((check) => check.label === label && check.required && !check.exists);
}

function pathCheckTitle(checks: AssetCheckDto[], label: string): string | undefined {
  const check = checks.find((item) => item.label === label);
  if (!check) return undefined;
  return check.exists ? `Resolved path: ${check.path}` : `Missing required ${label}${check.path ? `: ${check.path}` : ""}`;
}

function nextProfileName(profiles: EngineProfileRecordDto[]): string {
  const existing = new Set(profiles.map((profile) => profile.profile.name));
  let index = profiles.length + 1;
  let name = `KataGo Profile ${index}`;
  while (existing.has(name)) {
    index += 1;
    name = `KataGo Profile ${index}`;
  }
  return name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
