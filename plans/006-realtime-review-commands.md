# Plan 006: Tauri 实时复盘命令、事件与陈旧性守卫

> **已按 `plans/GTP_LIVE_PROBE_FINDINGS.md` 修订（2026-09-13）**：**明确事件 payload 携带的是「已转换的黑视角值」还是「原始走棋方视角 + `to_play`」**（二选一写死，避免前端二次转换）；**明确 `player`（轮谁走）与 `perspective`（引擎用哪个视角）是两个语义，`perspective` 实参恒为 `Black`（防双重转换，见 `GTP_LIVE_PROBE_FINDINGS.md` §2 裁定）**；明确 `kata-analyze` 必须带 `rootInfo true` 与 `ownership true`（否则根统计静默降级、热图恒空）；更新 Drift check 基底。
>
> **Executor instructions**: 按步骤执行，每步先跑验证命令、确认预期结果再进入下一步。若出现 "STOP conditions" 中的任一情况，停止并报告，不要即兴发挥。完成后更新 `plans/README.md` 中本计划的状态行。
>
> **Drift check（先跑）**: `git diff --stat b7f33a2..HEAD -- apps/desktop/src-tauri/src/lib.rs apps/desktop/src/api/backend.ts crates/engine-manager/src/lib.rs crates/katago-protocol/src/lib.rs`
> **基底说明（已更新）**：工作树 HEAD 已推进到 **`92dcfe8`**（含 001/002/UI 提交），因此上述文件会有**与本计划无关**的既有改动（001 改过 `katago-protocol`；UI 重构改过前端）。**判据**：确认 plan 004 的 `GtpSession`（`crates/engine-manager/src/lib.rs`）与 plan 005 的 `parse_kata_analyze_line`（`crates/katago-protocol/src/lib.rs`）是否已存在。若不存在，见 STOP conditions。

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/004-long-lived-gtp-session.md, plans/005-kata-analyze-stream-parser.md
- **Category**: direction（新能力接线）
- **Planned at**: commit `b7f33a2`, 2026-09-12
- **Revised**: 2026-09-13，按 `plans/GTP_LIVE_PROBE_FINDINGS.md` 实测规格修订（见顶部说明）

## Why this matters

plan 004 提供了长驻 GTP 会话，plan 005 提供了 `kata-analyze` 行解析器，但两者都躺在 Rust crate 里，前端够不着。本计划把它们**接成 Tauri 命令与事件**，这是实时复盘能否工作的最后一环。

**本计划的核心难点不是"接线"，而是陈旧性守卫（staleness guard）。**

实时复盘有一个必然发生的竞态：用户在 A 手发起了分析，引擎还在推 `info` 行；用户立刻跳到 B 手并发起新分析。此时**旧流可能还有几行在路上**。若不加守卫，这些 A 手的行会被当成 B 手的结果渲染——棋盘上是 B 手的局面，叠加的却是 A 手的候选点与归属热图。

Java 主线为此投入了**六层守卫**（`src/main/java/featurecat/lizzie/analysis/Leelaz.java`）：

1. `analysisOutputRoute`（`:6490`）在入口按 generation 分类，不匹配即丢弃。
2. `hasSameOwner` 在捕获与提交之间重新校验（`:7114-7131`）。
3. `isCurrentAnalysisInfoTarget`（`:4887-4897`）校验棋盘对象身份、**棋盘上下文修订号**、以及显示节点：
```java
&& expected.board == Lizzie.board
&& expected.board.getContextRevision() == expected.boardRevision
&& expected.displayNode != null
&& Lizzie.frame != null
&& Lizzie.frame.getDisplayNode() == expected.displayNode;
```
4. `analysisInfoEpoch` 载荷纪元（`:621`），每次局面变更自增。
5. `analysisOutputGeneration` 世代计数（`:623`），仅在**物理写入**分析命令时发布新所有者。
6. `runIfCurrentAnalysisOutputRoute`（`:6606`）在锁内原子提交。

本仓库是单引擎、单窗口、无远程传输的简化场景，**不需要六层**，但**必须有一层等价物**：一个单调递增的世代号 + 当前目标手数，两者不匹配的 `info` 行直接丢弃。这是本计划要交付的核心正确性保障。

## Current state

**关键文件**

- `apps/desktop/src-tauri/src/lib.rs`（7,752 行）— 48 个命令、`AnalysisJobRegistry`（`:443`）、事件发射（`katago://analysis-*`）。
- `apps/desktop/src/api/backend.ts` — 前端命令与事件 wrapper，事件 payload 类型在 `:167-190`。

**摘录 1：事件 payload 类型（前端约定的形状）**（`apps/desktop/src/api/backend.ts:167-190`）

```ts
export type AnalysisProgressPayload = {
  job_id: string;
  completed: number;
  expected: number;
  turn: number;
  response_jsonl: string;
};

export type AnalysisCompletePayload = {
  job_id: string;
  frames: AnalysisFrameDto[];
};

export type AnalysisErrorPayload = {
  job_id: string;
  message: string;
};

export type KataGoAnalysisEventHandlers = {
  onProgress?: (payload: AnalysisProgressPayload) => void;
  onComplete?: (payload: AnalysisCompletePayload) => void;
  onError?: (payload: AnalysisErrorPayload) => void;
  onCancelled?: (payload: AnalysisErrorPayload) => void;
};
```

**摘录 2：既有事件名（前端已监听，必须沿用同一命名空间）**（`apps/desktop/src/api/backend.ts:328-333`）

```ts
    listen<AnalysisProgressPayload>("katago://analysis-progress", (event) => handlers.onProgress?.(event.payload)),
    listen<AnalysisCompletePayload>("katago://analysis-complete", (event) => handlers.onComplete?.(event.payload)),
    listen<AnalysisErrorPayload>("katago://analysis-error", (event) => handlers.onError?.(event.payload)),
    listen<AnalysisErrorPayload>("katago://analysis-cancelled", (event) => handlers.onCancelled?.(event.payload))
```

**摘录 3：既有 job 注册表（可复用其模式）**（`apps/desktop/src-tauri/src/lib.rs:443-479`）

```rust
struct AnalysisJobRegistry {
    jobs: Mutex<HashMap<String, AnalysisCancelToken>>,
}

impl AnalysisJobRegistry {
    fn insert(&self, job_id: String, cancel_token: AnalysisCancelToken) -> Result<(), String> { ... }
    fn cancel(&self, job_id: &str) -> Result<bool, String> { ... }
    fn remove(&self, job_id: &str) { ... }
    #[cfg(test)]
    fn contains(&self, job_id: &str) -> bool { ... }
}
```

**摘录 4：state 注册与 handler 注册位置**（`apps/desktop/src-tauri/src/lib.rs:4964-4980`，节选）

```rust
        .manage(AnalysisJobRegistry::default())
        ...
        .invoke_handler(tauri::generate_handler![
            health,
            native_menu_contract,
            ...
```

**摘录 5：既有的后台任务 + 事件发射范式（照此写实时转发循环）**（`apps/desktop/src-tauri/src/lib.rs:2318-2335`，节选）

```rust
    match result {
        Ok(result) => emit_katago_analysis_complete(&app_handle, job_id, &job_id_string, prepared, result),
        Err(EngineManagerError::Cancelled { .. }) => {
            let _ = app_handle.emit(
                "katago://analysis-cancelled",
                AnalysisMessagePayload {
                    job_id: job_id_string.clone(),
                    message: "analysis job was cancelled".to_string(),
                },
            );
        }
        Err(err) => {
            let _ = app_handle.emit(
                "katago://analysis-error",
                AnalysisMessagePayload {
                    job_id: job_id_string.clone(),
                    message: err.to_string(),
                },
            );
        }
    }
```

**摘录 6：`build_command_spec` 是唯一的引擎启动入口**（`crates/engine-manager/src/lib.rs:348`）
plan 003 已使 `EngineBackend::KataGoGtp` 产出 `["gtp", "-config", <cfg>, "-model", <model>]`。

**仓库约定**

- `apps/desktop/src-tauri/src/lib.rs` 是单文件；48 个命令全为**同步 `fn`**（plan 003 已把两个分析命令改为 `async fn`）。
- 命令参数用 snake_case Rust 形参，前端 `invoke` 传 camelCase 键（Tauri 自动转换）。现有调用示例：`invoke<string>("katago_start_analyze_game", { profile, sgfText, maxVisits })`。
- 结构化 payload 用 `#[derive(Serialize, Deserialize)]` 的本地 struct，如 `AnalysisMessagePayload`。
- Tauri state 用 `.manage(...)` 注册，命令用 `State<'_, T>` 取用。
- 跨线程发事件需 `AppHandle`（不是 `AppHandle<R>` 参数），现有代码用 `app_handle.clone()` 移入 `move` 闭包。
- `apps/desktop/src-tauri/src/lib.rs:953` 起有 94 个内联测试，用 `#[cfg(test)] mod tests`。

## Commands you will need

前置：`export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`

| Purpose | Command | Expected on success |
|---|---|---|
| 编译 | `cargo check --workspace --all-targets` | exit 0 |
| 定向测试 | `cargo test -p lizzieyzy-next-desktop` | all pass |
| 全量测试 | `cargo test --workspace` | all pass |
| 格式 | `cargo fmt --all --check` | exit 0 |
| 静态检查 | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| 前端构建 | `cd apps/desktop && npm run build` | exit 0 |

**引擎可用性**：命令的集成测试无法在 `cargo test` 内端到端跑（需真实引擎）。本计划的可测部分通过**纯函数**抽出（世代守卫判定、目标匹配），在 `#[cfg(test)]` 内覆盖。**本机现已安装可用 KataGo**（见 `plans/KATAGO_LOCAL_ENV.md`，用 `gtp.cfg` 而非 `analysis.cfg`），执行者可手工跑一次端到端确认；**如实标注哪些部分未做端到端验证**。

## Scope

**In scope**

- `apps/desktop/src-tauri/src/lib.rs` — 新增实时会话 state、3 个命令、2 个事件、世代守卫；注册进 `.manage()` 与 `generate_handler!`
- `apps/desktop/src/api/backend.ts` — 新增命令与事件的 wrapper 与类型
- `apps/desktop/src/domain/types.ts` — 仅当需要新增 payload 类型时

**Out of scope**

- **不要**改 `crates/katago-protocol/`（plan 005 的产物）。
- **不要**改 `crates/engine-manager/`（plan 004/003 的产物）。若 `GtpSession` 的 API 不足，报告并建议追加计划。
- **不要**改 `apps/desktop/src/App.tsx`（前端接线是 plan 007）。
- **不要**改既有的 `katago_analyze_once` / `katago_analyze_game` / `katago_start_analyze_game` / `katago_cancel_analysis`（批处理路径必须保持原样）。
- **不要**实现 ponder、`genmove`、多引擎槽位、远程传输。
- **不要**新增依赖。

## Git workflow

- 分支：`advisor/006-realtime-review-commands`
- 提交示例：`feat(ipc): expose live gtp review session commands and events`
- **不要推送、不要开 PR**，除非操作者指示。

## Steps

### Step 1: 定义实时会话 state 与世代守卫

在 `apps/desktop/src-tauri/src/lib.rs` 新增：

```rust
/// 实时复盘会话的运行态。单引擎单窗口，因此只需一份状态。
struct LiveReviewSession {
    /// 当前会话（None 表示未启动）。关闭后置 None。
    session: Option<engine_manager::GtpSession>,
    /// 已启动的 job id，用于把事件与前端请求对应起来。
    job_id: Option<String>,
    /// 单调递增世代号。每次发起新的实时分析（或局面变更）自增。
    generation: u64,
    /// 当前正在分析的手数。`info` 行的归属由世代号 + 该手数共同决定。
    target_turn: Option<u32>,
    /// 板面大小，解析 ownership 时需要。
    board_size: u8,
}
```

**必须实现的纯函数守卫**（这是本计划的可测核心，务必抽成可单测的纯函数）：

```rust
/// 判定一条来自某世代的 info 行是否属于当前目标。
/// 返回 false 表示该行是陈旧输出，必须丢弃。
fn accepts_live_info_line(
    current_generation: u64,
    line_generation: u64,
    current_target_turn: Option<u32>,
    line_target_turn: Option<u32>,
) -> bool {
    line_generation == current_generation && current_target_turn.is_some() && line_target_turn == current_target_turn
}
```

设计理由：转发线程在**读取到行的那一刻**记录 `line_generation`/`line_target_turn`（即该行所属请求的世代与目标手），提交前用当前值重新判定。这是 Java 第 4、5 层守卫的简化等价物。

**Verify**: `cargo check -p lizzieyzy-next-desktop` → exit 0。

### Step 2: 实现启动命令

```rust
#[tauri::command]
fn katago_start_live_review(
    app_handle: AppHandle,
    state: State<'_, Mutex<LiveReviewSession>>,
    registry: State<'_, AnalysisJobRegistry>,
    profile: EngineProfileDto,
    board_size: u8,
    turn: u32,
    interval_centisec: u32,
) -> Result<String, String>
```

行为：

1. **若已有会话在跑，先关闭它**（调用 plan 004 的 `close()`），保证单会话不变量。这同时天然实现了"切手即停旧分析"。
2. `interval_centisec` 为 0 时取默认 **10**（与 Java 默认一致，见 `Config.java:2129`）。
3. 用 `engine_manager::build_command_spec(&profile)` 取 spec。**要求 `profile.backend == EngineBackend::KataGoGtp`**；否则返回明确错误（例如 `"live review requires the KataGo GTP backend"`）。plan 003 已保证该后端的 spec 含 `-model`/`-config`。
4. `GtpSession::start(&spec)`。
5. 先发 GTP 初始化序列（这是**必须的**，否则引擎不知棋盘大小）：`boardsize <board_size>`，然后由调用方通过 `katago_live_review_set_position` 送入局面（Step 3）。**不要**在本命令内推局面——局面需要 SGF 回放，属前端与 Step 3 的职责。
6. 生成 job id、自增世代号、记录 `target_turn = Some(turn)`、`board_size`。
7. 起**转发线程**：循环 `session.next_event_timeout(...)`，对每个 `GtpSessionEvent::Line(line)`：
   - 记录该行所属的 `generation` 与 `target_turn`（来自闭包捕获的局部快照）。
   - 用 `katago_protocol::parse_kata_analyze_line(&line, board_size)` 解析；`None` 则跳过（GTP 响应行、空行等）。
   - 用 `accepts_live_info_line(...)` 判定；**不接受则直接丢弃，不发事件**。
   - 接受则 `kata_analyze_line_to_frame(job_id, &parsed, board_size, target_turn)`，通过 `app_handle.emit("katago://live-review-frame", payload)` 推送。
   - 收到 `Eof`/`ReadError` 时 `emit("katago://live-review-ended", ...)` 并结束线程。
8. 返回 job id。

**事件 payload（新增）**：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LiveReviewFramePayload {
    job_id: String,
    generation: u64,
    turn: u32,
    /// 该帧局面的**走棋方**（轮谁走）。仅作元数据（显示"轮谁走"等），
    /// **不是** `frame` 的视角——`frame.winrate_black`/`score_mean_black`
    /// 恒为黑视角（引擎已由 `-override-config` 固定），**前端不得据此转换**。
    to_play: PlayerColor,
    frame: AnalysisFrameDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LiveReviewEndedPayload {
    job_id: String,
    generation: u64,
    reason: String,
}
```

**⚠️ 视角契约（必须二选一写死，并在代码注释与前端类型里同步声明）**：

`kata-analyze` 报的是**引擎 `perspective` 所决定**的视角（本项目启动时已 override 为黑视角），而 `AnalysisFrameDto` 的字段名是 `winrate_black`/`score_mean_black`（约定**黑视角**）。plan 005 的 `kata_analyze_line_to_frame` 已在**产出帧时**完成转换（见 plan 005 Step 3b）。因此：

- **选定方案（本计划采用）：payload 携带「已转换的黑视角值」+ 额外的 `to_play` 字段。**
  - `frame.winrate_black` / `frame.score_mean_black` **恒为黑视角**，与批处理路径（`katago_analyze_game`）语义一致。
  - `to_play` **只作为元数据**传递（供前端显示"轮谁走"、或将来做别的判定），**前端绝不能再据此做第二次转换**。
  - 理由：前端（plan 007）复用 `mergeAnalysisFrame` 与 `BoardCanvas`/`AnalysisPanel`/`WinrateChart`，它们都按 `winrate_black` 黑视角渲染。若 payload 送原始走棋方视角，前端必须知道并转换，会把视角知识泄漏到 UI 层、且与批处理帧混在一起时**方向不一致**。

- **不采用**：payload 只送原始走棋方视角 + `to_play`，让前端转换。那会让两个来源（实时 vs 批处理）的帧语义不同，而它们最终**汇入同一个 `frames` 数组**（`mergeAnalysisFrame`），必然错乱。

**因此**：在 `LiveReviewFramePayload` 的 `frame` 字段文档注释里明确写「**已转换为黑视角**」，并在 plan 007 的 TS 类型注释里同样声明。审阅者应确认前端**没有**任何二次转换。

**⚠️ `to_play`（轮谁走）与 `perspective`（引擎用哪个视角）是两个不同的东西——不要混用同一个值**

- `player`（Step 3 传给 `kata-analyze` 的参数）语义是「**轮谁走棋**」，影响**搜索**。
- `perspective`（plan 005 `kata_analyze_line_to_frame` 的入参）语义是「**引擎本次输出用的是哪个视角**」，影响**输出编码**。

**在本项目的启动配置下（plan 003 的 `build_command_spec` 已强制 `-override-config reportAnalysisWinratesAs=BLACK`），引擎恒报黑视角**，因此调用 `kata_analyze_line_to_frame` 时**必须恒传 `PlayerColor::Black`**，**不要**传"走棋方"。

**这是本计划最容易犯的错**：看起来"视角=走棋方"很自然，于是把 `set_position` 的 `player`（轮白时是 `W`）直接喂给 `perspective`。但 override 已让引擎输出黑视角，再按"走棋方=白"翻一次就是**双重转换**。实测后果（黑占下 4 行、白占上 4 行、**白走**、带 override）：

```
引擎原始 rootInfo.winrate（已是黑视角） = 0.000549    ← 正确：黑其实快输了
若再按"走棋方=白"翻折：1 - 0.000549 = 0.999451      ← 错误：变成"黑大胜"
```

不报错、不崩溃，只是每个白走局面都反向。**启动参数（override）与 `perspective` 实参必须成对一致**——plan 005 测试 15 锁住该不变量；本计划应加一条断言（见 Done criteria）。

**`to_play` 的来源**：`set_position` 收到的 `player` 参数（Step 3）。它**用于** `kata-analyze` 的 `player` 实参**与** payload 的 `to_play` 元数据；**不用于** `perspective` 实参（后者恒为 `Black`）。

注意 `frame` 内嵌整个 DTO（含 ownership 数组），事件体积会明显大于既有 progress 事件。**JSON 事件序列化是 Tauri 的常规做法，可接受**；若将来发现体积问题，再考虑分片或按需请求，本轮不做。

**Verify**: `cargo check -p lizzieyzy-next-desktop` → exit 0。

### Step 3: 实现局面设置与停止命令

```rust
#[tauri::command]
fn katago_live_review_set_position(
    state: State<'_, Mutex<LiveReviewSession>>,
    moves: Vec<String>,          // GTP 走法序列，如 ["B", "D4", "W", "Q16"]
    turn: u32,
    interval_centisec: u32,
    player: Option<String>,      // "B" 或 "W"；缺省由调用方从 SGF 的 PL/手数推断
    komi: Option<f32>,           // 棋谱贴目；缺省不发 komi
) -> Result<u64, String>

#[tauri::command]
fn katago_live_review_stop(
    state: State<'_, Mutex<LiveReviewSession>>,
) -> Result<(), String>
```

`set_position` 行为：

1. **自增世代号**（关键：这会让所有在途的旧行失效）。
2. 更新 `target_turn = Some(turn)`。
3. 向会话发送：`boardsize <board_size>`（若与上次不同）、`komi <komi>`（**仅当 `komi` 为 `Some`**）、`clear_board`，然后 `play` 每条走法（成对的 color + vertex）。
   - **为什么必须支持 `komi`**：不同规则/棋谱的贴目不同（中国规则常见 7.5，日韩可能 6.5），而引擎配置里的默认值未必匹配当前棋谱。若不下发正确的 `komi`，收官阶段的目差与胜率会有系统性偏差，问题手判定随之失真。Java 在每次局面恢复时都会下发 `komi`（`src/main/java/featurecat/lizzie/rules/Board.java:4571-4586`）。调用方（plan 007）从 SGF 的 `KM` 取值传入。`komi` 为 `None` 时才回退到引擎默认。
4. 发送 `kata-analyze`：
   - 命令形如 `kata-analyze <player> <interval> ownership true rootInfo true`。
   - `player` 可选：轮黑发 `B`、轮白发 `W`。**视角正确性依赖这个参数**（Java 在 `Leelaz.java:22478-22479` 有专门注释说明用错视角会导致"轮谁谁稳赢"）。由调用方通过 `player` 参数或从 `moves`/`turn` 推断给出；两者都缺省时可省略 `player`（KataGo 会假设轮到走棋方）。
     - **注意**：`kata-analyze` 的行内**不报**走棋方（实测），因此本命令的 `player` 必须记入会话状态（`LiveReviewSession` 需新增 `player: PlayerColor` 字段），用于 payload 的 `to_play` 元数据。
     - **但 `player` 不用于 `perspective`**：引擎已由 plan 003 的 `-override-config reportAnalysisWinratesAs=BLACK` 固定为黑视角，故 `kata_analyze_line_to_frame` 的 `perspective` 实参**恒为 `PlayerColor::Black`**。把 `player`（走棋方）喂给 `perspective` 会**双重转换**（见上方「视角契约」）。
   - `interval` 用厘秒（Step 2 已归一化）。
   - **`ownership true` 与 `rootInfo true` 都是硬性要求，必须带上**：
     - `ownership true`：实测**默认不输出** `ownership`，不带它热力图恒为空（plan 007 的底部热力概览会永远没数据）。
     - `rootInfo true`：实测**默认不输出** `rootInfo`，不带它 plan 005 的 `root` 恒为 `None`，帧会**静默降级**为最佳手统计（胜率抖动明显、与批处理路径不一致）。
     - 二者都是"不加就静默出错、不加不报错"的类型，**必须显式断言**（见 Done criteria）。
5. 返回新的世代号，供前端做乐观校验。

`stop` 行为：调用 `GtpSession::send_bare_newline()`（plan 004 提供；这是终止 `kata-analyze` 的规范手段），自增世代号，`target_turn = None`。

**注意**：不要在本命令里 `close()` 会话——保持引擎进程存活以便下次快速分析，这正是长驻会话的价值。只有在 `katago_start_live_review` 重新启动或应用退出时才 `close()`。

**Verify**: `cargo check -p lizzieyzy-next-desktop` → exit 0。

### Step 4: 注册 state 与命令，补前端 wrapper

1. 在 `.manage(...)` 链（`:4964` 附近）加 `.manage(Mutex::new(LiveReviewSession::default()))`，并给 `LiveReviewSession` 实现 `Default`。
2. 在 `generate_handler![...]`（`:4977` 起）加入 `katago_start_live_review`、`katago_live_review_set_position`、`katago_live_review_stop`。
3. 在 `apps/desktop/src/api/backend.ts` 新增：

```ts
export type LiveReviewFramePayload = {
  job_id: string;
  generation: number;
  turn: number;
  /** 该帧局面的走棋方。**仅作元数据**——frame 内的 winrate_black 已是黑视角，前端不要再转换。 */
  to_play: "black" | "white";
  /** **已转换为黑视角**（plan 005 Step 3b 完成）。前端直接渲染，禁止二次转换。 */
  frame: AnalysisFrameDto;
};

export type LiveReviewEndedPayload = {
  job_id: string;
  generation: number;
  reason: string;
};

export type LiveReviewEventHandlers = {
  onFrame?: (payload: LiveReviewFramePayload) => void;
  onEnded?: (payload: LiveReviewEndedPayload) => void;
};

export async function startLiveReview(profile: EngineProfileDto, boardSize: number, turn: number, intervalCentisec: number): Promise<string>;
export async function setLiveReviewPosition(moves: string[], turn: number, intervalCentisec: number): Promise<number>;
export async function stopLiveReview(): Promise<void>;
export async function listenToLiveReviewEvents(handlers: LiveReviewEventHandlers): Promise<() => void>;
```

wrapper 必须**沿用既有 `isTauriRuntime()` 守卫**（`apps/desktop/src/api/backend.ts:212`），浏览器预览下返回安全的空值/`() => undefined`，与既有 wrapper 一致。

**Verify**:
1. `cargo check -p lizzieyzy-next-desktop` → exit 0
2. `cd apps/desktop && npm run build` → exit 0

### Step 5: 补单元测试（覆盖纯函数与 registry 行为）

在 `apps/desktop/src-tauri/src/lib.rs` 测试模块新增：

1. `accepts_live_info_line_rejects_stale_generation` — 传 `line_generation=1, current=2`，断言 `false`。
2. `accepts_live_info_line_rejects_stale_turn` — 世代相同但 `line_target_turn=5, current=Some(7)`，断言 `false`。
3. `accepts_live_info_line_accepts_matching_generation_and_turn` — 二者都匹配，断言 `true`。
4. `accepts_live_info_line_rejects_when_no_target` — `current_target_turn=None`，断言 `false`（停止后不应再有帧）。
5. `live_review_set_position_bumps_generation` — 构造一个 `LiveReviewSession`，记录世代号，模拟自增后断言单调递增。
6. `live_review_default_interval_is_ten_centisec` — 断言 `interval_centisec = 0` 时归一化为 `10`。

**结构参照**：`:5160` 起的 `katago_cancel_registry_*` 测试（registry 行为的单测范式）。

若某个断言需要真实引擎才能做，**不要写**该测试；如实报告该行为未自动化覆盖。

**Verify**: `cargo test -p lizzieyzy-next-desktop` → all pass，且 6 个新测试出现在输出。

### Step 6: 门禁

**Verify**（逐条）:

1. `cargo fmt --all --check` → exit 0
2. `cargo clippy --workspace --all-targets -- -D warnings` → exit 0
3. `cargo test --workspace` → all pass
4. `cd apps/desktop && npm run build` → exit 0
5. `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed

## Test plan

- 新增 6 个测试（Step 5），全部覆盖**纯函数**与 state 变换，不需要真实引擎。
- 结构参照：`apps/desktop/src-tauri/src/lib.rs:5160` 起的 `katago_cancel_registry_*`。
- **未覆盖（必须如实报告）**：命令的端到端行为（真实引擎握手、`kata-analyze` 实际输出、事件送达前端）。**本机现已安装可用 KataGo**（见 `plans/KATAGO_LOCAL_ENV.md`），执行者可**手工**跑一次真实引擎做端到端确认（`gtp.cfg` + bundle 权重），但**不要**把它写进自动化测试。若未做手工验证，报告须明确标注「未做端到端验证」。
- 验证：`cargo test --workspace` → all pass，含 6 个新测试。

## Done criteria

全部成立才算完成：

- [ ] `cargo fmt --all --check` exit 0
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` exit 0
- [ ] `cargo test --workspace` exit 0；Step 5 的 6 个新测试通过
- [ ] `grep -nF 'fn accepts_live_info_line(' apps/desktop/src-tauri/src/lib.rs` 有 1 处匹配（**必须锚定左括号**：Step 5 的 4 个测试名如 `accepts_live_info_line_rejects_stale_generation` 均以该串为前缀，用裸子串 grep 会匹配到 5 行）
- [ ] `grep -c 'katago_start_live_review\|katago_live_review_set_position\|katago_live_review_stop' apps/desktop/src-tauri/src/lib.rs` ≥ 6（3 个定义 + 3 个注册）
- [ ] `grep -n 'katago://live-review-frame' apps/desktop/src-tauri/src/lib.rs apps/desktop/src/api/backend.ts` 两侧各有匹配
- [ ] `kata-analyze` 命令字符串**同时**含 `ownership true` 与 `rootInfo true`（实测二者默认都不输出，漏掉任一即静默降级）
- [ ] `LiveReviewFramePayload` 含 `to_play` 字段，且 `frame` 的文档注释明确声明「**已转换为黑视角**」；`apps/desktop/src/api/backend.ts` 的 TS 类型注释同样声明
- [ ] **`kata_analyze_line_to_frame` 的 `perspective` 实参恒为 `PlayerColor::Black`**（不得传 `player`/走棋方）——结构化核验：读转发循环的调用点，确认实参是常量 `Black` 而非变量 `player`/`to_play`
- [ ] `grep -n 'perspective' apps/desktop/src-tauri/src/lib.rs` 的每个实参位置**不含** `player` 变量（防双重转换；plan 005 测试 15 为单元级防线，本条为集成级）
- [ ] `grep -n '1.0 -\|1.0-' apps/desktop/src` **无匹配**（前端**没有**任何视角二次转换——转换只在 plan 005 的 Rust 侧发生一次）
- [ ] `cd apps/desktop && npm run build` exit 0
- [ ] 既有的 `katago_analyze_once` / `katago_analyze_game` / `katago_start_analyze_game` / `katago_cancel_analysis` 及其测试全部未改动
- [ ] `git status` 的改动文件仅为 `apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src/api/backend.ts`（若动了 `domain/types.ts`，须在报告中说明理由）
- [ ] `plans/README.md` 中本计划状态行已改为 `DONE`

## STOP conditions

出现以下任一情况，停止并报告，不要即兴发挥：

- `engine_manager::GtpSession` 不存在（plan 004 未合入）或 `katago_protocol::parse_kata_analyze_line` 不存在（plan 005 未合入）。**不要**自行实现它们。
- `GtpSession` 的公开 API 不足以完成本计划（例如没有 `send_command` 或不支持所有权转移进线程）。报告缺口，建议追加计划，不要改 004。
- `GtpSession` 无法移入 `std::thread`（例如含不可 `Send` 的字段）。这是 plan 004 的设计缺陷，**报告**，不要用 `Arc<Mutex<GtpSession>>` 就地绕过（那会改变锁语义并可能死锁）。
- 你发现把 `GtpSession` 放进 Tauri 的 `State<Mutex<...>>` 后，转发线程与会话之间存在所有权冲突无法用 `std` 手段解决——报告并停下。
- 需要改动 Scope 之外的任何文件，或需要新增依赖。
- `cargo test --workspace` 出现除 README 所述 2 个既有 macOS `/tmp` 失败之外的新失败。

## Maintenance notes

- **⚠️ 若你新增 `EngineManagerError` 消费点，注意穷尽 match**：`apps/desktop/src-tauri/src/lib.rs` 的 `engine_error_kind`（`:1272`）对 `EngineManagerError` 做**无通配臂**的 match。本计划**不新增错误变体**（那属 plan 004），但若你新增了消费 `EngineManagerError` 的 match，同样需保证穷尽，否则 `--workspace` 门禁 E0004 / exit 101（详见 plan 004 的「下游联动说明」）。
- **验收口径**：改动面用 **path-scoped** 判定（`git status --porcelain -- <声明路径>`），**并且**单独跑 `cargo test --workspace` / `cargo clippy --workspace --all-targets`——**不要用路径 grep 代替 workspace 编译验证**（路径 `apps/desktop/src` 不含 `apps/desktop/src-tauri`，会漏掉跨 crate 阻断点）。
- **谁依赖这个**：plan 007 会在 `App.tsx` 里调用这三个命令、监听两个新事件，并在切手时调 `set_position`。007 **不应**修改本计划的守卫语义。
- **守卫是核心价值**：审阅者应重点确认——(a) 转发线程在**读取时**快照世代/目标，而非在**发射时**读取共享状态（后者会引入竞态）；(b) `set_position` **确实**自增世代号（漏掉这一步会让守卫失效，实时复盘会出现错位帧）；(c) `stop` 后 `target_turn` 置 `None`，使守卫拒绝后续残余帧。
- **⚠️ 视角契约是第二个核心价值**：`kata-analyze` 报的视角由引擎 `reportAnalysisWinratesAs` 决定，而本项目已在 plan 003 用 `-override-config` 固定为黑视角；DTO 也约定黑视角。本计划**采用**「payload 送已转换的黑视角值 + 额外 `to_play` 元数据」方案。审阅者应确认：(a) `kata_analyze_line_to_frame` 的 `perspective` 实参**是常量 `Black`**，不是 `player`/走棋方（**传走棋方会双重转换**，见上方「视角契约」的实测演示）；(b) 前端**没有**任何二次转换（`grep '1.0 -' apps/desktop/src` 无匹配）；(c) `player` 只用于 `kata-analyze` 的实参与 payload 的 `to_play` 元数据。
- **`player` 与 `perspective` 是两个语义**：前者"轮谁走棋"（影响搜索），后者"引擎本次输出用哪个视角"（影响编码）。二者在本项目的 override 配置下**恰好不同**（`player` 随局面变、`perspective` 恒为 `Black`）。把它们当成同一个值是本计划最隐蔽的缺陷来源。
- **`ownership true` / `rootInfo true` 必须显式带上**：实测二者**默认都不输出**。漏 `ownership true` → 热图恒空（plan 007）；漏 `rootInfo true` → `root` 恒 `None`，帧静默降级为最佳手统计（与批处理路径数值不一致，且胜率抖动明显）。**二者都是"不报错但结果错"的类型**，审阅者应逐字确认命令字符串含这两个 flag。
- **单会话不变量**：`katago_start_live_review` 会先 `close()` 旧会话。这意味着**同一时刻只有一个实时引擎**。Java 支持双引擎（`leelaz`/`leelaz2` 用于对弈双盲等场景），本仓库**有意不做**——那是独立的一档工作。
- **事件体积**：`katago://live-review-frame` 携带完整 `AnalysisFrameDto`（含最多 361 个 ownership 浮点与多个 candidate 的 pv）。默认 10 厘秒一行时，这是每秒 10 次、每次可能数 KB 的 IPC。**当前可接受**，但如果前端出现卡顿，第一个该测的就是这个事件的序列化与反序列化开销，而不是先怀疑渲染。
- **未实现但相关**：
  - **ponder（思考中分析）**：即"引擎在等对手落子时继续分析"。Java 有完整的 ponder 状态机（`Leelaz.java:22386` 起）。本轮不做。
  - **引擎对弈（`genmove`）**：不在本轮。
  - **引擎信息面板**（版本、后端、权重名）：Java 启动时会发 `name`/`version`/`list_commands`（`Leelaz.java:1294-1299`）。本计划**只发 `boardsize`**。若前端需要显示引擎信息，应作为独立小计划追加。
- **`komi` 已支持但由调用方决定**：`set_position` 接受可选 `komi`，调用方（plan 007）从 SGF 的 `KM` 传入。若 plan 007 未传，分析会退化为引擎配置默认值，收官目差可能偏差。审阅者应确认 007 确实传了 komi。
- **引擎信息未采集**：Java 启动时发 `name`/`version`/`list_commands`（`Leelaz.java:1294-1299`）以显示引擎名与能力（例如据此决定是否支持 `movesOwnership`）。本计划**只发 `boardsize`/`komi`/`clear_board`/`play`**。若将来需要显示引擎信息或按能力降级，应作为独立小计划追加。
