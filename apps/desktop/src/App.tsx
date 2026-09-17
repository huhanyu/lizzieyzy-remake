import {useHumanGame} from "./hooks/useHumanGame";
import {HumanGameControls} from "./components/HumanGameControls";
import { OnlineKifuImport } from "./components/OnlineKifuImport";
import { AnalysisShortcuts } from "./components/AnalysisShortcuts";
import { useBackgroundCurve } from "./hooks/useBackgroundCurve";
import { shouldAutoFillHistory, type AnalysisSource } from "./domain/analysisPolicy";
import { useResearchQueue } from "./hooks/useResearchQueue";
import { ResearchQueuePanel } from "./components/ResearchQueuePanel";
import { RemoteEnginePanel } from "./components/RemoteEnginePanel";
import { GtpConsole } from "./components/GtpConsole";
import { startRemoteLiveReview, type RemoteEngineConfig } from "./api/engineTools";
import { useSgfAutoplay } from "./hooks/useSgfAutoplay";
import { DocumentTools, type DocumentCommit } from "./components/DocumentTools";
import { useSgfHistory } from "./hooks/useSgfHistory";
import { useRecentDocuments } from "./hooks/useRecentDocuments";
import { applyBoardEdit, dragStone, type BoardEditTool } from "./api/documentOperations";
import { useFullGameReview, type FullGameReviewController } from "./hooks/useFullGameReview";
import { FullGameReviewControls } from "./components/FullGameReviewControls";
import { EngineSearchControls } from "./components/EngineSearchControls";
import { pauseLiveReview, configureLiveReview, listenToLiveReviewPaused, type LiveSearchOptions, type LiveEngineParameters } from "./api/liveControls";
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType } from "react";
import recordedLiveFrames from "./fixtures/recorded-live-review.json";
import { reviewChartFrames, retainLiveFrame, rebindAppendedFrames } from "./domain/reviewFrames";
import { useTryPlay } from "./hooks/useTryPlay";
import { buildLivePosition } from "./domain/livePosition";
import { BoardCanvas } from "./components/BoardCanvas";
import { useSearchSpeed } from "./hooks/useSearchSpeed";
import { bindBatchFramesToNodes, calculatePositionMetrics } from "./domain/positionMetrics";
import { GameRulesControls } from "./components/GameRulesControls";

import { AnalysisModules } from "./components/AnalysisModules";
import { AnalysisPanel } from "./components/AnalysisPanel";
import { CloudComputePanel } from "./components/CloudComputePanel";
import { useCloudCompute } from "./hooks/useCloudCompute";
import { EngineSetupPanel } from "./components/EngineSetupPanel";
import { CacheStatusBadge } from "./components/CacheStatusBadge";
import { PreferencesPanel } from "./components/PreferencesPanel";
import { ProviderPanel } from "./components/ProviderPanel";
import { LegacyShell } from "./components/LegacyShell";
import { SgfTreePanel } from "./components/SgfTreePanel";
import * as backendApi from "./api/backend";
import {
  cancelKataGoAnalysis,
  classifyProblems,
  getHealth,
  isTauriRuntime,
  listenToKataGoAnalysisEvents,
  listenToLiveReviewEvents,
  openSgfDocument,
  parseSgfTree,
  parseSgfSummary,
  replaySgfPositionAtNode,
  replaySgfPositions,
  saveSgfDocument,
  startKataGoGameAnalysis,
  updateSgfNodeComment,
  updateSgfNodeProperties,
  previewLegacyConfigMigration,
  applyLegacyConfigMigration,
  loadEngineProfilesSettings,
  setLiveReviewPosition,
  startLiveReview,
  stopLiveReview,
  type SgfPropertyUpdate
} from "./api/backend";
import { computeGameCacheKey, loadAnalysisCache, saveAnalysisCache } from "./api/analysisCache";
import { loadAppPreferences, saveAppPreferences } from "./api/preferences";
import { clampMoveNumberToPositions, createDemoGame, isPoint, replayGamePositions, selectExactPosition } from "./domain/board";
import type { AnalysisCacheRecord, CacheStatus, GameCacheKey, JsonValue } from "./domain/cache";
import { defaultAppPreferences, normalizeAppPreferences, type AppPreferences } from "./domain/preferences";
import { providerDocumentName, providerLabel, providerSourceLabel, type ProviderImportResult } from "./domain/providers";
import type { AnalysisFrameDto, AppHealthDto, EngineProfileDto, GameDto, MoveVertex, PlayerColor, PositionDto, ProblemMarkerDto, SgfTreeDto, SgfTreeNodeDto } from "./domain/types";
import { resolveRuntimeSmokeConfig, runRuntimeSmokeMode } from "./runtimeSmoke";

const demoSgf = "(;GM[1]FF[4]SZ[19]KM[7.5]PB[Lee Changho]PW[Rui Naiwei]RE[B+R];B[pd];W[dd];B[pp];W[dp];B[jq];W[qj];B[nc];W[fc];B[qf];W[cn];B[cp];W[do];B[co];W[dn];B[fq];W[eq];B[fp];W[gp];B[gq];W[hp])";
const demoGame = createDemoGame();
type AnalysisProgress = { jobId: string; completed: number; expected: number; turn: number; responseJsonl: string };
type PendingAnalysisTerminalEvent =
  | { kind: "complete"; frames: AnalysisFrameDto[] }
  | { kind: "error" | "cancelled"; message: string };
type CacheEngineKind = "fake" | "katago";
type CachedAnalysisPayload = { frames: AnalysisFrameDto[]; problems: ProblemMarkerDto[] };
/** 前端认为当前有效的实时复盘会话：job、世代号、目标手数。三者共同构成陈旧帧判据。 */
type LiveReviewState = { jobId: string; generation: number; turn: number; targetKey?: string };
type ReviewWorkflowPhase = "idle" | "starting" | "running" | "completed" | "cancelling" | "cancelled" | "error" | "cache-restored";
type ReviewWorkflowSource = "none" | "fake" | "katago" | "cache";
type ReviewWorkflowStatus = {
  phase: ReviewWorkflowPhase;
  source: ReviewWorkflowSource;
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
type PendingPreferencesSave = { version: number; preferences: AppPreferences };
type AppendSgfMove = (sgfText: string, parentNodeId: string, color: PlayerColor, vertex: MoveVertex) => Promise<unknown>;
type EditSgfMove = (sgfText: string, nodeId: string, color: PlayerColor, vertex: MoveVertex) => Promise<unknown>;
type DeleteSgfNode = (sgfText: string, nodeId: string) => Promise<unknown>;
type ReorderSgfVariation = (sgfText: string, nodeId: string, targetIndex: number) => Promise<unknown>;
type SgfMoveEditMode = "append" | "edit";
type SgfTreeMoveEditProps = {
  moveEditMode?: SgfMoveEditMode;
  canEditSelectedMove?: boolean;
  onMoveEditModeChange?: (mode: SgfMoveEditMode) => void;
  onEditSelectedMovePass?: () => void;
};
type AnalysisCacheLoadResult =
  | { status: "hit"; record: AnalysisCacheRecord; engineKind: CacheEngineKind }
  | { status: "miss" }
  | { status: "error"; message: string };

const SgfTreePanelWithMoveEdit = SgfTreePanel as ComponentType<ComponentProps<typeof SgfTreePanel> & SgfTreeMoveEditProps>;
const initialReviewWorkflowStatus: ReviewWorkflowStatus = {
  phase: "idle",
  source: "none",
  message: "No review analysis is running.",
  sessionToken: "review-session-0",
  activeJobId: null,
  completed: 0,
  expected: 0,
  currentTurn: null,
  progressVerified: false,
  cancelVerified: false,
  restartAfterCancelVerified: false,
  cacheRestoreVerified: false,
  engineFailureVerified: false,
  staleAnalysisPrevented: false
};

export function App() {
  const recordedPreview = !isTauriRuntime() && new URLSearchParams(location.search).get("preview") === "recorded";
  const [replayRunning, setReplayRunning] = useState(true);
  const [liveStarting, setLiveStarting] = useState(false);
  const liveStartingRef = useRef(false);
  const autoStartedRef = useRef(false);
  const researchRestoringRef=useRef(false);
  const researchBusyRef = useRef(false);
  const remoteConfigRef = useRef<RemoteEngineConfig | null>(null);
  const researchRestoreRef = useRef<null | {enabled:boolean;source:string;profile:EngineProfileDto|null;remote:RemoteEngineConfig|null;documentKey:string;frames:AnalysisFrameDto[]}>(null);
  const fullReviewRef = useRef<FullGameReviewController | null>(null);
  const autoReviewKeyRef = useRef("");
  const [autoFillHistory, setAutoFillHistory] = useState(false);
  const [analysisSource, setAnalysisSource] = useState<AnalysisSource>("local");
  const [analysisConfiguration, setAnalysisConfiguration] = useState(0);
  const [sourceSearchOptions, setSourceSearchOptions] = useState<Record<AnalysisSource, LiveSearchOptions>>({local: {}, ssh: {}, cloud: {}});
  const searchOptions = sourceSearchOptions[analysisSource];
  const setSearchOptions = (options: LiveSearchOptions) => setSourceSearchOptions(previous => ({...previous, [analysisSource]: options}));
  const liveTargetKeyRef = useRef("");
  const liveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [liveProfile, setLiveProfile] = useState<EngineProfileDto | null>(null);
  const [liveListenersReady, setLiveListenersReady] = useState(false);
  const [health, setHealth] = useState<AppHealthDto | null>(null);
  const [game, setGame] = useState<GameDto>(() => demoGame);
  const [positions, setPositions] = useState<PositionDto[]>(() => replayGamePositions(demoGame));
  const [currentMove, setCurrentMove] = useState(0);
  const [frames, setFrames] = useState<AnalysisFrameDto[]>([]);
  const [problems, setProblems] = useState<ProblemMarkerDto[]>([]);
  const [sgfText, setSgfText] = useState(demoSgf);
  const currentDocumentKeyRef=useRef(sgfText);currentDocumentKeyRef.current=sgfText;
  const [message, setMessage] = useState("Preview workspace ready. Parse the sample SGF or import a local game to start reviewing.");
  const [isKataGoRunning, setIsKataGoRunning] = useState(false);
  const [selectedCandidateIndex, setSelectedCandidateIndex] = useState<number | null>(null);
  // 实时复盘：`liveReview` 记录前端认为**当前有效**的 job/世代/手数，用于双重陈旧性校验。
  // `generation` 与 Rust 侧 `LiveReviewSession::publish_request` 的单调世代号对应，
  // 由 `katago_live_review_set_position` 的返回值同步（不在前端自增，避免两边错位）。
  const [liveReview, setLiveReview] = useState<LiveReviewState | null>(null);
  const [liveReviewEnabled, setLiveReviewEnabled] = useState(false);
  // 实时帧单独存放，**不写进 `frames`**：`frames` 是批量/缓存的权威数组，若把流式帧合并进去，
  // 一个只跑了 24 visits 的实时帧会永久覆盖同一手 800 visits 的批量帧，且停止后残留。
  // 实时期间用 `effectiveFrames` 做「批量 + 实时」叠加，停止时清空本数组即可干净回退。
  const [liveFrames, setLiveFrames] = useState<AnalysisFrameDto[]>([]);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [fallbackFileName, setFallbackFileName] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [documentEpoch,setDocumentEpoch] = useState(0);
  const [historyInitiallySaved,setHistoryInitiallySaved] = useState(true);
  const [documentEditing,setDocumentEditing] = useState(false);
  const [boardTool,setBoardTool] = useState<BoardEditTool>('play');
  const recentDocuments = useRecentDocuments();
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [cacheStatus, setCacheStatus] = useState<CacheStatus>("idle");
  const [cacheRecord, setCacheRecord] = useState<AnalysisCacheRecord | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [currentCacheKey, setCurrentCacheKey] = useState<GameCacheKey | null>(null);
  const [sgfTree, setSgfTree] = useState<SgfTreeDto | null>(null);
  const [selectedSgfNodeId, setSelectedSgfNodeId] = useState<string | null>(null);
  const [sgfTreeError, setSgfTreeError] = useState<string | null>(null);
  const [isSgfTreeLoading, setIsSgfTreeLoading] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [isCommentSaving, setIsCommentSaving] = useState(false);
  const [isPropertySaving, setIsPropertySaving] = useState(false);
  const [isAnnotationSaving, setIsAnnotationSaving] = useState(false);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [isMoveAppending, setIsMoveAppending] = useState(false);
  const [isNodeDeleting, setIsNodeDeleting] = useState(false);
  const [isNodeReordering, setIsNodeReordering] = useState(false);
  const [editColor, setEditColor] = useState<PlayerColor>("black");
  const [sgfMoveEditMode, setSgfMoveEditMode] = useState<SgfMoveEditMode>("append");
  const [treeNodePositionOverride, setTreeNodePositionOverride] = useState<PositionDto | null>(null);
  const [preferences, setPreferences] = useState<AppPreferences>(() => defaultAppPreferences);
  const [preferencesStatus, setPreferencesStatus] = useState("Loading preferences...");
  const [legacyConfigPath, setLegacyConfigPath] = useState("");
  const [legacyConfigStatus, setLegacyConfigStatus] = useState("No legacy config selected.");
  const [legacyConfigPreview, setLegacyConfigPreview] = useState<backendApi.LegacyConfigMigrationPreviewDto | null>(null);
  const [legacyConfigApplyResult, setLegacyConfigApplyResult] = useState<backendApi.LegacyConfigMigrationApplyDto | null>(null);
  const [isLegacyConfigMigrating, setIsLegacyConfigMigrating] = useState(false);
  const [reviewWorkflowStatus, setReviewWorkflowStatus] = useState<ReviewWorkflowStatus>(() => initialReviewWorkflowStatus);
  const { trial, busy: trialBusy, begin: beginTrial, play: playTrial, finish: finishTrial } = useTryPlay(
    sgfText, selectedSgfNodeId, setMessage, commitTrial);
  const activeJobIdRef = useRef<string | null>(null);
  const analysisSessionCounterRef = useRef(0);
  const startingAnalysisRef = useRef(false);
  const userChangedPreferencesRef = useRef(false);
  const preferencesSaveInFlightRef = useRef(false);
  const preferencesSaveVersionRef = useRef(0);
  const pendingPreferencesSaveRef = useRef<PendingPreferencesSave | null>(null);
  const pendingAnalysisProgressRef = useRef<Map<string, AnalysisProgress>>(new Map());
  const pendingAnalysisTerminalEventsRef = useRef<Map<string, PendingAnalysisTerminalEvent>>(new Map());
  const analysisCleanupRef = useRef<(() => void) | null>(null);
  const sgfTreeRequestVersionRef = useRef(0);
  const treeNodeReplayRequestVersionRef = useRef(0);
  const sgfTextEditVersionRef = useRef(0);
  const runtimeSmokeStartedRef = useRef(false);
  // 实时复盘用的状态镜像。事件监听在挂载时只注册一次，闭包不能读到最新的 state，
  // 因此用 ref 暴露「当前有效世代/手数」与最新的 positions/game 给回调与同步函数。
  const liveReviewRef = useRef<LiveReviewState | null>(null);
  const resumeAfterBatchRef = useRef<{ profile: EngineProfileDto; revision: number } | null>(null);
  const liveReviewEnabledRef = useRef(false);
  // 局面同步请求序号：快速连续切手时会有多个 set_position 在途，只有**最新**一次的结果可以
  // 写回世代号。否则先发后到的旧响应会把前端世代号改回旧值，导致 Rust 侧新世代的帧全部被
  // 前端守卫丢弃——表现为「实时分析开着但没有反应」，正是本计划要避免的静默失效。
  const liveReviewSyncSeqRef = useRef(0);
  const positionsRef = useRef<PositionDto[]>(positions);
  const gameRef = useRef<GameDto>(game);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((error: unknown) => setMessage(errorMessage(error)));
  }, []);

  useEffect(() => {
    let isMounted = true;
    loadAppPreferences()
      .then((loaded) => {
        if (!isMounted || userChangedPreferencesRef.current) return;
        setPreferences(loaded);
        setPreferencesStatus("Preferences loaded.");
      })
      .catch((error: unknown) => {
        if (isMounted && !userChangedPreferencesRef.current) setPreferencesStatus(`Load failed: ${errorMessage(error)}`);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    return () => cleanupAnalysisListeners();
  }, []);

  // 把最新状态镜像进 ref，供只注册一次的事件监听与切手 effect 读取。
  const cloudEndedDuringStartRef = useRef(new Set<string>());
  const cloud = useCloudCompute({
    canStart: () => !researchBusyRef.current && !activeJobIdRef.current && !startingAnalysisRef.current && !liveStartingRef.current && liveListenersReady && !!sgfTree && !isSgfTreeLoading,
    prepare: async () => {
      cloudEndedDuringStartRef.current.clear();
      remoteConfigRef.current = null;
      setAnalysisSource("cloud");
      autoStartedRef.current = true;
      resumeAfterBatchRef.current = null;
      await stopCurrentLiveSession();
    },
    position: () => ({ boardSize: currentPosition.board_size, turn: currentPosition.move_number }),
    activate: (jobId) => {
      if (cloudEndedDuringStartRef.current.has(jobId)) throw new Error("云端会话已结束");
      ++liveReviewSyncSeqRef.current;
      const next = { jobId, generation: -1, turn: currentPosition.move_number, targetKey: liveTargetKey };
      liveReviewRef.current = next; liveReviewEnabledRef.current = true;
      setLiveReview(next); setLiveReviewEnabled(true);
      setMessage("智子云 VIP 共享实时分析中，切换手数可分析对应局面。");
    },
    stop: stopCurrentLiveSession
  });

  async function stopCurrentLiveSession() {
    await fullReviewRef.current?.cancel({returnToForeground: false});
    ++liveReviewSyncSeqRef.current;
    liveReviewRef.current = null; liveReviewEnabledRef.current = false;
    setLiveReview(null); setLiveReviewEnabled(false); setLiveFrames([]);
    await liveQueueRef.current.catch(() => {});
    await stopLiveReview();
  }

  useEffect(() => {
    liveReviewRef.current = liveReview;
  }, [liveReview]);

  useEffect(() => {
    liveReviewEnabledRef.current = liveReviewEnabled;
  }, [liveReviewEnabled]);

  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  // 实时复盘事件监听：只在挂载时注册一次，浏览器预览下由 wrapper 的运行时守卫降级为空实现。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenToLiveReviewPaused(payload => {
      if (fullReviewRef.current?.busyRef.current) return;
      const current = liveReviewRef.current;
      if (current?.jobId !== payload.job_id || current.generation !== payload.generation) return;
      liveReviewEnabledRef.current = false; setLiveReviewEnabled(false);
      setMessage(payload.reason === "console" ? "控制台查询已暂停分析；完成查询后可继续。" : "已达到搜索限额，分析暂停；连接与结果已保留。");
    }).then(stop => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return () => undefined;
    let disposed = false;
    let dispose: (() => void) | null = null;
    void listenToLiveReviewEvents({
      onFrame: (payload) => {
        if (fullReviewRef.current?.consumeFrame(payload)) return;
        // 双保险：Rust 侧已按世代丢弃陈旧行，这里再用 payload 的三个维度校验一次，
        // 挡住「事件已排队、但用户已切手」的异步间隙。三个维度缺一不可：
        // 换了会话（job）、换了世代（generation）、或换了目标手数（turn），任一不符即为陈旧帧。
        // 校验在 setState updater 之外完成（用 liveReviewRef 读当前值），避免在 updater 内产生副作用。
        const current = liveReviewRef.current;
        if (!current || current.targetKey !== liveTargetKeyRef.current) return;
        if (payload.job_id !== current.jobId) return;
        if (payload.generation !== current.generation) return;
        if (payload.turn !== current.turn) return;
        // 只写实时图层，不污染 `frames`（批量/缓存的权威数据）。
        setLiveFrames((previousLiveFrames) => retainLiveFrame(previousLiveFrames, { ...payload.frame, job_id: payload.job_id, node_id: current.targetKey }));
      },
      onEnded: (payload) => {
        if (cloud.sourceRef.current === "cloud" && cloud.isPending()) cloudEndedDuringStartRef.current.add(payload.job_id);
        if (payload.job_id !== liveReviewRef.current?.jobId) return;
        liveReviewSyncSeqRef.current += 1;
        liveReviewRef.current = null; liveReviewEnabledRef.current = false;
        setLiveReview(null); setLiveReviewEnabled(false); setLiveFrames([]);
        cloud.ended();
        setMessage(cloud.sourceRef.current === "cloud" ? `智子云连接已中断：${payload.reason}。正在尝试恢复。` : `实时分析已结束：${payload.reason}`);
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        dispose = unlisten;
        setLiveListenersReady(true);
      })
      .catch((error: unknown) => setMessage(`实时分析事件监听失败：${errorMessage(error)}`));
    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    void handleParseSgf();
  }, []);

  useEffect(() => {
    if (runtimeSmokeStartedRef.current) return;
    resolveRuntimeSmokeConfig()
      .then((config) => {
        if (runtimeSmokeStartedRef.current || !config.enabled) return;
        runtimeSmokeStartedRef.current = true;
        setMessage("Runtime smoke mode is running...");
        return runRuntimeSmokeMode(config)
          .then((report) => setMessage(`Runtime smoke mode ${report.status}: report written to ${report.reportPath ?? "configured report path"}.`));
      })
      .catch((error: unknown) => setMessage(`Runtime smoke mode failed before reporting: ${errorMessage(error)}`));
  }, []);

  const [curveImport, setCurveImport] = useState<{text: string; id: number}>();
  const curveImportId = useRef(0);
  const backgroundCurve = useBackgroundCurve(sgfText, curveImport);
  function queueImportedCurve(text: string) {
    setCurveImport({text, id: ++curveImportId.current});
  }
  // 实时帧覆盖同手的批量帧（同一手的新数据应当生效），但只作用于渲染视图，不改动 `frames`。
  const effectiveFrames = useMemo(
    () => recordedPreview ? frames : reviewChartFrames([...backgroundCurve.frames, ...frames], liveFrames, sgfText, sgfTree, selectedSgfNodeId),
    [backgroundCurve.frames, frames, liveFrames, sgfText, sgfTree, selectedSgfNodeId, recordedPreview]
  );
  const currentPosition = useMemo(
    () => trial?.position ?? treeNodePositionOverride ?? selectExactPosition(positions, currentMove, game.summary.board_size),
    [trial, treeNodePositionOverride, positions, currentMove, game.summary.board_size]
  );
  const liveTargetKey = JSON.stringify([trial?.sgf_text ?? sgfText, trial?.node_id ?? selectedSgfNodeId, currentPosition]);
  liveTargetKeyRef.current = liveTargetKey;
  const currentFrame = liveFrames.find(frame => frame.turn === currentPosition.move_number && frame.node_id === liveTargetKey)
    ?? (!trial && !liveReviewEnabled && !treeNodePositionOverride ? frames.find(frame => frame.turn === currentMove) : undefined);
  const searchSpeed = useSearchSpeed({ jobId: liveReview?.jobId, generation: liveReview?.generation,
    visits: currentFrame?.node_id === liveTargetKey ? currentFrame.visits : 0,
    active: liveReviewEnabled && (liveReview?.generation ?? -1) >= 0 });
  const metricFrames = useMemo(() => [...bindBatchFramesToNodes(sgfText, sgfTree, frames), ...liveFrames], [sgfText, sgfTree, frames, liveFrames]);
  const visibleCurrentFrame = applyPreferencesToFrame(currentFrame, preferences);
  useEffect(() => { setLiveFrames([]); }, [sgfText]);
  const fullReview = useFullGameReview({
    sgfText, documentKey: sgfText, configurationKey: JSON.stringify([analysisConfiguration, searchOptions]),
    jobId: liveReview?.jobId ?? null, game, tree: sgfTree, positions, frames: metricFrames,
    beforeStart: async () => {
      if(researchBusyRef.current) throw new Error("研究队列正在使用引擎。");
      ++liveReviewSyncSeqRef.current;
      await liveQueueRef.current.catch(() => {});
    },
    onAccepted: frame => setLiveFrames(previous => retainLiveFrame(previous, frame)),
    onReturnToForeground: () => syncLiveReviewPosition(currentMove)
  });
  const researchQueue = useResearchQueue({
    acquire: async()=>{
      if(documentEditing || trial || trialBusy || isKataGoRunning || activeJobIdRef.current || startingAnalysisRef.current || liveStartingRef.current || cloud.isPending())throw new Error('请先结束试下或引擎切换。');
      researchRestoreRef.current=liveReviewRef.current ? {enabled:liveReviewEnabledRef.current,source:cloud.sourceRef.current,profile:liveProfile,remote:remoteConfigRef.current,documentKey:sgfText,frames:liveFrames} : null;
      researchBusyRef.current=true;
      try {await cloud.disconnect();await stopCurrentLiveSession();}catch(error){researchBusyRef.current=false;throw error;}
    },
    release: async()=>{
      const previous=researchRestoreRef.current;researchRestoreRef.current=null;researchBusyRef.current=false;
      if(!previous)return;
      if(previous.documentKey===currentDocumentKeyRef.current)setLiveFrames(previous.frames);
      researchRestoringRef.current=true;
      try {
      if(previous.source==='cloud')await cloud.connect();
      else if(previous.remote)await connectRemoteEngine(previous.remote,true);
      else if(previous.profile)await handleToggleLiveReview(previous.profile);
      if(!liveReviewRef.current)throw new Error("前景引擎恢复失败，请手动连接。");
      if(!previous.enabled && liveReviewRef.current){
        liveReviewEnabledRef.current=false;setLiveReviewEnabled(false);
        ++liveReviewSyncSeqRef.current;await liveQueueRef.current.catch(()=>{});await pauseLiveReview();
      }
      if(previous.documentKey===currentDocumentKeyRef.current)setLiveFrames(previous.frames);
      } finally {researchRestoringRef.current=false;}
    },
    onCurrentResult: result=>{if(result.document.documentKey===currentDocumentKeyRef.current){setFrames(result.frames);setProblems([]);setMessage('轻量补线完成，已载入当前棋谱的完整走势。');}}
  });
  fullReviewRef.current = fullReview;
  useEffect(() => {
    if (researchBusyRef.current || researchRestoringRef.current) return;
    if (!shouldAutoFillHistory(analysisSource, autoFillHistory) || !liveReviewEnabled || !liveReview?.jobId || !sgfTree || isSgfTreeLoading || trial || recordedPreview) return;
    const key = JSON.stringify([liveReview.jobId, sgfText, analysisConfiguration]);
    if (autoReviewKeyRef.current === key) return;
    autoReviewKeyRef.current = key;
    void backgroundCurve.start();
  }, [analysisSource, autoFillHistory, liveReview?.jobId, liveReviewEnabled, sgfText, sgfTree, isSgfTreeLoading, analysisConfiguration, trial, recordedPreview]);

  useEffect(() => {
    if (!liveReviewEnabled || isSgfTreeLoading || !sgfTree || sgfTreeError) return;
    void syncLiveReviewPosition(currentMove);
  }, [liveTargetKey, liveReviewEnabled, isSgfTreeLoading, sgfTree, sgfTreeError]);
  useEffect(() => {
    let disposed = false;
    void loadEngineProfilesSettings().then(settings => {
      if (disposed) return;
      setLiveProfile((settings.profiles.find(item => item.id === settings.selected_profile_id) ?? settings.profiles[0])?.profile ?? null);
    });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (cloud.sourceRef.current === "cloud" || cloud.isPending() || !isTauriRuntime() || !liveListenersReady || !sgfTree || isSgfTreeLoading || !liveProfile || autoStartedRef.current) return;
    autoStartedRef.current = true;
    if (liveProfile.engine_path && liveProfile.model_path && liveProfile.config_path) void handleToggleLiveReview(liveProfile);
  }, [liveListenersReady, sgfTree, isSgfTreeLoading, liveProfile]);
  useEffect(() => {
    if (!recordedPreview || !replayRunning || isSgfTreeLoading || !sgfTree || currentMove !== 20) return;
    let index = 0;
    const tick = () => {
      const raw = recordedLiveFrames[index % recordedLiveFrames.length];
      const frame = JSON.parse(JSON.stringify(raw)) as AnalysisFrameDto;
      setFrames([frame]); setProblems([]);
      setMessage(`真实 KataGo 结果回放 · 第 ${index % recordedLiveFrames.length + 1}/${recordedLiveFrames.length} 帧 · 此浏览器不运行引擎，实时分析请使用桌面应用。`);
      index += 1;
    };
    tick(); const timer = window.setInterval(tick, 650);
    return () => window.clearInterval(timer);
  }, [recordedPreview, replayRunning, sgfTree, isSgfTreeLoading, currentMove]);
  const maxTreeMove = useMemo(()=>sgfTree?.nodes.reduce((max,node)=>Math.max(max,node.move_number ?? 0),0) ?? game.summary.move_count,[sgfTree,game.summary.move_count]);
  const maxMove = Math.max(positions.at(-1)?.move_number ?? 0, currentPosition.move_number, 0);
  const documentName = useMemo(() => currentFilePath ? fileNameFromPath(currentFilePath) : fallbackFileName ?? "Untitled SGF", [currentFilePath, fallbackFileName]);
  const saveFileName = documentName.toLowerCase().endsWith(".sgf") ? documentName : `${documentName}.sgf`;
  const selectedSgfNode = useMemo(
    () => selectedSgfNodeId ? sgfTree?.nodes.find((node) => node.id === selectedSgfNodeId) ?? null : null,
    [selectedSgfNodeId, sgfTree]
  );
  const humanGame = useHumanGame({sgfText,nodeId:selectedSgfNodeId,profile:liveProfile,message:setMessage,
    prepare:async options=>{if(trial||trialBusy||researchQueue.busyRef.current||fullReview.busyRef.current)throw new Error('请先结束试下或批量分析');
      if(options.source!=='local' && (!liveReviewRef.current || analysisSource!==options.source))throw new Error(options.source==='cloud'?'请先在引擎设置中连接智子云，再选择智子云对弈':'请先在引擎设置中连接 SSH 引擎，再选择 SSH 对弈');
      autoplay.stop();await backgroundCurve.cancel();
      if(options.source!=='local'){liveReviewEnabledRef.current=false;setLiveReviewEnabled(false);++liveReviewSyncSeqRef.current;await liveQueueRef.current.catch(()=>{});await pauseLiveReview();return liveReviewRef.current!.jobId;}
      await cloud.disconnect();await stopCurrentLiveSession();return null;},
    commit:async snapshot=>{await commitDocument({sgfText:snapshot.sgfText,nodeId:snapshot.nodeId,newDocument:snapshot.newDocument??false});}
  });
  const isBusy = humanGame.active || researchQueue.busyRef.current || documentEditing || cloud.busy || liveStarting || isKataGoRunning || isCommentSaving || isPropertySaving || isAnnotationSaving || isMoveAppending || isNodeDeleting || isNodeReordering;
  const autoplay = useSgfAutoplay({tree:sgfTree,nodeId:selectedSgfNodeId,documentKey:sgfText,disabled:isBusy || !!trial || trialBusy,onSelect:id=>handleSgfTreeNodeSelect(id,true)});
  const documentHistory = useSgfHistory({sgfText,nodeId:selectedSgfNodeId,documentId:String(documentEpoch),initiallySaved:historyInitiallySaved,
    onRestore: snapshot=>commitDocument({sgfText:snapshot.sgfText,nodeId:snapshot.nodeId,newDocument:false})});
  useEffect(()=>setDirty(documentHistory.dirty),[documentHistory.dirty]);
  async function commitDocument(change: DocumentCommit) {
    if(researchBusyRef.current)throw new Error("请先结束研究队列再编辑棋谱。");
    if (trial || trialBusy) throw new Error('请先保存或退出试下。');
    if (change.newDocument && dirty && !window.confirm('当前棋谱尚未保存，是否打开新棋谱？')) throw new Error('已取消，当前棋谱未改变。');
    const revision=sgfTextEditVersionRef.current;
    setDocumentEditing(true);
    try {
      const [parsed,replayed,tree]=await Promise.all([parseSgfSummary(change.sgfText),replaySgfPositions(change.sgfText),parseSgfTree(change.sgfText)]);
      if(!tree) throw new Error("棋谱中没有可编辑的节点。 ");
      const id=change.nodeId && tree.nodes.some(n=>n.id===change.nodeId) ? change.nodeId : change.newDocument ? tree.root_id : selectedSgfNodeId && tree.nodes.some(n=>n.id===selectedSgfNodeId) ? selectedSgfNodeId : tree.root_id;
      const position=await replaySgfPositionAtNode(change.sgfText,id);
      if(researchBusyRef.current || revision!==sgfTextEditVersionRef.current) throw new Error('棋谱已改变，请重新执行编辑。');
      await fullReview.cancel({returnToForeground:false});
      if(researchBusyRef.current || revision!==sgfTextEditVersionRef.current) throw new Error('棋谱已改变，请重新执行编辑。');
      sgfTextEditVersionRef.current++;
      setSgfText(change.sgfText);setGame(parsed);setPositions(replayed);clearReviewData();resetAnalysisCacheState();
      applySgfTreeSelectedNode(tree,id);setTreeNodePositionOverride(position);setCurrentMove(position.move_number);setDirty(true);
      if(change.newDocument){setCurrentFilePath(null);setFallbackFileName(null);setHistoryInitiallySaved(false);setDocumentEpoch(n=>n+1);setBoardTool('play');}
      setMessage('棋谱已更新。');
    } finally {setDocumentEditing(false);}
  }
  async function playBoardPoint(point: {x:number;y:number}) {
    try {
      if(humanGame.active){await humanGame.play({point});return;}
      if(trial){await playTrial({point});return;}
      if(boardTool==='play'){
        if (sgfMoveEditMode !== "edit" && (currentFilePath || fallbackFileName) && sgfTree && selectedSgfNodeId) {
          const node = sgfTree.nodes.find(item => item.id === selectedSgfNodeId);
          const continuation = sgfTree.nodes.find(item => item.id === node?.child_ids[0]);
          const vertex = continuation?.vertex;
          if (vertex && typeof vertex === "object" && "point" in vertex &&
              vertex.point.x === point.x && vertex.point.y === point.y) {
            await handleSgfTreeNodeSelect(continuation!.id);
          } else {
            await beginTrial({point});
          }
          return;
        }
        handleMoveEditInput({point});return;
      }
      if(!sgfTree || !selectedSgfNodeId) return;
      const text=await applyBoardEdit(sgfText,sgfTree,selectedSgfNodeId,boardTool,point,currentPosition.to_play,currentPosition.board_size);
      await commitDocument({sgfText:text,newDocument:false});
    } catch(error){setMessage(errorMessage(error));}
  }
  const canDeleteSgfNode = Boolean(selectedSgfNode && selectedSgfNode.id !== sgfTree?.root_id && selectedSgfNode.parent_id !== null && !isBusy);
  const canEditSelectedMove = Boolean(selectedSgfNode && selectedSgfNode.id !== sgfTree?.root_id && selectedSgfNode.color && selectedSgfNode.vertex !== null && selectedSgfNode.vertex !== undefined && !isBusy);

  useEffect(() => {
    const pending = resumeAfterBatchRef.current;
    if (cloud.sourceRef.current === "cloud" || cloud.isPending()) { resumeAfterBatchRef.current = null; return; }
    if (!pending || isKataGoRunning || isSgfTreeLoading || startingAnalysisRef.current || activeJobIdRef.current) return;
    if (reviewWorkflowStatus.phase === "error" || pending.revision !== sgfTextEditVersionRef.current) {
      resumeAfterBatchRef.current = null;
      return;
    }
    if (!["completed", "cancelled"].includes(reviewWorkflowStatus.phase)) return;
    resumeAfterBatchRef.current = null;
    void handleToggleLiveReview(pending.profile);
  }, [isKataGoRunning, isSgfTreeLoading, reviewWorkflowStatus.phase, currentMove, sgfText]);

  useEffect(() => {
    setEditColor(sgfMoveEditMode === "edit" && selectedSgfNode?.color ? selectedSgfNode.color : currentPosition.to_play);
  }, [currentPosition.to_play, selectedSgfNode?.color, sgfMoveEditMode]);

  useEffect(() => {
    setSelectedCandidateIndex(null);
  }, [currentMove, trial]);

  useEffect(() => {
    if (selectedCandidateIndex !== null && selectedCandidateIndex >= preferences.candidateLimit) {
      setSelectedCandidateIndex(null);
    }
  }, [preferences.showCandidates, preferences.candidateLimit, selectedCandidateIndex]);

  function handlePreferencesChange(nextPreferences: AppPreferences) {
    const normalized = normalizeAppPreferences(nextPreferences);
    userChangedPreferencesRef.current = true;
    pendingPreferencesSaveRef.current = {
      version: preferencesSaveVersionRef.current + 1,
      preferences: normalized
    };
    preferencesSaveVersionRef.current = pendingPreferencesSaveRef.current.version;
    setPreferences(normalized);
    setPreferencesStatus("Saving preferences...");
    void runPreferencesSaveLoop();
  }

  async function runPreferencesSaveLoop() {
    if (preferencesSaveInFlightRef.current) return;
    preferencesSaveInFlightRef.current = true;
    try {
      while (pendingPreferencesSaveRef.current) {
        const pending = pendingPreferencesSaveRef.current;
        try {
          await saveAppPreferences(pending.preferences);
        } catch (error) {
          if (pendingPreferencesSaveRef.current?.version === pending.version) {
            setPreferencesStatus(`Save failed: ${errorMessage(error)}`);
            return;
          }
          setPreferencesStatus("Saving preferences...");
          continue;
        }

        if (pendingPreferencesSaveRef.current?.version === pending.version) {
          pendingPreferencesSaveRef.current = null;
          setPreferencesStatus("Preferences saved.");
          return;
        }
        setPreferencesStatus("Saving preferences...");
      }
    } finally {
      preferencesSaveInFlightRef.current = false;
    }
  }

  function handleLegacyConfigPathChange(path: string) {
    setLegacyConfigPath(path);
    setLegacyConfigPreview(null);
    setLegacyConfigApplyResult(null);
    setLegacyConfigStatus(path.trim() ? "Ready to preview legacy config." : "No legacy config selected.");
  }

  async function handlePreviewLegacyConfigMigration() {
    const path = legacyConfigPath.trim();
    if (!path) {
      setLegacyConfigStatus("Enter a legacy Java/Swing config path before previewing.");
      return;
    }
    setIsLegacyConfigMigrating(true);
    setLegacyConfigStatus("Previewing legacy config migration...");
    setLegacyConfigApplyResult(null);
    try {
      const preview = await previewLegacyConfigMigration(path);
      setLegacyConfigPreview(preview);
      const fieldCount = preview.migratedFields.length;
      const warningCount = preview.warnings.length;
      setLegacyConfigStatus(`Preview ready: ${fieldCount} migrated fields, ${warningCount} warnings.`);
    } catch (error) {
      setLegacyConfigPreview(null);
      setLegacyConfigStatus(`Preview failed: ${errorMessage(error)}`);
    } finally {
      setIsLegacyConfigMigrating(false);
    }
  }

  async function handleApplyLegacyConfigMigration() {
    const path = legacyConfigPath.trim();
    if (!path) {
      setLegacyConfigStatus("Enter a legacy Java/Swing config path before applying.");
      return;
    }
    setIsLegacyConfigMigrating(true);
    setLegacyConfigStatus("Applying legacy config migration...");
    try {
      const result = await applyLegacyConfigMigration(path);
      setLegacyConfigApplyResult(result);
      if (result.status === "failed") {
        setLegacyConfigStatus(`Apply failed: ${legacyConfigApplyFailureSummary(result)}`);
        return;
      }
      setLegacyConfigPreview({
        sourcePath: result.sourcePath,
        preferences: null,
        engineProfiles: null,
        migratedFields: result.migratedFields,
        warnings: result.warnings
      });
      const loadedPreferences = await loadAppPreferences();
      setPreferences(loadedPreferences);
      await loadEngineProfilesSettings();
      setPreferencesStatus("Preferences loaded after legacy migration.");
      setLegacyConfigStatus(`Applied legacy config migration: ${result.migratedFields.length} migrated fields. ${legacyConfigApplySuccessSummary(result)}`);
    } catch (error) {
      setLegacyConfigStatus(`Apply failed: ${errorMessage(error)}`);
    } finally {
      setIsLegacyConfigMigrating(false);
    }
  }

  async function commitTrial(saved: { sgf_text: string; node_id: string }) {
    // Publish the accepted draft before rebuilding views, so a rendering failure cannot lose it.
    sgfTextEditVersionRef.current += 1;
    setSgfText(saved.sgf_text); setDirty(true); clearReviewData(); resetAnalysisCacheState();
    const [parsed, replayed, tree, position] = await Promise.all([
      parseSgfSummary(saved.sgf_text), replaySgfPositions(saved.sgf_text),
      parseSgfTree(saved.sgf_text), replaySgfPositionAtNode(saved.sgf_text, saved.node_id)
    ]);
    setGame(parsed); setPositions(replayed);
    applySgfTreeSelectedNode(tree, saved.node_id);
    setTreeNodePositionOverride(position); setCurrentMove(position.move_number);
  }

  async function handleParseSgf() {
    const text = sgfText;
    const sgfTreeRequest = beginSgfTreeLoad();
    try {
      const [parsed, replayed, tree] = await Promise.all([parseSgfSummary(text), replaySgfPositions(text), parseSgfTree(text)]);
      const targetMove = replayed.at(-1)?.move_number ?? parsed.moves.length;
      const loadedMessage = `Loaded ${parsed.summary.black_name ?? "Black"} vs ${parsed.summary.white_name ?? "White"}: ${parsed.summary.move_count} moves.`;
      setGame(parsed);
      setPositions(replayed);
      setCurrentMove(targetMove);
      setFrames([]);
      setProblems([]);
      setSelectedCandidateIndex(null);
      clearTreeNodePositionOverride();
      applySgfTree(tree, targetMove, sgfTreeRequest);
      setMessage(loadedMessage);
      await checkAnalysisCacheForGame(text, currentFilePath, parsed, replayed, loadedMessage, tree);
    } catch (error) {
      clearReviewData();
      resetAnalysisCacheState();
      setCurrentMove(0);
      failSgfTreeLoad(error, sgfTreeRequest);
      setMessage(`Parse failed: ${errorMessage(error)}`);
    } finally {
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function handleOpenSgfDocument(recentPath?: string) {
    if (dirty && !window.confirm("Discard unsaved SGF changes and open another file?")) return;
    let sgfTreeRequest: number | null = null;
    try {
      const document = recentPath ? await backendApi.readSgfDocument(recentPath) : await openSgfDocument();
      if (!document) {
        setMessage("Native Open is unavailable here. Use Import SGF in browser preview.");
        return;
      }
      sgfTreeRequest = beginSgfTreeLoad();
      const [parsed, replayed, tree] = await Promise.all([parseSgfSummary(document.sgfText), replaySgfPositions(document.sgfText), parseSgfTree(document.sgfText)]);
      if (sgfTreeRequest !== sgfTreeRequestVersionRef.current) return;
      setSgfText(document.sgfText);
      sgfTextEditVersionRef.current += 1;
      setCurrentFilePath(document.path);
      setHistoryInitiallySaved(true);setDocumentEpoch(n=>n+1);
      if(document.path) recentDocuments.remember(document.path);
      setFallbackFileName(null);
      setDirty(false);
      clearTreeNodePositionOverride();
      const targetMove = replayed.at(-1)?.move_number ?? parsed.moves.length;
      const openedMessage = `Opened ${fileNameFromPath(document.path ?? "SGF")}: ${parsed.summary.move_count} moves.`;
      setGame(parsed);
      setPositions(replayed);
      setCurrentMove(targetMove);
      setFrames([]);
      setProblems([]);
      setSelectedCandidateIndex(null);
      clearTreeNodePositionOverride();
      applySgfTree(tree, targetMove, sgfTreeRequest);
      setMessage(openedMessage);
      await checkAnalysisCacheForGame(document.sgfText, document.path, parsed, replayed, openedMessage, tree);
      queueImportedCurve(document.sgfText);
    } catch (error) {
      failSgfTreeLoad(error, sgfTreeRequest);
      setMessage(`Open failed: ${errorMessage(error)}`);
    } finally {
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function handleSaveSgfDocument(saveAs = false) {
    let sgfTreeRequest: number | null = null;
    let savedPath: string | null = null;
    try {
      const saved = await saveSgfDocument(saveAs ? null : currentFilePath, sgfText, saveFileName);
      if (!saved) {
        setMessage("Save cancelled.");
        return;
      }
      savedPath = saved.path;
      documentHistory.markSaved(saved.sgfText);
      if(saved.path) recentDocuments.remember(saved.path);

      if (!saved.path) {
        setCurrentFilePath(saved.path);
        setDirty(false);
        setMessage(`Saved ${saveFileName}.`);
        return;
      }

      setCurrentFilePath(saved.path);
      setFallbackFileName(null);
      setDirty(false);
      sgfTreeRequest = beginSgfTreeLoad();
      const [parsed, replayed, tree] = await Promise.all([parseSgfSummary(saved.sgfText), replaySgfPositions(saved.sgfText), parseSgfTree(saved.sgfText)]);
      const targetMove = replayed.at(-1)?.move_number ?? parsed.moves.length;
      const savedMessage = `Saved and reloaded ${fileNameFromPath(saved.path)}: ${parsed.summary.move_count} moves.`;
      setSgfText(saved.sgfText);
      sgfTextEditVersionRef.current += 1;
      setGame(parsed);
      setPositions(replayed);
      setCurrentMove(targetMove);
      setFrames([]);
      setProblems([]);
      setSelectedCandidateIndex(null);
      clearTreeNodePositionOverride();
      applySgfTree(tree, targetMove, sgfTreeRequest);
      setMessage(savedMessage);
      await checkAnalysisCacheForGame(saved.sgfText, saved.path, parsed, replayed, savedMessage, tree);
    } catch (error) {
      if (sgfTreeRequest !== null) {
        failSgfTreeLoad(error, sgfTreeRequest);
      }
      setMessage(savedPath ? `Saved ${fileNameFromPath(savedPath)}, but reload failed: ${errorMessage(error)}` : `Save failed: ${errorMessage(error)}`);
    } finally {
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function handleSelectedGameAnalysis() {
    if(researchBusyRef.current){setMessage("研究队列正在使用引擎，请先结束队列。");return;}
    if (trial || trialBusy) { setMessage("请先退出或保存试下，再做全盘分析。"); return; }
    if (!isTauriRuntime()) {
      setMessage("全盘分析需要 Tauri 桌面应用和真实 KataGo；浏览器仅用于预览。");
      return;
    }
    try {
      const settings = await loadEngineProfilesSettings();
      const selected = settings.profiles.find(item => item.id === settings.selected_profile_id) ?? settings.profiles[0];
      if (!selected?.profile.engine_path || !selected.profile.model_path || !selected.profile.config_path) {
        setMessage("请先在引擎设置中选择 KataGo、权重和分析配置。");
        return;
      }
      await handleAnalyzeKataGoGame({ ...selected.profile, backend: "kata_go_analysis" }, selected.max_visits);
    } catch (error) {
      setMessage(`全盘分析启动失败：${errorMessage(error)}`);
    }
  }

  /**
   * 同步实时复盘目标局面到引擎。
   *
   * 先调用后端 `setLiveReviewPosition`（它会自增 Rust 侧世代号，从而**立刻**作废在途的旧行），
   * 再用它返回的世代号更新前端状态——前端世代号不从本地自增，避免与 Rust 侧错位导致所有帧被丢弃。
   */
  async function syncLiveReviewPosition(_targetMove: number) {
    if(researchBusyRef.current)return;
    if (fullReviewRef.current?.busyRef.current) return;
    const base = liveReviewRef.current;
    if (!liveReviewEnabledRef.current || !base) return;
    const targetKey = liveTargetKey;
    const seq = ++liveReviewSyncSeqRef.current;
    liveReviewRef.current = { ...base, generation: -1, targetKey };
    try {
      const request = buildLivePosition(game, currentPosition, trial?.tree ?? sgfTree, trial?.node_id ?? selectedSgfNodeId);
      const work = async () => {
        if (seq !== liveReviewSyncSeqRef.current || targetKey !== liveTargetKeyRef.current) return;
        const generation = await setLiveReviewPosition(request.moves, request.turn, 10, request.player, request.komi,
          request.boardSize, request.setup, request.rules, request.handicap, searchOptions);
        if (seq !== liveReviewSyncSeqRef.current || targetKey !== liveTargetKeyRef.current || liveReviewRef.current?.jobId !== base.jobId) return;
        const next = { ...base, generation, turn: request.turn, targetKey };
        liveReviewRef.current = next; setLiveReview(next);
      };
      liveQueueRef.current = liveQueueRef.current.catch(() => {}).then(work);
      await liveQueueRef.current;
    } catch (error) {
      if (seq !== liveReviewSyncSeqRef.current) return;
      cloud.ended();
      await stopLiveReview().catch(() => {});
      liveReviewRef.current = null; liveReviewEnabledRef.current = false;
      setLiveReview(null); setLiveReviewEnabled(false); setLiveFrames([]);
      setMessage(cloud.sourceRef.current === "cloud" ? "云端局面同步失败，连接已停止。请手动重新连接。" : `实时分析局面同步失败：${errorMessage(error)}`);
    }
  }

  async function toggleConnectedAnalysis() {
    if (fullReviewRef.current?.busyRef.current) { await fullReviewRef.current.pause().catch(error => setMessage(errorMessage(error))); return; }
    if (fullReviewRef.current?.progress.status === "paused") { void fullReviewRef.current.resume(); return; }
    if (!liveReviewRef.current) return;
    if (!liveReviewEnabledRef.current) {
      liveReviewEnabledRef.current = true; setLiveReviewEnabled(true); return;
    }
    ++liveReviewSyncSeqRef.current;
    liveReviewEnabledRef.current = false; setLiveReviewEnabled(false);
    await liveQueueRef.current.catch(() => {});
    try {
      const generation = await pauseLiveReview();
      if (liveReviewRef.current) {
        const next = {...liveReviewRef.current, generation};
        liveReviewRef.current = next; setLiveReview(next);
      }
      setMessage("分析已暂停，连接与结果已保留。");
    } catch (error) { setMessage(`暂停失败：${errorMessage(error)}`); }
  }

  async function applyEngineParameters(parameters: LiveEngineParameters) {
    if (analysisSource !== "local") throw new Error("远程引擎沿用服务端配置。");
    if(researchBusyRef.current){setMessage("研究队列正在使用引擎，请先结束队列。");return;}
    ++liveReviewSyncSeqRef.current;
    await liveQueueRef.current.catch(() => {});
    try {
      await fullReviewRef.current?.cancel({returnToForeground: false});
      if(researchBusyRef.current)throw new Error("研究队列正在使用引擎。");
      await configureLiveReview(parameters);
      setAnalysisConfiguration(value => value + 1);
      setLiveFrames([]); setFrames([]); // Parameters change the analysis context; old comparisons are invalid.
      if (liveReviewEnabledRef.current) await syncLiveReviewPosition(currentMove);
    } catch (error) {
      liveReviewEnabledRef.current = false; setLiveReviewEnabled(false);
      throw error;
    }
  }

  async function toggleSelectedLiveReview() {
    if(researchBusyRef.current){setMessage("研究队列进行中，请先结束队列。");return;}
    if (liveReviewRef.current) { await toggleConnectedAnalysis(); return; }
    if (cloud.sourceRef.current === "cloud") {
      setMessage("请在引擎设置中连接 VIP 算力。"); return;
    }
    if (recordedPreview) { setReplayRunning(value => !value); return; }
    if (!isTauriRuntime()) {
      setMessage("浏览器仅供布局预览；实时 KataGo 分析请使用已打开的桌面应用。");
      return;
    }
    const settings = await loadEngineProfilesSettings();
    const profile = (settings.profiles.find(item => item.id === settings.selected_profile_id) ?? settings.profiles[0])?.profile;
    if (!profile?.engine_path) { setMessage("请先在引擎设置中选择 KataGo、权重和 GTP 配置。"); return; }
    setLiveProfile(profile);
    await handleToggleLiveReview(profile);
  }

  async function connectRemoteEngine(config: RemoteEngineConfig, restoring=false) {
    if((isBusy && !restoring) || trial || !liveListenersReady)throw new Error('当前无法切换引擎，请先结束正在执行的操作。');
    await cloud.disconnect();await stopCurrentLiveSession();cloud.selectLocal();
    setAnalysisSource("ssh");
    liveStartingRef.current=true;setLiveStarting(true);
    try {
      const jobId=await startRemoteLiveReview(config,currentPosition.board_size,currentPosition.move_number);
      ++liveReviewSyncSeqRef.current;
      const next={jobId,generation:-1,turn:currentPosition.move_number,targetKey:liveTargetKey};
      liveReviewRef.current=next;liveReviewEnabledRef.current=true;setLiveReview(next);setLiveReviewEnabled(true);
      remoteConfigRef.current=config;setMessage('SSH KataGo 已连接。');
    } finally {liveStartingRef.current=false;setLiveStarting(false);}
  }

  async function handleToggleLiveReview(profile: EngineProfileDto) {
    if(researchBusyRef.current)throw new Error("研究队列正在使用算力。");
    remoteConfigRef.current=null;
    setAnalysisSource("local");
    if (cloud.isPending() || cloud.connected) { setMessage("请先断开智子云，再启动本地引擎。"); return; }
    cloud.selectLocal();
    if (activeJobIdRef.current || startingAnalysisRef.current) {
      setMessage("全盘分析进行中，请先取消或等待完成后开始实时分析。");
      return;
    }
    if (liveStartingRef.current) return;
    if (liveReviewRef.current) { await toggleConnectedAnalysis(); return; }
    setLiveProfile(profile);
    liveStartingRef.current = true; setLiveStarting(true);
    try {
      const jobId = await startLiveReview({ ...profile, backend: "kata_go_gtp" }, currentPosition.board_size, currentPosition.move_number, 10);
      if (!jobId) { setMessage("实时分析需要 Tauri 桌面运行时。"); return; }
      ++liveReviewSyncSeqRef.current;
      const next = { jobId, generation: -1, turn: currentPosition.move_number, targetKey: liveTargetKey };
      liveReviewRef.current = next; liveReviewEnabledRef.current = true;
      setLiveReview(next); setLiveReviewEnabled(true);
      setMessage("KataGo 实时分析中，切换手数可分析对应局面。");
    } catch (error) {
      liveReviewRef.current = null; liveReviewEnabledRef.current = false;
      setLiveReviewEnabled(false); setLiveReview(null);
      setMessage(`实时分析启动失败：${errorMessage(error)}`);
    } finally { liveStartingRef.current = false; setLiveStarting(false); }
  }

  async function handleAnalyzeKataGoGame(profile: EngineProfileDto, maxVisits: number) {
    if(researchBusyRef.current){setMessage("研究队列正在使用引擎，请先结束队列。");return;}
    try { await fullReviewRef.current?.cancel({returnToForeground: false}); }
    catch (error) { setMessage(errorMessage(error)); return; }
    if (cloud.sourceRef.current === "cloud" || cloud.isPending()) { setMessage("云算力目前仅支持实时分析；如需本地全盘分析，请先断开云算力并选择本地实时引擎。"); return; }
    if (trial || trialBusy) return;
    if (activeJobIdRef.current || startingAnalysisRef.current) return;
    if (liveStartingRef.current) { setMessage("实时引擎正在启动，请稍后再开始全盘分析。"); return; }
    const visits = resolveAnalysisMaxVisits(maxVisits, preferences);
    if(researchBusyRef.current){setMessage("研究队列正在使用引擎。");return;}
    const sourceVersion = sgfTextEditVersionRef.current;
    const previousWasCancelled = reviewWorkflowStatus.phase === "cancelled";
    const sessionToken = nextAnalysisSessionToken();
    resumeAfterBatchRef.current = liveReviewEnabledRef.current && liveProfile
      ? { profile: liveProfile, revision: sourceVersion } : null;
    startingAnalysisRef.current = true;
    pendingAnalysisProgressRef.current.clear();
    pendingAnalysisTerminalEventsRef.current.clear();
    setIsKataGoRunning(true);
    setAnalysisProgress(null);
    setReviewWorkflowStatus({
      ...initialReviewWorkflowStatus,
      phase: "starting",
      source: "katago",
      message: "Starting full-game KataGo review.",
      sessionToken,
      restartAfterCancelVerified: previousWasCancelled
    });
    setMessage("Starting full-game KataGo analysis...");
    let cleanup: (() => void) | null = null;
    const sgfTreeRequest = beginSgfTreeLoad();
    try {
      // Invalidate frontend event acceptance before requesting a pause.
      // The batch command owns confirmed engine teardown and mutual exclusion.
      ++liveReviewSyncSeqRef.current;
      liveReviewEnabledRef.current = false;
      liveReviewRef.current = null;
      setLiveReviewEnabled(false); setLiveReview(null); setLiveFrames([]);
      await liveQueueRef.current.catch(() => {});
      await stopLiveReview();
      const [parsed, replayed, tree] = await Promise.all([parseSgfSummary(sgfText), replaySgfPositions(sgfText), parseSgfTree(sgfText)]);
      clearTreeNodePositionOverride();
      applySgfTree(tree, replayed.at(-1)?.move_number ?? parsed.moves.length, sgfTreeRequest);
      cleanup = await listenToKataGoAnalysisEvents({
        onProgress: (payload) => {
          if (startingAnalysisRef.current && activeJobIdRef.current === null) {
            pendingAnalysisProgressRef.current.set(payload.job_id, {
              jobId: payload.job_id,
              completed: payload.completed,
              expected: payload.expected,
              turn: payload.turn,
              responseJsonl: payload.response_jsonl
            });
            return;
          }
          if (!isCurrentAnalysisJob(payload.job_id)) {
            markStaleAnalysisPrevented(payload.job_id);
            return;
          }
          const progress = {
            jobId: payload.job_id,
            completed: payload.completed,
            expected: payload.expected,
            turn: payload.turn,
            responseJsonl: payload.response_jsonl
          };
          setAnalysisProgress(progress);
          setReviewWorkflowProgress(progress);
          setMessage(`Analyzing move ${payload.turn}: ${payload.completed}/${payload.expected} positions complete.`);
        },
        onComplete: (payload) => {
          if (startingAnalysisRef.current && activeJobIdRef.current === null) {
            pendingAnalysisTerminalEventsRef.current.set(payload.job_id, { kind: "complete", frames: payload.frames });
            return;
          }
          if (!isCurrentAnalysisJob(payload.job_id)) {
            markStaleAnalysisPrevented(payload.job_id);
            return;
          }
          void finishCompletedAnalysis(payload.job_id, payload.frames, parsed, replayed, sourceVersion);
        },
        onError: (payload) => {
          if (startingAnalysisRef.current && activeJobIdRef.current === null) {
            pendingAnalysisTerminalEventsRef.current.set(payload.job_id, { kind: "error", message: payload.message });
            return;
          }
          if (!isCurrentAnalysisJob(payload.job_id)) {
            markStaleAnalysisPrevented(payload.job_id);
            return;
          }
          finishStoppedAnalysis(payload.job_id);
          const message = engineFailureMessage(payload.message);
          setReviewWorkflowStatus((status) => ({
            ...status,
            phase: "error",
            source: "katago",
            activeJobId: null,
            message,
            engineFailureVerified: true
          }));
          setMessage(message);
        },
        onCancelled: (payload) => {
          if (startingAnalysisRef.current && activeJobIdRef.current === null) {
            pendingAnalysisTerminalEventsRef.current.set(payload.job_id, { kind: "cancelled", message: payload.message });
            return;
          }
          if (!isCurrentAnalysisJob(payload.job_id)) {
            markStaleAnalysisPrevented(payload.job_id);
            return;
          }
          finishStoppedAnalysis(payload.job_id);
          setAnalysisProgress(null);
          setReviewWorkflowStatus((status) => ({
            ...status,
            phase: "cancelled",
            source: "katago",
            activeJobId: null,
            message: payload.message || "Full-game KataGo analysis cancelled. You can restart review when ready.",
            cancelVerified: true
          }));
          setMessage(payload.message || "Full-game KataGo analysis cancelled. You can restart review when ready.");
        }
      });
      cleanupAnalysisListeners();
      analysisCleanupRef.current = cleanup;
      const jobId = await startKataGoGameAnalysis(profile, sgfText, visits);
      const pendingTerminalEvent = pendingAnalysisTerminalEventsRef.current.get(jobId);
      const pendingProgress = pendingAnalysisProgressRef.current.get(jobId);
      const hasStalePendingEvent = [...pendingAnalysisProgressRef.current.keys(), ...pendingAnalysisTerminalEventsRef.current.keys()].some((pendingJobId) => pendingJobId !== jobId);
      startingAnalysisRef.current = false;
      pendingAnalysisProgressRef.current.clear();
      pendingAnalysisTerminalEventsRef.current.clear();
      if (hasStalePendingEvent) markStaleAnalysisPrevented("pending-startup-event");
      activeJobIdRef.current = jobId;
      if (pendingTerminalEvent) {
        await finishPendingAnalysisTerminalEvent(jobId, pendingTerminalEvent, parsed, replayed, sourceVersion);
        return;
      }
      setActiveJobId(jobId);
      setReviewWorkflowStatus((status) => ({
        ...status,
        phase: pendingProgress ? "running" : "starting",
        source: "katago",
        activeJobId: jobId,
        message: `Full-game KataGo analysis started (${jobId}).`
      }));
      if (pendingProgress) {
        setAnalysisProgress(pendingProgress);
        setReviewWorkflowProgress(pendingProgress);
      }
      setMessage(`Full-game KataGo analysis started (${jobId}).`);
    } catch (error) {
      failSgfTreeLoad(error, sgfTreeRequest);
      cleanup?.();
      if (analysisCleanupRef.current === cleanup) analysisCleanupRef.current = null;
      startingAnalysisRef.current = false;
      pendingAnalysisProgressRef.current.clear();
      pendingAnalysisTerminalEventsRef.current.clear();
      activeJobIdRef.current = null;
      setActiveJobId(null);
      setAnalysisProgress(null);
      setIsKataGoRunning(false);
      const message = engineFailureMessage(error);
      setReviewWorkflowStatus((status) => ({
        ...status,
        phase: "error",
        source: "katago",
        activeJobId: null,
        message,
        engineFailureVerified: true
      }));
      setMessage(message);
    } finally {
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function handleCancelKataGoAnalysis() {
    const jobId = activeJobIdRef.current;
    if (!jobId) return;
    setReviewWorkflowStatus((status) => ({
      ...status,
      phase: "cancelling",
      source: "katago",
      activeJobId: jobId,
      message: `Cancelling full-game KataGo analysis (${jobId})...`
    }));
    try {
      setMessage("Cancelling full-game KataGo analysis...");
      await cancelKataGoAnalysis(jobId);
      // Cancellation acknowledges a request; the matching terminal event owns cleanup.
      // Keep the job and listeners alive until the worker has released the engine slot.
    } catch (error) {
      if (activeJobIdRef.current !== jobId) return;
      const message = `取消请求失败：${errorMessage(error)}。任务仍在运行，可重试取消。`;
      setReviewWorkflowStatus((status) => ({ ...status, phase: "running", message }));
      setMessage(message);
    }
  }

  async function handleImportFile(file: File | null) {
    if (!file) return;
    const sgfTreeRequest = beginSgfTreeLoad();
    try {
      const text = await file.text();
      const [parsed, replayed, tree] = await Promise.all([parseSgfSummary(text), replaySgfPositions(text), parseSgfTree(text)]);
      if (sgfTreeRequest !== sgfTreeRequestVersionRef.current) return;
      const targetMove = replayed.at(-1)?.move_number ?? parsed.moves.length;
      const importedMessage = `Imported ${file.name}: ${parsed.summary.move_count} moves.`;
      setSgfText(text);
      sgfTextEditVersionRef.current += 1;
      setCurrentFilePath(null);
      setFallbackFileName(file.name);
      setHistoryInitiallySaved(true);setDocumentEpoch(n=>n+1);
      setDirty(false);
      setGame(parsed);
      setPositions(replayed);
      setCurrentMove(targetMove);
      setFrames([]);
      setProblems([]);
      setSelectedCandidateIndex(null);
      clearTreeNodePositionOverride();
      applySgfTree(tree, targetMove, sgfTreeRequest);
      setMessage(importedMessage);
      await checkAnalysisCacheForGame(text, null, parsed, replayed, importedMessage, tree);
      queueImportedCurve(text);
    } catch (error) {
      failSgfTreeLoad(error, sgfTreeRequest);
      setMessage(`Import failed: ${errorMessage(error)}`);
    } finally {
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function handleProviderImport(result: ProviderImportResult) {
    const sgfTreeRequest = beginSgfTreeLoad();
    try {
      const [parsed, replayed, tree] = await Promise.all([parseSgfSummary(result.sgf_text), replaySgfPositions(result.sgf_text), parseSgfTree(result.sgf_text)]);
      if (sgfTreeRequest !== sgfTreeRequestVersionRef.current) return;
      const source = providerSourceLabel(result);
      const warningText = result.warnings.length > 0 ? ` ${result.warnings.length} provider warning(s).` : "";
      const importedMessage = `Imported ${providerLabel(result.provider)} provider payload from ${source}: ${parsed.summary.move_count} moves.${warningText}`;
      const targetMove = replayed.at(-1)?.move_number ?? parsed.moves.length;
      setSgfText(result.sgf_text);
      sgfTextEditVersionRef.current += 1;
      setCurrentFilePath(null);
      setFallbackFileName(providerDocumentName(result));
      setHistoryInitiallySaved(true);setDocumentEpoch(n=>n+1);
      setDirty(false);
      setGame(parsed);
      setPositions(replayed);
      setCurrentMove(targetMove);
      setFrames([]);
      setProblems([]);
      setSelectedCandidateIndex(null);
      clearTreeNodePositionOverride();
      applySgfTree(tree, targetMove, sgfTreeRequest);
      setMessage(importedMessage);
      await checkAnalysisCacheForGame(result.sgf_text, null, parsed, replayed, importedMessage, tree);
      queueImportedCurve(result.sgf_text);
    } catch (error) {
      failSgfTreeLoad(error, sgfTreeRequest);
      setMessage(`Provider import failed: ${errorMessage(error)}`);
      throw error;
    } finally {
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function loadSample() {
    const sgfTreeRequest = beginSgfTreeLoad();
    try {
      const [parsed, replayed, tree] = await Promise.all([parseSgfSummary(demoSgf), replaySgfPositions(demoSgf), parseSgfTree(demoSgf)]);
      const targetMove = replayed.at(-1)?.move_number ?? parsed.moves.length;
      const sampleMessage = `Sample SGF restored: ${parsed.summary.move_count} moves.`;
      setSgfText(demoSgf);
      sgfTextEditVersionRef.current += 1;
      setCurrentFilePath(null);
      setFallbackFileName("sample.sgf");
      setHistoryInitiallySaved(true);setDocumentEpoch(n=>n+1);
      setDirty(false);
      setGame(parsed);
      setPositions(replayed);
      setCurrentMove(targetMove);
      setFrames([]);
      setProblems([]);
      setSelectedCandidateIndex(null);
      clearTreeNodePositionOverride();
      applySgfTree(tree, targetMove, sgfTreeRequest);
      setMessage(sampleMessage);
      await checkAnalysisCacheForGame(demoSgf, null, parsed, replayed, sampleMessage, tree);
    } catch (error) {
      failSgfTreeLoad(error, sgfTreeRequest);
      setMessage(`Sample load failed: ${errorMessage(error)}`);
    } finally {
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  function handleMoveSelect(moveNumber: number) {
    if(researchBusyRef.current)return;
    if (trial || trialBusy) { setMessage("请先退出或保存试下，再浏览原棋谱。"); return; }
    clearTreeNodePositionOverride();
    const selectedMove = clampMoveNumberToPositions(positions, moveNumber);
    setCurrentMove(selectedMove);
    setSelectedCandidateIndex(null);
    syncSelectedSgfNodeToMove(selectedMove);
  }

  async function handleSgfTreeNodeSelect(nodeId: string, strict=false) {
    if(researchBusyRef.current)return;
    if (trial || trialBusy) { setMessage("请先退出或保存试下，再切换分支。"); return; }
    const node = sgfTree?.nodes.find((item) => item.id === nodeId);
    setSelectedSgfNodeId(nodeId);
    setCommentDraft(node?.comment ?? "");
    if (node?.move_number !== null && node?.move_number !== undefined) {
      setCurrentMove(clampMoveNumberToPositions(positions, node.move_number));
      setSelectedCandidateIndex(null);
    }
    if (!node) return;

    const requestVersion = beginTreeNodeReplay();
    const text = sgfText;

    try {
      const position = await replaySgfPositionAtNode(text, nodeId);
      if (treeNodeReplayRequestVersionRef.current !== requestVersion) return;
      setTreeNodePositionOverride(position);
      setCurrentMove(position.move_number);
      if (node.is_mainline) {
        setMessage(`主线第 ${position.move_number} 手，实时分析将跟随局面更新。`);
      } else {
        setMessage(`分支 ${formatSgfNodeLabel(node)}，实时分析将跟随局面更新。`);
      }
    } catch (error) {
      if (treeNodeReplayRequestVersionRef.current !== requestVersion) return;
      setTreeNodePositionOverride(null);
      setMessage(`Branch position replay failed: ${errorMessage(error)}`);
      if(strict)throw error;
    }
  }

  async function handleSaveComment(nodeId: string, comment: string) {
    if (trial || trialBusy) { setMessage("请先退出或保存试下，再编辑原棋谱。"); return; }
    const existingNode = sgfTree?.nodes.find((node) => node.id === nodeId) ?? null;
    const sgfTreeRequest = beginSgfTreeLoad();
    const sourceVersion = sgfTextEditVersionRef.current;
    const sourceText = sgfText;
    setIsCommentSaving(true);
    try {
      const updatedSgfText = await updateSgfNodeComment(sourceText, nodeId, comment.length > 0 ? comment : null);
      if (sgfTextEditVersionRef.current !== sourceVersion) {
        setMessage("Save comment cancelled because the SGF source changed while the save was running.");
        return;
      }
      sgfTextEditVersionRef.current += 1;
      setSgfText(updatedSgfText);
      setDirty(true);
      clearReviewData();
      resetAnalysisCacheState();
      const updatedTree = await parseSgfTree(updatedSgfText);
      const selectedNode = applySgfTreeSelectedNode(updatedTree, nodeId, sgfTreeRequest)
        ?? selectSgfTreeNodeForMove(updatedTree, currentMove);
      setSgfTreeError(null);
      setCommentDraft(selectedNode?.comment ?? "");
      let replayWarning = "";
      if (selectedNode) {
        try {
          const replayRequest = beginTreeNodeReplay();
          const position = await replaySgfPositionAtNode(updatedSgfText, selectedNode.id);
          if (treeNodeReplayRequestVersionRef.current === replayRequest) setTreeNodePositionOverride(position);
        } catch (error) {
          setTreeNodePositionOverride(null);
          replayWarning = ` Position replay failed: ${errorMessage(error)}`;
        }
      }
      setMessage(`comment saved to SGF text for ${selectedNode ? formatSgfNodeLabel(selectedNode) : existingNode ? formatSgfNodeLabel(existingNode) : "selected node"}.${replayWarning}`);
    } catch (error) {
      setMessage(`Save comment failed: ${errorMessage(error)}`);
    } finally {
      setIsCommentSaving(false);
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function handleSaveProperties(nodeId: string, updates: SgfPropertyUpdate[]) {
    if (trial || trialBusy) { setMessage("请先退出或保存试下，再编辑原棋谱。"); return false; }
    if (updates.length === 0) return false;
    const existingNode = sgfTree?.nodes.find((node) => node.id === nodeId) ?? null;
    const sgfTreeRequest = beginSgfTreeLoad();
    const sourceVersion = sgfTextEditVersionRef.current;
    const sourceText = sgfText;
    setIsPropertySaving(true);
    try {
      const result = await updateSgfNodeProperties(sourceText, nodeId, updates);
      if (sgfTextEditVersionRef.current !== sourceVersion) {
        setMessage("Save properties cancelled because the SGF source changed while the save was running.");
        return false;
      }

      sgfTextEditVersionRef.current += 1;
      setSgfText(result.sgf_text);
      setDirty(true);
      clearReviewData();
      resetAnalysisCacheState();

      const [parsed, replayed, updatedTree] = await Promise.all([
        parseSgfSummary(result.sgf_text),
        replaySgfPositions(result.sgf_text),
        parseSgfTree(result.sgf_text)
      ]);
      const selectedNode = applySgfTreeSelectedNode(updatedTree, result.node_id, sgfTreeRequest)
        ?? selectSgfTreeNodeForMove(updatedTree, currentMove);
      setGame(parsed);
      setPositions(replayed);
      setSgfTreeError(null);
      setCommentDraft(selectedNode?.comment ?? "");

      let replayWarning = "";
      if (selectedNode) {
        try {
          const replayRequest = beginTreeNodeReplay();
          const position = await replaySgfPositionAtNode(result.sgf_text, selectedNode.id);
          if (treeNodeReplayRequestVersionRef.current === replayRequest) {
            setTreeNodePositionOverride(position);
            setCurrentMove(clampMoveNumberToPositions(replayed, position.move_number));
          }
        } catch (error) {
          setTreeNodePositionOverride(null);
          setCurrentMove(clampMoveNumberToPositions(replayed, selectedNode.move_number ?? replayed.at(-1)?.move_number ?? parsed.moves.length));
          replayWarning = ` Position replay failed: ${errorMessage(error)}`;
        }
      } else {
        clearTreeNodePositionOverride();
        setCurrentMove(clampMoveNumberToPositions(replayed, replayed.at(-1)?.move_number ?? parsed.moves.length));
      }

      setMessage(`SGF properties saved for ${selectedNode ? formatSgfNodeLabel(selectedNode) : existingNode ? formatSgfNodeLabel(existingNode) : "selected node"}.${replayWarning}`);
      return true;
    } catch (error) {
      setMessage(`Save properties failed: ${errorMessage(error)}`);
      return false;
    } finally {
      setIsPropertySaving(false);
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function handleSaveAnnotations(nodeId: string, updates: SgfPropertyUpdate[]) {
    if (trial || trialBusy) { setMessage("请先退出或保存试下，再编辑原棋谱。"); return; }
    if (updates.length === 0) return;
    const existingNode = sgfTree?.nodes.find((node) => node.id === nodeId) ?? null;
    const sgfTreeRequest = beginSgfTreeLoad();
    const sourceVersion = sgfTextEditVersionRef.current;
    const sourceText = sgfText;
    setIsAnnotationSaving(true);
    setAnnotationError(null);
    try {
      const result = await updateSgfNodeProperties(sourceText, nodeId, updates);
      if (sgfTextEditVersionRef.current !== sourceVersion) {
        const cancelled = "Save annotations cancelled because the SGF source changed while the save was running.";
        setAnnotationError(cancelled);
        setMessage(cancelled);
        return;
      }

      sgfTextEditVersionRef.current += 1;
      setSgfText(result.sgf_text);
      setDirty(true);
      clearReviewData();
      resetAnalysisCacheState();

      const [parsed, replayed, updatedTree] = await Promise.all([
        parseSgfSummary(result.sgf_text),
        replaySgfPositions(result.sgf_text),
        parseSgfTree(result.sgf_text)
      ]);
      const selectedNode = applySgfTreeSelectedNode(updatedTree, result.node_id, sgfTreeRequest)
        ?? selectSgfTreeNodeForMove(updatedTree, currentMove);
      setGame(parsed);
      setPositions(replayed);
      setSgfTreeError(null);
      setCommentDraft(selectedNode?.comment ?? "");

      let replayWarning = "";
      if (selectedNode) {
        try {
          const replayRequest = beginTreeNodeReplay();
          const position = await replaySgfPositionAtNode(result.sgf_text, selectedNode.id);
          if (treeNodeReplayRequestVersionRef.current === replayRequest) {
            setTreeNodePositionOverride(position);
            setCurrentMove(clampMoveNumberToPositions(replayed, position.move_number));
          }
        } catch (error) {
          setTreeNodePositionOverride(null);
          setCurrentMove(clampMoveNumberToPositions(replayed, selectedNode.move_number ?? replayed.at(-1)?.move_number ?? parsed.moves.length));
          replayWarning = ` Position replay failed: ${errorMessage(error)}`;
        }
      } else {
        clearTreeNodePositionOverride();
        setCurrentMove(clampMoveNumberToPositions(replayed, replayed.at(-1)?.move_number ?? parsed.moves.length));
      }

      setMessage(`SGF annotations saved for ${selectedNode ? formatSgfNodeLabel(selectedNode) : existingNode ? formatSgfNodeLabel(existingNode) : "selected node"}.${replayWarning}`);
    } catch (error) {
      const message = `Save annotations failed: ${errorMessage(error)}`;
      setAnnotationError(message);
      setMessage(message);
    } finally {
      setIsAnnotationSaving(false);
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function handleAppendMove(vertex: MoveVertex) {
    if (trial || trialBusy) { setMessage("请先退出或保存试下，再编辑原棋谱。"); return; }
    const parentNodeId = selectedSgfNodeId;
    if (!parentNodeId) {
      setMessage("Select an SGF tree node before appending a move.");
      return;
    }
    if (isBusy) return;

    const sgfTreeRequest = beginSgfTreeLoad();
    const sourceVersion = sgfTextEditVersionRef.current;
    const sourceText = sgfText;
    setIsMoveAppending(true);
    setMessage("Appending move to SGF...");
    try {
      const result = normalizeAppendSgfMoveResult(await callAppendSgfMove(sourceText, parentNodeId, editColor, vertex));
      if (sgfTextEditVersionRef.current !== sourceVersion) {
        setMessage("Append move cancelled because the SGF source changed while the edit was running.");
        return;
      }

      sgfTextEditVersionRef.current += 1;
      setSgfText(result.sgfText);
      setDirty(true);
      const retainedFrames = liveFrames;
      const retainedTree = sgfTree;
      clearReviewData();
      resetAnalysisCacheState();

      const [parsed, replayed, updatedTree] = await Promise.all([
        parseSgfSummary(result.sgfText),
        replaySgfPositions(result.sgfText),
        parseSgfTree(result.sgfText)
      ]);
      if (sgfTextEditVersionRef.current !== sourceVersion + 1) return;
      setLiveFrames(rebindAppendedFrames(retainedFrames, sourceText, retainedTree, result.sgfText, updatedTree));
      const selectedNode = applySgfTreeSelectedNode(updatedTree, result.newNodeId, sgfTreeRequest);
      setGame(parsed);
      setPositions(replayed);
      setSgfTreeError(null);
      setCommentDraft(selectedNode?.comment ?? "");

      let replayWarning = "";
      if (selectedNode) {
        try {
          const replayRequest = beginTreeNodeReplay();
          const position = await replaySgfPositionAtNode(result.sgfText, selectedNode.id);
          if (treeNodeReplayRequestVersionRef.current === replayRequest) {
            setTreeNodePositionOverride(position);
            setCurrentMove(clampMoveNumberToPositions(replayed, position.move_number));
          }
        } catch (error) {
          setTreeNodePositionOverride(null);
          setCurrentMove(clampMoveNumberToPositions(replayed, selectedNode.move_number ?? replayed.at(-1)?.move_number ?? parsed.moves.length));
          replayWarning = ` Position replay failed: ${errorMessage(error)}`;
        }
      } else {
        clearTreeNodePositionOverride();
        setCurrentMove(clampMoveNumberToPositions(replayed, replayed.at(-1)?.move_number ?? parsed.moves.length));
      }

      setMessage(`Move appended to SGF.${replayWarning}`);
    } catch (error) {
      setMessage(`Append move failed: ${errorMessage(error)}`);
    } finally {
      setIsMoveAppending(false);
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function handleEditExistingMove(vertex: MoveVertex) {
    if (!selectedSgfNodeId) {
      setMessage("Select an existing SGF move node before editing a move.");
      return;
    }
    const node = sgfTree?.nodes.find((item) => item.id === selectedSgfNodeId) ?? null;
    if (!node) {
      setMessage("Edit move failed: selected SGF node was not found in the current tree.");
      return;
    }
    if (node.id === sgfTree?.root_id || node.parent_id === null || node.parent_id === undefined) {
      setMessage("Root SGF node cannot be edited as a move. Select an existing move node first.");
      return;
    }
    if (!node.color || node.vertex === null || node.vertex === undefined) {
      setMessage("Selected SGF node is not a move node. Select an existing black or white move before editing.");
      return;
    }
    if (isBusy) return;

    const sgfTreeRequest = beginSgfTreeLoad();
    const sourceVersion = sgfTextEditVersionRef.current;
    const sourceText = sgfText;
    setIsMoveAppending(true);
    setMessage(`Editing ${formatSgfNodeLabel(node)}...`);
    try {
      const result = normalizeEditSgfMoveResult(await callEditSgfMove(sourceText, node.id, editColor, vertex));
      if (sgfTextEditVersionRef.current !== sourceVersion) {
        setMessage("Edit move cancelled because the SGF source changed while the edit was running.");
        return;
      }

      sgfTextEditVersionRef.current += 1;
      const appliedVersion = sgfTextEditVersionRef.current;
      setSgfText(result.sgfText);
      setDirty(true);
      clearReviewData();
      resetAnalysisCacheState();

      const [parsed, replayed, updatedTree] = await Promise.all([
        parseSgfSummary(result.sgfText),
        replaySgfPositions(result.sgfText),
        parseSgfTree(result.sgfText)
      ]);
      if (sgfTextEditVersionRef.current !== appliedVersion) return;

      const selectedNode = applySgfTreeSelectedNode(updatedTree, result.nodeId, sgfTreeRequest)
        ?? selectSgfTreeNodeForMove(updatedTree, currentMove);
      setGame(parsed);
      setPositions(replayed);
      setSgfTreeError(null);
      setCommentDraft(selectedNode?.comment ?? "");

      let replayWarning = "";
      if (selectedNode) {
        try {
          const replayRequest = beginTreeNodeReplay();
          const position = await replaySgfPositionAtNode(result.sgfText, selectedNode.id);
          if (sgfTextEditVersionRef.current !== appliedVersion) return;
          if (treeNodeReplayRequestVersionRef.current === replayRequest) {
            setTreeNodePositionOverride(position);
            setCurrentMove(clampMoveNumberToPositions(replayed, position.move_number));
          }
        } catch (error) {
          if (sgfTextEditVersionRef.current !== appliedVersion) return;
          setTreeNodePositionOverride(null);
          setCurrentMove(clampMoveNumberToPositions(replayed, selectedNode.move_number ?? replayed.at(-1)?.move_number ?? parsed.moves.length));
          replayWarning = ` Position replay failed: ${errorMessage(error)}`;
        }
      } else {
        clearTreeNodePositionOverride();
        setCurrentMove(clampMoveNumberToPositions(replayed, replayed.at(-1)?.move_number ?? parsed.moves.length));
      }

      setMessage(`Edited existing SGF move.${replayWarning}`);
    } catch (error) {
      setMessage(`Edit move failed: ${errorMessage(error)}`);
    } finally {
      setIsMoveAppending(false);
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  function handleMoveEditInput(vertex: MoveVertex) {
    if (sgfMoveEditMode === "edit") {
      void handleEditExistingMove(vertex);
      return;
    }
    void handleAppendMove(vertex);
  }

  async function handleDeleteSgfNode(nodeId: string) {
    if (trial || trialBusy) { setMessage("请先退出或保存试下，再编辑原棋谱。"); return; }
    if (!selectedSgfNodeId) {
      setMessage("Select an SGF tree node before deleting.");
      return;
    }
    if (nodeId !== selectedSgfNodeId) {
      setMessage("Delete cancelled because the selected SGF node changed.");
      return;
    }
    const node = sgfTree?.nodes.find((item) => item.id === nodeId) ?? null;
    if (!node) {
      setMessage("Delete failed: selected SGF node was not found in the current tree.");
      return;
    }
    if (node.id === sgfTree?.root_id || node.parent_id === null) {
      setMessage("Root SGF node cannot be deleted.");
      return;
    }
    if (isBusy) return;

    const sgfTreeRequest = beginSgfTreeLoad();
    const sourceVersion = sgfTextEditVersionRef.current;
    const sourceText = sgfText;
    setIsNodeDeleting(true);
    setMessage(`Deleting ${formatSgfNodeLabel(node)} from SGF...`);
    try {
      const result = normalizeDeleteSgfNodeResult(await callDeleteSgfNode(sourceText, nodeId));
      if (sgfTextEditVersionRef.current !== sourceVersion) {
        setMessage("Delete node cancelled because the SGF source changed while the edit was running.");
        return;
      }

      sgfTextEditVersionRef.current += 1;
      const appliedVersion = sgfTextEditVersionRef.current;
      setSgfText(result.sgfText);
      setDirty(true);
      clearReviewData();
      resetAnalysisCacheState();

      const [parsed, replayed, updatedTree] = await Promise.all([
        parseSgfSummary(result.sgfText),
        replaySgfPositions(result.sgfText),
        parseSgfTree(result.sgfText)
      ]);
      if (sgfTextEditVersionRef.current !== appliedVersion) return;

      const parentNode = applySgfTreeSelectedNode(updatedTree, result.parentNodeId, sgfTreeRequest)
        ?? selectSgfTreeNodeForMove(updatedTree, 0);
      setGame(parsed);
      setPositions(replayed);
      setSgfTreeError(null);
      setCommentDraft(parentNode?.comment ?? "");

      let replayWarning = "";
      if (parentNode) {
        try {
          const replayRequest = beginTreeNodeReplay();
          const position = await replaySgfPositionAtNode(result.sgfText, parentNode.id);
          if (sgfTextEditVersionRef.current !== appliedVersion) return;
          if (treeNodeReplayRequestVersionRef.current === replayRequest) {
            setTreeNodePositionOverride(position);
            setCurrentMove(clampMoveNumberToPositions(replayed, position.move_number));
          }
        } catch (error) {
          if (sgfTextEditVersionRef.current !== appliedVersion) return;
          setTreeNodePositionOverride(null);
          setCurrentMove(clampMoveNumberToPositions(replayed, parentNode.move_number ?? 0));
          replayWarning = ` Parent position replay failed: ${errorMessage(error)}`;
        }
      } else {
        clearTreeNodePositionOverride();
        setCurrentMove(0);
      }

      setMessage(`Deleted ${formatSgfNodeLabel(node)} and its subtree from SGF.${replayWarning}`);
    } catch (error) {
      setMessage(`Delete node failed: ${errorMessage(error)}`);
    } finally {
      setIsNodeDeleting(false);
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function handleReorderSgfVariation(nodeId: string, targetIndex: number) {
    if (trial || trialBusy) { setMessage("请先退出或保存试下，再编辑原棋谱。"); return; }
    if (!selectedSgfNodeId) {
      setMessage("Select an SGF tree node before reordering variations.");
      return;
    }
    if (nodeId !== selectedSgfNodeId) {
      setMessage("Reorder cancelled because the selected SGF node changed.");
      return;
    }
    const node = sgfTree?.nodes.find((item) => item.id === nodeId) ?? null;
    if (!node) {
      setMessage("Reorder failed: selected SGF node was not found in the current tree.");
      return;
    }
    if (node.id === sgfTree?.root_id || node.parent_id === null || node.parent_id === undefined) {
      setMessage("Root SGF node cannot be reordered.");
      return;
    }
    const parentNode = sgfTree?.nodes.find((item) => item.id === node.parent_id) ?? null;
    const siblingIds = parentNode?.child_ids ?? [];
    const currentIndex = siblingIds.indexOf(node.id);
    if (!parentNode || currentIndex < 0 || siblingIds.length < 2 || targetIndex < 0 || targetIndex >= siblingIds.length || targetIndex === currentIndex) {
      setMessage("Reorder skipped: selected node has no valid sibling target.");
      return;
    }
    if (isBusy) return;

    const sgfTreeRequest = beginSgfTreeLoad();
    const sourceVersion = sgfTextEditVersionRef.current;
    const sourceText = sgfText;
    setIsNodeReordering(true);
    setMessage(`Moving ${formatSgfNodeLabel(node)} to variation ${targetIndex + 1}...`);
    try {
      const result = normalizeReorderSgfVariationResult(await callReorderSgfVariation(sourceText, nodeId, targetIndex));
      if (sgfTextEditVersionRef.current !== sourceVersion) {
        setMessage("Reorder variation cancelled because the SGF source changed while the edit was running.");
        return;
      }

      sgfTextEditVersionRef.current += 1;
      const appliedVersion = sgfTextEditVersionRef.current;
      setSgfText(result.sgfText);
      setDirty(true);
      clearReviewData();
      resetAnalysisCacheState();

      const [parsed, replayed, updatedTree] = await Promise.all([
        parseSgfSummary(result.sgfText),
        replaySgfPositions(result.sgfText),
        parseSgfTree(result.sgfText)
      ]);
      if (sgfTextEditVersionRef.current !== appliedVersion) return;

      const selectedNode = applySgfTreeSelectedNode(updatedTree, result.nodeId, sgfTreeRequest)
        ?? selectSgfTreeNodeForMove(updatedTree, currentMove);
      setGame(parsed);
      setPositions(replayed);
      setSgfTreeError(null);
      setCommentDraft(selectedNode?.comment ?? "");

      let replayWarning = "";
      if (selectedNode) {
        try {
          const replayRequest = beginTreeNodeReplay();
          const position = await replaySgfPositionAtNode(result.sgfText, selectedNode.id);
          if (sgfTextEditVersionRef.current !== appliedVersion) return;
          if (treeNodeReplayRequestVersionRef.current === replayRequest) {
            setTreeNodePositionOverride(position);
            setCurrentMove(clampMoveNumberToPositions(replayed, position.move_number));
          }
        } catch (error) {
          if (sgfTextEditVersionRef.current !== appliedVersion) return;
          setTreeNodePositionOverride(null);
          setCurrentMove(clampMoveNumberToPositions(replayed, selectedNode.move_number ?? replayed.at(-1)?.move_number ?? parsed.moves.length));
          replayWarning = ` Position replay failed: ${errorMessage(error)}`;
        }
      } else {
        clearTreeNodePositionOverride();
        setCurrentMove(clampMoveNumberToPositions(replayed, replayed.at(-1)?.move_number ?? parsed.moves.length));
      }

      setMessage(`Moved ${selectedNode ? formatSgfNodeLabel(selectedNode) : formatSgfNodeLabel(node)} to sibling position ${targetIndex + 1}. Variation 1 is the mainline.${replayWarning}`);
    } catch (error) {
      setMessage(`Reorder variation failed: ${errorMessage(error)}`);
    } finally {
      setIsNodeReordering(false);
      finishSgfTreeLoad(sgfTreeRequest);
    }
  }

  async function refreshSgfTree(text: string, targetMove: number, showLoading = true) {
    const requestVersion = beginSgfTreeLoad(showLoading);
    try {
      applySgfTree(await parseSgfTree(text), targetMove, requestVersion);
    } catch (error) {
      failSgfTreeLoad(error, requestVersion);
    } finally {
      finishSgfTreeLoad(requestVersion, showLoading);
    }
  }

  function beginSgfTreeLoad(showLoading = true): number {
    const requestVersion = sgfTreeRequestVersionRef.current + 1;
    sgfTreeRequestVersionRef.current = requestVersion;
    if (showLoading) {
      ++liveReviewSyncSeqRef.current; // Discard queued positions from the previous document.
      setIsSgfTreeLoading(true);
    }
    return requestVersion;
  }

  function finishSgfTreeLoad(requestVersion: number | null, showLoading = true) {
    if (!showLoading || requestVersion === null) return;
    if (sgfTreeRequestVersionRef.current === requestVersion) setIsSgfTreeLoading(false);
  }

  function failSgfTreeLoad(error: unknown, requestVersion: number | null) {
    if (requestVersion !== null && sgfTreeRequestVersionRef.current !== requestVersion) return;
    setSgfTree(null);
    setSelectedSgfNodeId(null);
    setCommentDraft("");
    setSgfTreeError(errorMessage(error));
  }

  function applySgfTree(tree: SgfTreeDto | null, targetMove: number, requestVersion?: number | null) {
    if (requestVersion !== undefined && requestVersion !== null && sgfTreeRequestVersionRef.current !== requestVersion) return;
    setSgfTree(tree);
    setSgfTreeError(null);
    const selectedNode = selectSgfTreeNodeForMove(tree, targetMove);
    setSelectedSgfNodeId(selectedNode?.id ?? tree?.root_id ?? null);
    setCommentDraft(selectedNode?.comment ?? "");
    setAnnotationError(null);
  }

  function applySgfTreeSelectedNode(tree: SgfTreeDto | null, nodeId: string, requestVersion?: number | null): SgfTreeNodeDto | null {
    if (requestVersion !== undefined && requestVersion !== null && sgfTreeRequestVersionRef.current !== requestVersion) return null;
    setSgfTree(tree);
    setSgfTreeError(null);
    const selectedNode = tree?.nodes.find((node) => node.id === nodeId) ?? null;
    setSelectedSgfNodeId(selectedNode?.id ?? tree?.root_id ?? null);
    setCommentDraft(selectedNode?.comment ?? "");
    setAnnotationError(null);
    return selectedNode;
  }

  function syncSelectedSgfNodeToMove(moveNumber: number, sourceTree = sgfTree) {
    const selectedNode = selectSgfTreeNodeForMove(sourceTree, moveNumber);
    if (!selectedNode) return;
    setSelectedSgfNodeId(selectedNode.id);
    setCommentDraft(selectedNode.comment ?? "");
    setAnnotationError(null);
  }

  function beginTreeNodeReplay(): number {
    const requestVersion = treeNodeReplayRequestVersionRef.current + 1;
    treeNodeReplayRequestVersionRef.current = requestVersion;
    return requestVersion;
  }

  function clearTreeNodePositionOverride() {
    treeNodeReplayRequestVersionRef.current += 1;
    setTreeNodePositionOverride(null);
  }

  function nextAnalysisSessionToken(): string {
    analysisSessionCounterRef.current += 1;
    return `review-session-${analysisSessionCounterRef.current}`;
  }

  function setReviewWorkflowProgress(progress: AnalysisProgress) {
    setReviewWorkflowStatus((status) => ({
      ...status,
      phase: "running",
      source: "katago",
      activeJobId: progress.jobId,
      message: `Analyzing move ${progress.turn}: ${progress.completed}/${progress.expected || "?"} positions complete.`,
      completed: progress.completed,
      expected: progress.expected,
      currentTurn: progress.turn,
      progressVerified: true
    }));
  }

  function markStaleAnalysisPrevented(jobId: string) {
    setReviewWorkflowStatus((status) => ({
      ...status,
      staleAnalysisPrevented: true,
      message: status.phase === "running" || status.phase === "starting"
        ? `${status.message} Ignored stale event from ${jobId}.`
        : `Ignored stale analysis event from ${jobId}.`
    }));
  }

  function cleanupAnalysisListeners() {
    analysisCleanupRef.current?.();
    analysisCleanupRef.current = null;
  }

  function isCurrentAnalysisJob(jobId: string): boolean {
    return activeJobIdRef.current === jobId;
  }

  async function finishPendingAnalysisTerminalEvent(jobId: string, event: PendingAnalysisTerminalEvent, parsed: GameDto, replayed: PositionDto[], sourceVersion: number) {
    if (event.kind === "complete") {
      await finishCompletedAnalysis(jobId, event.frames, parsed, replayed, sourceVersion);
      return;
    }
    finishStoppedAnalysis(jobId);
    setAnalysisProgress(null);
    if (event.kind === "error") {
      const message = engineFailureMessage(event.message);
      setReviewWorkflowStatus((status) => ({
        ...status,
        phase: "error",
        source: "katago",
        activeJobId: null,
        message,
        engineFailureVerified: true
      }));
      setMessage(message);
      return;
    }
    const message = event.message || "Full-game KataGo analysis cancelled. You can restart review when ready.";
    setReviewWorkflowStatus((status) => ({
      ...status,
      phase: "cancelled",
      source: "katago",
      activeJobId: null,
      message,
      cancelVerified: true
    }));
    setMessage(message);
  }

  async function finishCompletedAnalysis(jobId: string, result: AnalysisFrameDto[], parsed: GameDto, replayed: PositionDto[], sourceVersion: number) {
    try {
      const lastAnalyzedMove = result.at(-1)?.turn ?? replayed.at(-1)?.move_number ?? parsed.moves.length;
      const shownMove = clampMoveNumberToPositions(replayed, lastAnalyzedMove);
      const classified = await classifyProblems(result, sgfText);
      if (!isCurrentAnalysisJob(jobId) || sgfTextEditVersionRef.current !== sourceVersion) {
        if (isCurrentAnalysisJob(jobId)) finishStoppedAnalysis(jobId);
        return;
      }
      setGame(parsed);
      setPositions(replayed);
      setFrames(result);
      setProblems(classified);
      setCurrentMove(shownMove);
      setSelectedCandidateIndex(null);
      clearTreeNodePositionOverride();
      setAnalysisProgress((progress) => progress ? { ...progress, completed: progress.expected || result.length, expected: progress.expected || result.length } : progress);
      const cacheMessage = await saveAnalysisCacheForGame(sgfText, currentFilePath, parsed, result, classified, "katago");
      if (!isCurrentAnalysisJob(jobId) || sgfTextEditVersionRef.current !== sourceVersion) return;
      finishStoppedAnalysis(jobId);
      setReviewWorkflowStatus((status) => ({
        ...status,
        phase: "completed",
        source: "katago",
        activeJobId: null,
        message: `Full-game KataGo analysis completed with ${result.length} frames.`,
        completed: result.length,
        expected: Math.max(status.expected, result.length),
        currentTurn: shownMove,
        progressVerified: true
      }));
      setMessage(`Full-game KataGo analysis completed with ${result.length} frames. Showing move ${shownMove}.${cacheMessage}`);
    } catch (error) {
      if (isCurrentAnalysisJob(jobId)) {
        resumeAfterBatchRef.current = null;
        const message = `分析结果处理失败：${errorMessage(error)}`;
        setReviewWorkflowStatus(status => ({ ...status, phase: "error", activeJobId: null, message }));
        setMessage(message);
      }
    } finally {
      if (isCurrentAnalysisJob(jobId)) finishStoppedAnalysis(jobId);
    }
  }

  function finishStoppedAnalysis(jobId: string) {
    if (activeJobIdRef.current !== null && activeJobIdRef.current !== jobId) return;
    activeJobIdRef.current = null;
    setActiveJobId(null);
    setIsKataGoRunning(false);
    cleanupAnalysisListeners();
  }

  async function checkAnalysisCacheForGame(
    text: string,
    filePath: string | null,
    parsed: GameDto,
    replayed: PositionDto[],
    baseMessage: string,
    treeForSelection: SgfTreeDto | null = sgfTree
  ) {
    if (!preferences.autoLoadCache) {
      resetAnalysisCacheState();
      setMessage(`${baseMessage} Cache auto-load is off.`);
      return;
    }
    setCacheStatus("checking");
    setCacheRecord(null);
    setCacheError(null);
    try {
      const key = await computeGameCacheKey(text, filePath);
      setCurrentCacheKey(key);
      const lookup = await loadPreferredAnalysisCache(key.gameKey);
      if (lookup.status === "hit") {
        if (isTauriRuntime() && lookup.engineKind === "fake") {
          resetAnalysisCacheState();
          setMessage("棋谱已载入，等待 KataGo 分析当前局面。");
          return;
        }
        const payload = cachedAnalysisPayload(lookup.record.payload);
        if (!payload) {
          setCacheStatus("error");
          setCacheRecord(lookup.record);
          setCacheError("Cached payload is not compatible with this app version.");
          setMessage(`${baseMessage} ${cacheEngineLabel(lookup.engineKind)} cache hit, but the payload could not be restored.`);
          return;
        }
        setFrames(payload.frames);
        setProblems(payload.problems);
        const cachedMove = clampMoveNumberToPositions(replayed, payload.frames.at(-1)?.turn ?? parsed.moves.length);
        setCurrentMove(cachedMove);
        setSelectedCandidateIndex(null);
        setAnalysisProgress(null);
        setIsKataGoRunning(false);
        syncSelectedSgfNodeToMove(cachedMove, treeForSelection);
        setCacheStatus("hit");
        setCacheRecord(lookup.record);
        setReviewWorkflowStatus((status) => ({
          ...status,
          phase: "cache-restored",
          source: "cache",
          activeJobId: null,
          message: `Restored ${payload.frames.length} cached ${cacheEngineLabel(lookup.engineKind)} review frames.`,
          completed: payload.frames.length,
          expected: payload.frames.length,
          currentTurn: cachedMove,
          cacheRestoreVerified: true
        }));
        setMessage(`${baseMessage} Restored ${payload.frames.length} cached ${cacheEngineLabel(lookup.engineKind)} review frames.`);
        return;
      }
      if (lookup.status === "error") {
        setCacheStatus("error");
        setCacheRecord(null);
        setCacheError(lookup.message);
        setMessage(`${baseMessage} Cache unavailable: ${lookup.message}`);
        return;
      }
      setCacheStatus("miss");
      setCacheRecord(null);
      setMessage(`${baseMessage} No cached review yet.`);
    } catch (error) {
      const message = errorMessage(error);
      setCacheStatus("error");
      setCacheRecord(null);
      setCacheError(message);
      setCurrentCacheKey(null);
      setMessage(`${baseMessage} Cache unavailable: ${message}`);
    }
  }

  async function loadPreferredAnalysisCache(gameKey: string): Promise<AnalysisCacheLoadResult> {
    const katagoLookup = await loadAnalysisCache(gameKey, null, "katago");
    if (katagoLookup.status === "hit" && katagoLookup.record) return { status: "hit", record: katagoLookup.record, engineKind: "katago" };
    if (katagoLookup.status === "error") return { status: "error", message: katagoLookup.error ?? "KataGo cache lookup failed." };

    return { status: "miss" };
  }

  async function saveAnalysisCacheForGame(
    text: string,
    filePath: string | null,
    parsed: GameDto,
    analysisFrames: AnalysisFrameDto[],
    analysisProblems: ProblemMarkerDto[],
    engineKind: CacheEngineKind
  ): Promise<string> {
    if (!preferences.autoSaveAnalysis) {
      setCacheStatus("idle");
      return " Cache auto-save is off.";
    }
    setCacheStatus("saving");
    setCacheError(null);
    try {
      const key = currentCacheKey ?? await computeGameCacheKey(text, filePath);
      setCurrentCacheKey(key);
      const payload = { frames: analysisFrames, problems: analysisProblems } as unknown as JsonValue;
      const saved = await saveAnalysisCache({
        gameKey: key.gameKey,
        sgfHash: key.sgfHash,
        profileId: null,
        engineKind,
        source: engineKind,
        moveCount: parsed.summary.move_count,
        analyzedMoveCount: countAnalyzedMoves(analysisFrames, parsed.summary.move_count),
        payload
      });
      const record: AnalysisCacheRecord = {
        id: saved.id,
        gameKey: saved.gameKey,
        sgfHash: key.sgfHash,
        profileId: null,
        engineKind,
        source: engineKind,
        moveCount: parsed.summary.move_count,
        analyzedMoveCount: countAnalyzedMoves(analysisFrames, parsed.summary.move_count),
        payload,
        createdAt: saved.updatedAt,
        updatedAt: saved.updatedAt
      };
      setCacheStatus("saved");
      setCacheRecord(record);
      return " Cache saved.";
    } catch (error) {
      const message = errorMessage(error);
      setCacheStatus("error");
      setCacheError(message);
      return ` Cache save failed: ${message}`;
    }
  }

  function resetAnalysisCacheState() {
    setCacheStatus("idle");
    setCacheRecord(null);
    setCacheError(null);
    setCurrentCacheKey(null);
  }

  function clearReviewData() {
    setLiveFrames([]);
    setFrames([]);
    setProblems([]);
    setSelectedCandidateIndex(null);
    setAnalysisProgress(null);
    setCacheRecord(null);
  }

  async function callAppendSgfMove(sgfText: string, parentNodeId: string, color: PlayerColor, vertex: MoveVertex): Promise<unknown> {
    const appendSgfMove = (backendApi as unknown as { appendSgfMove?: AppendSgfMove }).appendSgfMove;
    if (!appendSgfMove) {
      throw new Error("appendSgfMove is not available yet. Bridge/Core needs to expose the SGF append API.");
    }
    return await appendSgfMove(sgfText, parentNodeId, color, vertex);
  }

  async function callEditSgfMove(sgfText: string, nodeId: string, color: PlayerColor, vertex: MoveVertex): Promise<unknown> {
    const editSgfMove = (backendApi as unknown as { editSgfMove?: EditSgfMove }).editSgfMove;
    if (!editSgfMove) {
      throw new Error("editSgfMove is not available yet. Bridge/Core needs to expose the SGF edit API.");
    }
    return await editSgfMove(sgfText, nodeId, color, vertex);
  }

  async function callDeleteSgfNode(sgfText: string, nodeId: string): Promise<unknown> {
    const deleteSgfNode = (backendApi as unknown as { deleteSgfNode?: DeleteSgfNode }).deleteSgfNode;
    if (!deleteSgfNode) {
      throw new Error("deleteSgfNode is not available yet. Bridge/Core needs to expose the SGF delete API.");
    }
    return await deleteSgfNode(sgfText, nodeId);
  }

  async function callReorderSgfVariation(sgfText: string, nodeId: string, targetIndex: number): Promise<unknown> {
    const reorderSgfVariation = (backendApi as unknown as { reorderSgfVariation?: ReorderSgfVariation }).reorderSgfVariation;
    if (!reorderSgfVariation) {
      throw new Error("reorderSgfVariation is not available yet. Bridge/Core needs to expose the SGF reorder API.");
    }
    return await reorderSgfVariation(sgfText, nodeId, targetIndex);
  }

  const sgfTreeDeleteProps = {
    onDeleteNode: (nodeId: string) => void handleDeleteSgfNode(nodeId),
    isNodeDeleting,
    canDelete: canDeleteSgfNode
  };

  const sgfTreeReorderProps = {
    onReorderNode: (nodeId: string, targetIndex: number) => void handleReorderSgfVariation(nodeId, targetIndex),
    isNodeReordering,
    canReorder: !isBusy
  };
  const runtimeSource = backendApi.frontendRuntimeSource();
  const tauriRuntimeObserved = runtimeSource === "tauri";
  const backendAvailability = health === null
    ? "checking"
    : tauriRuntimeObserved && health.rust_backend_ready
      ? "available"
      : tauriRuntimeObserved
        ? "tauri-backend-unavailable"
        : "browser-fallback";
  const backendAvailable = backendAvailability === "available";
  const sgfWorkflowState = sgfTreeError
    ? "parse-error"
    : isSgfTreeLoading
      ? "loading-tree"
      : dirty
        ? "dirty"
        : currentFilePath
          ? "opened-saved"
          : fallbackFileName
            ? "imported"
            : sgfTree
              ? "sample-ready"
              : "source-editing";
  const sgfWorkflowLabel = sgfTreeError
    ? `SGF 错误: ${sgfTreeError}`
    : `${documentName}: 共 ${game.summary.move_count} 手, 当前第 ${currentMove} 手, ${dirty ? "未保存" : "已保存"}。`;

  return (
    <LegacyShell onPrepareSetup={async () => {
        if (isBusy || trial) throw new Error('请先结束当前编辑或批量任务。');
        await cloud.disconnect();
        await stopCurrentLiveSession();
        setMessage('引擎已停止，可以配置模型。');
      }} setupDisabled={isBusy || liveReview !== null || fullReview.busyRef.current || researchQueue.busyRef.current || cloud.connected || !!trial}
      analysisShortcuts={<AnalysisShortcuts source={analysisSource}
        cloudPanel={<CloudComputePanel reconnectStatus={cloud.reconnectStatus} connected={cloud.connected} busy={cloud.busy} onConnect={cloud.connect} onDisconnect={cloud.disconnect} />}
        disabled={isBusy || !!trial || trialBusy || isSgfTreeLoading || fullReview.busyRef.current || fullReview.progress.status === 'paused' || researchQueue.busyRef.current || cloud.busy}
        quickBusy={backgroundCurve.busy} onQuick={() => backgroundCurve.start()} onCancelQuick={backgroundCurve.cancel}
        onSwitch={async source => {
          if (source === analysisSource && liveReviewRef.current) return;
          if (source === 'cloud') { await cloud.connect(); return; }
          const settings = await loadEngineProfilesSettings();
          const profile = (settings.profiles.find(p => p.id === settings.selected_profile_id) ?? settings.profiles[0])?.profile;
          if (!profile?.engine_path) throw new Error('请先在一键设置中安装或选择本地引擎。');
          await cloud.disconnect(); await stopCurrentLiveSession(); cloud.selectLocal();
          await handleToggleLiveReview(profile);
        }}>
        <FullGameReviewControls controller={fullReview} maxTurn={maxTreeMove} connected={!!liveReview && !trial && !researchQueue.busyRef.current} />
      </AnalysisShortcuts>}
      onToggleLiveReview={toggleSelectedLiveReview}
      isLiveReviewActive={liveReviewEnabled || (recordedPreview && replayRunning)}
      isRecordedPreview={recordedPreview}
      liveReviewStatus={recordedPreview ? "真实结果回放 · 非实时" : cloud.busy ? "云算力请求处理中…" : liveStarting ? "引擎启动中…" : fullReview.busyRef.current ? `全盘补算 · 第 ${fullReview.progress.turn} 手 · ${fullReview.progress.completed}/${fullReview.progress.total}` : fullReview.progress.status === "paused" ? "全盘补算已暂停" : liveReviewEnabled ? `${analysisSource === "cloud" ? "智子云 VIP · " : analysisSource === "ssh" ? "SSH 远程 · " : "本地 · "}${currentFrame?.visits.toLocaleString() ?? "等待"} 次 · ${searchSpeed.visitsPerSecond === null ? "—" : Math.round(searchSpeed.visitsPerSecond).toLocaleString()} 次/秒 · ${Math.floor(searchSpeed.elapsedSeconds)}秒` : isTauriRuntime() ? "分析已暂停" : "浏览器预览"}
      themeClassName={preferences.boardTheme === "high-contrast" ? "theme-high-contrast" : ""}
      architectureLabel={health?.architecture ?? "Tauri 2 + React 围棋复盘工作区"}
      backendStatusLabel={health?.rust_backend_ready ? "Rust 后端就绪" : "浏览器回退模式"}
      cacheBadge={recordedPreview ? <span>回放样例 · KataGo 1.18.2</span> : liveReviewEnabled || liveFrames.length > 0 ? <span>{analysisSource === "cloud" ? "智子云 VIP" : analysisSource === "ssh" ? "SSH KataGo" : "本地 KataGo"} · 实时结果</span> :
        <CacheStatusBadge
          status={cacheStatus}
          record={cacheRecord}
          error={cacheError}
          cacheRestoreVerified={reviewWorkflowStatus.cacheRestoreVerified}
        />
      }
      board={
        <BoardCanvas
                showCandidates={preferences.showCandidates && !humanGame.hideHints}
          tree={trial?.tree ?? sgfTree}
          selectedNodeId={trial?.node_id ?? selectedSgfNodeId}
          onDragStone={!trial && !humanGame.active ? (from,to)=>{if(sgfTree && selectedSgfNodeId)void dragStone(sgfText,sgfTree,selectedSgfNodeId,from,to,currentPosition.board_size).then(text=>commitDocument({sgfText:text,nodeId:selectedSgfNodeId,newDocument:false})).catch(error=>setMessage(errorMessage(error)));} : undefined}
          allowOccupied={boardTool.startsWith("setup-")}
          position={currentPosition}
          analysis={humanGame.hideHints ? undefined : visibleCurrentFrame}
          selectedCandidateIndex={selectedCandidateIndex}
          canEdit={(humanGame.active ? humanGame.state?.phase === "human" : !isBusy && !trialBusy) && selectedSgfNodeId !== null}
          editColor={trial || humanGame.active ? currentPosition.to_play : editColor}
          onPlayPoint={(point) => void playBoardPoint(point)}
          controls={<div className={`trial-controls${trial || humanGame.active ? " is-active" : ""}`} aria-label="试下控制">
            {humanGame.active ? <><span>{humanGame.state?.status}</span><HumanGameControls controller={humanGame} disabled={false}/></> : trial ? <>
              <span>试下 · 第 {currentPosition.move_number} 手</span>
              <button disabled={trialBusy} onClick={() => void playTrial("pass")}>停一手</button>
              <button disabled={trialBusy} onClick={() => void finishTrial(true)}>保存变化</button>
              <button disabled={trialBusy} onClick={() => void finishTrial(false)}>取消试下</button>
            </> : <button disabled={isBusy || trialBusy || !selectedSgfNodeId} onClick={() => void beginTrial()}>试下</button>}
          </div>}
        />
      }
      playbackControls={<><button aria-label={autoplay.playing ? "暂停逐手播放" : "逐手播放棋谱"} aria-pressed={autoplay.playing} disabled={isBusy || !!trial || !selectedSgfNode?.child_ids.length} onClick={autoplay.toggle}>{autoplay.playing ? 'Ⅱ' : '▶'}</button><select aria-label="逐手播放间隔" value={autoplay.seconds} onChange={e=>autoplay.setSeconds(Number(e.target.value))}>{[.5,1,2,3,5].map(n=><option key={n} value={n}>{n} 秒/手</option>)}</select></>}
      documentTools={<DocumentTools sgfText={sgfText} tree={sgfTree} position={currentPosition} disabled={isBusy || !!trial}
        onCommit={commitDocument} boardTool={boardTool} onBoardToolChange={setBoardTool}
        canUndo={documentHistory.canUndo} canRedo={documentHistory.canRedo} onUndo={documentHistory.undo} onRedo={documentHistory.redo}
        recentDocuments={recentDocuments.documents} onOpenRecent={handleOpenSgfDocument} onRemoveRecent={recentDocuments.remove}/>}
      humanGameControls={<HumanGameControls controller={humanGame} disabled={isBusy || !!trial}/>}
      gameControls={<GameRulesControls rules={game.summary.rules} komi={game.summary.komi} disabled={isBusy || !!trial || trialBusy || !sgfTree} onApply={async (rules, komi) => {
        if (!sgfTree) return;
        const saved = await handleSaveProperties(sgfTree.root_id, [{ key: "RU", values: [rules] }, { key: "KM", values: [String(komi)] }]);
        if (!saved) throw new Error("规则与贴目未保存，请查看状态提示后重试。");
      }} />}
      chart={humanGame.hideHints ? <p className="human-game-notice">对弈期间隐藏复盘提示，结束后可查看走势和测评。</p> :
        <AnalysisModules
          statistics={{ documentKey: sgfText, tree: sgfTree, selectedNodeId: selectedSgfNodeId, frames: metricFrames }}
          onNodeSelect={(nodeId) => void handleSgfTreeNodeSelect(nodeId)}
          frames={effectiveFrames}
          onMoveSelect={handleMoveSelect}
          currentMove={currentMove}
          reviewSource={liveReviewEnabled ? "katago" : reviewWorkflowStatus.source}
          reviewPhase={liveReviewEnabled ? "running" : reviewWorkflowStatus.phase}
          cacheRestoreVerified={reviewWorkflowStatus.cacheRestoreVerified}
        />
      }
      analysisPanel={humanGame.hideHints ? <div className="human-game-notice"><h2>人机对弈</h2><p>{humanGame.state?.status}</p><HumanGameControls controller={humanGame} disabled={false}/></div> :
          <AnalysisPanel
            showCandidates={preferences.showCandidates && !humanGame.hideHints}
            onShowCandidatesChange={showCandidates => void handlePreferencesChange({...preferences, showCandidates})}
            searchRate={recordedPreview || fullReview.busyRef.current || !liveReviewEnabled ? null : searchSpeed.visitsPerSecond}
            lastMoveMetrics={calculatePositionMetrics({ documentKey: trial?.sgf_text ?? sgfText, tree: trial?.tree ?? sgfTree, selectedNodeId: trial?.node_id ?? selectedSgfNodeId, frames: metricFrames })}
            frame={visibleCurrentFrame}
            blackName={game.summary.black_name ?? "黑方"}
            whiteName={game.summary.white_name ?? "白方"}
            problems={liveReviewEnabled || liveFrames.length > 0 ? [] : problems}
            boardSize={game.summary.board_size}
            currentMove={currentMove}
            selectedCandidateIndex={selectedCandidateIndex}
            onSelectCandidate={setSelectedCandidateIndex}
            onSelectProblem={handleMoveSelect}
            reviewSource={recordedPreview ? "recorded" : liveReviewEnabled || liveFrames.length > 0 ? "katago" : reviewWorkflowStatus.source}
            reviewPhase={liveReviewEnabled ? "running" : liveFrames.length > 0 ? "paused" : reviewWorkflowStatus.phase}
            cacheRestoreVerified={reviewWorkflowStatus.cacheRestoreVerified}
          />
      }
      treePanel={
          <SgfTreePanelWithMoveEdit
            tree={sgfTree}
            selectedNodeId={selectedSgfNodeId}
            currentMove={currentMove}
            boardSize={game.summary.board_size}
            isLoading={isSgfTreeLoading}
            parseError={sgfTreeError}
            commentDraft={commentDraft}
            onCommentDraftChange={setCommentDraft}
            onSelectNode={(nodeId) => void handleSgfTreeNodeSelect(nodeId)}
            onSaveComment={(nodeId, comment) => void handleSaveComment(nodeId, comment)}
            onSaveProperties={(nodeId, updates) => void handleSaveProperties(nodeId, updates)}
            onSaveAnnotations={(nodeId, updates) => void handleSaveAnnotations(nodeId, updates)}
            isCommentSaving={isCommentSaving}
            isPropertySaving={isPropertySaving}
            isAnnotationSaving={isAnnotationSaving}
            annotationError={annotationError}
            commentActionLabel="保存备注"
            commentNote="保存会将选定节点的备注写入 SGF 文本中。开启实时分析后，候选点、胜率和热力图随选中的分支局面更新。"
            moveEditMode={sgfMoveEditMode}
            canEditSelectedMove={canEditSelectedMove}
            onMoveEditModeChange={setSgfMoveEditMode}
            onEditSelectedMovePass={() => void handleEditExistingMove("pass")}
            {...sgfTreeDeleteProps}
            {...sgfTreeReorderProps}
          />
      }
      providerPanel={
        <div className="sgf-edit-provider-stack">
          <section className="sgf-edit-panel" aria-label="SGF move editing" data-testid="sgf-move-edit-panel">
            <div className="sgf-edit-header">
              <strong>{sgfMoveEditMode === "append" ? "追加落子" : "修改选点"}</strong>
              <span>{editColor === "black" ? "黑先" : "白先"}{sgfMoveEditMode === "append" ? "落子" : "修改"}</span>
            </div>
            <div className="sgf-edit-controls" aria-label="Move edit mode">
              <button type="button" data-testid="sgf-move-mode-append" aria-pressed={sgfMoveEditMode === "append"} disabled={isBusy} onClick={() => setSgfMoveEditMode("append")}>追加</button>
              <button type="button" data-testid="sgf-move-mode-edit" aria-pressed={sgfMoveEditMode === "edit"} disabled={isBusy} onClick={() => setSgfMoveEditMode("edit")}>修改</button>
            </div>
            <div className="sgf-edit-controls" aria-label="Move color">
              <button type="button" data-testid="sgf-move-color-black" aria-pressed={editColor === "black"} disabled={isBusy} onClick={() => setEditColor("black")}>黑</button>
              <button type="button" data-testid="sgf-move-color-white" aria-pressed={editColor === "white"} disabled={isBusy} onClick={() => setEditColor("white")}>白</button>
              <button type="button" data-testid="sgf-move-pass" disabled={isBusy || selectedSgfNodeId === null} onClick={() => handleMoveEditInput("pass")}>停一手 (Pass)</button>
            </div>
          </section>
          <ProviderPanel disabled={isBusy} onImport={handleProviderImport} />
        </div>
      }
      enginePanel={
        <>
          <section
            className="analysis-progress"
            aria-label="Installed app runtime proof"
            data-testid="installed-app-runtime-proof"
            data-runtime-source={runtimeSource}
            data-tauri-runtime-observed={String(tauriRuntimeObserved)}
            data-browser-fallback-used={String(!tauriRuntimeObserved)}
            data-backend-availability={backendAvailability}
            data-backend-available={String(backendAvailable)}
            data-sgf-workflow-state={sgfWorkflowState}
            data-sgf-tree-loaded={String(Boolean(sgfTree))}
            data-sgf-tree-loading={String(isSgfTreeLoading)}
            data-sgf-tree-error={sgfTreeError ?? ""}
            data-sgf-current-move={currentMove}
            data-sgf-max-move={maxMove}
            data-sgf-dirty={String(dirty)}
          >
            <strong data-testid="runtime-source" data-runtime-source={runtimeSource}>
              {tauriRuntimeObserved ? "Tauri 运行时" : "浏览器预览"}
            </strong>
            <span data-testid="backend-availability" data-backend-availability={backendAvailability}>
              {backendAvailable ? "后端已就绪" : tauriRuntimeObserved ? "后端未就绪" : "浏览器回退，无 Tauri 后端"}
            </span>
            <span data-testid="sgf-workflow-state" data-sgf-workflow-state={sgfWorkflowState}>
              {sgfWorkflowLabel}
            </span>
          </section>
          <ResearchQueuePanel onQuickCurve={profile => void backgroundCurve.start(profile)} curveBusy={backgroundCurve.busy} controller={researchQueue} current={{id:"current",name:documentName,sgfText,documentKey:sgfText}} disabled={!!trial || cloud.busy || liveStarting || isKataGoRunning}/>
          <RemoteEnginePanel disabled={isBusy || !!trial} onConnect={connectRemoteEngine}/>
          <GtpConsole disabled={!liveReview || fullReview.busyRef.current || isBusy}/>
          <CloudComputePanel reconnectStatus={cloud.reconnectStatus} connected={cloud.connected} busy={cloud.busy} onConnect={cloud.connect} onDisconnect={cloud.disconnect} />
          <label><input type="checkbox" checked={autoFillHistory} disabled={analysisSource !== "local"} onChange={event => setAutoFillHistory(event.target.checked)} />本地自动生成 1v 走势（默认关闭）</label>
          <button disabled={backgroundCurve.busy || !!trial} onClick={() => void backgroundCurve.start()}>本地后台 1v 生成曲线</button>
          {backgroundCurve.busy && <button onClick={() => void backgroundCurve.cancel()}>取消后台补线</button>}
          <p role="status">{backgroundCurve.status}</p>
          <p className="statistics-note">远程连接后只分析当前局面，使用远程配置。后台补线使用独立本地配置和 1 个搜索线程，完成即退出，不暂停实时分析。</p>
          <FullGameReviewControls controller={fullReview} maxTurn={maxTreeMove} connected={!!liveReview && !trial && !researchQueue.busyRef.current} />
          <EngineSearchControls key={analysisSource} serverConfig={analysisSource !== "local"} value={searchOptions} onChange={setSearchOptions}
            cloud={cloud.source === "cloud"} disabled={!liveReview || isBusy || fullReview.busyRef.current}
            onApplyParameters={applyEngineParameters} />
          <EngineSetupPanel hideLegacyReview
            disabled={isBusy || cloud.connected || !!trial || trialBusy}
            onAnalyzeGame={handleAnalyzeKataGoGame}
            onCancelAnalysis={handleCancelKataGoAnalysis}
            onToggleLiveReview={handleToggleLiveReview}
            isLiveReviewActive={analysisSource === "local" && liveReview !== null}
            analysisProgress={analysisProgress}
            activeJobId={activeJobId}
            reviewWorkflow={reviewWorkflowStatus}
          />
        </>
      }
      preferencesPanel={
        <PreferencesPanel
          preferences={preferences}
          status={preferencesStatus}
          disabled={isBusy}
          onChange={(nextPreferences) => void handlePreferencesChange(nextPreferences)}
          legacyConfigPath={legacyConfigPath}
          legacyConfigStatus={legacyConfigStatus}
          legacyConfigPreview={legacyConfigPreview}
          legacyConfigApplyResult={legacyConfigApplyResult}
          isLegacyConfigMigrating={isLegacyConfigMigrating}
          onLegacyConfigPathChange={handleLegacyConfigPathChange}
          onPreviewLegacyConfigMigration={() => void handlePreviewLegacyConfigMigration()}
          onApplyLegacyConfigMigration={() => void handleApplyLegacyConfigMigration()}
        />
      }
      documentName={documentName}
      documentTitle={currentFilePath ?? documentName}
      dirty={dirty}
      sgfText={sgfText}
      currentMove={currentMove}
      maxMove={maxMove}
      message={message}
      isBusy={isBusy || !!trial || trialBusy}
      canSave={dirty}
      onlineKifu={<OnlineKifuImport disabled={isBusy || !!trial} documentKey={sgfText} onImport={async result => { if (dirty && !window.confirm("当前棋谱尚未保存，是否放弃修改并导入在线棋谱？")) return false; await handleProviderImport(result); return true; }} />}
      onOpen={handleOpenSgfDocument}
      onSave={() => handleSaveSgfDocument(false)}
      onSaveAs={() => handleSaveSgfDocument(true)}
      onImportFile={handleImportFile}
      onLoadSample={loadSample}
      onParseSgf={handleParseSgf}
      onRunReview={handleSelectedGameAnalysis}
      onSgfTextChange={(value) => {
        sgfTextEditVersionRef.current += 1;
        sgfTreeRequestVersionRef.current += 1;
        setSgfText(value);
        setDirty(true);
        clearTreeNodePositionOverride();
        clearReviewData();
        resetAnalysisCacheState();
        setIsSgfTreeLoading(false);
        setSgfTree(null);
        setSelectedSgfNodeId(null);
        setCommentDraft("");
        setSgfTreeError(null);
        setCurrentMove(0);
        setMessage("SGF edited. Parse SGF or run review to refresh.");
      }}
      onMoveChange={handleMoveSelect}
    />
  );
}

function applyPreferencesToFrame(frame: AnalysisFrameDto | undefined, preferences: AppPreferences): AnalysisFrameDto | undefined {
  if (!frame) return undefined;
  return {
    ...frame,
    candidates: frame.candidates.slice(0, preferences.candidateLimit),
    ownership: preferences.showOwnership ? frame.ownership : null,
    policy: preferences.showPolicy ? frame.policy : null
  };
}

function resolveAnalysisMaxVisits(requestedMaxVisits: number | null | undefined, preferences: AppPreferences): number {
  if (typeof requestedMaxVisits === "number" && Number.isFinite(requestedMaxVisits) && requestedMaxVisits > 0) {
    return Math.floor(requestedMaxVisits);
  }
  return preferences.reviewMode === "deep" ? preferences.defaultMaxVisits * 2 : preferences.defaultMaxVisits;
}

function cachedAnalysisPayload(payload: JsonValue): CachedAnalysisPayload | null {
  if (!isJsonObject(payload)) return null;
  if (!Array.isArray(payload.frames) || !Array.isArray(payload.problems)) return null;
  return {
    frames: payload.frames as unknown as AnalysisFrameDto[],
    problems: payload.problems as unknown as ProblemMarkerDto[]
  };
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeAnalysisFrame(frames: AnalysisFrameDto[], frame: AnalysisFrameDto): AnalysisFrameDto[] {
  return [...frames.filter((item) => item.turn !== frame.turn), frame].sort((a, b) => a.turn - b.turn);
}

/**
 * GTP 坐标字符串。列 A-T **跳过 I**，行号 1-based 且从棋盘底部起算；虚手（pass）原样返回 "pass"。
 *
 * `domain/board.ts` 的 `vertexLabel` 产出的正是这套坐标（同一字母表、同一行号方向），
 * 但它是为显示而写的：越界时返回 "?"。GTP 命令里 "?" 非法，且棋谱中的虚手若被丢弃会让
 * 后续 `play` 序列整体错位，因此这里单独处理 pass 与越界，返回合法的 "pass"。
 */
function gtpCoordinate(vertex: MoveVertex, boardSize: number): string {
  if (!isPoint(vertex)) return "pass";
  const { x, y } = vertex.point;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= boardSize || y >= boardSize) {
    return "pass";
  }
  const letters = "ABCDEFGHJKLMNOPQRSTUVWXYZ";
  const column = letters[x];
  if (!column) return "pass";
  return `${column}${boardSize - y}`;
}

/** 把棋谱前 `targetMove` 手展开成 plan 006 `set_position` 需要的扁平 GTP 序列：["B","D4","W","Q16",...]。 */
function buildLiveReviewMoves(positions: PositionDto[], targetMove: number, boardSize: number): string[] {
  return positions
    .filter((item) => item.move_number > 0 && item.move_number <= targetMove && item.last_move)
    .flatMap((item) => {
      const move = item.last_move;
      if (!move) return [];
      return [move.color === "black" ? "B" : "W", gtpCoordinate(move.vertex, boardSize)];
    });
}

/**
 * 前端的第二道陈旧性防线（判据本体）。
 *
 * Rust 侧（plan 006）已在转发线程里按世代号丢弃陈旧行，但事件到达与 React 状态更新之间
 * 存在异步间隙：用户切手后，已排队的旧事件仍会送达。这里用 payload 的三个维度再校验一次，
 * 任一不匹配即丢弃，避免旧手的帧被渲染到新手的棋盘上（比 plan 002 修的问题更隐蔽，因为数据在动）。
 *
 * `onFrame` 内联了同样的三个判断（便于逐点核对），本函数是其可复用的等价形式。
 */
function acceptsLiveReviewFrame(
  current: LiveReviewState | null,
  payload: { job_id: string; generation: number; turn: number }
): boolean {
  if (!current) return false;
  if (payload.job_id !== current.jobId) return false;
  if (payload.generation !== current.generation) return false;
  return payload.turn === current.turn;
}

function countAnalyzedMoves(frames: AnalysisFrameDto[], moveCount: number): number {
  const turns = new Set(frames.map((frame) => frame.turn).filter((turn) => turn > 0 && turn <= moveCount));
  return turns.size;
}

function selectSgfTreeNodeForMove(tree: SgfTreeDto | null, moveNumber: number): SgfTreeNodeDto | null {
  if (!tree) return null;
  if (moveNumber <= 0) return tree.nodes.find((node) => node.id === tree.root_id) ?? null;
  const candidates = tree.nodes.filter((node) => node.move_number === moveNumber);
  return candidates.find((node) => node.is_mainline) ?? candidates[0] ?? null;
}

function formatSgfNodeLabel(node: SgfTreeNodeDto): string {
  if (node.move_number === null || node.move_number === undefined) return "root";
  const line = node.is_mainline ? "mainline" : `variation ${node.variation_index + 1}`;
  return `${line} move ${node.move_number}`;
}

function normalizeAppendSgfMoveResult(result: unknown): { sgfText: string; newNodeId: string } {
  if (!isUnknownRecord(result)) throw new Error("appendSgfMove returned an invalid response.");
  const sgfText = typeof result.sgfText === "string" ? result.sgfText : typeof result.sgf_text === "string" ? result.sgf_text : null;
  const newNodeId = typeof result.newNodeId === "string" ? result.newNodeId : typeof result.new_node_id === "string" ? result.new_node_id : null;
  if (!sgfText || !newNodeId) throw new Error("appendSgfMove response must include sgfText and newNodeId.");
  return { sgfText, newNodeId };
}

function normalizeEditSgfMoveResult(result: unknown): { sgfText: string; nodeId: string } {
  if (!isUnknownRecord(result)) throw new Error("editSgfMove returned an invalid response.");
  const sgfText = typeof result.sgfText === "string" ? result.sgfText : typeof result.sgf_text === "string" ? result.sgf_text : null;
  const nodeId = typeof result.nodeId === "string" ? result.nodeId : typeof result.node_id === "string" ? result.node_id : null;
  if (!sgfText || !nodeId) throw new Error("editSgfMove response must include sgfText and nodeId.");
  return { sgfText, nodeId };
}

function normalizeDeleteSgfNodeResult(result: unknown): { sgfText: string; parentNodeId: string } {
  if (!isUnknownRecord(result)) throw new Error("deleteSgfNode returned an invalid response.");
  const sgfText = typeof result.sgfText === "string" ? result.sgfText : typeof result.sgf_text === "string" ? result.sgf_text : null;
  const parentNodeId = typeof result.parentNodeId === "string"
    ? result.parentNodeId
    : typeof result.parent_node_id === "string"
      ? result.parent_node_id
      : null;
  if (!sgfText || !parentNodeId) throw new Error("deleteSgfNode response must include sgfText and parentNodeId.");
  return { sgfText, parentNodeId };
}

function normalizeReorderSgfVariationResult(result: unknown): { sgfText: string; nodeId: string; parentNodeId: string } {
  if (!isUnknownRecord(result)) throw new Error("reorderSgfVariation returned an invalid response.");
  const sgfText = typeof result.sgfText === "string" ? result.sgfText : typeof result.sgf_text === "string" ? result.sgf_text : null;
  const nodeId = typeof result.nodeId === "string" ? result.nodeId : typeof result.node_id === "string" ? result.node_id : null;
  const parentNodeId = typeof result.parentNodeId === "string"
    ? result.parentNodeId
    : typeof result.parent_node_id === "string"
      ? result.parent_node_id
      : null;
  if (!sgfText || !nodeId || !parentNodeId) throw new Error("reorderSgfVariation response must include sgfText, nodeId, and parentNodeId.");
  return { sgfText, nodeId, parentNodeId };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function colorLabel(color: PlayerColor): string {
  return color === "black" ? "Black" : "White";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function engineFailureMessage(error: unknown): string {
  return `KataGo analysis failed: ${errorMessage(error)}. Check the engine, model, config paths, run Check assets, then start again.`;
}

function legacyConfigApplyFailureSummary(result: backendApi.LegacyConfigMigrationApplyDto): string {
  const reason = result.errorMessage?.trim() || "legacy config migration failed";
  const noWrite = result.noWriteOnError ? "no writes performed on error" : "write state may require inspection";
  const rollback = result.rollbackPerformed
    ? result.rollbackSucceeded
      ? "rollback succeeded"
      : "rollback failed"
    : "rollback not needed";
  return `${reason}; ${noWrite}; ${rollback}.`;
}

function legacyConfigApplySuccessSummary(result: backendApi.LegacyConfigMigrationApplyDto): string {
  const transactional = result.transactional ? "transactional apply" : "non-transactional apply";
  const writtenCount = result.writtenPathLabels.length;
  const written = writtenCount === 1 ? "1 target written" : `${writtenCount} targets written`;
  return `${transactional}; ${written}.`;
}

function cacheEngineLabel(engineKind: CacheEngineKind): string {
  return engineKind === "katago" ? "KataGo" : "fake";
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
