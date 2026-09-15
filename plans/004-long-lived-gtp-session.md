# Plan 004: engine-manager 长驻 GTP 会话内核

> **已按 `plans/GTP_LIVE_PROBE_FINDINGS.md` 修订（2026-09-13）**：新增 §4 的「发送/读取异步分发」硬性要求（管道批量缓冲实测）、明确 `=` 响应不得同步等待、明确 `kata-analyze` 无需命令编号、更新 Drift check 基底、移除「本机未安装 KataGo」的过时描述。**同日追加裁定**：Step 1 新增错误变体时，In-scope 临时扩展到 `apps/desktop/src-tauri/src/lib.rs` 的 `engine_error_kind` match 补臂（否则 `--workspace` 门禁 E0004 必然失败——t10 实执行即卡在此）。
>
> **Executor instructions**: 按步骤执行，每步先跑验证命令、确认预期结果再进入下一步。若出现 "STOP conditions" 中的任一情况，停止并报告，不要即兴发挥。完成后更新 `plans/README.md` 中本计划的状态行。
>
> **Drift check（先跑）**: `git diff --stat b7f33a2..HEAD -- crates/engine-manager/src/lib.rs`
> **基底说明（已更新）**：工作树 HEAD 已推进到 **`92dcfe8`**（含 001/002/UI 提交），`b7f33a2..HEAD` 会显示与本计划无关的既有改动。**判据**：只关心 `crates/engine-manager/src/lib.rs` 是否已被 plan 003 改动（`build_command_spec` 的 GTP 分支是否已带 `-model`/`-config`、`check_assets` 是否已要求 GTP 资产）。若 plan 003 已合入，先读现网代码再动手；本计划 "Current state" 的摘录仍以基准提交为准，**若与现网冲突以现网为准并在报告中说明差异**。

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans/003-nonblocking-analysis-and-gtp-spec.md（提供带 `-model`/`-config` 的 GTP `CommandSpec`）
- **Category**: tech-debt（架构能力）
- **Planned at**: commit `b7f33a2`, 2026-09-12
- **Revised**: 2026-09-13，按 `plans/GTP_LIVE_PROBE_FINDINGS.md` 实测规格修订（见顶部说明与 Step 4 的异步分发要求）

## Why this matters

本仓库当前**没有长驻引擎会话**能力。每次分析都 spawn 一个新进程、写完 stdin、读到期望行数、进程退出。证据：

- `run_katago_analysis_batch_with_options`（`crates/engine-manager/src/lib.rs:174`）在函数内 `command.spawn()`（`:190`），函数结束即进程终结。
- `run_katago_analysis_once`（`:512`）同样在函数内 spawn 并等待退出。
- 全仓 `grep` 无 `ponder`、无 `kata-analyze`、无命令编号管理。

这就是为什么实时复盘做不到：实时复盘要求**同一个引擎进程持续存在**，用户每次换手只是往这个进程写一条新命令，引擎不断推送 `info` 行，界面持续刷新。Java 主线正是这个模型——`Leelaz.java` 持有长驻进程，`kata-analyze` 异步运行、收到新命令或裸换行时终止（[KataGo GTP_Extensions.md](https://raw.githubusercontent.com/lightvector/KataGo/master/docs/GTP_Extensions.md)："This command is a bit unusual for GTP in that it will run forever on its own, but asynchronously if any new GTP command or a raw newline is received, then it will terminate."）。

本计划只做**会话内核**：进程生命周期、命令发送、行读取线程、`stop` 语义、优雅关闭、错误与退出传播。**不做** `info` 行解析（plan 005）、**不做** Tauri 命令（plan 006）。

**为什么 Risk 是 HIGH**：进程生命周期与两个后台线程（stdout/stderr）的所有权、关闭时序、以及"子进程不泄漏"是本仓库最容易出错的地方。既有代码的 reader 线程模型（`spawn_stdout_lines_reader`，`:743`）是为"读到 EOF 就结束"设计的，长驻会话下 EOF 只应发生在引擎崩溃时。

## Current state

**关键文件**

- `crates/engine-manager/src/lib.rs`（1,445 行，单文件 crate）— 唯一改动文件。
- 依赖只有 `app-model`、`serde`、`thiserror`（见 `crates/engine-manager/Cargo.toml`）。**没有 tokio，本计划也不引入。**

**摘录 1：现有 API 全貌**（`crates/engine-manager/src/lib.rs`，行号见表）

| 行 | 项 |
|---|---|
| 16 | `pub struct CommandSpec { program, args, working_dir, env }` |
| 23 | `pub struct AssetCheck` |
| 30 | `pub struct AnalysisRunResult` |
| 36 | `pub struct AnalysisBatchRunResult` |
| 42 | `pub struct AnalysisBatchProgress` |
| 48 | `pub struct AnalysisCancelToken`（内含 `Arc<AtomicBool>`） |
| 64 | `pub struct AnalysisBatchRunOptions<'a>` |
| 81 | `pub enum EngineManagerError`（`thiserror`） |
| 348 | `pub fn build_command_spec` |
| 409 | `pub fn check_assets` |
| 512 | `pub fn run_katago_analysis_once` |

**摘录 2：现有进程构造（会被会话复用）**（`crates/engine-manager/src/lib.rs:697-714`）

```rust
fn build_process_command(spec: &CommandSpec) -> Command {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(working_dir) = spec.working_dir.as_ref().filter(|value| !value.trim().is_empty()) {
        command.current_dir(working_dir);
    }
    for (key, value) in &spec.env {
        command.env(key, value);
    }

    command
}
```

**摘录 3：现有行读取线程（长驻场景需扩展）**（`crates/engine-manager/src/lib.rs:743-768`，节选）

```rust
fn spawn_stdout_lines_reader(stdout: std::process::ChildStdout) -> Receiver<io::Result<Option<String>>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(Ok(None));
                    break;
                }
                Ok(_) => {
                    if tx.send(Ok(Some(trim_line_ending(line)))).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(error));
```

`Ok(0)` 是 EOF，只在引擎退出时发生。这个线程结构可直接复用。

**摘录 4：取消令牌**（`crates/engine-manager/src/lib.rs:48-62`）

```rust
pub struct AnalysisCancelToken {
    cancelled: Arc<AtomicBool>,
}
impl AnalysisCancelToken {
    pub fn new() -> Self { ... }
    pub fn cancel(&self) { self.cancelled.store(true, Ordering::SeqCst); }
    pub fn is_cancelled(&self) -> bool { self.cancelled.load(Ordering::SeqCst) }
}
```

**摘录 5：测试造假引擎的范式**（`crates/engine-manager/src/lib.rs:960-1005`）

```rust
    struct TestTempDir { path: PathBuf }
    impl TestTempDir {
        fn new(label: &str) -> Self { ... }   // 建在 std::env::temp_dir().join("lizzieyzy-engine-manager-tests")
        fn path(&self) -> &Path { &self.path }
    }
    impl Drop for TestTempDir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.path); } }

    #[cfg(unix)]
    fn fake_engine_spec(temp_dir: &TestTempDir, script: &str) -> CommandSpec {
        let script_path = temp_dir.path().join("fake-engine.sh");
        std::fs::write(&script_path, format!("#!/bin/sh\n{script}\n")).unwrap();

        CommandSpec {
            program: "/bin/sh".into(),
            args: vec![script_path.to_string_lossy().into_owned()],
            working_dir: None,
            env: vec![],
        }
    }
```

**必须沿用这个范式**：所有会话测试都用 `/bin/sh` 假引擎脚本驱动（保持测试可移植、不依赖引擎）。**本机现已安装可用 KataGo**（见 `plans/KATAGO_LOCAL_ENV.md`），需要手工端到端确认时可另跑真实引擎，但**不要**把真实引擎写进 `cargo test`。

**协议事实（来自 KataGo 官方文档，权威）**

- `kata-analyze [player] [interval] KEYVALUEPAIR...`。`player` 可选，`interval` 是**厘秒**（centiseconds）；也可用 `interval CENTISECONDS` 键值对指定。
- `rootInfo true` 输出根节点统计（总 visits、winrate 等），推荐用于统计而非跨手累加。
- `ownership true` 输出每个点的预测归属。
- 该命令**自行运行不停**，但收到**任何新 GTP 命令或裸换行**时终止；终止时仍会输出常规的双换行 GTP 响应结束标记。
- 输出行以 `info` 开头，一行内可含多个 `info ...` 块（用空格分隔的 `info` 关键字划分）。

因此**停止分析的规范做法是发送一个裸换行（或 `stop`）**。Java 用的是 `sendCommand("stop")`（`src/main/java/featurecat/lizzie/analysis/Leelaz.java:8391`、`:8594`）。

**仓库约定**

- 单文件 `lib.rs`，追加不拆模块。当前 1,445 行，加会话代码后会显著变长——**若超过约 2,500 行**，可在报告中建议拆分，但**本计划内不要拆**（拆分会让 diff 难以审阅）。
- 错误统一进 `EngineManagerError`（`thiserror`），用 `#[error("...")]` 描述性消息，含上下文（program、exit_code、stderr），照 `:81-160` 的风格。
- 测试内联 `#[cfg(test)] mod tests`，测试名 snake_case 描述句，如 `analysis_batch_cancel_token_kills_process_and_returns_partial_stdout`（`:1242`）。
- 模块内 `use` 集中在文件顶部（现有：`std::io`、`std::process`、`std::sync::atomic`、`std::sync::mpsc`、`std::thread`、`std::time`、`thiserror`）。

## Commands you will need

前置：`export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`

| Purpose | Command | Expected on success |
|---|---|---|
| 编译 | `cargo check --workspace --all-targets` | exit 0 |
| 定向测试 | `cargo test -p engine-manager` | all pass |
| 全量测试 | `cargo test --workspace` | all pass |
| 格式 | `cargo fmt --all --check` | exit 0 |
| 静态检查 | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |

**重要**：`cargo test -p engine-manager` 必须能在**无 KataGo** 的机器上全过。若你的新测试需要真实引擎，设计错误。

## Scope

**In scope**

- `crates/engine-manager/src/lib.rs` — 新增长驻会话类型与其错误变体、单元测试
- `apps/desktop/src-tauri/src/lib.rs` — **仅限** `engine_error_kind`（`:1272`）的 match 补臂（Step 1 裁定；每新增一个错误变体必须补一行，否则 `--workspace` 门禁 E0004 失败）。**除该 match 外不得改动该文件。**

**Out of scope**

- **不要**碰 `crates/katago-protocol/`（`info` 行解析是 plan 005）。
- **不要**碰 `apps/desktop/src-tauri/src/lib.rs`（Tauri 命令是 plan 006）——**唯一例外见上方 In-scope 的 `engine_error_kind` 补臂**。不要顺手改其它任何命令、事件或 state。
- **不要**碰任何前端文件。
- **不要**修改既有的 `run_katago_analysis_batch*` / `run_katago_analysis_once` / `build_command_spec` / `check_assets` 的行为。它们是既有批处理路径（plan 003 会改 `build_command_spec` 的 GTP 分支，那是 003 的事）。本计划是**纯新增**。
- **不要**新增依赖（不加 tokio / async-std / crossbeam）。用 `std::sync::mpsc` + `std::thread`，与现有风格一致。
- **不要**实现 ponder（思考中分析）——那是后续计划。
- **不要**实现 `genmove`（引擎对弈）——不在本轮范围。

## Git workflow

- 分支：`advisor/004-long-lived-gtp-session`
- 提交示例：`feat(engine): add long-lived gtp session for streaming analysis`
- **不要推送、不要开 PR**，除非操作者指示。

## Steps

### Step 1: 定义会话错误变体

在 `EngineManagerError`（`crates/engine-manager/src/lib.rs:81`）中新增变体（保持既有变体不动）：

```rust
    #[error("engine session is not running")]
    SessionNotRunning,
    #[error("engine session already exited with code {exit_code:?}: {stderr}")]
    SessionExited { exit_code: Option<i32>, stderr: String },
    #[error("failed to write command to engine session: {source}")]
    SessionWrite { source: std::io::Error },
    #[error("engine session stop was acknowledged without the engine closing the stream")]
    SessionStopUnconfirmed,
```

**⚠️ 新增变体会牵连 `apps/desktop/src-tauri/src/lib.rs`（裁定，2026-09-13，必读）**

`apps/desktop/src-tauri/src/lib.rs` 的 `engine_error_kind`（`:1272`）对 `EngineManagerError` 做**穷尽 match（无通配臂）**。**每新增一个错误变体，该 match 就会 E0004 编译失败**，因此 `cargo check --workspace --all-targets` 与 `cargo test --workspace` 必然挂掉。

这与本计划 Out-of-scope 的「**不要**碰 `apps/desktop/src-tauri/src/lib.rs`」**直接冲突**——t10 实执行时正是卡在这里（实现本身正确且单 crate 测试全绿，但 `--workspace` 门禁无法通过，且执行者无权越界修）。

**裁定：本步骤的 In-scope 临时扩展到 `apps/desktop/src-tauri/src/lib.rs`，仅限 `engine_error_kind` 的 match 补臂**（每个新变体加一行映射，字符串用 camelCase，照既有风格）。除该 match 外**仍不得改动该文件**。执行者应：

1. 新增变体后，先跑 `cargo check --workspace --all-targets`，确认 E0004 的报错点；
2. 只在 `engine_error_kind` 里补 4 个臂（`"sessionNotRunning"` / `"sessionExited"` / `"sessionWrite"` / `"sessionStopUnconfirmed"`）；
3. 在提交信息与完成报告中**显式说明这是 In-scope 的定向扩展**，便于 reviewer 判定不属越界。

> **为什么不让 plan 006 事后补**：那会让 plan 004 的 `--workspace` 门禁在 004 阶段就是红的，违反"每个计划自身门禁全绿"的验收前提；且新增变体的归属是 004，让 006 承担会破坏计划边界的可读性。

**Verify**: `cargo check -p engine-manager` → exit 0；`cargo check --workspace --all-targets` → exit 0（需完成上述 match 补臂）。

### Step 2: 定义会话类型与句柄

在同一文件新增（放在 `AnalysisCancelToken` 附近，保持公开类型聚集）：

```rust
/// 一条已从引擎 stdout 读出的行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GtpSessionEvent {
    /// 引擎 stdout 的一行原始文本（已去除行尾）。
    Line(String),
    /// 引擎 stdout 到达 EOF；附带退出码（若已能取到）。
    Eof { exit_code: Option<i32> },
    /// 读取 stdout 出错。
    ReadError(String),
}

/// 长驻 KataGo GTP 会话。
pub struct GtpSession {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    events: std::sync::mpsc::Receiver<GtpSessionEvent>,
    stderr_snapshot: std::sync::Arc<std::sync::Mutex<String>>,
    closed: bool,
}
```

要点：

- `stdin` **取出并持有**（不像现有一次性路径那样在 `write_query` 里临时 `take()`），因为会话要反复写。
- `events` 是**单消费者**通道，`Receiver` 归会话所有。调用方通过 `GtpSession::next_event_timeout` 拉取（Step 4），而不是让调用方持有 receiver——这样会话能保证关闭时统一清理。
- `stderr_snapshot` 用 `Arc<Mutex<String>>` 累积 stderr，供 `close()` 与非零退出错误携带上下文。
- `closed` 防止重复关闭。

**Verify**: `cargo check -p engine-manager` → exit 0（此时可能有 dead_code 警告，clippy 门禁在 Step 6 才跑）。

### Step 3: 实现 `GtpSession::start`

```rust
impl GtpSession {
    pub fn start(spec: &CommandSpec) -> Result<Self, EngineManagerError> { ... }
}
```

实现要求：

1. 用现有的 `validate_command_spec`（`:670`）校验 spec。
2. 用现有的 `build_process_command`（`:697`）构造命令。**复用，不要重写**。
3. `spawn()`，把 `spawn` 失败映射为既有的 `EngineManagerError::Spawn { program, source }`。
4. 取出 `stdout`、`stderr`、`stdin`（三者都已 piped）。取出失败时 `expect` 并附上与现有代码一致的说明——现有代码用的是 `expect("stdout is piped before spawning the engine")`（`:198`），沿用同样风格。
5. 起 **stderr 线程**：循环 `read_line`，把内容追加进 `Arc<Mutex<String>>`，EOF 或错误时结束。
6. 起 **stdout 线程**：循环 `read_line`，向 `events` 通道发送 `GtpSessionEvent::Line(...)`；`Ok(0)` 时发送 `Eof { exit_code: None }` 并结束；`Err` 时发送 `ReadError(...)` 并结束。
   - EOF 时若想带退出码，可在发送 `Eof` 前尝试 `child.wait()`——但 `child` 已被 `GtpSession` 持有，线程拿不到。**因此 `Eof` 事件不带退出码，由 `close()` 在 join 后补齐**（见 Step 5）。把 `GtpSessionEvent::Eof` 的字段语义在文档注释里写清。

**Verify**: `cargo check -p engine-manager` → exit 0。

### Step 4: 实现发送与接收

```rust
impl GtpSession {
    /// 发送一条 GTP 命令（自动补换行）。不等待响应。
    pub fn send_command(&mut self, command: &str) -> Result<(), EngineManagerError>;

    /// 发送一个裸换行，用于终止正在运行的 analyze 类命令。
    pub fn send_bare_newline(&mut self) -> Result<(), EngineManagerError>;

    /// 等待下一条事件，最多等 timeout。
    pub fn next_event_timeout(&self, timeout: Duration) -> Option<GtpSessionEvent>;

    /// 当前累积的 stderr 快照。
    pub fn stderr_snapshot(&self) -> String;
}
```

实现要点：

- `send_command`：清洗命令中的 `\r`/`\n`（**防止命令注入进 GTP 流**——命令里含换行会把一条命令变成多条，这是真实风险，务必过滤），追加 `\n`，`write_all` + `flush`。写失败映射为 `SessionWrite`。
- `send_bare_newline`：只写 `b"\n"` 并 flush。这是停止 `kata-analyze` 的规范手段（见 "协议事实"）。
- `next_event_timeout`：`self.events.recv_timeout(timeout).ok()`。返回 `None` 表示超时（不是错误）。
- `stderr_snapshot`：`lock().map(|g| g.clone()).unwrap_or_default()`（锁中毒时降级为空串，不要 panic）。

### Step 4b: ⚠️ 发送/读取必须异步分发（实测要求，**不是可选优化**）

**实测事实**（`GTP_LIVE_PROBE_FINDINGS.md` §4）：GTP 管道存在**批量缓冲**。连发 5 条命令后，它们的 `=` 响应在约 1.5 秒后**同一时间戳批量到达**：

```
[1.49s] '='      ← boardsize
[1.49s] ''
[1.49s] '='      ← komi
[1.49s] ''
[1.49s] '='      ← clear_board
[1.49s] ''       ← 5 个 '=' 全部同一时间戳（gaps 0.000s）
...
```

**因此本步骤是硬性要求**：

1. **绝不 `send` 后同步阻塞等待 `=` 响应。** 等待时长不确定（取决于后续是否有数据冲刷管道），且**等待期间无法处理引擎主动推送的 `info` 行**——实时复盘会彻底失去实时性。
2. 发送与读取**完全解耦**：写路径只负责 `write_all` + `flush`；常驻 stdout 读线程负责把每行按类别分发（`=`/`?` 响应 vs `info` 流 vs 空行）。
3. 需要"命令已确认"语义时，用**命令编号做异步匹配**，而不是阻塞等待。
   - **`kata-analyze` 不需要编号**：它是流式的，没有"单次响应"，靠裸换行/新命令终止。**不要**为它引入编号机制。
   - `boardsize` / `komi` / `play` / `clear_board` 需要确认语义，用编号异步匹配。
4. 启动时**不做同步握手探测**；`boardsize`/`komi`/摆子按序异步发出即可。
5. 本计划已交付的 `GtpSession::send_command`（**不等待响应**）+ `next_event_timeout`（拉取式）**天然满足**该要求——**不要**为了让"send 后能拿到 `=`"而改成阻塞式 API。若审阅者或后续计划要求 `send_and_wait`，应作为独立小计划追加，**不要**改 `GtpSession` 的语义。

> **Rust 侧必须实测确认**：上述批量行为实测于 macOS + Python `select`，Rust `BufReader` 读线程模型下**未必相同**。执行者应在 Rust 侧用一个假引擎脚本（或真实引擎）确认读取时序，**不能直接假定"Rust 就没这个问题"**。但无论实测结果如何，第 1–2 条（解耦）都必须满足。
>
> **建议的验证方式**：写一个假引擎脚本，在收到 N 条命令后**一次性**（而非逐条）输出全部响应，断言 `send_command` 不阻塞、且随后 `next_event_timeout` 能一次性按序读到全部响应行。

**Verify**: `cargo check -p engine-manager` → exit 0；并新增一个假引擎测试覆盖"响应批量到达时不阻塞"（见 Step 6 测试 8）。

### Step 5: 实现 `close` 与 `Drop`

```rust
impl GtpSession {
    /// 优雅关闭：终止在跑的分析、关闭 stdin、等待进程退出、join 读取线程。
    pub fn close(&mut self) -> Result<Option<i32>, EngineManagerError>;
}

impl Drop for GtpSession {
    fn drop(&mut self) { let _ = self.close(); }
}
```

实现要求：

1. 幂等：若 `closed` 为真直接返回 `Ok(None)`。
2. 先 `send_bare_newline()`（尽力而为，失败不致命）。
3. 再 `drop` 掉 stdin（`ChildStdin` 需要被替换为 `Option` 或通过 `std::mem::replace` 拿走，才能主动关闭——**设计决定**：把字段类型设为 `Option<std::process::ChildStdin>`，关闭后置 `None`。Step 2 的类型定义需相应调整，请在实现时统一）。
4. `child.wait()` 取退出码。为防引擎卡死不退，先 `try_wait()`；若仍在运行，调用 `child.kill()` 再 `wait()`。
5. `closed = true`，返回退出码。
6. `Drop` 调用 `close()` 并忽略错误——**保证子进程不泄漏**。这是本计划最重要的正确性目标。

**Why this matters**：若 `Drop` 不 kill，用户每次切换引擎都会泄漏一个 KataGo 进程，长会话下会累积成资源灾难。

**Verify**: 用一个假引擎脚本测试（Step 6），确认 `close()` 后进程已退出。

### Step 6: 新增单元测试（用假引擎脚本，不需要真实 KataGo）

在测试模块新增至少以下测试。全部用 `fake_engine_spec`（`:994`）范式，`#[cfg(unix)]`。

1. `gtp_session_streams_multiple_lines_from_fake_engine`
   - 脚本：`printf 'info move D4 visits 1\ninfo move Q16 visits 2\n'; sleep 5`
   - 断言：`next_event_timeout` 依次读到两行 `Line`，内容与脚本输出一致。

2. `gtp_session_send_command_reaches_fake_engine_stdin`
   - 脚本：`read line; printf 'got %s\n' "$line"; sleep 5`
   - 断言：`send_command("kata-analyze B 10")` 后，能读到 `Line("got kata-analyze B 10")`。

3. `gtp_session_send_command_strips_newlines`
   - 脚本同 2。
   - 断言：`send_command("a\nb")` 后读到的是 `got ab`（换行被剥离），**而不是**两条命令。这是反命令注入的回归测试。

4. `gtp_session_reports_eof_when_fake_engine_exits`
   - 脚本：`printf 'info move D4 visits 1\n'`
   - 断言：先读到 `Line`，再读到 `Eof { .. }`。

5. `gtp_session_close_terminates_child_process`
   - 脚本：`sleep 30`
   - 断言：`close()` 在合理时间内（测试自身用 `Duration` 上限保护）返回；返回后 `is_cancelled` 无关，改为断言 `close()` 返回 `Ok(_)` 且第二次 `close()` 幂等返回 `Ok(None)`。

6. `gtp_session_drop_terminates_child_process`
   - 脚本：`sleep 30`；在一个作用域内 `start` 后直接 drop。
   - 断言：drop 后进程不再存活。判定方式：脚本把 PID 写到临时文件（`echo $$ > pidfile; sleep 30`），测试在 drop 后读该文件并检查进程是否仍在（用 `kill -0 <pid>` 的等价 `std::process::Command` 调用）。**若这一实现过于脆弱，可退化为只断言 `close()` 路径，并在报告中说明。**

7. `gtp_session_bare_newline_is_sent_verbatim`
   - 脚本：`read line; printf 'len %s\n' "${#line}"; sleep 5`
   - 断言：`send_bare_newline()` 后读到 `Line("len 0")`。

8. `gtp_session_send_does_not_block_when_responses_arrive_in_a_batch`（**Step 4b 的回归测试**）
   - 脚本：`read a; read b; read c; printf '=\n\n=\n\n=\n\n'; sleep 5`（三条命令的响应**一次性**输出，模拟实测的管道批量缓冲）
   - 断言：连续三次 `send_command(...)` 均**立即返回**（不被响应等待阻塞），随后 `next_event_timeout` 能按序读到三个 `=` 与空行。**这条测试防止有人把 `send_command` 改成阻塞式等待响应。**
   - 若该假引擎脚本的时序难以稳定表达，可退化为：断言 `send_command` 在引擎**完全没有任何输出**的情况下也能立即返回（脚本为 `sleep 30`，不读 stdin），并在报告中说明退化方式。

**注意测试稳定性**：假引擎用 `sleep` 保持存活，测试必须用 `next_event_timeout(Duration::from_secs(...))` 而非无限等待，避免 CI 挂起。每个测试的总时长控制在数秒内。

**Verify**: `cargo test -p engine-manager` → all pass，且 8 个新测试出现在输出中。

### Step 7: 门禁

**Verify**（逐条）:

1. `cargo fmt --all --check` → exit 0
2. `cargo clippy --workspace --all-targets -- -D warnings` → exit 0（**这一步会因 dead_code 报错**：新 API 尚无调用方。若报 `dead_code`，给新公开项加 `#[allow(dead_code)]` 并在提交信息说明"plan 006 将接入调用方"，**不要**为了让 clippy 过而删掉功能。）
3. `cargo test --workspace` → all pass
4. `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed

## Test plan

- 新增 8 个测试（Step 6），全部基于假引擎脚本，`#[cfg(unix)]`。
- 结构参照：`crates/engine-manager/src/lib.rs:1165` 的 `analysis_once_reads_one_json_response`（读一行）、`:1242` 的 `analysis_batch_cancel_token_kills_process_and_returns_partial_stdout`（进程终止断言）、`:960`/`:994` 的 `TestTempDir`/`fake_engine_spec`。
- 验证：`cargo test -p engine-manager` → all pass，含 8 个新测试。

## Done criteria

全部成立才算完成：

- [ ] `cargo fmt --all --check` exit 0
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` exit 0
- [ ] `cargo test --workspace` exit 0；Step 6 的 8 个新测试通过
- [ ] `grep -n 'pub struct GtpSession' crates/engine-manager/src/lib.rs` 有 1 处匹配
- [ ] `grep -n 'impl Drop for GtpSession' crates/engine-manager/src/lib.rs` 有 1 处匹配
- [ ] `grep -n 'pub fn send_bare_newline' crates/engine-manager/src/lib.rs` 有 1 处匹配
- [ ] `send_command` 的文档注释明确写出「**不等待响应**」，且代码中**没有**任何"发送后阻塞读取直到 `=`"的逻辑（Step 4b）
- [ ] 既有的 `run_katago_analysis_batch*` / `run_katago_analysis_once` 测试全部仍通过（纯新增，无行为变更）
- [ ] **改动面（path-scoped）**：`git status --porcelain -- crates/engine-manager/src/lib.rs apps/desktop/src-tauri/src/lib.rs` 的条目仅为这两个文件，且后者**仅** `engine_error_kind` match 部分被改（Step 1 裁定的定向例外；若有该 match 之外的改动，须在报告中说明理由）
- [ ] **且必须跑跨 crate 编译门禁**：`cargo check --workspace --all-targets` exit 0、`cargo clippy --workspace --all-targets -- -D warnings` exit 0、`cargo test --workspace` exit 0——新增错误变体必须补齐 Tauri 侧 `engine_error_kind` 穷尽 match，否则 E0004 / exit 101
  > **口径说明**：**path-scoped `git status` 与 workspace 编译验证两者都要，不可互相替代**。纯路径式判据（如"未修改 `apps/desktop/src`"）**不含** `apps/desktop/src-tauri`，会漏掉本计划的跨 crate 阻断点——t10 实执行即如此。
- [ ] `plans/README.md` 中本计划状态行已改为 `DONE`

## STOP conditions

出现以下任一情况，停止并报告，不要即兴发挥：

- "Current state" 摘录与现网代码不一致（尤其若 plan 003 已改 `build_command_spec`）。
- 你发现必须新增 crate 依赖（如 tokio）才能实现——**报告并停下**，不要自行加依赖；std 的 `mpsc` + `thread` 足以完成本计划。
- 测试 6（进程泄漏检测）在你的环境无法可靠实现——退化并在报告中**明确标注该风险未自动化验证**，不要假装它通过了。
- `close()` 无法在合理时间内终止假引擎（例如 `kill()` 后 `wait()` 仍阻塞）——报告，这可能意味着需要 `SIGKILL` 或分离的等待线程，属于设计决策。
- clippy 因 dead_code 无法通过，且你不确定是否应该 `#[allow]`——报告，不要删功能也不要改 CI 配置。
- **`--workspace` 门禁因 `engine_error_kind` 的 E0004 失败**：这**不是** STOP condition。按 Step 1 的裁定，在 `apps/desktop/src-tauri/src/lib.rs` 的 `engine_error_kind` 里补 match 臂即可（这是已授权的定向扩展）。只有当该文件**除该 match 外**还需要改动时，才停下报告。
- 需要改动 Scope 之外的任何文件（`engine_error_kind` 的 match 补臂是 Step 1 已授权的例外，不算）。
- `cargo test --workspace` 出现除 README 所述 2 个既有 macOS `/tmp` 失败之外的新失败。

## Maintenance notes

- **⚠️ 下游联动说明（新增 engine-manager 公开枚举变体时必读）**：新增 `EngineManagerError` 变体会**必然**打破下游的穷尽 match。

  `EngineManagerError` 被 `apps/desktop/src-tauri/src/lib.rs` 的 `engine_error_kind`（`:1272`）以**无通配臂**的 match 消费。新增任一变体都会让该 crate 编译失败：

  ```
  error[E0004]: non-exhaustive patterns: `SessionNotRunning`, `SessionExited { .. }`,
                `SessionWrite { .. }` and 1 more not covered
    --> apps/desktop/src-tauri/src/lib.rs:1272:11
  ```
  进而使 `cargo test --workspace` / `cargo clippy --workspace` **exit 101**。

  **需要同步的位置**：`engine_error_kind` 的 match 臂（错误码字符串映射，camelCase）。

  **归属已裁定（2026-09-13）**：本计划 Step 1 已把 In-scope 定向扩展到该 match 的补臂，**不要留给执行者临时抉择**；也**不要**改成"由 plan 006 承担并调整依赖顺序"——那会让 004 阶段的门禁就是红的。**执行者应在完成报告中显式申报该扩展**，便于 reviewer 不将其判为越界。

  > 这条是 t10 实执行踩到的坑：实现本身正确、`-p engine-manager` 全绿，但 `--workspace` 门禁无法通过，且当时计划未授权改 `apps/`，执行者正确地选择不越界 → 任务被判 failed。**属计划缺陷，非实现缺陷。**

- **验收口径澄清（t10 执行者提出，2026-09-13）**：**不要用路径 grep 代替 workspace 编译验证**。路径式判据（如"未修改 `apps/desktop/src`"）**不含 `apps/desktop/src-tauri`**，恰好漏掉本计划这个阻断点；真正抓到它的是 `--workspace` 门禁。
  - **统一口径**：改动面用 **path-scoped** 判定（`git status --porcelain -- <本任务声明路径>`），**并且**单独跑 `cargo test --workspace` / `cargo clippy --workspace --all-targets`。两者都要，不可互相替代。

- **谁依赖这个**：plan 005 会在 `next_event_timeout` 之上写 `info` 行解析；plan 006 会把 `GtpSession` 包成 Tauri state 并暴露命令。两者都**只消费**本计划的 API，不应修改 `GtpSession` 的语义。若 005/006 需要新能力（例如"发命令并等待其编号响应"），应作为独立小计划追加，不要在会话内核里塞业务逻辑。
- **审阅者重点看**：
  1. `Drop` 是否**无条件**保证子进程被回收（这是本计划的核心价值）。
  2. `stdin` 的 `Option` 化是否所有使用点都被更新，避免"关闭后仍尝试写"的 panic。
  3. `send_command` 的换行过滤是否覆盖 `\r`、`\n`、以及 `\r\n`。
  4. 两个读取线程是否在 `close()` 后真正 join（或用可证明的方式保证不泄漏线程）。**当前设计里 `events` 通道在 stdout 线程结束时关闭，但 `stderr` 线程可能需要单独的 join handle**——实现时若发现 stderr 线程无法保证结束，请在报告里说明并考虑持有 join handle。
- **与 Java 的差异（有意为之）**：Java 的 `Leelaz` 是一个 24,889 行的巨类，混杂了引擎生命周期、棋盘状态、UI 刷新、对弈、远程传输。本计划的 `GtpSession` **刻意只做进程与 IO**，不含棋盘与 UI。这是把 Java 的"上帝对象"拆成可测单元的关键一步。
- **未实现但相关**：ponder（思考中分析）、`genmove`（对弈）、远程传输（智子云）、多引擎槽位（Java 的 `leelaz`/`leelaz2` 双引擎）。若将来要支持双引擎，应把 `GtpSession` 设计成可直接实例化两份——目前它没有全局状态，已满足该条件。
- **性能注意**：`next_event_timeout` 是轮询式消费。plan 006 在 Tauri 侧应使用一个专职转发线程把事件转成 Tauri 事件，**不要**在命令处理里忙等。
