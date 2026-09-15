# Plan 007: 前端实时复盘 UX（胜率实时刷新）

> **已按 `plans/GTP_LIVE_PROBE_FINDINGS.md` 修订（2026-09-13）**：**明确 `kata-analyze` 必须带 `ownership true`**（实测默认不输出，否则底部热力概览恒为空）；明确前端**不得**对 `winrate_black` 做视角二次转换（plan 005 已转好，且引擎已由 plan 003 的 `-override-config` 固定黑视角）；明确 `player`（轮谁走）≠ 视角；移除「本机未安装 KataGo」的过时描述（现已可用）；更新 Drift check 基底。
>
> **Executor instructions**: 按步骤执行，每步先跑验证命令、确认预期结果再进入下一步。若出现 "STOP conditions" 中的任一情况，停止并报告，不要即兴发挥。完成后更新 `plans/README.md` 中本计划的状态行。
>
> **Drift check（先跑）**: `git diff --stat b7f33a2..HEAD -- apps/desktop/src/App.tsx apps/desktop/src/domain/types.ts apps/desktop/src/components/EngineSetupPanel.tsx apps/desktop/src/components/PreferencesPanel.tsx`
> **基底说明（已更新）**：工作树 HEAD 已推进到 **`92dcfe8`**，且含一次 **UI 重构提交 `d1d18df`（界面中文化 + 布局重设计）**，它大幅改动了 `App.tsx` 与 `EngineSetupPanel.tsx`（后者现为 **526 行**，原摘录写 341 行）。**因此本计划 "Current state" 的行号与摘录可能已与现网不符——以现网代码为准**，不要因行号对不上而判 STOP。唯一要确认的硬前提是 plan 002 的改动存在：`App.tsx` 的帧选取是 `frames.find((f) => f.turn === currentMove)` 且**没有** `?? frames.at(-1)` 回退（实测仍在 `:204`）。

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-drop-stale-frame-fallback.md, plans/006-realtime-review-commands.md
- **Category**: direction（新能力：实时续析 UX）
- **Planned at**: commit `b7f33a2`, 2026-09-12
- **Revised**: 2026-09-13，按 `plans/GTP_LIVE_PROBE_FINDINGS.md` 实测规格修订（见顶部说明）

## Why this matters

plan 006 已经让 Rust 侧能跑长驻 GTP 会话并推送 `katago://live-review-frame` 事件，但前端还没接线。本计划把这条链路接上，交付**实时复盘**这一核心体验：用户点某一手，胜率/候选点/归属热图**持续刷新**并随搜索深入而收敛，而不是等一次性算完。

这正是 Java 主线的核心价值（`kata-analyze` 流式 + 图形实时重绘），也是本仓库当前完全缺失的部分。

**本计划的关键设计决策：在 `currentMove` 上挂一个 `useEffect`，而不是在 33 个 `setCurrentMove` 调用点各插一次。**

`apps/desktop/src/App.tsx` 有 **33 处** `setCurrentMove(...)`（`grep -n 'setCurrentMove('` 的结果），分散在 SGF 加载、树节点导航、缓存恢复、文件导入、抽样加载等路径里。逐个插桩既不可维护也必然会漏。以 `currentMove` 为唯一真相源、用 effect 响应变化，是唯一可靠的接法。

**必须处理的两个正确性风险**：

1. **陈旧帧**：plan 002 刚移除了"回退到最后一帧"的错误行为。实时复盘若不做世代校验，会把旧手的流式帧渲染到新手上——比 plan 002 修的问题更隐蔽（因为数据在动）。
2. **陈旧性双保险**：Rust 侧（plan 006）已按世代号丢弃陈旧行；前端**还应**用事件 payload 里的 `generation`/`turn` 再校验一次，因为事件到达与 React 状态更新之间存在异步间隙。

**第三个必须遵守的约定（新增）**：

3. **不要做视角转换**。`kata-analyze` 报的是**走棋方视角**，plan 005 的 `kata_analyze_line_to_frame` 已在产出帧时把它转成**黑视角**（见 plan 005 Step 3b），plan 006 的 payload 注释也声明了这一点。因此 `payload.frame.winrate_black` / `score_mean_black` **拿到就是黑视角**，前端**直接渲染**。
   - **禁止**在 `onFrame` 里写 `1 - winrate_black` 或任何按 `payload.to_play` 的翻折逻辑——那会造成**二次转换**，白走局的胜率会再次反向。
   - `payload.to_play` **仅作元数据**（显示"轮谁走"等），不参与数值计算。
   - 之所以强调：批处理路径（`katago_analyze_game`）的帧也是黑视角，两条路径的帧最终**汇入同一个 `frames` 数组**（`mergeAnalysisFrame`）。若实时帧是走棋方视角，同一数组里就会混着两种视角的帧，图表会出现无法解释的跳变。
   - 验收：`grep -n '1.0 -\|1.0-' apps/desktop/src` **无匹配**。

## Current state

**关键文件**

- `apps/desktop/src/App.tsx`（2,104 行）— 状态编排中心。
- `apps/desktop/src/components/EngineSetupPanel.tsx`（341 行）— 引擎配置与运行按钮。
- `apps/desktop/src/domain/types.ts` — DTO 类型（`GameSummaryDto` 含 `komi`，见 `:12`）。
- `apps/desktop/src/api/backend.ts` — plan 006 新增的实时复盘 wrapper。

**摘录 1：帧选取（plan 002 修复后应为精确匹配）**（`apps/desktop/src/App.tsx:204-205`，plan 002 改动后）

```ts
  const currentFrame = useMemo(() => frames.find((f) => f.turn === currentMove), [frames, currentMove]);
  const visibleCurrentFrame = useMemo(() => applyPreferencesToFrame(currentFrame, preferences), [currentFrame, preferences]);
```

**摘录 2：手数状态与派生值**（`apps/desktop/src/App.tsx:107`、`:206-211`）

```ts
  const [currentMove, setCurrentMove] = useState(0);
  ...
  const currentPosition = useMemo(
    () => treeNodePositionOverride ?? selectExactPosition(positions, currentMove, game.summary.board_size),
    [treeNodePositionOverride, positions, currentMove, game.summary.board_size]
  );
  const maxMove = Math.max(positions.at(-1)?.move_number ?? 0, 1);
```

**摘录 3：帧合并（保持 turn 升序、同 turn 覆盖）**（`apps/desktop/src/App.tsx:2001-2003`）

```ts
function mergeAnalysisFrame(frames: AnalysisFrameDto[], frame: AnalysisFrameDto): AnalysisFrameDto[] {
  return [...frames.filter((item) => item.turn !== frame.turn), frame].sort((a, b) => a.turn - b.turn);
}
```

这个函数**正是实时帧需要的语义**：同一手的新帧覆盖旧帧。直接复用，不要另写。

**摘录 4：引擎面板的回调签名（需要在其中加入实时按钮）**（`apps/desktop/src/components/EngineSetupPanel.tsx:9-11`）

```tsx
  onRun: (profile: EngineProfileDto, maxVisits: number) => void | Promise<void>;
  onAnalyzeGame: (profile: EngineProfileDto, maxVisits: number) => void | Promise<void>;
  onCancelAnalysis?: () => void | Promise<void>;
```

**摘录 5：SGF 走法已是结构化数据（构造 GTP `play` 序列需要它）**（`apps/desktop/src/domain/types.ts:3-4`）

```ts
export type MoveDto = { color: PlayerColor; vertex: MoveVertex; move_number: number };
export type PositionDto = { board_size: number; move_number: number; to_play: PlayerColor; stones: StoneDto[]; captures_black: number; captures_white: number; last_move?: MoveDto | null; errors: string[] };
```

`PositionDto.to_play` 直接给出轮谁走棋，**正是 plan 006 `set_position` 的 `player` 参数所需的视角信息**。`GameSummaryDto.komi`（`:12`）则是 `komi` 参数的来源。

**摘录 6：坐标 → GPT 字符串（构造 `play` 需要）**（`apps/desktop/src/domain/board.ts:101`）

```ts
export function vertexLabel(vertex: MoveVertex, boardSize: number): string
```

**注意**：先确认 `vertexLabel` 产出的格式（它在 UI 里用于显示，**可能是 `D4` 这类 GTP 风格，也可能是 `Q16`**）。GTP 的 `play` 命令需要 GTP 风格坐标（列字母 A-T 跳过 I，行号从 1 开始）。**若 `vertexLabel` 的格式与 GTP 不完全一致（例如跳 I 的处理），必须新写一个专用转换函数并单测**。这是本计划最容易出错的地方之一。

**仓库约定**

- 前端无测试框架（`package.json` 只有 `dev`/`build`/`preview`/`tauri:*`，devDependencies 只有 `@tauri-apps/cli` 与 `@types/*`）。**不要引入 vitest/jest**。
- 可断言状态通过 `data-*` 属性暴露（先例：`AnalysisPanel.tsx:43` 的 `data-winrate-black`、`WinrateChart.tsx` 的 `data-review-source`）。
- `isTauriRuntime()` 守卫是既有惯例（`api/backend.ts:212`）；浏览器预览必须优雅降级，不能抛错。
- 组件受控 prop 命名 `onXxx`；`disabled` 用于运行中禁用。

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| 类型检查+构建 | `cd apps/desktop && npm run build` | exit 0 |
| Rust 门禁（回归） | `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" && cargo test --workspace` | all pass |
| 脚手架校验 | `python3 scripts/validate_scaffold.py --verbose` | 10 passed, 0 failed |

`npm run build` 的脚本是 `tsc && vite build`，所以类型错误会导致失败——这是本计划的主要自动化验证手段。

## Scope

**In scope**

- `apps/desktop/src/App.tsx` — 实时复盘状态、`useEffect` 接线、事件监听、世代校验
- `apps/desktop/src/components/EngineSetupPanel.tsx` — 新增"实时复盘"开关按钮
- `apps/desktop/src/domain/board.ts` — **仅当**需要新增 GTP 坐标转换函数时
- `apps/desktop/src/api/backend.ts` — **仅当** plan 006 的 wrapper 签名需要微调时（不应需要）

**Out of scope**

- **不要**改任何 Rust 代码。plan 003/004/005/006 已交付所需能力。
- **不要**改 `BoardCanvas.tsx` / `AnalysisPanel.tsx` / `WinrateChart.tsx` 的渲染逻辑。它们已能消费 `AnalysisFrameDto`，实时帧与批处理帧类型相同。
- **不要**改 `package.json`（不加测试框架）。
- **不要**改 `analysis-core` 或任何阈值（那是 plan 008）。
- **不要**实现 ponder、悬停触发分析（Java 也没有悬停触发，见下方 Maintenance notes）、多引擎、远程算力。
- **不要**给 33 个 `setCurrentMove` 调用点逐个插桩——用 effect。

## Git workflow

- 分支：`advisor/007-frontend-live-review`
- 提交示例：`feat(ui): wire live gtp review into the board view`
- **不要推送、不要开 PR**，除非操作者指示。

## Steps

### Step 1: 新增实时复盘状态

在 `apps/desktop/src/App.tsx` 的状态声明区（`:104-120` 一带）新增：

```ts
  const [liveReview, setLiveReview] = useState<{ jobId: string; generation: number; turn: number } | null>(null);
  const [liveReviewEnabled, setLiveReviewEnabled] = useState(false);
```

`liveReview` 记录**当前前端认为有效的** job/世代/手数，用于双重校验。`liveReviewEnabled` 是用户开关（默认关，避免误开引擎）。

**Verify**: `cd apps/desktop && npx tsc --noEmit` → exit 0（此时可能报未使用变量；若 `noUnusedLocals` 开启则先按 Step 2-4 一并接完再验证）。

### Step 2: 构造 GTP 局面并实现位置同步函数

新增一个函数，把 `positions` + `currentMove` 转成 plan 006 `setLiveReviewPosition` 需要的 `moves: string[]`：

```ts
  async function syncLiveReviewPosition(targetMove: number) {
    if (!liveReviewEnabled || !liveReview) return;
    const position = selectExactPosition(positions, targetMove, game.summary.board_size);
    const moveList = positions
      .filter((item) => item.move_number > 0 && item.move_number <= targetMove && item.last_move)
      .flatMap((item) => {
        const move = item.last_move!;
        const color = move.color === "black" ? "B" : "W";
        return [color, gtpCoordinate(move.vertex, game.summary.board_size)];
      });
    const player = position.to_play === "black" ? "B" : "W";
    const generation = await setLiveReviewPosition(moveList, targetMove, 10, player, game.summary.komi);
    setLiveReview((current) => (current ? { ...current, generation, turn: targetMove } : current));
  }
```

要点：

- `moves` 是**扁平数组** `["B", "D4", "W", "Q16", ...]`，与 plan 006 的约定一致（成对 color + vertex）。
- `player` 取自 `position.to_play`，供 plan 006 的 `kata-analyze <player>` 参数使用（**轮谁走棋**，影响引擎搜索）。
  - **注意**：`player` **不是**"视角来源"。引擎的**输出视角**已由 plan 003 的 `-override-config reportAnalysisWinratesAs=BLACK` 固定为黑视角，与 `player` 无关。**不要**把 `player` 当成"视角"传给 `perspective`——那会双重转换（见 `GTP_LIVE_PROBE_FINDINGS.md` §2 裁定）。
- `komi` 取自 `game.summary.komi`（**plan 006 明确要求调用方传入**）。
- `interval` 传 `10` 厘秒（Java 默认值）。
- `gtpCoordinate` 见 Step 3。

**Verify**: `cd apps/desktop && npx tsc --noEmit` → exit 0。

### Step 3: 实现 GTP 坐标转换（如 `vertexLabel` 不适用）

先检查 `apps/desktop/src/domain/board.ts:101` 的 `vertexLabel` 实现：

- 若它产出的就是标准 GTP 坐标（列 A-T **跳过 I**、行 1-19 从底部起算），**直接复用**，跳过本步。
- 若格式不同（例如跳 I 的规则不一致、或行号方向相反），在 `domain/board.ts` 新增专用函数：

```ts
/** 把 DTO 走法转为 GTP 坐标字符串（列 A-T 跳过 I，行号 1-based 从棋盘底部起算）。pass 转为 "pass"。 */
export function gtpCoordinate(vertex: MoveVertex, boardSize: number): string
```

**三种情况都要处理**：`{ point: { x, y } }`、`"pass"`。注意越界时返回 `"pass"`（不要抛错，与 Rust 侧 `gtp_vertex_to_dto` 的容错风格一致）。

**`pass` 是关键**：GTP 的 `play B pass` 是合法命令，必须支持。棋谱中的虚手若被丢弃会导致后续局面整体错位。

**Verify**: `cd apps/desktop && npx tsc --noEmit` → exit 0。

### Step 4: 挂 `currentMove` effect 与事件监听

**4a. 切手 effect**：

```ts
  useEffect(() => {
    if (!liveReviewEnabled || !liveReview) return;
    if (liveReview.turn === currentMove) return;
    void syncLiveReviewPosition(currentMove);
  }, [currentMove, liveReviewEnabled, liveReview?.jobId]);
```

注意依赖数组**刻意不含** `liveReview.turn`，否则会自我触发循环。

**4b. 事件监听 effect**（在组件挂载时注册一次）：

```ts
  useEffect(() => {
    if (!isTauriRuntimeSafe()) return () => undefined;
    let dispose: (() => void) | null = null;
    void listenToLiveReviewEvents({
      onFrame: (payload) => {
        setLiveReview((current) => {
          // 双重校验：job、世代、手数三者都必须匹配，否则丢弃。
          if (!current) return current;
          if (payload.job_id !== current.jobId) return current;
          if (payload.generation !== current.generation) return current;
          if (payload.turn !== current.turn) return current;
          setFrames((frames) => mergeAnalysisFrame(frames, payload.frame));
          return current;
        });
      },
      onEnded: (payload) => {
        setMessage(`Live review ended: ${payload.reason}`);
      }
    }).then((unlisten) => { dispose = unlisten; });
    return () => { dispose?.(); };
  }, []);
```

**在 `setLiveReview` 的 updater 内调用 `setFrames` 是反模式**（在 updater 里产生副作用）。**不要这样写。** 正确做法：把校验放在 updater 外，用 `liveReviewRef`（`useRef` 镜像）读取当前值：

```ts
  const liveReviewRef = useRef(liveReview);
  useEffect(() => { liveReviewRef.current = liveReview; }, [liveReview]);
  // onFrame 内：
  const current = liveReviewRef.current;
  if (!current) return;
  if (payload.job_id !== current.jobId) return;
  if (payload.generation !== current.generation) return;
  if (payload.turn !== current.turn) return;
  setFrames((frames) => mergeAnalysisFrame(frames, payload.frame));
```

**Verify**: `cd apps/desktop && npx tsc --noEmit` → exit 0。

### Step 5: 启动与停止实时复盘

新增两个 handler：

```ts
  async function handleToggleLiveReview(profile: EngineProfileDto) {
    if (liveReview) {
      await stopLiveReview();
      setLiveReview(null);
      setLiveReviewEnabled(false);
      setMessage("Live review stopped.");
      return;
    }
    const jobId = await startLiveReview(profile, game.summary.board_size, currentMove, 10);
    setLiveReview({ jobId, generation: 0, turn: currentMove });
    setLiveReviewEnabled(true);
    setMessage("Live review started. Move around the game to refresh analysis in real time.");
    await syncLiveReviewPosition(currentMove);
  }
```

要点：

- **启动时 `generation` 从 `0` 起**，与 Rust 侧（plan 006 Step 2 第 6 步首增后为 1）可能不一致。**必须先确认 Rust 侧首次返回/使用的世代号**，然后让前端初值与之一致。若不一致，第一次 `onFrame` 就全部被前端丢弃，表现为"实时复盘开了但没反应"——这是最难排查的一类 bug。
  - **验证方法**：读 plan 006 的实现（`katago_start_live_review` 的返回值与 `katago_live_review_set_position` 的返回值）。**以 Rust 实际返回的世代号为准**设置前端初值，或改为直接用 `setLiveReviewPosition` 的返回值初始化（推荐：启动后立即调一次 `syncLiveReviewPosition`，用它返回的 generation 覆盖，避免猜）。
- 停止时**必须**同时清 `liveReview` 与 `liveReviewEnabled`，否则 effect 会继续调 `set_position` 到一个已停止的会话。

**Verify**: `cd apps/desktop && npx tsc --noEmit` → exit 0。

### Step 6: 在引擎面板加按钮

在 `apps/desktop/src/components/EngineSetupPanel.tsx` 加一个按钮（沿用 `data-testid` 惯例）：

```tsx
<button
  type="button"
  data-testid="engine-live-review-toggle"
  onClick={handleToggleLiveReview}
  disabled={!canRun && !isLiveReviewActive}
>
  {isLiveReviewActive ? "Stop live review" : "Live review"}
</button>
```

需要给 `Props` 加两个可选 prop：`onToggleLiveReview?: () => void | Promise<void>` 和 `isLiveReviewActive?: boolean`。**保持可选**，避免破坏既有调用方与测试。

在 `App.tsx` 的 `<EngineSetupPanel ... />` 处传入这两个 prop。

**Verify**:
1. `cd apps/desktop && npm run build` → exit 0
2. `grep -n 'engine-live-review-toggle' apps/desktop/src/components/EngineSetupPanel.tsx` → 1 处匹配

### Step 7: 加可断言的实时状态标记

在 `AnalysisPanel` 根元素（或 `BoardCanvas` 容器）新增一个可断言的属性，编码实时状态。**不要新增渲染分支**，只加属性：

```tsx
data-live-review={isLiveReviewActive ? `live:${liveReview?.generation ?? 0}:${liveReview?.turn ?? 0}` : "off"}
```

这符合仓库既有的 `data-*` 可断言惯例（见 `AnalysisPanel.tsx:43`、`WinrateChart.tsx` 的 `data-review-*`）。

**Verify**: `cd apps/desktop && npm run build` → exit 0。

### Step 8: 全量门禁

**Verify**（逐条）:

1. `cd apps/desktop && npm run build` → exit 0
2. `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" && cargo test --workspace` → all pass
3. `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed

### Step 9: 人工核对（不可自动化的部分）

**如实记录结果**，不要声称验证过而实际未做：

1. `cd apps/desktop && npm run dev`（浏览器预览，**无真实引擎**）。
2. 确认预览下点"Live review"给出**明确的错误或不可用提示**，而不是崩溃或无响应（`isTauriRuntime()` 守卫应拦住）。
3. `npm run tauri:dev`（需真实 Tauri 环境）：**本机已有可用 KataGo**（见 `plans/KATAGO_LOCAL_ENV.md`）。若时间允许，配置 GTP 后端（`gtp.cfg` + bundle 权重）并实际点开实时复盘，观察胜率是否持续刷新。**若未做该端到端核对，如实报告「未做真实引擎端到端核对」**，不要编造成功结果。注意引擎配置须用 `gtp.cfg`（用 `analysis.cfg` 会直接崩溃退出）。

## Test plan

- 前端无测试框架，本计划**不引入**。
- 自动化保障：`tsc` 类型检查 + `npm run build` + Rust 全量测试回归 + `data-*` 属性供将来的自动化断言。
- **必须如实报告**：实时复盘的端到端行为（真实引擎、真实流式刷新）**未自动化覆盖**。本机**已有可用 KataGo**（`plans/KATAGO_LOCAL_ENV.md`），执行者应尝试做一次手工端到端核对；**若未做，必须明确标注未验证**。这是本计划最大的验证缺口，审阅者必须知道。
- 若将来引入 vitest，应优先为以下纯函数补测：`gtpCoordinate`（坐标边界、pass）、`syncLiveReviewPosition` 的 `moves` 构造（含 pass、含第 0 手）、世代校验三条件。

## Done criteria

全部成立才算完成：

- [ ] `cd apps/desktop && npm run build` exit 0
- [ ] `grep -nF 'listenToLiveReviewEvents({' apps/desktop/src/App.tsx` 有 **1 处**匹配（**必须锚定 `({` 调用点**：它还需一处具名导入，按仓库惯例同类函数 `listenToKataGoAnalysisEvents` 在基线 App.tsx 就是 2 处——`:18` 导入 + `:584` 调用。裸子串 grep 会匹配到 2 行）
- [ ] `grep -nF 'listenToLiveReviewEvents,' apps/desktop/src/App.tsx` 有 1 处匹配（具名导入已添加）
- [ ] `grep -n 'mergeAnalysisFrame' apps/desktop/src/App.tsx` 在实时路径中被复用（不是新写的合并逻辑）
- [ ] `grep -n 'engine-live-review-toggle' apps/desktop/src/components/EngineSetupPanel.tsx` 有 1 处匹配
- [ ] `grep -n 'data-live-review' apps/desktop/src` 有匹配
- [ ] `grep -nF 'setLiveReview(' apps/desktop/src/App.tsx` 的**每个**匹配点，其 updater 回调体内**不含** `setFrames`（无 updater 内副作用）
  > **注意：这是一条负向 gate，单条 grep 无法表达。** 不要用 `grep -c` 或管道组合来"凑"一个计数——必须**逐点人工/结构化核对**：定位每个 `setLiveReview(` 调用，读取其回调函数体，确认体内没有 `setFrames` 调用。核验方式：读取 `onFrame` 的实现，确认校验逻辑在 updater **之外**完成（用 `liveReviewRef` 读当前值），`setFrames` 在 updater **之外**被调用。
- [ ] 三个世代校验条件（`job_id`、`generation`、`turn`）都在 `onFrame` 中显式存在（此条同为结构化核验：读 `onFrame` 函数体，确认三个 `if (... !== current.xxx) return` 判断齐备，不能只数出现次数）
- [ ] `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" && cargo test --workspace` → all pass
- [ ] `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed
- [ ] `grep -n 'vitest\|jest' apps/desktop/package.json` 无匹配（未引入测试框架）
- [ ] `grep -n '1.0 -\|1.0-' apps/desktop/src` **无匹配**（前端未做视角二次转换——转换只在 plan 005 的 Rust 侧发生一次）
- [ ] `ownership` 数据确实到达前端：`payload.frame.ownership` 被渲染路径消费（plan 006 已发 `ownership true`；实测不带该 flag 则引擎不输出 ownership）
- [ ] Step 9 的人工核对结果已如实记录（含"未验证"的明确标注）
- [ ] `plans/README.md` 中本计划状态行已改为 `DONE`

## STOP conditions

出现以下任一情况，停止并报告，不要即兴发挥：

- plan 002 未合入（`App.tsx:204` 仍是 `?? frames.at(-1)`）。本计划的实时帧会与陈旧回退叠加，**必须先完成 002**。
- plan 006 的 `startLiveReview` / `setLiveReviewPosition` / `stopLiveReview` / `listenToLiveReviewEvents` 未在 `api/backend.ts` 中导出。
- **Rust 首次返回的世代号与前端初值语义不明确**（例如 `startLiveReview` 返回 job id 但 `setLiveReviewPosition` 才返回 generation，而二者关系不清）。**报告并请求澄清**，不要靠猜——猜错会导致所有帧被静默丢弃。
- `vertexLabel` 的格式与 GTP 坐标不一致，且你不确定差异所在——报告，附上 `vertexLabel` 的实现与几个示例输出。
- 你发现 `set_position` 需要的 `moves` 扁平数组格式与 plan 006 的文档描述不符——报告，以 Rust 实现为准。
- 需要在 33 个 `setCurrentMove` 调用点逐个插桩才能工作（说明 effect 方案不成立）——报告，不要逐个插。
- 需要改动 Scope 之外的任何文件，或需要引入依赖。
- `cargo test --workspace` 出现除 README 所述 2 个既有 macOS `/tmp` 失败之外的新失败。

## Maintenance notes

- **依赖链**：本计划是 001→008 链条的最后一环 UX。008（问题手阈值 + 底部热力概览）会消费本计划产出的实时帧，因此 **008 应在本计划之后**。
- **审阅者重点看**：
  1. `onFrame` 的三重校验是否**都在**（job/generation/turn）。缺任一项都会让陈旧帧漏进来。
  2. `setFrames` 是否被放在 `setLiveReview` updater 内（反模式，会触发 React 警告与潜在死循环）。
  3. 切手 effect 的依赖数组是否会导致**无限循环**（`syncLiveReviewPosition` 里 `setLiveReview` 会改状态；effect 依赖必须只含 `currentMove`/`liveReviewEnabled`/`liveReview?.jobId`，**不含** `liveReview.turn`）。
  4. `komi` 是否确实从 `game.summary.komi` 传下去了（plan 006 明确要求；漏传会让收官目差偏差）。
  5. `pass` 走法是否被正确转成 `"pass"`（漏处理会让后续局面整体错位）。
  6. **视角**：前端**没有**对 `winrate_black` 做任何按 `to_play` 的二次转换（plan 005 已转好；重复转会反向）。`grep '1.0 -' apps/desktop/src` 应为空。
  7. **`ownership` 是否真的非空**：plan 006 必须发 `ownership true`（实测默认不输出）。若热图恒空，**首先怀疑这个 flag**，而不是渲染逻辑。
- **性能**：默认 10 厘秒一行，即每秒最多 10 次 `setFrames`。每次都新建数组并排序（`mergeAnalysisFrame`），在长棋谱（300+ 手）下是 O(n log n) × 10/s。**当前可接受**。若出现卡顿，应优先考虑：把 `frames` 改成 `Map<turn, frame>` 以 O(1) 更新，或在 React 外批处理帧再一次性 `setState`。**不要提前优化**。
- **Java 也没有悬停触发分析**：我核查过 Java 主线的 `LizzieFrame.onMouseMoved`（`:9881`）与 `setMouseOverCoords`（`:14169-14189`），它们**只改 UI 状态**（`mouseOverCoordinate`、预览渲染器），**不发** `kata-analyze`。重析由落子、历史前进/后退、撤消、配置变更、上限触发等驱动（见 Java 侧触发器清单）。因此本计划**同样不做悬停触发**——那会造成引擎被悬停风暴淹没。若将来要做，必须有显式节流与"仅当停在同一处 X 毫秒"的条件。
- **未实现但相关**：
  - **ponder（思考中分析）**：Java 在评估到手数上限或时间上限后停止，并可开启 ponder 在对手回合继续搜索。本轮不做。
  - **自动分析走子**（Java 的 `autoAnalyzeMode`/`notifyAutoAna`）：逐手自动推进并分析全盘。本轮不做。
  - **引擎对弈、远程算力、双引擎槽位**：不在本轮。
  - **引擎信息显示**（名称/版本/后端）：plan 006 未采集，本轮不显示。
