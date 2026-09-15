# Plan 008: 问题手判定视角修正 + 阈值对齐 + 底部热力概览条

> **范围已收窄（2026-09-13 裁定，按 `plans/GTP_LIVE_PROBE_FINDINGS.md` §2）**：**流式（GTP `kata-analyze`）路径的视角转换已归 plan 005**（其新增 Step 3b 提供显式 `perspective: PlayerColor` 入参并完成转换）。**本计划不再包含流式视角转换**，范围收窄为：
> 1. **消除对配置文件的隐式依赖** —— 让帧自带 `to_play`，消费侧无论引擎配置如何都能归一化；
> 2. 问题手阈值对齐 Java；
> 3. 底部热力概览条。
>
> 关于流式路径：plan 005 已把 `kata_analyze_line_to_frame` 的输出转成黑视角；本计划**只需**在该函数里补填 `to_play` 字段（它已是黑视角，**不要**再加一次转换）。同理，plan 003 已在 GTP 启动时用 `-override-config reportAnalysisWinratesAs=BLACK` 把引擎输出固定为黑视角——**本计划不要重复该职责**。
>
> **Executor instructions**: 按步骤执行，每步先跑验证命令、确认预期结果再进入下一步。若出现 "STOP conditions" 中的任一情况，停止并报告，不要即兴发挥。完成后更新 `plans/README.md` 中本计划的状态行。
>
> **Drift check（先跑）**: `git diff --stat b7f33a2..HEAD -- crates/analysis-core/src/lib.rs crates/app-model/src/lib.rs crates/katago-protocol/src/lib.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/components/WinrateChart.tsx`
> 若 `crates/katago-protocol/` 因 plan 005 而有改动，属预期（含其视角转换）。本计划的 "Current state" 摘录若与现网冲突，以现网为准并报告差异。

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-analysis-query-fidelity.md（提供 `GameSummaryDto.to_play` 等保真字段）
- **Category**: bug + direction（阈值错 + 缺失热力概览）
- **Planned at**: commit `b7f33a2`, 2026-09-12

## Why this matters

三个问题，都在"问题手判定"这条链上。

**问题 A（最严重）：跨手相减时视角错乱。**

`classify_problem_markers` 直接把相邻两帧的 `winrate_black` 相减（`crates/analysis-core/src/lib.rs:15-16`）：

```rust
let winrate_loss = (previous.winrate_black - current.winrate_black).abs();
let score_loss = (previous.score_mean_black - current.score_mean_black).abs();
```

但这两个字段**没有携带"该手由谁走"的信息**，其视角取决于分析配置的 `reportAnalysisWinratesAs` 取值（`crates/katago-protocol/src/lib.rs:265` 只是把 `root.winrate` 原样填入，无任何视角转换）。几种情形：

- **配置为 `SIDETOMOVE`（或该键缺失时引擎回退到默认 `C_EMPTY`）** → 值是"当前走棋方"视角。字段名 `winrate_black` 是**误导**：轮白走棋时它实际是白方胜率。
- **配置为 `BLACK`** → 值确实是黑视角，字段名恰好正确，**相邻帧相减没有视角错乱问题**。

KataGo 的解析逻辑（`cpp/program/setup.cpp:920-925` `parseReportAnalysisWinrates`）：**键存在**则按 `BLACK`/`WHITE`/`SIDETOMOVE` 解析；**键缺失**才回退到调用方传入的 `defaultPerspective`。而 `katago analysis` 传入的默认值是 `C_EMPTY`（等价 SIDETOMOVE）——见 `cpp/command/analysis.cpp:141`。

> **实测事实（2026-09-12，本机 T4 环境）**：本机 `~/.lizzieyzy-dev/configs/analysis.cfg` 第 30 行为 `reportAnalysisWinratesAs = BLACK`（取自官方 `cpp/configs/analysis_example.cfg:30`，**是生效的键值**，非注释）。
>
> **这意味着**：在当前本机配置下，`winrate_black` 恰是黑视角，**相邻帧相减不会错乱**；本计划所谓"问题 A"在当前配置下**不触发**。
>
> **但本计划仍然必要**，理由有二：
> 1. **配置相关而非无条件正确**：用户可换成不带该键的自定义 analysis 配置（或显式设 `SIDETOMOVE`），该缺陷立刻显现。依赖"用户恰好用了官方模板"是脆弱的隐式假设。
> 2. **渲染层已经在做归一化，分析层却没有**：Java 主线在**显示**时统一切到黑视角（`WinrateGraph.java:2463-2476` 的 `displayedGraphWinrate`、`BoardData.getWinrate()` 的 `win-rate-always-black` 开关），正是因为不能假设配置已给黑视角。本仓库的显示层（`WinrateChart.tsx` 直接用 `frame.winrate_black`）**没有**做归一化。
>
> 因此本计划的正确目标不是"修一个当前必然触发的 bug"，而是**消除对引擎配置的隐式依赖**：让帧自带 `to_play`，消费侧无论配置是 `BLACK` 还是 `SIDETOMOVE` 都能归一化到同一视角。
>
> **执行者与验证者必须**：先 `grep -E '^reportAnalysisWinratesAs' <实际使用的 analysis.cfg>` 确认取值，再判断本计划的效果。若为 `BLACK`，则 Step 6 中"未归一化会算出 `|0.60-0.55|=0.05`"那类断言的**现实触发条件**是"配置改为 SIDETOMOVE 时"；测试用例仍需按计划构造（单测直接构造 `to_play`，不依赖配置），但**不要**声称"当前生产路径已错"。
>
> 更正说明：本计划初稿把"默认视角是 SIDETOMOVE"写成无条件事实，并引用 **GTP** 配置文件（`gtpconfig.cpp`）作为依据——对 `analysis` 子命令这不严谨（其默认取决于配置，官方 analysis 模板恰为 `BLACK`）。已按上述事实链更正。

围棋**每一手都换走棋方**。当配置为 SIDETOMOVE 时，第 N 手与第 N+1 手的"当前走棋方"永远相反。把两个相反视角的胜率直接相减，得到的是 `wr_N - wr_{N+1}`，而正确的黑视角差应为 `wr_N - (1 - wr_{N+1})`。此时该值在换手处系统性错误——它把一个正常局面算成大幅波动（或反过来，把真失误算成正常）。

Java 主线对此有显式处理（`src/main/java/featurecat/lizzie/rules/Board.java:5929-5937`）：

```java
double lastWR = lastNode.get().winrate;
if (lastNode.get().blackToPlay == node.getData().blackToPlay) {
  return lastWR - node.getData().winrate;
} else {
  return (100 - lastWR) - node.getData().winrate;
}
```

目差同理（`Board.java:6005-6013`，`(-lastWR) - node.getData().scoreMean`）。**本计划必须复刻这个视角归一化。**

**问题 B：分数阈值差了 2-4 倍。**

| 严重度 | Java（百分点 / 目） | 本仓库（小数 / 目） | 差异 |
|---|---|---|---|
| Blunder | `>20.0` / `>5.0` | `>=0.18`（=18pp） / `>=12.0` | 胜率接近，**目数阈值是 2.4 倍** |
| Mistake | `>10.0` / `>2.0` | `>=0.10`（=10pp） / `>=7.0` | 胜率一致，**目数阈值是 3.5 倍** |
| Inaccuracy | `>5.0` / `>1.0` | `>=0.05`（=5pp） / `>=3.0` | 胜率一致，**目数阈值是 3 倍** |
| 轻微（缺失） | `>2.0` / `>0.3` | **无此档** | 少一档 |

Java 的目数阈值（5 / 2 / 1 / 0.3）比本仓库（12 / 7 / 3）**敏感得多**。因为 `scoreLoss` 取的是绝对值，本仓库的目数判据几乎从不触发（12 目以上的单手目差波动很少见），实际判定**几乎完全由胜率主导**。而 Java 会大量用目数捕捉"胜率变化不大但目数损失明显"的官子失误——这正是业余棋手最需要的一类反馈。

另外 Java 用**严格大于**（`>`），本仓库用 `>=`；Java 有一个本仓库没有的第四档。

**问题 C：缺少底部热力概览条。**

README 把"底部热力概览"列为核心卖点："底部热力概览：整盘问题手分布，红橙黄越多，越值得先看"。本仓库完全没有——`WinrateChart.tsx` 只画一条胜率曲线加一条当前手竖线（全文 20 行，见 `apps/desktop/src/components/WinrateChart.tsx:22`）。

Java 的实现（`src/main/java/featurecat/lizzie/gui/WinrateGraph.java`）是每手一个竖条，高度与颜色由该手的 `swing`（黑视角胜率变化幅度）决定：`swing` 越大，条越高越红。用户扫一眼底部就知道该看哪几手。

## Current state

**关键文件**

- `crates/analysis-core/src/lib.rs`（78 行，全文件）— 问题手分级。**核心改动点。**
- `crates/app-model/src/lib.rs` — `AnalysisFrameDto`（`:120`）、`ProblemSeverity`（`:145`）、`ProblemMarkerDto`（`:135`）。
- `crates/katago-protocol/src/lib.rs:246` — `normalize_response`（透视填充语义的源头）。
- `apps/desktop/src/components/WinrateChart.tsx`（20 行）— 需扩展为含热力条。
- `apps/desktop/src/components/AnalysisPanel.tsx:104` — 消费 `severity` 渲染列表。

**摘录 1：当前分级（视角与阈值问题所在）**（`crates/analysis-core/src/lib.rs:10-40`）

```rust
pub fn classify_problem_markers(frames: &[AnalysisFrameDto]) -> Vec<ProblemMarkerDto> {
    let mut markers = Vec::new();
    for pair in frames.windows(2) {
        let previous = &pair[0];
        let current = &pair[1];
        let winrate_loss = (previous.winrate_black - current.winrate_black).abs();
        let score_loss = (previous.score_mean_black - current.score_mean_black).abs();
        let severity = severity_for(winrate_loss, score_loss);
        if severity != ProblemSeverity::Info {
            markers.push(ProblemMarkerDto {
                turn: current.turn,
                severity,
                winrate_loss,
                score_loss,
                label: label_for(severity).to_string(),
            });
        }
    }
    markers
}

pub fn severity_for(winrate_loss: f32, score_loss: f32) -> ProblemSeverity {
    if winrate_loss >= 0.18 || score_loss >= 12.0 {
        ProblemSeverity::Blunder
    } else if winrate_loss >= 0.10 || score_loss >= 7.0 {
        ProblemSeverity::Mistake
    } else if winrate_loss >= 0.05 || score_loss >= 3.0 {
        ProblemSeverity::Inaccuracy
    } else {
        ProblemSeverity::Info
    }
}
```

`label_for`（`:42`）返回中文标签：`正常波动` / `疑似缓手` / `明显问题手` / `重大失误`。**保留这些标签**（前端与用户已依赖）。

**摘录 2：`AnalysisFrameDto`（需要新增视角字段）**（`crates/app-model/src/lib.rs:120-132`）

```rust
pub struct AnalysisFrameDto {
    pub job_id: AnalysisJobId,
    pub game_id: Option<GameId>,
    pub node_id: Option<NodeId>,
    pub turn: u32,
    pub visits: u32,
    pub winrate_black: f32,
    pub score_mean_black: f32,
    pub score_stdev: Option<f32>,
    pub candidates: Vec<CandidateMoveDto>,
    pub ownership: Option<Vec<f32>>,
    pub policy: Option<Vec<f32>>,
}
```

**没有**"该手由谁走"的字段，这正是视角无法归一化的根因。

**摘录 3：既有 JSONL 归一化（视角字段的填充点）**（`crates/katago-protocol/src/lib.rs:246-270`，节选）

```rust
pub fn normalize_response(
    job_id: AnalysisJobId,
    response: AnalysisResponse,
    board_size: u8,
) -> AnalysisFrameDto {
    let root = response.root_info.unwrap_or(RootInfo { ... });
    AnalysisFrameDto {
        job_id,
        game_id: None,
        node_id: None,
        turn: response.turn_number,
        visits: root.visits,
        winrate_black: root.winrate,
        ...
```

`AnalysisResponse` 只有 `turn_number`，**不含走棋方**。因此视角需要**从棋谱推导**（手数为奇数则黑走、偶数则白走；或读取 SGF 的 `PL`）。

**摘录 4：前端消费 severity**（`apps/desktop/src/components/AnalysisPanel.tsx:104`）

```tsx
        return <li key={p.turn} className={`severity-${p.severity}${isCurrent ? " is-current" : ""}`}>
```

CSS 类名是 `severity-info` / `severity-inaccuracy` / `severity-mistake` / `severity-blunder`（见 `apps/desktop/src/styles.css`）。**不要改这些类名。**

**摘录 5：现有胜率图（热力条要加在这里）**（`apps/desktop/src/components/WinrateChart.tsx`，全文 20 行，核心是）

```tsx
    if (sortedFrames.length > 1) { ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2; ctx.beginPath(); sortedFrames.forEach((frame, index) => { const x = turnToX(frame.turn); const y = height - frame.winrate_black * height; if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); }
    const markerX = turnToX(currentMove); ctx.strokeStyle = "rgba(15,23,42,.72)"; ctx.beginPath(); ctx.moveTo(markerX, 0); ctx.lineTo(markerX, height); ctx.stroke();
```

Canvas 高度取自 `canvas.clientHeight || 160`。

**摘录 6：Java 的热力条颜色与高度公式（权威参照）**

颜色（`WinrateGraph.java:2137-2152`）：

```java
double severity = Math.max(0.0, Math.min(1.0, (swing - threshold) / Math.max(1.0, swingScale - threshold)));
int alpha = Math.min(255, (int) Math.round(150 + 80 * severity));
int red = 255;
int green = Math.max(70, (int) Math.round(176 - 96 * severity));
int blue = Math.max(36, (int) Math.round(84 - 48 * severity));
return new Color(red, green, blue, alpha);
```

高度（`WinrateGraph.java:1870-1882`，节选）：

```java
if (move.hasAnalysis && move.swing >= layout.issueThreshold) {
  int barHeight = Math.max(3, (int) Math.round(move.swing * layout.innerHeight * 0.75 / layout.swingScale));
  gBlunder.fillRoundRect(point.x - layout.barWidth / 2, layout.innerY + layout.innerHeight - barHeight, layout.barWidth, barHeight, 4, 4);
}
```

默认 `issueThreshold`（`WinrateGraph.java:1997-1998`）：`blunderWinThreshold > 0 ? blunderWinThreshold : 3.0`，即**默认 3.0 百分点**。

`swingScale`（`WinrateGraph.java:2046-2054`）：`max(issueThreshold, ceil(maxSwing / 5.0) * 5.0)`。

**注意门控条件用的比较符是 `>=`（与 `getBlunderColor` 的 `>` 不同），且 Java 的默认阈值 3.0 是百分点。**本仓库用小数，对应 **0.03**。

**仓库约定**

- `analysis-core` 是 78 行的单文件 crate，**依赖只有 `app-model`**（见 `crates/analysis-core/Cargo.toml`）。改动应保持轻量。
- 阈值常量必须是**命名常量**并附文档注释说明单位（当前是魔法数字，这是问题 B 的一部分原因）。
- Rust 测试内联 `#[cfg(test)] mod tests`（`crates/analysis-core/src/lib.rs:52` 起有 1 个测试 `classifies`）。
- 前端无测试框架。热力条通过 `data-*` 属性暴露可断言状态（`WinrateChart.tsx` 已有 `data-review-source` 等先例）。

## Commands you will need

前置：`export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`

| Purpose | Command | Expected on success |
|---|---|---|
| 编译 | `cargo check --workspace --all-targets` | exit 0 |
| 定向测试 | `cargo test -p analysis-core -p katago-protocol` | all pass |
| 全量测试 | `cargo test --workspace` | all pass |
| 格式 | `cargo fmt --all --check` | exit 0 |
| 静态检查 | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| 前端构建 | `cd apps/desktop && npm run build` | exit 0 |

**无真实 KataGo**：本计划全部逻辑可用构造的 `AnalysisFrameDto` 单测，不需要引擎。

## Scope

**In scope**

- `crates/app-model/src/lib.rs` — `AnalysisFrameDto` 新增 `to_play` 字段（带 `#[serde(default)]`）
- `crates/analysis-core/src/lib.rs` — 视角归一化、命名阈值常量、新增第四档、热力条 `swing` 计算
- `crates/katago-protocol/src/lib.rs` — `normalize_response`（**批处理路径**）填充 `to_play`；`kata_analyze_line_to_frame`（流式）**只需补填 `to_play` 字段，视角转换已在 plan 005 Step 3b 完成，不要重复**
- `apps/desktop/src-tauri/src/lib.rs` — 批处理路径填充 `to_play`；`classify_problems` 签名如需微调
- `apps/desktop/src/components/WinrateChart.tsx` — 新增底部热力条绘制
- `apps/desktop/src/domain/types.ts` — 同步 `AnalysisFrameDto` 与 `ProblemMarkerDto` 的 TS 类型

**Out of scope**

- **不要**改 `ProblemSeverity` 的四个变体名或其 `snake_case` 序列化名——前端 CSS 类与 TS 类型依赖它们。
- **不要**改 `label_for` 的中文标签文案。
- **不要**改 `AnalysisPanel.tsx` 的列表渲染逻辑（只加属性不改结构）。
- **不要**改 `BoardCanvas.tsx`（候选点/归属叠加与热力条无关）。
- **不要**实现悬停触发分析、ponder、引擎对弈。
- **不要**为热力条引入图表库（用现有 Canvas 手绘，与 `WinrateChart` 现状一致）。
- **不要**在本计划内实现"点击热力条跳转到该手"——那是交互增强，可作后续项。
- **不要**改 `provider` / `readboard` 相关代码。

## Git workflow

- 分支：`advisor/008-blunder-perspective-and-overview`
- 提交示例：`fix(analysis): normalize problem-move diffs to one perspective`、`feat(ui): add bottom quick-overview heat strip`
- **不要推送、不要开 PR**，除非操作者指示。

## Steps

### Step 1: 给 `AnalysisFrameDto` 加视角字段

在 `crates/app-model/src/lib.rs` 的 `AnalysisFrameDto`（`:120`）新增：

```rust
    /// 该手由哪一方走。用于把 KataGo 的 side-to-move 视角值归一化为单一视角，
    /// 否则相邻手相减会在换手处系统性出错。
    #[serde(default)]
    pub to_play: PlayerColor,
```

**字段名必须用 `to_play`**，与既有的 `PositionDto.to_play`（`crates/app-model/src/lib.rs:56`）以及 plan 001 给 `GameSummaryDto` 加的同名字段保持一致。语义相同：该局面轮到谁走。

**`PlayerColor` 的 `Default`：T2（plan 001）已提供，你不要再加。** T2 采用的实现是在枚举上派生（commit `96132c9`）：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum PlayerColor {
    #[default]
    Black,
    White,
}
```

因此本步骤直接用 `#[serde(default)]` 即可，**不要**再写 `impl Default for PlayerColor`（全局只能有一份，重复会编译失败）。先确认：

```bash
grep -n 'impl Default for PlayerColor' crates/app-model/src/lib.rs   # 应无匹配（用的是 derive）
grep -n '#\[default\]' crates/app-model/src/lib.rs                    # 应有 1 处（在 PlayerColor 内）
```

**Verify**: `cargo check --workspace --all-targets` → exit 0（此时会报构造点缺字段，Step 2/3 修复）。

### Step 2: 在协议层填充视角

`crates/katago-protocol/src/lib.rs` 有两处构造 `AnalysisFrameDto`：

- `normalize_response`（`:246`）— `analysis` JSONL 路径（**本计划的主战场**）
- `kata_analyze_line_to_frame`（plan 005 新增）— GTP 流式路径（**只需补填 `to_play` 字段**；其视角转换已由 plan 005 Step 3b 用显式 `perspective` 入参完成，**不要在此重复转换**）

两处都需要知道"该手由谁走"。**协议层无法自行推导**（`AnalysisResponse` 只有 `turn_number`），因此**新增一个参数**：

```rust
pub fn normalize_response(
    job_id: AnalysisJobId,
    response: AnalysisResponse,
    board_size: u8,
    to_play: PlayerColor,   // 新增
) -> AnalysisFrameDto
```

`normalize_responses_for_turns`（`:227`）同样需要接收一个 `&[PlayerColor]` 或一个能按 turn 查视角的闭包。**推荐**改为接收 `turns: &[(u32, PlayerColor)]` 或额外的 `players_by_turn: &HashMap<u32, PlayerColor>`，由调用方（Tauri 层）从棋谱构造。

**这是一个跨 crate 的签名变更**，会牵动 `apps/desktop/src-tauri/src/lib.rs`。改动面较大但必要——**不要**用"默认黑"敷衍，那等于问题 A 未修。

**Verify**: `cargo check --workspace --all-targets` → exit 0（可能仍需 Step 3 修调用点）。

### Step 3: 在 Tauri 层从棋谱推导视角并传入

在 `apps/desktop/src-tauri/src/lib.rs` 中，三处构造分析帧的地方需要传入视角：

- `katago_analyze_once`（`:2134`）— 单一手，视角 = 该手由谁走
- `prepare_katago_batch_analysis`（`:2239`）+ `normalize_responses_for_turns` 调用点
- plan 006 的实时路径（`kata_analyze_line_to_frame` 调用点）

推导规则：第 `n` 手（`n >= 1`）由 `game.moves[n-1].color` 走。第 0 手（空盘开局）由 `game.summary.to_play` 走（plan 001 已加该字段）。

**推荐实现一个纯函数并单测**：

```rust
/// 返回每一手（含第 0 手）的走棋方。索引即手数。
fn players_by_turn(game: &GameDto) -> Vec<PlayerColor>
```

这样调用方可以 O(1) 查表，且推导逻辑可独立验证。

**Verify**: `cargo check --workspace --all-targets` → exit 0；`cargo test --workspace` → all pass。

### Step 4: 修正 `analysis-core` 的视角归一化

把 `classify_problem_markers`（`crates/analysis-core/src/lib.rs:10`）改为**先归一化到黑视角，再相减**：

```rust
/// 把 side-to-move 视角的胜率转为黑视角胜率。
fn winrate_as_black(winrate_side_to_move: f32, to_play: PlayerColor) -> f32 {
    match to_play {
        PlayerColor::Black => winrate_side_to_move,
        PlayerColor::White => 1.0 - winrate_side_to_move,
    }
}

/// 把 side-to-move 视角的目差转为黑视角目差（正数表示黑领先）。
fn score_as_black(score_side_to_move: f32, to_play: PlayerColor) -> f32 {
    match to_play {
        PlayerColor::Black => score_side_to_move,
        PlayerColor::White => -score_side_to_move,
    }
}
```

然后在循环内：

```rust
let previous_wr_black = winrate_as_black(previous.winrate_black, previous.to_play);
let current_wr_black = winrate_as_black(current.winrate_black, current.to_play);
let winrate_loss = (previous_wr_black - current_wr_black).abs();

let previous_score_black = score_as_black(previous.score_mean_black, previous.to_play);
let current_score_black = score_as_black(current.score_mean_black, current.to_play);
let score_loss = (previous_score_black - current_score_black).abs();
```

**注意**：`winrate_loss` 与 `score_loss` 的**单位保持现状**（胜率小数 0..1、目数点数），因为前端 `ProblemMarkerDto` 的 `winrate_loss`/`score_loss` 字段与阈值常量都以该单位工作。**这样也与 plan 005 的"不缩放"约定一致。**

**Verify**: `cargo test -p analysis-core` → all pass（既有 `classifies` 测试可能需要更新构造以填 `to_play`；见 Step 6）。

### Step 5: 阈值常量对齐 Java + 新增第四档

把 `severity_for`（`crates/analysis-core/src/lib.rs:31`）的魔法数字提为命名常量并**对齐 Java**：

```rust
// 胜率损失以小数计（0..1），与 AnalysisFrameDto.winrate_black 同单位。
// 目数损失以目计。
// 数值对齐 Java 主线 WinrateGraph.getBlunderColor（20/10/5/2 百分点 → 0.20/0.10/0.05/0.02）。
const WINRATE_LOSS_BLUNDER: f32 = 0.20;
const WINRATE_LOSS_MISTAKE: f32 = 0.10;
const WINRATE_LOSS_INACCURACY: f32 = 0.05;
const WINRATE_LOSS_DOUBT: f32 = 0.02;

// 对齐 Java 的 5.0 / 2.0 / 1.0 / 0.3 目。
const SCORE_LOSS_BLUNDER: f32 = 5.0;
const SCORE_LOSS_MISTAKE: f32 = 2.0;
const SCORE_LOSS_INACCURACY: f32 = 1.0;
const SCORE_LOSS_DOUBT: f32 = 0.3;
```

**重大行为变更**：目数阈值从 12/7/3 收紧到 5/2/1。这会让**更多手**被标为问题手（尤其官子阶段）。这是**有意为之**（对齐 Java、修正过钝的判据），必须在提交信息中说明。

关于第四档：Java 的第四档（`>2.0` / `>0.3`）对应"轻微"，介于 `Info` 与 `Inaccuracy` 之间。但 `ProblemSeverity` 只有四档且前端 CSS 只有四个类名。**两种可选做法，请选其一并说明**：

- **(推荐) 不新增枚举变体**，把 Java 的第四档合并进 `Inaccuracy`（即降低 Inaccuracy 的门槛到 0.02 / 0.3）。这样前端零改动，且能捕捉 Java 会提示的轻微问题。
- 新增 `ProblemSeverity::Doubt` 变体 + 前端补 CSS 类。改动面大，且 `snake_case` 名为 `doubt`，需同步 TS 类型与样式。

**除非你有明确理由，选第一个**（改动小、前端零改、行为最接近 Java 的可感知效果）。若选第二个，必须在报告与提交信息中说明新增了枚举变体及其前端配套改动。

`label_for` 的中文标签**保持不变**。

**Verify**: `cargo test -p analysis-core` → all pass。

### Step 6: 补 `analysis-core` 单元测试

现有测试只有 1 个（`classifies`）。新增至少：

1. `diffs_are_normalized_to_black_perspective`
   - 构造两帧：`turn=1, to_play=Black, winrate_black=0.60`；`turn=2, to_play=White, winrate_black=0.55`。
   - 白走时的 0.55 表示**白**方 55%，即黑方 45%。故黑视角从 0.60 降到 0.45，损失 **0.15**。
   - 断言 `winrate_loss ≈ 0.15`（容差 `1e-5`），严重度为 `Mistake`（0.15 >= 0.10, < 0.20）。
   - **若实现未做视角归一化**，会算出 `|0.60 - 0.55| = 0.05` → `Inaccuracy`。这个测试会失败。这是本计划最重要的回归测试。

2. `no_problem_when_winrate_is_stable_across_side_change`
   - 两帧：`turn=1, Black, 0.60`；`turn=2, White, 0.40`。
   - 白走时 0.40 = 黑方 60%。黑视角**无变化**，损失应为 0。
   - 断言 `winrate_loss ≈ 0.0`，且**不产生** marker（严重度 `Info`）。
   - 未归一化时会算出 `|0.60 - 0.40| = 0.20` → 误报 `Blunder`。**这是问题 A 的典型误报场景。**

3. `score_loss_is_normalized_to_black_perspective`
   - `turn=1, Black, score_mean_black=2.0`；`turn=2, White, score_mean_black=1.0`。
   - 白走时 +1.0 表示白领先 1 目 = 黑落后 1 目（`-1.0`）。黑视角从 +2.0 到 -1.0，损失 **3.0** 目。
   - 断言 `score_loss ≈ 3.0`，严重度按新阈值应为 `Mistake`（3.0 >= 2.0）。

4. `severity_thresholds_match_java_ladder`
   - 表驱动断言边界值，覆盖 8 个常量：`0.20`/`0.19`（Blunder 边界）、`0.10`/`0.09`、`0.05`/`0.04`、`0.02`/`0.01`，以及目数 `5.0`/`4.9`、`2.0`/`1.9`、`1.0`/`0.9`、`0.3`/`0.2`。
   - 明确断言**边界相等时的行为**（`>=` 还是 `>`）——请与 Java 对齐：Java 的 `getBlunderColor` 用 `>`，但合并第四档后本实现的语义应在测试里固定下来并在注释中说明取舍。

5. `quick_overview_swing_uses_black_perspective`
   - 见 Step 7 的 `swing` 函数，构造用例断言 `swing` 用黑视角差值。

**Verify**: `cargo test -p analysis-core` → all pass，且 5 个新测试出现在输出。

### Step 7: 提供热力条数据（`swing`）

在 `crates/analysis-core/src/lib.rs` 新增：

```rust
/// 底部热力概览条的每一手数据。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuickOverviewBar {
    pub turn: u32,
    /// 黑视角胜率（0..1）。
    pub winrate_black: f32,
    /// 该手的黑视角胜率变化幅度（0..1）。越大越值得看。
    pub swing: f32,
    /// 是否有分析数据。
    pub has_analysis: bool,
}

/// 构造底部热力概览条数据，按手数升序。`swing` 用黑视角差值（对齐 Java 的 resolveQuickOverviewSwing）。
pub fn build_quick_overview_bars(frames: &[AnalysisFrameDto]) -> Vec<QuickOverviewBar>
```

要点：

- `winrate_black` 用 `winrate_as_black` 归一化后的值（与 Step 4 一致）。
- `swing` = 与**前一个已分析手**的黑视角胜率差的绝对值。首手（无前手）`swing = 0`。
- `has_analysis` 恒为 `true`（因为 frames 本身只含已分析手）。保留该字段是为了将来支持"未分析手也要显示占位"。
- **注意**：Java 的 `startsNewSegment`/快照节点会把 `swing` 置 0（`WinrateGraph.java:1954-1957`）。本仓库的 `AnalysisFrameDto` 没有快照节点概念（`BoardNodeKind` 在 SGF 树里有，但帧里没有），**因此本计划不做分段**。在 `Maintenance notes` 记录该差异。

**Verify**: `cargo test -p analysis-core` → all pass，含 Step 6 的测试 5。

### Step 8: 暴露为 Tauri 命令

在 `apps/desktop/src-tauri/src/lib.rs` 新增：

```rust
#[tauri::command]
fn quick_overview_bars(frames: Vec<AnalysisFrameDto>) -> Vec<analysis_core::QuickOverviewBar> {
    analysis_core::build_quick_overview_bars(&frames)
}
```

并注册进 `generate_handler![...]`。命名风格对齐既有的 `classify_problems`（`:1932`）。

在 `apps/desktop/src/api/backend.ts` 加 wrapper（沿用 `isTauriRuntime()` 守卫），并在 `apps/desktop/src/domain/types.ts` 加 `QuickOverviewBar` 类型。

**Verify**: `cargo check -p lizzieyzy-next-desktop` → exit 0；`cd apps/desktop && npm run build` → exit 0。

### Step 9: 前端绘制底部热力条

在 `apps/desktop/src/components/WinrateChart.tsx` 新增底部热力条绘制。

**布局**：把 Canvas 下部约 1/5 高度作为热力区，在胜率曲线之下。Java 用 `overviewHeight = max(42, min(68, height / 5))`（`WinrateGraph.java:1986`），可直接照搬。

**门控**（对齐 Java `canShowQuickOverview`，`WinrateGraph.java:2024-2030`）：宽度 >= 140 且手数 >= 2 才绘制。当前 Canvas 宽度取自 `canvas.clientWidth || 600`。

**默认阈值**（对齐 Java 默认 3.0 百分点）：`const issueThreshold = 0.03;`（小数）。

**`swingScale`**（对齐 `quickOverviewSwingScale`）：`max(issueThreshold, Math.ceil(maxSwing / 0.05) * 0.05)`。Java 的 `/5.0 *5.0` 是百分点粒度，小数下对应 `/0.05 *0.05`。

**高度与颜色**（对齐 Java 公式）：

```ts
if (bar.has_analysis && bar.swing >= issueThreshold) {
  const barHeight = Math.max(3, Math.round((bar.swing * innerHeight * 0.75) / swingScale));
  const severity = Math.max(0, Math.min(1, (bar.swing - issueThreshold) / Math.max(0.01, swingScale - issueThreshold)));
  const alpha = Math.min(255, Math.round(150 + 80 * severity)) / 255;
  const green = Math.max(70, Math.round(176 - 96 * severity));
  const blue = Math.max(36, Math.round(84 - 48 * severity));
  ctx.fillStyle = `rgba(255,${green},${blue},${alpha})`;
  ctx.fillRect(x - barWidth / 2, innerY + innerHeight - barHeight, barWidth, barHeight);
}
```

`barWidth` 对齐 Java `max(2, ceil(innerWidth / max(70.0, numMoves)))`（`WinrateGraph.java:2011-2012`）。

**保留既有行为**：胜率曲线与当前手竖线**必须继续绘制**，位置与样式不变。热力条是**新增**在最底部区域，不能挤占曲线的可用高度到不可读——若高度紧张，把 Canvas 的 CSS 高度从 `160` 提到约 `200`（`apps/desktop/src/styles.css` 里 `.winrate-chart` 的高度），并在报告中说明。

**加可断言属性**：

```tsx
data-quick-overview-bars={bars.length}
data-quick-overview-threshold={issueThreshold}
```

**Verify**: `cd apps/desktop && npm run build` → exit 0。

### Step 10: 全量门禁

**Verify**（逐条）:

1. `cargo fmt --all --check` → exit 0
2. `cargo clippy --workspace --all-targets -- -D warnings` → exit 0
3. `cargo test --workspace` → all pass
4. `cd apps/desktop && npm run build` → exit 0
5. `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed

## Test plan

- 新增 5 个 `analysis-core` 测试（Step 6），其中 `diffs_are_normalized_to_black_perspective` 与 `no_problem_when_winrate_is_stable_across_side_change` 是核心回归测试。
- 新增 1 个热力条测试（Step 7 的 `quick_overview_swing_uses_black_perspective`）。
- 结构参照：`crates/analysis-core/src/lib.rs:52` 起既有的 `mod tests`（其 `f(t, w, s)` 构造辅助函数需扩展以接受 `to_play`）。
- 浮点断言一律用容差比较（`(a - b).abs() < 1e-5`），不要 `assert_eq!` 比 `f32`。
- 验证：`cargo test -p analysis-core` → all pass，含 6 个新测试。

## Done criteria

全部成立才算完成：

- [ ] `cargo fmt --all --check` exit 0
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` exit 0
- [ ] `cargo test --workspace` exit 0；Step 6 的 5 个 + Step 7 的 1 个新测试通过
- [ ] `grep -n 'winrate_as_black\|score_as_black' crates/analysis-core/src/lib.rs` 有匹配
- [ ] `grep -n 'WINRATE_LOSS_BLUNDER\|SCORE_LOSS_BLUNDER' crates/analysis-core/src/lib.rs` 有匹配（阈值已常量化）
- [ ] `grep -n 'SCORE_LOSS_BLUNDER: f32 = 5.0' crates/analysis-core/src/lib.rs` 有匹配（目数阈值已对齐 Java）
- [ ] `grep -n 'pub fn build_quick_overview_bars' crates/analysis-core/src/lib.rs` 有 1 处匹配
- [ ] `grep -n 'data-quick-overview-bars' apps/desktop/src/components/WinrateChart.tsx` 有 1 处匹配
- [ ] `grep -n 'enum ProblemSeverity' -A6 crates/app-model/src/lib.rs` **仍只有 4 个变体**（除非你在报告中明确说明选择了新增变体）
- [ ] `cd apps/desktop && npm run build` exit 0
- [ ] `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed
- [ ] `git status` 的改动文件全部落在 In-scope 列表内
- [ ] `plans/README.md` 中本计划状态行已改为 `DONE`

## STOP conditions

出现以下任一情况，停止并报告，不要即兴发挥：

- plan 001 未合入，`GameSummaryDto` 仍无 `to_play` 字段（第 0 手视角无法确定）。
- 你发现 `AnalysisFrameDto` 加字段会破坏某个既有测试，而该测试断言的是精确的序列化 JSON 结构——报告具体测试与断言，不要为了让测试过而改断言（这可能意味着前端或缓存有隐式依赖）。
- 收紧目数阈值（12/7/3 → 5/2/1）后，某个既有测试或 smoke 脚本失败。**这是重要的信号**——报告它，说明具体断言，不要回退阈值来让测试变绿。
- 你无法确定 `winrate_as_black` 与 `score_as_black` 的符号是否正确（尤其 `score_as_black` 对白走时的取负）。**核对我引用的 Java 代码后再动手**；若仍不确定，报告并附上你的推导。
- `kata_analyze_line_to_frame`（plan 005 的产物）不存在，无法为流式路径填视角——报告，实时路径的视角修正可拆为后续项，但**不要**在批处理路径上留着不修。
- 需要改动 Scope 之外的任何文件，或需要引入依赖（尤其图表库）。
- `cargo test --workspace` 出现除 README 所述 2 个既有 macOS `/tmp` 失败之外的新失败。

## Maintenance notes

- **这是本轮唯一的跨 crate 接口变更**：`AnalysisFrameDto` 新增 `to_play`，且 `normalize_response` / `normalize_responses_for_turns` 签名变化。审阅者应确认**所有**构造点都被更新（`grep -rn 'AnalysisFrameDto {' crates/ apps/`），任何遗漏都会让该帧的视角落到默认值（黑），从而在换手处重新引入问题 A。
- **单位约定一览（务必记住，这是本仓库最容易出错的地方）**：
  - `AnalysisFrameDto.winrate_black`：**小数 0..1**，但语义是 **side-to-move 视角**（字段名是历史误导）。plan 008 通过 `to_play` 在消费侧归一化，**没有改字段名或改填充单位**——改名会波及前端与缓存，风险大于收益。
  - `ProblemMarkerDto.winrate_loss`：**小数 0..1 的幅度**（已归一化到黑视角）。
  - `score_loss`：**目数**。
  - 热力条 `swing`：**小数 0..1 的幅度**。
  - Java 内部全用 0..100 百分点；本仓库全用 0..1。**不要混用。**
- **审阅者重点看**：
  1. `winrate_as_black` 对白走时是 `1.0 - x`（不是 `-x`）；`score_as_black` 对白走时是 `-x`。**这个不对称是正确的**（胜率是概率，目差是带符号量）。
  2. 阈值常量与 Java 的对应关系是否有一一注释。
  3. 热力条的 `severity` 分母是否用了 `max(0.01, ...)` 防止除零。
- **与 Java 的已知差异（有意为之）**：
  - **热力条不做分段**：Java 在快照节点（`SNAPSHOT`，来自棋盘同步）处断开并置 `swing = 0`（`WinrateGraph.java:1954-1957`）。本仓库的 `AnalysisFrameDto` 无快照概念（`BoardNodeKind` 只存在于 SGF 树），故不做分段。若将来引入棋盘同步，必须补上。
  - **热力条不可点击**：Java 支持点击热力条跳转到该手。本仓库暂不做（属交互增强）。
  - **Java 的 `blunderBarColor` 自定义色未实现**：Java 允许用户配置热力条颜色（`Config.blunderBarColor`）。本仓库无该偏好项，用内置红-绿梯度。
- **未实现但相关**：`BlunderListPanel`（Java 的独立问题手列表面板，729 行，含按黑白方过滤、按指标排序）。本仓库的 `AnalysisPanel` 已有基础列表，达到 Java 那个面板的完整度是独立工作项，不在本轮。
- **性能**：`build_quick_overview_bars` 是 O(n)，每次 `frames` 变化时调用一次。在实时复盘下（plan 007，每秒最多 10 帧）会频繁调用。**当前可接受**；若发现卡顿，应把它与 `classifyProblems` 合并为一次调用，而不是提前优化。
