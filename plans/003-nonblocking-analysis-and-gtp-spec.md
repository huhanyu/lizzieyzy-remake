# Plan 003: GTP 启动规格补全 + 分析命令非阻塞化

> **已按 `plans/GTP_LIVE_PROBE_FINDINGS.md` 修订（2026-09-13）**：新增「发送与读取解耦」要求（§4 管道缓冲实测）、明确实时复盘必须用 `gtp.cfg`、**新增 `-override-config reportAnalysisWinratesAs=BLACK` 强制固定视角（Step 1 裁定）**、更新 Drift check 基底、移除「本机未安装 KataGo」的过时环境描述。
>
> **Executor instructions**: 按步骤执行，每步先跑验证命令、确认预期结果再进入下一步。若出现 "STOP conditions" 中的任一情况，停止并报告，不要即兴发挥。完成后更新 `plans/README.md` 中本计划的状态行。
>
> **Drift check（先跑）**: `git diff --stat b7f33a2..HEAD -- crates/engine-manager/src/lib.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/components/EngineSetupPanel.tsx`
> **基底说明（已更新）**：本计划原写于 `b7f33a2`，但工作树 HEAD 已推进到 **`92dcfe8`**（含 001 提交 `96132c9`、002 的 `App.tsx`/`AnalysisPanel.tsx` 改动、以及 UI 重构与截图提交）。因此 `b7f33a2..HEAD` 会显示**本计划无关**的既有改动（`crates/katago-protocol/src/lib.rs`、`crates/app-model/src/lib.rs`、`apps/desktop/src/App.tsx`、`EngineSetupPanel.tsx` 等）。
> **判据修正**：不要因为 diff 非空就判 STOP。正确判据是——**`crates/engine-manager/src/lib.rs` 的 `build_command_spec` / `check_assets` 是否已被改动**（若 plan 004 已开工则可能被改）。用 `git diff b7f33a2..HEAD -- crates/engine-manager/src/lib.rs` 看该文件的实际内容变化；若 `build_command_spec` 的 GTP 分支已含 `-model`/`-config`，说明本计划已被他人实现，**停止并报告**。
> 若任一文件的 "Current state" 摘录与现网代码不符，以**现网代码**为准并在报告中说明差异。

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none（但 plan 004 依赖本计划）
- **Category**: bug
- **Planned at**: commit `b7f33a2`, 2026-09-12
- **Revised**: 2026-09-13，按 `plans/GTP_LIVE_PROBE_FINDINGS.md` 实测规格修订；**同日追加裁定**：GTP 启动必须带 `-override-config reportAnalysisWinratesAs=BLACK`（见顶部说明与 Step 1）

## Why this matters

两个独立缺陷，都必须在长驻 GTP 会话（plan 004）之前修掉，否则 004 建立在一个错误的地基上。

**缺陷 A：GTP 后端启动命令缺权重与配置。**

`build_command_spec` 对 `EngineBackend::KataGoGtp` 只产出 `args: ["gtp"]`，**不带 `-model` 与 `-config`**：

```rust
EngineBackend::KataGoGtp => Ok(CommandSpec {
    program,
    args: vec!["gtp".into()],
    working_dir,
    env: vec![],
}),
```

这样启动的 KataGo 没有神经网络权重，无法分析。对照 Java 主线实际发送的命令（`src/main/java/featurecat/lizzie/util/KataGoAutoSetupHelper.java:1991-1996`）：

```
<engine> gtp -model <weight> -config <gtp-config>
```

而 `check_assets` 也把 GTP 后端排除在必需资产校验之外（`requires_analysis_assets` 只匹配 `KataGoAnalysis`，见 `crates/engine-manager/src/lib.rs:410`），所以**用户配错权重路径时 GTP 路径不会报错**，只会在会话建立后静默失败。

目前这个缺陷是**潜伏的**：前端把 `backend` 硬编码为 `"kata_go_analysis"`（`apps/desktop/src/components/EngineSetupPanel.tsx:140`），GTP 后端的代码路径从未被 UI 走到。plan 004 要启用它，因此必须先修。

**缺陷 B：分析命令是同步的，会阻塞 IPC。**

全仓 **48 个 Tauri 命令，`async fn` 数量为 0**。Tauri 的 `#[tauri::command]` 对非 `async fn` 采用 blocking 执行上下文（`tauri-macros` 的 `body_blocking`，见 `Execution Context::Blocking` 分支），即在 IPC handler 内**内联**执行并直接 `respond`；只有 `async fn` 才走 `respond_async_serialized` 投递到异步运行时。

`katago_analyze_once`（`apps/desktop/src-tauri/src/lib.rs:2134`）内部调用 `run_katago_analysis_once(..., Duration::from_secs(60))`（`:2157`）——**最坏要阻塞 60 秒**。`katago_analyze_game`（`:2169`）同样是同步命令，其超时是 `60s.max(turns*15).min(600)`，**最长 600 秒**（`:2253`）。

对比之下 `katago_start_analyze_game`（`:2200`）是正确的做法：它 `std::thread::spawn` 后立刻返回 job id，用事件推送进度。

后果：用户点"Run KataGo"做单点分析时，UI 卡死最长 60 秒（Windows/Linux 上可能表现为窗口"无响应"）。这是本轮实时复盘要消除的体验问题的基础版本。

**缺陷 C（顺带修正）：provider 命令默认阻塞 30 秒。**

`provider_fetch_yike`（`:1331`）/ `provider_fetch_fox`（`:1338`）用 `reqwest::blocking::Client`（`:274`），默认超时 `DEFAULT_PROVIDER_HTTP_TIMEOUT_MS = 30_000`（`:35`）。同为同步命令。本计划只把**分析路径**改为非阻塞（provider 不在本轮核心范围），但应在 `Maintenance notes` 记录该遗留。

## Current state

**关键文件**

- `crates/engine-manager/src/lib.rs`（1,445 行）— `build_command_spec`（`:348`）、`check_assets`（`:409`）、`validate_command_spec`（`:670`）。
- `apps/desktop/src-tauri/src/lib.rs`（7,752 行）— 48 个 Tauri 命令、`AnalysisJobRegistry`（`:443`）、`run_katago_analysis_job`（`:2275`）。
- `apps/desktop/src/components/EngineSetupPanel.tsx` — 引擎配置 UI，`backend` 硬编码（`:140`）。

**摘录 1：GTP 规格缺 model/config**（`crates/engine-manager/src/lib.rs:394-397`）

```rust
        EngineBackend::KataGoGtp => Ok(CommandSpec {
            program,
            args: vec!["gtp".into()],
            working_dir,
            env: vec![],
        }),
```

**摘录 2：`check_assets` 只对 Analysis 后端要求 model/config**（`crates/engine-manager/src/lib.rs:409-410`）

```rust
pub fn check_assets(profile: &EngineProfileDto) -> Vec<AssetCheck> {
    let requires_analysis_assets = matches!(profile.backend, EngineBackend::KataGoAnalysis);
```

同一函数在 `:424` 用 `requires_analysis_assets || profile.model_path.is_some()` 决定是否校验 model。

**摘录 3：同步的单点分析命令**（`apps/desktop/src-tauri/src/lib.rs:2133-2165`，节选）

```rust
#[tauri::command]
fn katago_analyze_once(
    profile: EngineProfileDto,
    sgf_text: String,
    turn: u32,
    max_visits: u32,
) -> Result<AnalysisFrameDto, String> {
    ...
    let result = engine_manager::run_katago_analysis_once(&spec, &query_jsonl, Duration::from_secs(60))
        .map_err(|err| err.to_string())?;
```

**摘录 4：正确的非阻塞范式（照此仿写）**（`apps/desktop/src-tauri/src/lib.rs:2200-2223`）

```rust
#[tauri::command]
fn katago_start_analyze_game(
    app_handle: AppHandle,
    registry: State<'_, AnalysisJobRegistry>,
    profile: EngineProfileDto,
    sgf_text: String,
    max_visits: u32,
) -> Result<String, String> {
    let job_id = Uuid::new_v4();
    let job_id_string = job_id.to_string();
    let prepared = prepare_katago_batch_analysis(&sgf_text, job_id, max_visits)?;
    let spec = build_command_spec(&profile).map_err(|err| err.to_string())?;
    let cancel_token = AnalysisCancelToken::new();

    registry.insert(job_id_string.clone(), cancel_token.clone())?;

    std::thread::spawn({
        let job_id_string = job_id_string.clone();
        move || {
            run_katago_analysis_job(app_handle, job_id, job_id_string, spec, prepared, cancel_token);
        }
    });

    Ok(job_id_string)
}
```

**摘录 5：job 注册表**（`apps/desktop/src-tauri/src/lib.rs:443-445`）

```rust
struct AnalysisJobRegistry {
    jobs: Mutex<HashMap<String, AnalysisCancelToken>>,
}
```

已在 `:4964` 通过 `.manage(AnalysisJobRegistry::default())` 注册为 Tauri state。

**摘录 6：EngineProfileDto 已有 model_path / config_path**（`crates/app-model/src/lib.rs:153-160`）

```rust
pub struct EngineProfileDto {
    pub name: String,
    pub engine_path: String,
    pub model_path: Option<String>,
    pub config_path: Option<String>,
    pub working_dir: Option<String>,
    pub backend: EngineBackend,
}
```

**摘录 7：现有等价测试范式**（`crates/engine-manager/src/lib.rs:994-1005`）

```rust
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

**仓库约定**

- 所有 crate 为单文件 `lib.rs`。追加，不新建模块。
- 错误用 `thiserror`：`EngineManagerError` 在 `crates/engine-manager/src/lib.rs:81`。
- 既有 GTP 相关错误变体已存在可复用：`MissingModelPath`、`MissingConfigPath`、`ModelPathNotFound`、`ConfigPathNotFound`（在 `EngineManagerError` 中，供 Analysis 后端使用）。
- 测试内联在文件底部 `#[cfg(test)] mod tests`，用 `TestTempDir`（`:960`）+ `fake_engine_spec`（`:994`）造假引擎。**单测仍不要依赖真实 KataGo**（保持测试可移植）。但注意：**本机现在已有可用引擎**（见 `plans/KATAGO_LOCAL_ENV.md`），需要端到端确认时可手动跑真实引擎，只是不要把它写进 `cargo test`。

## Commands you will need

前置：`export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`

| Purpose | Command | Expected on success |
|---|---|---|
| 编译 | `cargo check --workspace --all-targets` | exit 0 |
| 定向测试 | `cargo test -p engine-manager` | all pass |
| 全量测试 | `cargo test --workspace` | all pass |
| 格式 | `cargo fmt --all --check` | exit 0 |
| 静态检查 | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| 前端构建 | `cd apps/desktop && npm run build` | exit 0 |

## Scope

**In scope**

- `crates/engine-manager/src/lib.rs` — `build_command_spec` 的 GTP 分支、`check_assets` 的资产要求
- `apps/desktop/src-tauri/src/lib.rs` — `katago_analyze_once` 与 `katago_analyze_game` 改为非阻塞；可能新增一个返回 job id 的命令与配套事件
- `apps/desktop/src/api/backend.ts` — 若新增命令，补对应 wrapper
- `apps/desktop/src/components/EngineSetupPanel.tsx` — 仅当需要暴露 backend 选择时（见 Step 4，可能不做）

**Out of scope**

- **不要**在 `katago-protocol` 里加 GTP 解析（那是 plan 005）。
- **不要**建立长驻会话（那是 plan 004）。本计划只把"一次性分析"改成后台线程，会话仍是短生命周期。
- **不要**改 `provider_fetch_yike` / `provider_fetch_fox`（见 Maintenance notes）。
- **不要**改 `AnalysisFrameDto` 或任何 DTO 形状。
- **不要**改 `analysis-core`。
- 不要新引入依赖（现有 `std::thread` 与 `mpsc` 已足够；`tokio` 不必要）。

## Git workflow

- 分支：`advisor/003-nonblocking-analysis-and-gtp-spec`
- 提交示例：`fix(engine): pass model and config to the GTP backend`、`fix(ipc): run one-shot analysis off the ipc thread`
- **不要推送、不要开 PR**，除非操作者指示。

## Steps

### Step 1: GTP 启动规格补全 model 与 config

在 `crates/engine-manager/src/lib.rs:394` 的 `EngineBackend::KataGoGtp` 分支中，比照同函数中 `KataGoAnalysis` 分支（`:362-393`）的做法：

1. 要求 `model_path` 与 `config_path` 非空（用现有的 `MissingModelPath` / `MissingConfigPath`）。
2. 用现有的 `resolve_asset_path`（`:471`）相对 `working_dir` 解析。
3. 用现有的 `asset_exists`（`:458`）校验存在性（用 `ModelPathNotFound` / `ConfigPathNotFound`）。
4. 产出 `args: vec!["gtp", "-model", model, "-config", config, "-override-config", "reportAnalysisWinratesAs=BLACK"]`。

**参数顺序必须与 Java 一致为 `gtp -model ... -config ...`**（Java: `KataGoAutoSetupHelper.java:1991`）。KataGo 对顺序不敏感（实测两种顺序均可正常握手，`name` 均返回 `= KataGo`），但保持一致便于比对。

**⚠️ 必须附 `-override-config reportAnalysisWinratesAs=BLACK`（裁定，2026-09-13，必做）**

理由：本机 `gtp.cfg:82` 的 `reportAnalysisWinratesAs` **是被注释掉的**（`# reportAnalysisWinratesAs = SIDETOMOVE`），KataGo 因而回落到**调用方 defaultPerspective = 走棋方**——即 `kata-analyze` 会报「走棋方视角」。而 DTO 的 `winrate_black`/`score_mean_black` 约定是**固定黑视角**。

该键在 KataGo 里是**可选**的，缺失即静默回落，**无法从引擎侧探测当前生效值**。因此在启动参数里**强制写死**，让引擎输出确定（恒为黑视角），不随用户配置漂移。

**实测确认 `-override-config` 在本机 v1.16.4 上生效**（9x9，黑占下方 4 行、白占上方 4 行；`rootInfo.winrate`）：

| 启动参数 | `player=B` | `player=W` |
|---|---|---|
| 无 override | 0.000357 | **0.999629** ← 走棋方视角（白走时把白方胜率报成 1） |
| `-override-config reportAnalysisWinratesAs=BLACK` | 0.000374 | **0.000362** ← 恒为黑视角 ✅ |

（`-override-config` 是 KataGo 的通用 CLI 选项，可多次出现；不是 GTP 命令，**不要**往 stdin 里发。语法为 `-override-config KEY=VALUE`，实测被接受且无 warning。）

**与 plan 005 的关系（互补，非二选一，且不会双重转换）**：
- 本 override 让**引擎输出确定**（恒黑视角），把不确定性挡在源头；
- plan 005 的 `perspective` 参数让**解析器契约显式可审计**——若将来有人去掉本 override，实参从 `Black` 变 `White` 是一个**可见的代码改动**，而不是所有白走帧被静默反向。
- **不会双重转换的原因**：override 生效时引擎报的就是黑视角，plan 006 调用 `kata_analyze_line_to_frame` 时传入的实参就是 `PlayerColor::Black`，`flip == false`，原样填充。**危险组合只有一个**：override 在、却传 `White`——那会给每个白走局面多翻一次。**启动参数与 `perspective` 实参必须成对一致**（plan 005 Step 3b 的测试 15 锁住该不变量）。

**Verify**: `cargo test -p engine-manager` → all pass。

> **已实现状态提示**：本步骤在 t8（commit `97ea9a4`）中**只实现了 `-model`/`-config`，尚未加本 override**。因此这是一条**新增的、尚未落实**的要求，需要回改 `build_command_spec`。执行者请先 `grep -n 'override-config' crates/engine-manager/src/lib.rs` 确认是否已存在，避免重复添加。

**⚠️ 实时复盘必须用 GTP 配置，不能用 `analysis.cfg`**（实测）：`katago gtp -config analysis.cfg` 会**直接崩溃退出**——

```
$ katago gtp -model <weight> -config .../configs/analysis.cfg
libc++abi: terminating due to uncaught exception of type IOError:
  Could not find key 'logAllGTPCommunication' in config file .../analysis.cfg
```

`analysis.cfg` 缺少 GTP 路径必需的键（`logAllGTPCommunication` 等），且它带 `reportAnalysisWinratesAs = BLACK`（批处理路径的视角设定）。**`gtp.cfg` 与 `analysis.cfg` 不可互换**，两个后端各用各的配置。

**Verify**: `cargo test -p engine-manager` → all pass。

### Step 1b: 明确「发送与读取解耦」要求（写入 CommandSpec 的使用约定）

**背景（实测，见 `GTP_LIVE_PROBE_FINDINGS.md` §4）**：GTP 管道存在**批量缓冲**。实测握手阶段连发 `boardsize 9` / `komi 7.5` / `clear_board` / `play ...`，其 `=` 响应**不会逐条立即到达**，而是在约 1.5 秒后**同一时间戳批量**到达：

```
[1.49s] '='
[1.49s] ''
[1.49s] '='      ← 5 个 '=' 全部同一时间戳
[1.49s] ''
...
```

**要求**：本计划产出的 `CommandSpec` 会被 plan 004 的长驻会话消费，因此**必须在 Step 1 的代码注释或本计划的 Maintenance notes 中明确写下**：

1. **禁止"send 后同步阻塞等待 `=` 响应"**。等待时间不确定，且等待期间**无法处理引擎主动推送的 `info` 行**，实时性会彻底丧失。
2. 发送与读取必须**完全解耦**：一个写路径 + 一个常驻 stdout 读线程，读到的每行按类别分发（`=`/`?` 响应 vs `info` 流 vs 空行）。
3. 需要"命令已确认"语义时，用**命令编号异步匹配**，而不是阻塞等待。`kata-analyze` **不需要**编号（它是流式的，没有单次响应）；`boardsize`/`komi`/`play` 需要。
4. 启动时**不做同步握手探测**；`boardsize`/`komi`/摆子按序异步发出即可。

> **注意**：该批量行为实测于 macOS + Python `select`；Rust `BufReader` 读线程模型下**未必相同**，执行者应在 Rust 侧实测确认，**不能直接假定"Rust 就没这个问题"**。但"发送与读取解耦"的设计要求无论实测结果如何都成立。

**本步骤不改代码**（`CommandSpec` 本身无需变化），只把约定写进注释/文档，供 plan 004 遵守。

**Verify**: 无需命令；在报告中确认该约定已写入 Step 1 附近的注释。

### Step 2: `check_assets` 对 GTP 后端也要求 model/config

把 `crates/engine-manager/src/lib.rs:410` 的判定改为对两种 KataGo 后端都要求资产：

```rust
    let requires_analysis_assets = matches!(profile.backend, EngineBackend::KataGoAnalysis);
    let requires_katago_assets =
        requires_analysis_assets || matches!(profile.backend, EngineBackend::KataGoGtp);
```

然后在 `:424` 与 `:435` 两处，把用于 `required` 字段的 `requires_analysis_assets` **改为 `requires_katago_assets`**，用于 `||` 条件的判据保持不变（那部分决定"是否产出该条目"，`profile.model_path.is_some()` 仍应触发）。

注意改动要精确：`required: requires_katago_assets` 才会让 GTP 缺权重时被标为必需失败。

**Verify**: `cargo test -p engine-manager` → all pass。
若既有的 `check_assets_*` 测试失败，说明它们断言的是"GTP 后端不要求 model"——那是**旧行为的编码**，需在 Step 3 一并更新断言，并在提交信息中说明这是有意的行为变更。

### Step 3: 为新 GTP 行为补测试

在 `crates/engine-manager/src/lib.rs` 测试模块新增：

- `build_command_spec_includes_model_and_config_for_katago_gtp` — 构造 `backend: EngineBackend::KataGoGtp` 且给出存在的假 model/config 文件的 profile，断言 `spec.args == ["gtp", "-model", <resolved model>, "-config", <resolved config>, "-override-config", "reportAnalysisWinratesAs=BLACK"]`。
- `build_command_spec_reports_missing_model_for_katago_gtp` — model 缺失时应返回 `MissingModelPath`。
- `check_assets_marks_model_required_for_katago_gtp` — GTP 后端下 model 检查项的 `required == true`。
- `build_command_spec_pins_black_perspective_for_katago_gtp`（**本裁定新增**）— 断言 `spec.args` **含** `"-override-config"` 与 `"reportAnalysisWinratesAs=BLACK"` 这一对相邻元素。
  - **这条防的是什么**：`gtp.cfg` 的该键被注释 → 引擎报走棋方视角。若有人删掉 override，引擎输出会随用户配置漂移，所有白走局面静默反向。本测试让"删 override"变成一个**必然失败的显式改动**。
  - 断言写法建议用窗口匹配（找 `-override-config` 的下一个元素），不要只 `args.contains(&"...BLACK")`——后者无法发现键值被拆开或顺序错乱。

参照 `:1105` 的 `build_command_spec_resolves_relative_katago_assets_under_working_dir` 与 `:1144` 的 `build_command_spec_reports_missing_model_path` 的类型与断言风格。

**Verify**: `cargo test -p engine-manager` → all pass，且 4 个新测试出现在输出。

### Step 4: 把单点分析改为非阻塞（后台线程 + 事件）

**背景**：`katago_analyze_once` 返回 `Result<AnalysisFrameDto, String>`，前端 `analyzeKataGoOnce` 直接 `await` 其返回值（`apps/desktop/src/api/backend.ts`）。改变为事件驱动会牵动前端。

**推荐的最小改动方案**：把 `katago_analyze_once` 与 `katago_analyze_game` 都改成 `async fn`。

理由：Tauri 对 `async fn` 使用 `ExecutionContext::Async`，会把 future 投递到异步运行时，**不再阻塞 IPC 线程**；而命令签名与返回值**完全不变**，前端 `await invoke(...)` 无需改动。这是本仓库从"同步阻塞"到"非阻塞"的最小侵入路径，且不需要新增事件协议。

同时，阻塞式内核（`run_katago_analysis_once` 内部用 `mpsc::Receiver::try_recv` 轮询 + `std::thread::sleep`）不应直接在 async 上下文中忙等。用 Tauri 提供的阻塞投递方式：

```rust
#[tauri::command]
async fn katago_analyze_once(
    profile: EngineProfileDto,
    sgf_text: String,
    turn: u32,
    max_visits: u32,
) -> Result<AnalysisFrameDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 现有函数体原样搬进来
    })
    .await
    .map_err(|err| format!("analysis task failed: {err}"))?
}
```

对 `katago_analyze_game` 做同样处理。

**注意**：`spawn_blocking` 的闭包必须 `Send + 'static`，因此需要 `move` 捕获所有参数（`profile`、`sgf_text`、`turn`、`max_visits` 都是 owned 类型，满足要求）。

**Verify**:
1. `cargo check --workspace --all-targets` → exit 0
2. `cargo test -p lizzieyzy-next-desktop` → all pass（Tauri crate 的测试，`:953` 起有 94 个）
3. `cd apps/desktop && npm run build` → exit 0

### Step 5: 全量门禁

**Verify**（逐条）:

1. `cargo fmt --all --check` → exit 0
2. `cargo clippy --workspace --all-targets -- -D warnings` → exit 0
3. `cargo test --workspace` → all pass
4. `cd apps/desktop && npm run build` → exit 0
5. `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed

## Test plan

- 新增 3 个 `engine-manager` 测试（Step 3）。
- `katago_analyze_once` 的 async 化属于签名兼容的调度变更，现有测试（`:5160` 起的 `katago_cancel_*` 等）应继续通过——若它们失败，说明 async 化改变了可观测行为，报告而不是改测试断言。
- 结构参照：`crates/engine-manager/src/lib.rs:1105`、`:1144`。
- 验证：`cargo test --workspace` → all pass，含 4 个新测试。

## Done criteria

全部成立才算完成：

- [ ] `cargo fmt --all --check` exit 0
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` exit 0
- [ ] `cargo test --workspace` exit 0；Step 3 的 4 个新测试通过
- [ ] `grep -n 'args: vec!\["gtp".into()\]' crates/engine-manager/src/lib.rs` 无匹配（已带 model/config）
- [ ] `grep -n 'override-config' crates/engine-manager/src/lib.rs` 有匹配，且同一行/相邻行含 `reportAnalysisWinratesAs=BLACK`（Step 1 的裁定，**新要求**）
- [ ] `async fn katago_analyze_once\|async fn katago_analyze_game` 的匹配数（`grep -n 'async fn katago_analyze_once\|async fn katago_analyze_game' apps/desktop/src-tauri/src/lib.rs`）为 2
- [ ] 「发送与读取解耦」约定已写入代码注释或本计划（Step 1b），且**实时复盘用 `gtp.cfg`、批处理用 `analysis.cfg`** 已在该约定中写明
- [ ] `cd apps/desktop && npm run build` exit 0
- [ ] `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed
- [ ] `git status` 的改动文件全部在 In-scope 列表内
- [ ] `plans/README.md` 中本计划状态行已改为 `DONE`

## STOP conditions

出现以下任一情况，停止并报告，不要即兴发挥：

- "Current state" 摘录与现网代码不一致。
- 把 `katago_analyze_once` 改为 `async` 后，前端 `invoke` 调用出现行为变化（例如返回值包装层级不同）。Tauri 2 的 async 命令返回值应与同步命令一致，但若实测不符，**报告**，不要自行改前端协议。
- `spawn_blocking` 因借用检查无法 `move` 捕获某个参数（例如它是引用）——报告具体哪个参数，不要用 `clone()` 之外的手段硬绕。
- 你发现把 `katago_analyze_game` 也 async 化会让某个既有 smoke 脚本超时或失败——报告，可考虑只改 `katago_analyze_once` 并在报告中说明取舍。
- 需要改动 Scope 之外的任何文件，或需要新增依赖。
- `cargo test --workspace` 出现除 README 所述 2 个既有 macOS `/tmp` 失败之外的新失败。

## Maintenance notes

- **行为变更需在提交信息中显式说明**：GTP 后端现在**要求** model/config，且 `check_assets` 对 GTP 后端把 model/config 标为必需。这会让此前"能过"的 GTP profile 校验开始报错——这是**有意的**（此前是静默漏检）。若发现既有测试断言了旧行为，更新断言并在提交信息正文写明理由。
- **审阅者重点看**：`spawn_blocking` 是否为每次分析创建新线程（本计划是有意如此，因为会话仍是短生命周期）；以及 async 化后 `katago_cancel_analysis` 与 job 注册表的竞态语义是否被改变（取消针对的是 `katago_start_analyze_game` 创建的 job，本计划不动那条路径）。
- **provider 命令仍会阻塞**：`provider_fetch_yike`/`provider_fetch_fox` 默认 30 秒超时且在 IPC 线程内阻塞（`apps/desktop/src-tauri/src/lib.rs:274`、`:35`）。provider 不在本轮核心范围，**明确推迟**。若将来处理，应对齐本计划采用的 `spawn_blocking` 方案。
- **与 plan 004 的接口**：004 会新增一个长驻会话类型。本计划产出的 GTP `CommandSpec`（含 `-model`/`-config`）就是 004 用来启动会话的输入。004 **不应**再改 `build_command_spec` 的 args，只需消费它。
- **前端未暴露 backend 选择**：`EngineSetupPanel.tsx:140` 仍硬编码 `backend: "kata_go_analysis"`。本计划**不**改这里——让用户选择 GPT 后端属于 plan 004/007 的 UX 范围（需要会话已可用才有意义）。GTP 路径目前仍只能通过直接构造 `EngineProfileDto` 走到（测试即如此），这是可接受的过渡状态。
