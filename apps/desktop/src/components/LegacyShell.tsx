import { SgfGraphFitContext } from "./SgfNodeGraph";
import { useWorkspaceGeometry } from "../hooks/useWorkspaceGeometry";
import { useBoardWheel } from "../hooks/useBoardWheel";
import { AnalysisLayoutDemo } from "./preview/AnalysisLayoutDemo";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listenToLegacyMenuActionEvents } from "../api/backend";
import {
  legacyActionFromKeyboardEvent,
  legacyActionDefinition,
  legacyActionLabel,
  legacyActionMenuPath,
  legacyActionMatrix,
  legacyActionTestId,
  legacyShortcutAria,
  type LegacyActionDefinition,
  type LegacyActionId,
  type LegacyActionSource,
  type LegacyMenuTarget
} from "../domain/legacyActions";

const OneClickSetup = lazy(() => import("./setup/OneClickSetup").then(module => ({ default: module.OneClickSetup })));

type LegacyShellProps = {
  themeClassName?: string;
  setupDisabled?: boolean;
  onPrepareSetup?: () => Promise<void>;
  onToggleLiveReview?: () => void | Promise<void>;
  isLiveReviewActive?: boolean;
  liveReviewStatus?: string;
  isRecordedPreview?: boolean;
  architectureLabel: string;
  backendStatusLabel: string;
  cacheBadge: ReactNode;
  board: ReactNode;
  chart: ReactNode;
  analysisPanel: ReactNode;
  positionSummary?: ReactNode;
  gameControls?: ReactNode;
  analysisShortcuts?: ReactNode;
  documentTools?: ReactNode;
  playbackControls?: ReactNode;
  treePanel: ReactNode;
  providerPanel: ReactNode;
  enginePanel: ReactNode;
  preferencesPanel: ReactNode;
  documentName: string;
  documentTitle: string;
  dirty: boolean;
  sgfText: string;
  currentMove: number;
  maxMove: number;
  message: string;
  isBusy: boolean;
  canSave: boolean;
  onlineKifu?: ReactNode;
  onOpen: () => void | Promise<void>;
  onSave: () => void | Promise<void>;
  onSaveAs: () => void | Promise<void>;
  onImportFile: (file: File | null) => void | Promise<void>;
  onLoadSample: () => void | Promise<void>;
  onParseSgf: () => void | Promise<void>;
  onRunReview: () => void | Promise<void>;
  onSgfTextChange: (value: string) => void;
  onMoveChange: (moveNumber: number) => void;
};

type LegacyMenuItem = {
  action: LegacyActionDefinition;
  disabled?: boolean;
};

type LegacyMenuGroup = {
  label: string;
  items: LegacyMenuItem[];
};

type LegacyMenuActionState = {
  activeTarget: LegacyMenuTarget | null;
  lastAction: string;
  lastActionId: LegacyActionId | "";
  lastActionSource: LegacyActionSource | "";
  status: "idle" | "dispatched" | "focused" | "missing" | "blocked" | "failed";
};

const MENU_GROUP_LABELS: Record<string, string> = {
  File: "文件",
  Game: "对局",
  Analysis: "分析",
  View: "视图",
  Engine: "引擎",
  Tools: "工具",
  Help: "帮助"
};

const MENU_ACTION_LABELS: Record<string, string> = {
  "file.open": "打开 SGF...",
  "file.save": "保存",
  "file.saveAs": "另存为...",
  "file.importSgf": "导入 SGF 文件...",
  "game.loadSample": "载入示例对局",
  "game.parseSgf": "解析 SGF 源码",
  "analysis.runReview": "运行复盘分析",
  "view.candidates": "候选点",
  "view.ownership": "领地/形势",
  "view.policy": "策略选点",
  "engine.profiles": "配置引擎",
  "engine.assets": "检查权重资源",
  "tools.providers": "对弈平台导入",
  "tools.preferences": "偏好设置",
  "help.shortcuts": "快捷键说明"
};

export function LegacyShell({
  themeClassName = "",
  onToggleLiveReview,
  isLiveReviewActive = false,
  liveReviewStatus = "",
  isRecordedPreview = false,
  setupDisabled = false,
  onPrepareSetup,
  architectureLabel,
  backendStatusLabel,
  cacheBadge,
  board,
  chart,
  analysisPanel,
  positionSummary,
  gameControls,
  analysisShortcuts,
  documentTools,
  playbackControls,
  treePanel,
  providerPanel,
  enginePanel,
  preferencesPanel,
  documentName,
  documentTitle,
  dirty,
  sgfText,
  currentMove,
  maxMove,
  message,
  isBusy,
  canSave,
  onlineKifu,
  onOpen,
  onSave,
  onSaveAs,
  onImportFile,
  onLoadSample,
  onParseSgf,
  onRunReview,
  onSgfTextChange,
  onMoveChange
}: LegacyShellProps) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [moveDraft, setMoveDraft] = useState(String(currentMove));
  useEffect(() => { setMoveDraft(String(currentMove)); }, [currentMove]);
  function commitMoveJump() {
    const value = Number(moveDraft);
    if (!moveDraft.trim() || !Number.isFinite(value)) { setMoveDraft(String(currentMove)); return; }
    const target = Math.max(0, Math.min(maxMove, Math.floor(value)));
    setMoveDraft(String(target));
    onMoveChange(target);
  }
  const [settingsTab, setSettingsTab] = useState<string | null>(null);
  const menubarRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const bar = menubarRef.current;
    if (!bar) return;
    const menus = Array.from(bar.querySelectorAll<HTMLDetailsElement>("details.legacy-menu"));
    let hoverOpenedMenu: HTMLDetailsElement | null = null;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelLeave = () => { clearTimeout(leaveTimer); leaveTimer = undefined; };
    const closeMenus = (except?: HTMLDetailsElement) => {
      menus.forEach(menu => { if (menu !== except) menu.open = false; });
      if (!except) hoverOpenedMenu = null;
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !bar.contains(event.target)) closeMenus();
    };
    const blur = () => closeMenus();
    const leave = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      cancelLeave();
      leaveTimer = setTimeout(() => closeMenus(), 150);
    };
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const summary = target?.closest("summary");
      if (summary) {
        const menu = summary.parentElement as HTMLDetailsElement;
        closeMenus(menu);
        if (hoverOpenedMenu === menu) { event.preventDefault(); menu.open = true; }
        hoverOpenedMenu = null;
      }
      else if (target?.closest("button:not(:disabled)")) closeMenus();
    };
    const hover = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || !menus.some(menu => menu.open)) return;
      const summary = event.target instanceof Element ? event.target.closest("summary") : null;
      if (!summary) return;
      const menu = summary.parentElement as HTMLDetailsElement;
      if (menu.open) return;
      closeMenus(menu);
      menu.open = true;
      hoverOpenedMenu = menu;
      summary.focus({ preventScroll: true });
    };
    const keydown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const menu = target?.closest("details.legacy-menu") as HTMLDetailsElement | null;
      if (event.key === "Escape") {
        const opened = menus.find(item => item.open);
        if (!opened) return;
        event.preventDefault(); event.stopPropagation(); closeMenus();
        opened.querySelector("summary")?.focus();
        return;
      }
      if (!menu || !bar.contains(menu)) return;
      if (event.key === "Tab") { menu.querySelector("summary")?.focus(); closeMenus(); return; }
      if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const next = menus[(menus.indexOf(menu) + (event.key === "ArrowRight" ? 1 : menus.length - 1)) % menus.length];
        const wasOpen = menu.open;
        closeMenus(); next.open = wasOpen;
        next.querySelector("summary")?.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); closeMenus(menu); menu.open = true;
        const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        if (!items.length) return;
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : index < 0 ? (event.key === "ArrowUp" ? items.length - 1 : 0)
          : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        items[next].focus();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", blur);
    bar.addEventListener("click", click, true);
    bar.addEventListener("pointerover", hover);
    bar.addEventListener("pointerleave", leave);
    bar.addEventListener("pointerenter", cancelLeave);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", blur);
      bar.removeEventListener("click", click, true);
      bar.removeEventListener("pointerover", hover);
      bar.removeEventListener("pointerleave", leave);
      bar.removeEventListener("pointerenter", cancelLeave);
      cancelLeave();
    };
  }, []);
  const fileInputId = "legacy-shell-import-sgf";
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [showMoveTree, setShowMoveTree] = useState(true);
  const workspaceRef = useRef<HTMLElement | null>(null);
  useWorkspaceGeometry(workspaceRef, showMoveTree);
  const boardPaneRef = useRef<HTMLDivElement | null>(null);
  useBoardWheel(boardPaneRef, currentMove, maxMove, isBusy, onMoveChange);
  const analysisPaneRef = useRef<HTMLDivElement | null>(null);
  const bottomDockRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (settingsTab === null) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") setSettingsTab(null); };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [settingsTab]);
  const statusbarRef = useRef<HTMLElement | null>(null);
  const focusResetRef = useRef<number | null>(null);
  const highlightedElementRef = useRef<HTMLElement | null>(null);
  const [highlightedTarget, setHighlightedTarget] = useState<LegacyMenuTarget | null>(null);
  const [menuAction, setMenuAction] = useState<LegacyMenuActionState>({
    activeTarget: null,
    lastAction: "",
    lastActionId: "",
    lastActionSource: "",
    status: "idle"
  });

  useEffect(() => {
    return () => {
      if (focusResetRef.current !== null) window.clearTimeout(focusResetRef.current);
      highlightedElementRef.current?.classList.remove("legacy-focus-highlight");
      focusResetRef.current = null;
      highlightedElementRef.current = null;
    };
  }, []);

  function focusTarget(target: LegacyMenuTarget): boolean {
    if (["profiles", "assets", "providers", "preferences"].includes(target)) {
      setSettingsTab(target === "assets" ? "profiles" : target);
    }
    const targetElement = resolveTargetElement(target);
    if (!targetElement) return false;

    if (focusResetRef.current !== null) {
      window.clearTimeout(focusResetRef.current);
      focusResetRef.current = null;
    }
    highlightedElementRef.current?.classList.remove("legacy-focus-highlight");
    ensureMenuTargetElement(targetElement, target);

    targetElement.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    if (!canFocusElement(targetElement) && !targetElement.hasAttribute("tabindex")) targetElement.setAttribute("tabindex", "-1");
    targetElement.focus({ preventScroll: true });
    targetElement.classList.add("legacy-focus-highlight");
    highlightedElementRef.current = targetElement;
    setHighlightedTarget(target);
    focusResetRef.current = window.setTimeout(() => {
      setHighlightedTarget(null);
      highlightedElementRef.current?.classList.remove("legacy-focus-highlight");
      highlightedElementRef.current = null;
    }, 1400);
    return true;
  }

  function runMenuTargetAction(target: LegacyMenuTarget, action: LegacyActionDefinition, source: LegacyActionSource) {
    const focused = focusTarget(target);
    setMenuAction({
      activeTarget: target,
      lastAction: legacyActionLabel(action.id),
      lastActionId: action.id,
      lastActionSource: source,
      status: focused ? "focused" : "missing"
    });
  }

  function resolveTargetElement(target: LegacyMenuTarget): HTMLElement | null {
    if (target === "candidates" || target === "ownership" || target === "policy") {
      activateBoardOverlay(target);
      return findAnalysisSection(target) ?? boardPaneRef.current;
    }

    if (target === "profiles" || target === "assets") {
      const enginePanelElement = bottomDockRef.current?.querySelector<HTMLElement>(".engine-setup-panel") ?? null;
      if (target === "assets") {
        const management = enginePanelElement?.querySelector<HTMLDetailsElement>("details.engine-local-management");
        if (management) management.open = true;
        return (
          enginePanelElement?.querySelector<HTMLElement>('[data-testid="engine-check-assets"]') ??
          findButtonByText(enginePanelElement, "Check assets") ??
          findButtonByText(enginePanelElement, "检查权重资源") ??
          findButtonByText(enginePanelElement, "检查资源") ??
          enginePanelElement
        );
      }
      return enginePanelElement?.querySelector<HTMLElement>("select") ?? enginePanelElement;
    }

    if (target === "providers") {
      return bottomDockRef.current?.querySelector<HTMLElement>(".provider-panel") ?? null;
    }

    if (target === "preferences") {
      return bottomDockRef.current?.querySelector<HTMLElement>(".preferences-panel") ?? null;
    }

    return statusbarRef.current;
  }

  function activateBoardOverlay(target: "candidates" | "ownership" | "policy") {
    const label = target === "candidates" ? "Candidates" : target === "ownership" ? "Ownership" : "Policy";
    const zhLabel = target === "candidates" ? "候选点" : target === "ownership" ? "领地" : "策略";
    const buttons = Array.from(boardPaneRef.current?.querySelectorAll<HTMLButtonElement>("[aria-pressed]") ?? []);
    const overlayButton = buttons.find(
      (button) =>
        button.dataset.overlayMode === target ||
        button.textContent?.trim() === label ||
        button.textContent?.trim() === zhLabel
    );
    if (overlayButton && !overlayButton.disabled) overlayButton.click();
  }

  function findAnalysisSection(target: "candidates" | "ownership" | "policy"): HTMLElement | null {
    const byData = analysisPaneRef.current?.querySelector<HTMLElement>(`[data-section="${target}"]`);
    if (byData) return byData;
    const heading = target === "ownership" ? "Position" : target === "candidates" ? "Candidates" : "Policy";
    const zhHeading = target === "ownership" ? "局面信息" : target === "candidates" ? "候选点推荐" : "策略选点";
    const headings = Array.from(analysisPaneRef.current?.querySelectorAll<HTMLHeadingElement>("h2, h3") ?? []);
    return (
      headings
        .find((item) => item.textContent?.trim() === heading || item.textContent?.trim() === zhHeading)
        ?.closest("section") ?? analysisPaneRef.current
    );
  }

  function findButtonByText(root: HTMLElement | null, label: string): HTMLElement | null {
    const buttons = Array.from(root?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    return buttons.find((button) => button.textContent?.trim() === label) ?? null;
  }

  function canFocusElement(element: HTMLElement): boolean {
    return /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(element.tagName);
  }

  function menuTargetId(target: LegacyMenuTarget): string {
    return `legacy-menu-target-${target}`;
  }

  function ensureMenuTargetElement(element: HTMLElement, target: LegacyMenuTarget) {
    element.id = menuTargetId(target);
    element.dataset.menuTarget = target;
    element.dataset.legacyMenuTargetId = menuTargetId(target);
  }

  function actionData(actionId: LegacyActionId) {
    const action = legacyActionDefinition(actionId);
    return {
      "data-legacy-action": action.id,
      "data-legacy-action-group": action.group,
      "data-legacy-action-label": action.label,
      "data-legacy-action-menu-path": legacyActionMenuPath(action),
      "data-legacy-action-shortcut": action.shortcut ?? "",
      "data-legacy-action-target": action.target ?? "",
      "data-legacy-action-target-selector": action.targetSelector ?? "",
      "data-legacy-action-testid": legacyActionTestId(action.id),
      "aria-keyshortcuts": legacyShortcutAria(action.shortcut)
    };
  }

  function markActionStatus(action: LegacyActionDefinition, source: LegacyActionSource, status: LegacyMenuActionState["status"]) {
    setMenuAction({
      activeTarget: action.target ?? null,
      lastAction: legacyActionLabel(action.id),
      lastActionId: action.id,
      lastActionSource: source,
      status
    });
  }

  function isActionDisabled(actionId: LegacyActionId): boolean {
    if (actionId === "file.save") return isBusy || !canSave;
    if (
      actionId === "file.open" ||
      actionId === "file.saveAs" ||
      actionId === "file.importSgf" ||
      actionId === "game.loadSample" ||
      actionId === "game.parseSgf" ||
      actionId === "analysis.runReview"
    ) {
      return isBusy;
    }
    return false;
  }

  const dispatchLegacyAction = useCallback(async (actionId: LegacyActionId, source: LegacyActionSource) => {
    const action = legacyActionMatrix.find((candidate) => candidate.id === actionId);
    if (!action) return;
    if (isActionDisabled(action.id)) {
      markActionStatus(action, source, "blocked");
      return;
    }

    try {
      if (action.target) {
        runMenuTargetAction(action.target, action, source);
        return;
      }

      markActionStatus(action, source, "dispatched");
      switch (action.id) {
        case "file.open":
          await onOpen();
          return;
        case "file.save":
          await onSave();
          return;
        case "file.saveAs":
          await onSaveAs();
          return;
        case "file.importSgf":
          importInputRef.current?.click();
          return;
        case "game.loadSample":
          await onLoadSample();
          return;
        case "game.parseSgf":
          await onParseSgf();
          return;
        case "analysis.runReview":
          await onRunReview();
          return;
      }
    } catch {
      markActionStatus(action, source, "failed");
    }
  }, [canSave, isBusy, onLoadSample, onOpen, onParseSgf, onRunReview, onSave, onSaveAs]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const actionId = legacyActionFromKeyboardEvent(event);
      if (!actionId) return;
      event.preventDefault();
      void dispatchLegacyAction(actionId, "keyboard");
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dispatchLegacyAction]);

  useEffect(() => {
    let cleanup: (() => void) | null = null;
    let active = true;
    listenToLegacyMenuActionEvents((actionId) => {
      void dispatchLegacyAction(actionId, "native-menu");
    }).then((unlisten) => {
      if (active) {
        cleanup = unlisten;
      } else {
        unlisten();
      }
    });
    return () => {
      active = false;
      cleanup?.();
    };
  }, [dispatchLegacyAction]);

  const menuGroups: LegacyMenuGroup[] = useMemo(() => {
    const groups = new Map<LegacyMenuGroup["label"], LegacyMenuItem[]>();
    for (const action of legacyActionMatrix) {
      const items = groups.get(action.group) ?? [];
      items.push({ action, disabled: isActionDisabled(action.id) });
      groups.set(action.group, items);
    }
    return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
  }, [canSave, isBusy]);

  return (
    <main
      className={`app-shell legacy-shell${themeClassName ? ` ${themeClassName}` : ""}`}
      data-testid="legacy-shell"
      data-active-menu-target={menuAction.activeTarget ?? ""}
      data-last-legacy-action={menuAction.lastActionId}
      data-last-legacy-action-source={menuAction.lastActionSource}
      data-last-menu-action={menuAction.lastAction}
      data-menu-action-status={menuAction.status}
      data-legacy-action-count={legacyActionMatrix.length}
      data-legacy-action-ids={legacyActionMatrix.map((action) => action.id).join(" ")}
      data-legacy-shortcut-editing-protection="input,textarea,select,[contenteditable=true]"
      data-legacy-shortcut-input-editing-protected="true"
    >
      <header className="legacy-titlebar">
        <div className="legacy-appmark">
          <h1>LizzieYzy Next</h1>
          <p title={architectureLabel}>围棋分析工作台</p>
        </div>
        <nav ref={menubarRef} className="legacy-menubar" aria-label="Application menu" data-testid="legacy-menubar" data-legacy-menu-groups="File Game Analysis View Engine Tools Help">
          {menuGroups.map((group) => (
            <details key={group.label} className="legacy-menu" data-legacy-menu-group={group.label}>
              <summary>{MENU_GROUP_LABELS[group.label] ?? group.label}</summary>
              <div className="legacy-menu-popover">
                {group.items.map((item) => (
                  <button
                    key={item.action.id}
                    type="button"
                    disabled={item.disabled}
                    {...actionData(item.action.id)}
                    data-menu-target={item.action.target ?? undefined}
                    data-menu-path={legacyActionMenuPath(item.action)}
                    data-shortcut={item.action.shortcut ?? undefined}
                    data-target-selector={item.action.targetSelector ?? undefined}
                    aria-controls={item.action.target ? menuTargetId(item.action.target) : undefined}
                    title={item.action.shortcut}
                    data-testid={`legacy-menu-${group.label.toLowerCase()}-${item.action.label.toLowerCase().replaceAll(" ", "-")}`}
                    onClick={(event) => {
                      void dispatchLegacyAction(item.action.id, "menu");
                      event.currentTarget.closest("details")?.removeAttribute("open");
                    }}
                  >
                    {MENU_ACTION_LABELS[item.action.id] ?? item.action.label}
                  </button>
                ))}
              </div>
            </details>
          ))}
        </nav>
        <div className={`legacy-title-status${highlightedTarget === "backend-status" ? " legacy-focus-highlight" : ""}`} data-testid="legacy-backend-status">
          <span className="status-pill" title={backendStatusLabel}>{backendStatusLabel.includes("浏览器") || backendStatusLabel.includes("Browser") ? "浏览器预览" : "桌面工作区"}</span>
        </div>
      <span className="legacy-menu-action-status" aria-live="polite" data-testid="legacy-menu-action-status">
        {menuAction.status === "idle" ? "" : `${menuAction.lastAction}:${menuAction.status}`}
      </span>

      <section className="legacy-toolbar" aria-label="Main toolbar" data-testid="legacy-toolbar">
        <button type="button" data-testid="toolbar-open-sgf" {...actionData("file.open")} onClick={() => void dispatchLegacyAction("file.open", "toolbar")} disabled={isBusy} title="打开 SGF">打开</button>
        {onlineKifu}
        <button type="button" data-testid="toolbar-save-sgf" {...actionData("file.save")} onClick={() => void dispatchLegacyAction("file.save", "toolbar")} disabled={isBusy || !canSave} title="保存 SGF">保存</button>
        <button type="button" data-testid="toolbar-save-as-sgf" {...actionData("file.saveAs")} onClick={() => void dispatchLegacyAction("file.saveAs", "toolbar")} disabled={isBusy} title="SGF 另存为">另存为</button>
        <label
          className={`file-button legacy-tool-file${isBusy ? " file-button-disabled" : ""}`}
          data-testid="toolbar-import-sgf"
          {...actionData("file.importSgf")}
          title="导入 SGF"
        >
          导入
          <input ref={importInputRef} id={fileInputId} type="file" accept=".sgf,.txt,application/x-go-sgf,text/plain" disabled={isBusy} onChange={(event) => {
            void onImportFile(event.target.files?.[0] ?? null);
            event.currentTarget.value = "";
          }} />
        </label>
        <span className="legacy-toolbar-divider" aria-hidden="true" />
        <button type="button" data-testid="toolbar-load-sample" {...actionData("game.loadSample")} onClick={() => void dispatchLegacyAction("game.loadSample", "toolbar")} disabled={isBusy} title="载入示例对局">示例</button>
        <button type="button" className="secondary-tool" data-testid="toolbar-parse-sgf" {...actionData("game.parseSgf")} onClick={() => void dispatchLegacyAction("game.parseSgf", "toolbar")} disabled={isBusy} title="解析 SGF 源码">解析</button>
        <button type="button" className="secondary-tool" data-testid="toolbar-run-review" {...actionData("analysis.runReview")} onClick={() => void dispatchLegacyAction("analysis.runReview", "toolbar")} disabled={isBusy} title="运行复盘分析">复盘</button>
        <button type="button" className={`live-toggle${isLiveReviewActive ? " is-running" : ""}`} data-testid="toolbar-live-review" onClick={() => void onToggleLiveReview?.()} disabled={!onToggleLiveReview || isBusy}>{isRecordedPreview ? isLiveReviewActive ? "Ⅱ 暂停回放" : "▶ 播放回放" : isLiveReviewActive ? "Ⅱ 暂停分析" : "▶ 开始分析"}</button>
        {analysisShortcuts}

        <span className="live-status" title={liveReviewStatus}><i className={isLiveReviewActive ? "is-running" : ""} />{liveReviewStatus || "等待分析"}</span>
        <details className="game-quick-settings"><summary>规则 / 贴目</summary>{gameControls}</details><button onClick={()=>setSettingsTab("document")}>棋谱编辑</button><button aria-pressed={showMoveTree} onClick={() => setShowMoveTree(value => !value)}>落子树</button>
        <span className="legacy-toolbar-spacer" />
        <button type="button" onClick={() => setSetupOpen(true)}>一键设置</button>
        <button type="button" onClick={() => setSettingsTab("profiles")}>引擎设置</button>
        <button type="button" onClick={() => setSettingsTab("source")}>棋谱源码</button>
        <div className="legacy-document-chip" title={documentTitle}>
          <strong>{documentName}{dirty ? " *" : ""}</strong>
          <span>{dirty ? "未保存" : "已保存"}</span>
        </div>
      </section>

      </header>
      <section ref={workspaceRef} className={`workspace legacy-workspace${showMoveTree ? " has-move-tree" : ""}`}>
        {showMoveTree && <aside className="workspace-move-tree" aria-label="落子树"><header><strong>落子树</strong><button aria-label="关闭落子树" onClick={() => setShowMoveTree(false)}>×</button></header><SgfGraphFitContext.Provider value={true}>{treePanel}</SgfGraphFitContext.Provider></aside>}
        <div
          ref={boardPaneRef}
          className={`left-pane legacy-board-pane${highlightedTarget === "candidates" || highlightedTarget === "ownership" || highlightedTarget === "policy" ? " legacy-focus-highlight" : ""}`}
          data-testid="legacy-board-pane"
        >
          <div className="legacy-board-stage">{board}</div>
          <div className="timeline-row legacy-timeline">
            <div className="move-navigation">{playbackControls}
              <button aria-label="第一手之前" onClick={() => onMoveChange(0)}>｜‹</button>
              <button aria-label="上一手" onClick={() => onMoveChange(Math.max(0, currentMove - 1))}>‹</button>
              <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 12 }}>第<input aria-label="跳转到手数" type="number" min={0} max={maxMove} step={1} value={moveDraft} onChange={event => setMoveDraft(event.target.value)} onBlur={commitMoveJump} onKeyDown={event => {
                if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                if (event.key === "Escape") { event.preventDefault(); setMoveDraft(String(currentMove)); }
              }} style={{ width: 48, minWidth: 0, padding: "3px 2px", textAlign: "center" }} />手</label>
              <button aria-label="下一手" onClick={() => onMoveChange(Math.min(maxMove, currentMove + 1))}>›</button>
              <button aria-label="最后一手" onClick={() => onMoveChange(maxMove)}>›｜</button>
            </div>
            <input className="move-slider" type="range" min={0} max={maxMove} value={Math.min(currentMove, maxMove)} onChange={(event) => onMoveChange(Number(event.target.value))} />
            <span>{maxMove}</span>
          </div>
        </div>
        <div ref={analysisPaneRef} className="legacy-right-pane" data-testid="legacy-analysis-pane" style={{ gridTemplateRows: "minmax(280px, 1.2fr) minmax(220px, 1fr)", overflowY: "auto" }}>
          {analysisPanel}
          <section className="legacy-chart-strip" style={{ minHeight: 175, gridTemplateRows: "minmax(0, 1fr)" }}>{chart}</section>
        </div>
      </section>

      {setupOpen && <Suspense fallback={<p role="status">正在打开一键设置…</p>}><OneClickSetup disabled={setupDisabled} onPrepare={onPrepareSetup} onClose={() => setSetupOpen(false)} onAdvanced={() => { setSetupOpen(false); setSettingsTab("profiles"); }} /></Suspense>}
      {settingsTab !== null && <div className="workspace-settings-backdrop" onClick={() => setSettingsTab(null)} aria-hidden="true" />}
      <section ref={bottomDockRef} hidden={settingsTab === null} data-settings-tab={settingsTab ?? ""} className="bottom-dock legacy-bottom-dock" aria-label="Controls and setup" data-testid="legacy-bottom-dock">
        <header className="settings-heading"><h2>工作区设置</h2><button aria-label="关闭设置" onClick={() => setSettingsTab(null)}>✕</button></header>
        <nav className="settings-tabs"><button aria-pressed={settingsTab === "document"} onClick={()=>setSettingsTab("document")}>棋谱与编辑</button>{[["profiles", "引擎"], ["preferences", "显示偏好"], ["source", "棋谱源码"], ["providers", "导入与编辑"]].map(([id, label]) => <button key={id} aria-pressed={settingsTab === id} onClick={() => setSettingsTab(id)}>{label}</button>)}</nav>
        <section hidden={settingsTab !== "document"}>{documentTools}<details><summary>节点与分支编辑</summary>{!showMoveTree && treePanel}</details></section>
        <section hidden={settingsTab !== "source"} className="sgf-tools legacy-sgf-panel" aria-label="SGF source">
          <div className="document-row">
            <strong title={documentTitle}>{documentName}{dirty ? " *" : ""}</strong>
            <span>{dirty ? "未保存修改" : "已保存"}</span>
          </div>
          <textarea data-testid="sgf-source-textarea" data-legacy-shortcut-scope="editable" data-legacy-shortcut-protected="true" value={sgfText} onChange={(event) => onSgfTextChange(event.target.value)} disabled={isBusy} spellCheck={false} aria-label="SGF source" />
          <div className="button-row">
            <button type="button" data-testid="sgf-source-open" onClick={() => void dispatchLegacyAction("file.open", "toolbar")} disabled={isBusy}>打开</button>
            <button type="button" data-testid="sgf-source-save" onClick={() => void dispatchLegacyAction("file.save", "toolbar")} disabled={isBusy || !canSave}>保存</button>
            <button type="button" data-testid="sgf-source-save-as" onClick={() => void dispatchLegacyAction("file.saveAs", "toolbar")} disabled={isBusy}>另存为</button>
            <label
              className={`file-button${isBusy ? " file-button-disabled" : ""}`}
            >
              导入 SGF
              <input type="file" accept=".sgf,.txt,application/x-go-sgf,text/plain" disabled={isBusy} onChange={(event) => {
                void onImportFile(event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }} />
            </label>
            <button type="button" data-testid="sgf-source-load-sample" onClick={() => void dispatchLegacyAction("game.loadSample", "toolbar")} disabled={isBusy}>载入示例</button>
            <button type="button" data-testid="sgf-source-parse" onClick={() => void dispatchLegacyAction("game.parseSgf", "toolbar")} disabled={isBusy}>解析 SGF</button>
            <button type="button" data-testid="sgf-source-run-review" onClick={() => void dispatchLegacyAction("analysis.runReview", "toolbar")} disabled={isBusy}>运行复盘</button>
          </div>
        </section>
        <div hidden={settingsTab !== "providers"}>{providerPanel}</div>
        <div hidden={settingsTab !== "profiles"}>{enginePanel}</div>
        <div hidden={settingsTab !== "preferences"}>{preferencesPanel}</div>
      </section>

      <footer
        ref={statusbarRef}
        id="legacy-menu-target-backend-status"
        className={`legacy-statusbar${highlightedTarget === "backend-status" ? " legacy-focus-highlight" : ""}`}
        role="status"
        tabIndex={-1}
        data-menu-target="backend-status"
        data-testid="legacy-statusbar"
      >
        <span className="status-document" title={documentTitle}>{documentName}{dirty ? " · 未保存" : ""}</span><span className="status-message">{message}</span><span className="status-cache">{cacheBadge}</span>
      </footer>
    </main>
  );
}
