# Plan 005: `kata-analyze` info 行流式解析器

> **已按 `plans/GTP_LIVE_PROBE_FINDINGS.md` 修订（2026-09-13）**：**新增 Step 3b 视角转换**（实测 `kata-analyze` 是走棋方视角，DTO 约定是黑视角，必须转换 `winrate` 与 `score_mean`）；修正 `rootInfo` 相关措辞（实测**请求 `rootInfo true` 时它存在**，见 findings §3.1 勘误）；更新 Drift check 基底。
>
> **Executor instructions**: 按步骤执行，每步先跑验证命令、确认预期结果再进入下一步。若出现 "STOP conditions" 中的任一情况，停止并报告，不要即兴发挥。完成后更新 `plans/README.md` 中本计划的状态行。
>
> **Drift check（先跑）**: `git diff --stat b7f33a2..HEAD -- crates/katago-protocol/src/lib.rs crates/engine-manager/src/lib.rs`
> **基底说明（已更新）**：工作树 HEAD 已推进到 **`92dcfe8`**（含 001 提交 `96132c9`）。`crates/katago-protocol/src/lib.rs` **已因 plan 001 而变更**（`AnalysisQuery` 新增 `initial_stones`/`to_play`/`rules` 等）——这是**预期的**，不是漂移，**不要**因此判 STOP。真正要确认的是 `crates/engine-manager/src/lib.rs` 里是否已有 plan 004 的 `GtpSession`；若没有，本计划的 Step 1 仍可完成（解析器是纯函数），但 Step 4 的集成判断需按 STOP conditions 处理。

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/004-long-lived-gtp-session.md
- **Category**: direction（新能力：实时流式分析协议）
- **Planned at**: commit `b7f33a2`, 2026-09-12
- **Revised**: 2026-09-13，按 `plans/GTP_LIVE_PROBE_FINDINGS.md` 实测规格修订（**新增 Step 3b 视角转换**，见顶部说明）

## Why this matters

本仓库**只理解 KataGo 的 `analysis` 子命令 JSONL**，完全不懂 GTP 的 `kata-analyze` 文本行。证据：`crates/katago-protocol/src/lib.rs` 全部 545 行只有 `AnalysisQuery`/`AnalysisResponse`/`parse_response_line`（读 JSON 行），全仓 `grep` 无 `kata-analyze`、无 `info move`。

`kata-analyze` 是实时复盘唯一的协议：它每 `interval` 厘秒推一行 `info`，一行内可含**多个** `info` 块，还可能在行尾带一个 `ownership` 浮点数组。要把这些变成界面能用的 `AnalysisFrameDto`，必须有专门的解析器。

**关键单位差异（最容易出错的地方，已核对官方文档）**：

- `kata-analyze` 的浮点是**小数**：`winrate 0.480018`、`prior 0.221121`、`lcb 0.477221`（[GTP_Extensions.md:120](https://raw.githubusercontent.com/lightvector/KataGo/master/docs/GTP_Extensions.md)）。
- `lz-analyze` 的同类字段是**10000 倍整数**：`winrate 4802`、`prior 2211`（同文档 `:95`）。

本仓库现有 `AnalysisFrameDto.winrate_black` 用的是**小数 0..1**（`crates/katago-protocol/src/lib.rs:265` 直接填 `root.winrate`，来自 analysis JSONL 的小数）。因此 `kata-analyze` 的小数格式**恰好与现有约定一致**——不要做 `* 100` 缩放，否则整条链路会差 100 倍（这正是 Java 里 `* 100` 的原因：Java 内部统一用 0..100 百分比，本仓库统一用 0..1 小数）。

另有一个**必须处理的解析陷阱**：行尾的 `ownership` 数组必须在按 `info` 切分**之前**剥离。否则那 361 个浮点数会被当成最后一个 `info` 块的 `pv` 走法。Java 主线明确这么做了（`src/main/java/featurecat/lizzie/analysis/Leelaz.java:4795-4798`：先 `line.indexOf("ownership")` 截断，再 `split(" info ")`）。

## Current state

**关键文件**

- `crates/katago-protocol/src/lib.rs`（545 行）— 协议层。现有 `AnalysisResponse`（`:52`）、`RootInfo`（`:72`）、`MoveInfo`（`:85`）、`parse_response_line`（`:116`）、`normalize_response`（`:246`）。
- `crates/engine-manager/src/lib.rs` — plan 004 在此新增 `GtpSession` 与 `GtpSessionEvent`。
- `crates/app-model/src/lib.rs` — `AnalysisFrameDto`（`:120`）与 `CandidateMoveDto`（`:110`）是需要产出的目标类型。

**摘录 1：现有 DTO（解析器的目标）**（`crates/app-model/src/lib.rs:110-132`）

```rust
pub struct CandidateMoveDto {
    pub vertex: MoveVertex,
    pub visits: u32,
    pub winrate_black: f32,
    pub score_mean_black: f32,
    pub policy_prior: Option<f32>,
    pub pv: Vec<MoveVertex>,
}

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

**注意**：字段名带 `_black`，但现有 `normalize_response`（`:246`）**并未做视角转换**，只是直接填入 KataGo 原值（因为 analysis 路径的配置是 `reportAnalysisWinratesAs = BLACK`，原值**恰好就是黑视角**）。

**⚠️ 但 GTP `kata-analyze` 路径不能照搬这一点**（实测，见 `GTP_LIVE_PROBE_FINDINGS.md` §2）：本机 `gtp.cfg:82` 的 `reportAnalysisWinratesAs` 是**注释掉的**，KataGo 因而回落到**调用方 defaultPerspective = 走棋方**。所以 `kata-analyze` 报出的 `winrate`/`scoreMean`/`scoreLead` 是**走棋方视角**，而 DTO 字段约定是**固定黑视角**。

**因此本计划必须新增视角转换（Step 3b）**——这是原计划完全遗漏的一整步。不做的后果是**方向性错误**：白走时胜率与目差会整体反向，与批处理路径（黑视角）数值矛盾。

> 原计划此处写「视角语义问题在 plan 008 处理；本计划保持直接填原值」。该说法**已被实测推翻**：008 处理的是**问题手阈值**的视角语义，而**流式解析器产出帧**这一层的视角转换必须在本计划完成，否则 006/007 拿到的就是走棋方视角的帧。以 `GTP_LIVE_PROBE_FINDINGS.md` 为准。

**摘录 2：现有归一化范式（照此风格写 GTP 版）**（`crates/katago-protocol/src/lib.rs:246-270`，节选）

```rust
pub fn normalize_response(
    job_id: AnalysisJobId,
    response: AnalysisResponse,
    board_size: u8,
) -> AnalysisFrameDto {
    let root = response.root_info.unwrap_or(RootInfo { visits: 0, winrate: 0.5, score_mean: 0.0, score_stdev: None });
    AnalysisFrameDto {
        job_id,
        game_id: None,
        node_id: None,
        turn: response.turn_number,
        visits: root.visits,
        winrate_black: root.winrate,
        ...
```

**摘录 3：既有的 GTP 坐标 → DTO 转换（直接复用）**（`crates/katago-protocol/src/lib.rs:287-300`，节选）

```rust
pub fn gtp_vertex_to_dto(vertex: &str, board_size: u8) -> MoveVertex {
    if vertex.eq_ignore_ascii_case("pass") || vertex.is_empty() {
        return MoveVertex::Pass;
    }
    let mut chars = vertex.chars();
    let Some(col) = chars.next() else { return MoveVertex::Pass; };
    let row: String = chars.collect();
    let Ok(row_num) = row.parse::<u8>() else { return MoveVertex::Pass; };
    let col_upper = col.to_ascii_uppercase();
    let skipped_i = if col_upper > 'I' { 1 } else { 0 };
    ...
```

**`pv` 里的走法就是 GTP 坐标字符串**（如 `E4`、`pass`），因此 `pv` 可直接逐项调用 `gtp_vertex_to_dto`，无需新写坐标逻辑。

**摘录 4：官方输出格式（权威）**

`kata-analyze` 的一行（[GTP_Extensions.md:120](https://raw.githubusercontent.com/lightvector/KataGo/master/docs/GTP_Extensions.md)）：

```
info move E4 visits 487 utility -0.0408357 winrate 0.480018 scoreMean -0.611848 scoreStdev 24.7058 scoreLead -0.611848 scoreSelfplay -0.515178 prior 0.221121 lcb 0.477221 utilityLcb -0.0486664 order 0 pv E4 E3 F3 D3 F4 P4 P3 O3 Q3 O4 K3 Q6 S6 E16 E17 info move P16 visits 470 ... order 1 pv P16 P17 ... info move E16 visits 143 ... order 2 pv E16 P4 P3 ...
```

带 `rootInfo` 与 `ownership` 时（同文档 `:121`）：

```
info move E4 <...> info move P16 <...> info move E16 <...> rootInfo visits 1101 <winrate, utility, other properties of root> ownership <361 floats predicting ownership of each board point>
```

顶层字段依次为 `info`、`rootInfo`、`ownership`、`ownershipStdev`（同文档 `:122`）。

**字段清单（同文档 `:146` 起的 `rootInfo` 段，及 `:111-118` 的选项段）**：

- `info` 块内：`move`、`visits`、`winrate`、`scoreMean`、`scoreStdev`、`scoreLead`、`prior`、`lcb`、`order`、`pv`（`pv` 之后通常还有 `pvVisits`，若启用）。
- `rootInfo`：`visits` 及根节点属性（含 `winrate`）。
- `ownership`：空格分隔的浮点数组，长度 = 棋盘点数。

**仓库约定**

- 单文件 `lib.rs`；`katago-protocol` 依赖只有 `app-model`、`serde`、`serde_json`、`thiserror`、`uuid`。**不新增依赖**。
- **不要用 `regex`**：`katago-protocol` 的 `Cargo.toml` 里没有 regex，且逐字段解析用 `split_whitespace` 即可。加依赖属超范围。
- 错误统一 `thiserror`，参照 `ProtocolError`（`crates/katago-protocol/src/lib.rs:101`）：
```rust
pub enum ProtocolError {
    #[error("json parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("KataGo returned error: {0}")]
    Engine(String),
    #[error("move vertex ({x}, {y}) is outside board size {board_size}")]
    InvalidVertex { x: u8, y: u8, board_size: u8 },
}
```
- 测试内联 `#[cfg(test)] mod tests`，测试名描述性 snake_case（现有如 `analysis_query_serializes_camel_case`、`normalizes_gtp_vertices`）。

## Commands you will need

前置：`export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`

| Purpose | Command | Expected on success |
|---|---|---|
| 编译 | `cargo check --workspace --all-targets` | exit 0 |
| 定向测试 | `cargo test -p katago-protocol` | all pass |
| 全量测试 | `cargo test --workspace` | all pass |
| 格式 | `cargo fmt --all --check` | exit 0 |
| 静态检查 | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |

**无真实 KataGo**：本计划的解析器是**纯函数**，全部测试用**内联字符串字面量**（照抄官方文档的示例行），不 spawn 任何进程，不需要引擎。

## Scope

**In scope**

- `crates/katago-protocol/src/lib.rs` — 新增 `kata-analyze` 行解析器与其单元测试
- `crates/engine-manager/src/lib.rs` — **仅当**需要为解析器提供一个"行 → 解析结果"的适配层时才改；优先不改（见 Step 4）

**Out of scope**

- **不要**改 `GtpSession` 的语义（那是 plan 004 的产物）。若 004 的 API 不足以支持解析，报告并建议追加计划。
- **不要**改 `apps/desktop/src-tauri/src/lib.rs`（Tauri 命令是 plan 006）。
- **不要**改任何前端文件。
- **不要**改 `normalize_response` / `parse_response_line` / `AnalysisResponse`（既有 JSONL 路径必须保持不变）。
- **不要**改 `AnalysisFrameDto` 的**字段形状**（加字段属 plan 008）。但**必须**在 `kata_analyze_line_to_frame` 内做**视角转换**（Step 3b）——那是填充语义，不是字段变更。
- **不要**引入 `regex` 或任何新依赖。

## Git workflow

- 分支：`advisor/005-kata-analyze-stream-parser`
- 提交示例：`feat(protocol): parse kata-analyze streaming info lines`
- **不要推送、不要开 PR**，除非操作者指示。

## Steps

### Step 1: 定义解析结果类型

在 `crates/katago-protocol/src/lib.rs` 新增：

```rust
/// 一行 `kata-analyze` 输出的解析结果。
#[derive(Debug, Clone, PartialEq)]
pub struct KataAnalyzeLine {
    /// 该行内所有 `info` 块的候选点，按 `order` 升序。
    pub candidates: Vec<KataAnalyzeCandidate>,
    /// 根节点统计（仅当请求了 `rootInfo true`）。
    pub root: Option<KataAnalyzeRoot>,
    /// 棋盘归属数组（仅当请求了 `ownership true`）；索引为 `y * board_size + x`。
    pub ownership: Option<Vec<f32>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KataAnalyzeCandidate {
    pub vertex: MoveVertex,
    pub visits: u32,
    /// KataGo 原始小数（0..1），**不做缩放**。
    pub winrate: f32,
    pub score_mean: f32,
    pub score_stdev: Option<f32>,
    /// `prior` 的原始小数（0..1）。
    pub prior: Option<f32>,
    pub order: u32,
    pub pv: Vec<MoveVertex>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KataAnalyzeRoot {
    pub visits: u32,
    pub winrate: f32,
    pub score_mean: f32,
    pub score_stdev: Option<f32>,
}
```

**单位约定必须写进文档注释**（`///`），明确 `winrate`/`prior` 是 0..1 小数、`score_mean`/`score_stdev` 是目数不缩放。这防止后续维护者误加 `*100`。

**Verify**: `cargo check -p katago-protocol` → exit 0。

### Step 2: 实现解析函数

```rust
/// 解析一行 `kata-analyze` 输出。返回 `None` 表示该行不是分析输出（例如 GTP 的 `=` 响应或空行）。
pub fn parse_kata_analyze_line(line: &str, board_size: u8) -> Option<KataAnalyzeLine>;
```

实现要点，按此顺序：

1. **前置判定**：`line.trim()` 不以 `info ` 开头且不等于 `info`，返回 `None`。GTP 的 `=`/`?` 响应行、空行、`info` 之外的行都由 `None` 表示——调用方据此忽略。

2. **剥离 ownership**（**顺序关键**）：若 `line` 含 `ownership` 子串，先取它之前的部分作为 `moves_part`，再解析 `moves_part`。取其余部分解析为浮点数组。
   - 注意区分 `ownership` 与 `movesOwnership`：`movesOwnership` 是 `info` 块**内部**的逐手数组（在 `pv` 附近）。本计划**不解析** `movesOwnership`（我们不请求它），但实现时若遇到，应确保不会把它的内容误当顶层 `ownership`。用 `line.rfind(" ownership ")` 或按 `rootInfo` 之后的最后一个 `ownership` 定位，并在测试里覆盖。
   - ownership 数组长度应为 `board_size * board_size`。不符时**丢弃该数组**（置 `None`）而不是报错——半截数组会让棋盘渲染错位。

3. **切分 `info` 块**：对 `moves_part` 按空白切分后，以 `info` 标记为块边界重组。**推荐做法**：先 `split_whitespace()` 得到 token 序列，遍历时遇到 `info` 就开新块，其余 token 按 `key value` 成对填入当前块。
   - `pv` 是**变长列表**，会吞掉后续所有非 key 的 token。判定方式：`pv` 之后，只要下一个 token 不是已知的 key 名，就继续当作 pv 走法收集，直到遇到下一个 `info` 或行尾。
   - 已知 key 集合：`move`、`visits`、`winrate`、`scoreMean`、`scoreLead`、`scoreStdev`、`prior`、`lcb`、`order`、`pv`、`pvVisits`。**未识别的 key** 应被安全跳过（跳过它的值），不要 panic——KataGo 未来会加字段（文档明确有 `utility`、`utilityLcb`、`scoreSelfplay` 等）。

4. **坐标转换**：`move` 与每个 `pv` 走法用现有的 `gtp_vertex_to_dto`（`:287`）转换。

5. **按 `order` 升序排序** `candidates`。`order` 缺失时按出现顺序（给一个递增的兜底）。

6. **解析 `rootInfo`**：`rootInfo` 之后是 key-value 对，直到下一个顶层字段（`ownership`/`ownershipStdev`）或行尾。取 `visits`、`winrate`、`scoreMean`/`scoreLead`、`scoreStdev`。
   - **`rootInfo` 仅在请求了 `rootInfo true` 时出现**（实测，见 findings §3.1）。**不要**用第一个 `info` 块顶替根统计——实测首个 `info` 块是**最佳手**（`order 0`），其 `visits`/`winrate` 与 `rootInfo` 不等（如 `rootInfo.visits=540` vs 首块 `visits=114`）。官方文档亦明确二者语义不同（根统计跨全部 visits 平滑平均，最佳手会快速波动）。
   - `root` 缺失时按 Step 3 的规则回退到 `candidates[0]`（这是**降级**，不是等价替代）。plan 006 必须发 `rootInfo true` 以避免该降级。

**容错原则**：解析器**绝不 panic**。所有 `parse::<f32>()`/`parse::<u32>()` 失败时用 `unwrap_or(0.0)`/`unwrap_or(0)` 或跳过该字段。理由：这是高频调用的流式解析，引擎输出任何格式抖动都不应导致应用崩溃。

**Verify**: `cargo check -p katago-protocol` → exit 0。

### Step 3: 补一个转成 `AnalysisFrameDto` 的辅助函数

```rust
/// 把一行流式解析结果转成帧 DTO。
/// `turn` 由调用方给出（GTP 不报手数，调用方知道当前正在分析哪一手）。
pub fn kata_analyze_line_to_frame(
    job_id: AnalysisJobId,
    line: &KataAnalyzeLine,
    board_size: u8,
    turn: u32,
) -> AnalysisFrameDto;
```

填充规则：

- `turn` 用参数。
- `visits`/`winrate_black`/`score_mean_black`/`score_stdev`：**优先用 `root`**（若存在），否则回退到 `candidates[0]`。理由：`rootInfo` 是整棵搜索的平均，比最佳手更平滑，官方文档明确建议用 `rootInfo` 而非跨手累加（[GTP_Extensions.md:111](https://raw.githubusercontent.com/lightvector/KataGo/master/docs/GTP_Extensions.md)）。若两者都没有，用 `0` / `0.5`（中性胜率，与 `normalize_response` 的 `unwrap_or` 默认一致：`winrate: 0.5`）。
- `candidates`：逐项映射，`policy_prior` 填 `prior`。
- `ownership`：直接用解析结果。
- `policy`：置 `None`。GTP 流式路径不产出整盘 policy 数组（`kata-analyze` 的 `prior` 是**逐手**的，不是整盘 362 维 policy）。置 `None`，前端 `BoardCanvas` 已能处理 `policy` 为空（降级到 candidates 叠加，见 `apps/desktop/src/components/BoardCanvas.tsx:23`）。
- `node_id`/`game_id`：`None`（调用方需要时自行填充）。

**Verify**: `cargo check -p katago-protocol` → exit 0。

### Step 3b: ⚠️ 视角转换（**原计划完全遗漏的一整步，必做**）

**实测依据**（`GTP_LIVE_PROBE_FINDINGS.md` §2）：同一局面（9x9，黑占下方 4 行），只改走棋方，`kata-analyze` 报出的值随之反向：

| 走棋方 | 配置 | `winrate` | `scoreLead` |
|---|---|---|---|
| BLACK | 默认（`gtp.cfg`） | **0.988298** | 0.0850384 |
| WHITE | 默认（`gtp.cfg`） | **0.012669** | 0.169398 |
| WHITE | 强制 `=BLACK` | 0.987424 | −0.150276 |

**结论**：`kata-analyze` 的 `winrate` / `scoreMean` / `scoreLead` 全部是**走棋方视角**；DTO 约定是**固定黑视角**。

**实现要求**：`kata_analyze_line_to_frame` 接受一个**显式视角参数** `perspective: PlayerColor`（不硬编码假设），在填充前做转换。**该参数名以本裁定为准：`perspective`**（不是 `to_play`——`to_play` 语义是"轮谁走棋"，而这里要表达的是"**引擎本次输出用的是哪个视角**"，二者在本计划里恰好等价，但语义不同，故用 `perspective` 更准确）：

```rust
/// 把一行流式解析结果转成帧 DTO。
/// `perspective` 是**引擎本次输出所用视角**的显式、可审计契约（不是解析器内置的假设）。
/// `turn` 由调用方给出（GTP 不报手数，调用方知道当前正在分析哪一手）。
pub fn kata_analyze_line_to_frame(
    job_id: AnalysisJobId,
    line: &KataAnalyzeLine,
    turn: u32,
    perspective: PlayerColor,
) -> AnalysisFrameDto;
```

> **签名已与实现对齐**（t9 已交付）：无 `board_size` 参数——坐标在 `parse_kata_analyze_line(line, board_size)` 阶段就已转成 `MoveVertex`，帧层不再需要棋盘尺寸。

转换规则（**`winrate` 与 `score_mean` 必须一起转，不能只转一个**）：

```rust
// 引擎按 `perspective` 报告的视角；DTO 恒要黑视角
let flip = perspective == PlayerColor::White;
let adjust_winrate = |w: f32| if flip { 1.0 - w } else { w };
let adjust_score   = |s: f32| if flip { -s }   else { s };
```

**必须同时转换的四处**：

1. **根统计**（`root.winrate` / `root.score_mean`）→ 帧的 `visits`/`winrate_black`/`score_mean_black`/`score_stdev`。
2. **每个候选**（`candidate.winrate` / `candidate.score_mean`）→ `CandidateMoveDto.winrate_black` / `score_mean_black`。**不要只转根、漏转候选**——那会让棋盘上的候选点胜率与主胜率方向相反，是最难发现的一类错位。
3. **`ownership` 数组**（**实测确认它同样是视角相关的**）：`kata-analyze ... ownership true` 的输出随 `perspective` 整体反号。实测（9x9，黑占下方 4 行）：
   - 无 override（走棋方视角）：`player=B` → 黑方行均值 **−0.999**、白方行 **+0.999**；`player=W` → **整体反号**（黑方行 **+0.999**、白方行 **−0.999**）。
   - 强制 `=BLACK`：`player=B` 与 `player=W` **都**得到黑方行 **−0.999**（一致）。
   → 因此 `ownership` 必须与 `winrate`/`score` 一起转换（`adjust_score`）。**漏转它会让热力图整体反色**——棋盘显示"黑占优"而实际是白占优，且**不会报错**。
4. `score_stdev` **不转换**（标准差无方向性）；`policy_prior`（`prior`）也不转换。

**与 `-override-config` 的关系（裁定，2026-09-13）**：本计划**要求 plan 003 的 GTP 启动命令附带 `-override-config reportAnalysisWinratesAs=BLACK`**（见 plan 003 Step 1）。二者**互补，不是二选一，也不会双重转换**：

- `-override-config` 让**引擎输出确定**（恒为黑视角），把不确定性挡在源头；
- `perspective` 参数让**解析器的契约显式可审计**——若将来有人去掉该 override，实参变为 `White` 即是一个**可见的代码改动**，而不是所有白走帧被静默反向。
- **为什么不会双重转换**：override 生效时引擎报的就是黑视角，调用方传入的实参就是 `PlayerColor::Black`，`flip == false`，原样填充。**双重转换只会在"override 在但传 `White`"的错误组合下发生**——调用点必须与启动参数保持一致，Step 5 测试 11/15 覆盖这两向。

> **重要区分**：`kata-analyze` 的 **`player` 参数**（"轮谁走棋"，影响**搜索**）与 **`reportAnalysisWinratesAs`**（"报告用哪个视角"，影响**输出编码**）是两个正交的东西。带上 override **不**意味着可以省略 `player`——plan 006 仍必须发正确的 `player`。

**⚠️ 最易犯的实现错误：双重转换（double flip）**。`perspective` 入参必须表达「**引擎本次输出用的是哪个视角**」，**不是**「轮谁走棋」。带上 `-override-config` 后引擎**恒报黑视角**，因此调用方**必须恒传 `PlayerColor::Black`**。

若错误地把"走棋方"（轮白时 `White`）传进来，override 与入参**不一致**，会双重转换。实测演示（黑占下方 4 行、白占上方 4 行、**白走**、引擎带 `-override-config`）：

```
引擎原始 rootInfo.winrate（已是黑视角） = 0.000549    ← 正确：黑其实快输了
若调用方再按"走棋方=白"翻折：1 - 0.000549 = 0.999451  ← 错误：变成"黑大胜"
```

**这个错误不报错、不崩溃**，只是每个白走局面都反向。plan 006 的 `set_position` 有 `player` 参数（走棋方，给 `kata-analyze` 用），**不要**把同一个值直接喂给 `perspective`。启动参数（override）与 `perspective` 实参必须**成对一致**——这是 Step 5 测试 15 要锁住的不变量。

**`PlayerColor` 已在 `crates/app-model/src/lib.rs:11`**（`Black`/`White`，已 `derive(Default)` 且 `#[default] Black`）——直接用，**不要**新建类型。

**注意**：`katago-protocol` 需 `use app_model::PlayerColor`；确认该 crate 已依赖 `app-model`（plan 005 的 "仓库约定" 已说明依赖里含 `app-model`）。

**Verify**: `cargo check -p katago-protocol` → exit 0；并补 Step 5 的视角转换测试（黑/白两向）。

### Step 4: 仅在有需要时才动 engine-manager

本计划的解析器是纯函数，`katago-protocol` 是独立 crate。**默认不需要改 `engine-manager`**。

只有当 `engine-manager` 需要提供一个"从 `GtpSessionEvent::Line` 直接产出帧"的便利方法时才改；即使要改，也应放在 `katago-protocol`（因为它不需要进程），由 plan 006 在 Tauri 层组装。

**若你判断需要改 `engine-manager`**：停下来，在报告中说明理由，不要擅自修改 `GtpSession`（plan 004 的产物）。

### Step 5: 补单元测试（用官方文档的示例行）

新增至少以下测试。**测试数据必须包含官方文档里的真实示例行**（见 "Current state" 摘录 4）。

1. `parses_single_info_block`
   - 输入：`info move E4 visits 487 winrate 0.480018 scoreMean -0.611848 scoreStdev 24.7058 scoreLead -0.611848 prior 0.221121 lcb 0.477221 order 0 pv E4 E3 F3`
   - 断言：1 个 candidate；`visits == 487`；`winrate` 约等于 `0.480018`（用 `(a - b).abs() < 1e-5`）；`score_mean` 约等于 `-0.611848`；`score_stdev == Some(24.7058 附近)`；`prior == Some(0.221121 附近)`；`order == 0`；`pv.len() == 3` 且首项为 `MoveVertex::Point(PointDto { x: 4, y: 3 })`（E4 → GTP 列 E 是第 5 列 → x=4；行 4 → y=3，**注意 GTP 行号从 1 开始而 y 从 0 开始，且跳字母 I**。此处请以 `gtp_vertex_to_dto` 的现有行为为准写断言，并在测试里加注释说明换算）。

2. `parses_multiple_info_blocks_on_one_line`
   - 输入：文档中三块连写的那一行（`info move E4 ... info move P16 ... info move E16 ...`）。
   - 断言：3 个 candidates，且按 `order` 升序为 `0, 1, 2`；各自 `visits` 正确。

3. `parses_root_info_and_ownership`
   - 输入：`info move E4 visits 487 winrate 0.480018 order 0 pv E4 rootInfo visits 1101 winrate 0.5005 scoreMean 1.25 ownership 0.1 0.2 0.3 0.4`
   - `board_size = 2`（因为 ownership 有 4 个值）。
   - 断言：`root` 存在且 `visits == 1101`；`ownership == Some(vec![0.1, 0.2, 0.3, 0.4])`；`candidates.len() == 1`。

4. `ownership_is_stripped_before_pv_parsing`（**本计划最重要的回归测试**）
   - 输入：`info move E4 visits 10 order 0 pv E4 E3 ownership 0.5 0.5 0.5 0.5`，`board_size = 2`。
   - 断言：`candidates[0].pv == vec![E4, E3]`（**只有 2 项**），`ownership` 长度为 4。
   - 若实现顺序错误（先切 `info` 后剥 ownership），`pv` 会多出 4 个元素——这个测试会失败。

5. `ownership_with_wrong_length_is_dropped`
   - 输入 ownership 只有 3 个值、`board_size = 2`（应为 4）。
   - 断言：`ownership == None`。

6. `non_info_lines_return_none`
   - 输入：`"= "`、`""`、`"?"`、`"info"`（仅关键字）分别断言返回 `None`。

7. `unknown_keys_do_not_panic`
   - 输入：含文档里出现的 `utility -0.0408357`、`utilityLcb -0.0486664`、`scoreSelfplay -0.515178` 的行。
   - 断言：正常解析出 candidate，`visits`/`winrate` 正确，不 panic。

8. `malformed_numbers_fall_back_without_panic`
   - 输入：`info move E4 visits abc winrate xyz order 0 pv E4`。
   - 断言：不 panic；`visits == 0`（或该字段被跳过）；仍返回 `Some`，且 `candidates` 非空。

9. `kata_analyze_line_to_frame_prefers_root_stats`
   - 构造含 `root` 与 `candidates` 的输入，断言帧的 `visits`/`winrate_black` 取自 `root` 而非 `candidates[0]`。

10. `kata_analyze_line_to_frame_falls_back_to_best_candidate`
    - 构造**不含** `root` 的输入，断言帧的值取自 `candidates[0]`。

**视角转换测试（Step 3b 的回归测试，必做）**：

11. `kata_analyze_line_to_frame_black_perspective_passes_values_through`
    - 输入：`root` 含 `winrate 0.98` / `scoreMean 0.085`，`perspective = PlayerColor::Black`。
    - 断言：帧的 `winrate_black ≈ 0.98`、`score_mean_black ≈ 0.085`（**原值直传，不翻折**）。

12. `kata_analyze_line_to_frame_white_perspective_flips_winrate_and_score`
    - 输入：同一份 `root`（`winrate 0.012669` / `scoreMean 0.169398`），`perspective = PlayerColor::White`。
    - 断言：帧的 `winrate_black ≈ 1.0 - 0.012669 = 0.987331`、`score_mean_black ≈ -0.169398`（**两者都翻**）。

13. `kata_analyze_line_to_frame_flips_candidates_too`
    - 输入：含 2 个候选（各带 `winrate`/`scoreMean`），`perspective = PlayerColor::White`。
    - 断言：**每个** `CandidateMoveDto.winrate_black == 1.0 - 原值`、`score_mean_black == -原值`。
    - **这条防的是"只转根、漏转候选"**——那会让棋盘候选点胜率与主胜率方向相反。

14. `kata_analyze_line_to_frame_does_not_flip_score_stdev_or_prior`
    - 输入：`scoreStdev 5.0`、`prior 0.2`，`perspective = PlayerColor::White`。
    - 断言：帧的 `score_stdev == Some(5.0)`、候选的 `policy_prior == Some(0.2)`（二者无方向性，**不取反**）。

15. `kata_analyze_line_to_frame_never_double_flips`
    - 目的：锁住「override 与 `perspective` 实参成对一致」的不变量。
    - 构造：模拟**引擎已带 `-override-config reportAnalysisWinratesAs=BLACK`** 的输出（即 `winrate` 已是黑视角，如 `0.000549`），断言调用方**传 `Black`** 时帧为 `0.000549`（不变），且**传 `White` 会得到 `0.999451`**（即双重转换）。
    - 该测试的价值：把"传错会怎样"**显式编码**，使后来者无法在不知情的情况下把走棋方喂进 `perspective`。
    - 补充断言：同一个 `KataAnalyzeLine` 分别以 `Black` 与 `White` 调用，两次 `winrate_black` 之和 ≈ `1.0`（证明转换只由入参决定、且是单次的 `1 - w`）。

16. `kata_analyze_line_to_frame_flips_ownership_array`
    - 输入：`ownership = [0.5, -0.25, 1.0, -1.0]`，`perspective = PlayerColor::White`。
    - 断言：帧的 `ownership == Some([-0.5, 0.25, -1.0, 1.0])`（**整体取反**）。
    - 实测依据：`ownership` 随 `perspective` 整体反号（见 Step 3b 第 3 条）。**漏转会让热力图整体反色且不报错。**

**Verify**: `cargo test -p katago-protocol` → all pass，且 16 个新测试出现在输出中。

### Step 6: 门禁

**Verify**（逐条）:

1. `cargo fmt --all --check` → exit 0
2. `cargo clippy --workspace --all-targets -- -D warnings` → exit 0（若新 API 尚无调用方导致 `dead_code`，加 `#[allow(dead_code)]` 并在提交信息说明"plan 006 将接入"，**不要**删功能）
3. `cargo test --workspace` → all pass
4. `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed

## Test plan

- 新增 16 个测试（Step 5：10 个解析测试 + 6 个视角转换测试），数据来自 KataGo 官方文档示例行与实测视角数据（不依赖真实引擎）。
- 结构参照：`crates/katago-protocol/src/lib.rs` 既有测试（`normalizes_gtp_vertices` 等一批 `pub fn` 的伴生测试）。
- 浮点断言一律用容差比较（`(a - b).abs() < 1e-5`），**不要**用 `assert_eq!` 比较 `f32`。
- 验证：`cargo test -p katago-protocol` → all pass，含 16 个新测试。

## Done criteria

全部成立才算完成：

- [ ] `cargo fmt --all --check` exit 0
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` exit 0
- [ ] `cargo test --workspace` exit 0；Step 5 的 16 个新测试通过
- [ ] `grep -n 'pub fn parse_kata_analyze_line' crates/katago-protocol/src/lib.rs` 有 1 处匹配
- [ ] `grep -n 'pub fn kata_analyze_line_to_frame' crates/katago-protocol/src/lib.rs` 有 1 处匹配
- [ ] `kata_analyze_line_to_frame` 的签名含 `perspective: PlayerColor` 参数（Step 3b；参数名以 `:302` 的裁定为准，**不是** `to_play`）
- [ ] `grep -n '1.0 - winrate\|1.0 - root' crates/katago-protocol/src/lib.rs` 有匹配（视角翻折已实现）
- [ ] 视角转换测试 11–16 全部通过（黑/白两向 + 候选也翻 + `stdev`/`prior` 不翻 + **`ownership` 也翻** + **无双重转换**）
- [ ] `grep -n 'regex' crates/katago-protocol/Cargo.toml` 无匹配（未加依赖）
- [ ] `grep -n '0.480018' crates/katago-protocol/src/lib.rs` 有匹配（测试用了官方示例行的真实数据）
- [ ] 既有 JSONL 路径测试全部仍通过（`parse_response_line` / `normalize_response` 未被改动）
- [ ] `git status` 的改动文件仅为 `crates/katago-protocol/src/lib.rs`（若动了 `engine-manager`，须在报告中说明理由）
- [ ] `plans/README.md` 中本计划状态行已改为 `DONE`

## STOP conditions

出现以下任一情况，停止并报告，不要即兴发挥：

- `GtpSession` 不存在（plan 004 未合入）。本计划的解析器虽是纯函数，但 Step 4 的集成判断依赖 004 已落地；**不要**因此自行实现会话。
- 你发现需要给 `AnalysisFrameDto` 加字段才能产出正确结果——**报告并停下**。加字段属 plan 008 的接口变更范围。（**注意**：Step 3b 的视角转换**不需要**加字段，它只改变填充语义；不要把它当成加字段的理由。）
- 官方示例行的 `pv` 中存在 `gtp_vertex_to_dto` 无法转换的 token（例如坐标带小写字母或超出棋盘）——报告具体 token，不要放宽现有转换函数的行为。
- 你发现必须引入 `regex` 或其它新依赖才能完成解析——报告，不要加依赖。
- 任何一步的验证连续两次失败且合理修复无效。
- 需要改动 Scope 之外的任何文件。
- `cargo test --workspace` 出现除 README 所述 2 个既有 macOS `/tmp` 失败之外的新失败。

## Maintenance notes

- **谁依赖这个**：plan 006 会在 Tauri 侧把 `GtpSessionEvent::Line` 喂给 `parse_kata_analyze_line`，再用 `kata_analyze_line_to_frame` 产出帧并通过事件推给前端。006 **不应**修改本计划的解析语义。
- **⚠️ 视角是第二个大坑（仅次于单位）**：`kata-analyze` 报**走棋方视角**（本机 `gtp.cfg` 的 `reportAnalysisWinratesAs` 被注释 → 回落 SIDETOMOVE），而 DTO 约定**黑视角**。Step 3b 的转换**必须同时覆盖 `winrate` 与 `score_mean`，且必须同时覆盖根统计与每个候选**。审阅者应重点确认：(a) 白走时确实翻折；(b) 候选也翻了（不能只翻根）；(c) `score_stdev` 没被误翻。漏转任一处都会产生**方向性错误**——白走局的胜率与目差整体反向，与批处理路径数值矛盾。
- **`perspective` 只能来自调用方**：`kata-analyze` 的行内**没有**走棋方字段（实测确认），因此视角完全依赖 `kata_analyze_line_to_frame` 的 `perspective` 入参。plan 006 必须把它从 `set_position` 的 `player` 参数一路传下来（注意：传入的是「引擎本次输出所用视角」，而非「轮谁走棋」——见 `:345` 的双重转换警告）。
- **单位是最大的坑**：`kata-analyze` 是小数 0..1，`lz-analyze` 是整数 0..10000，`analysis` JSONL 是小数 0..1。本仓库内部统一用 0..1 小数，因此**两种 KataGo 路径恰好一致**，但与 Java 内部（0..100）相反。任何"看到 winrate 是 0.48 觉得应该乘 100"的改动都会破坏整条链路。审阅者应重点确认没有引入 `*100`。
- **KataGo 会加字段**：文档明确 `utility`、`utilityLcb`、`scoreSelfplay`、`pvVisits`、`movesOwnership`、`ownershipStdev` 等存在或可能新增。解析器的"未知 key 安全跳过"是本计划的关键健壮性设计，审阅时不要为了"严格"而改成报错。
- **未实现但相关**：
  - `movesOwnership`（逐手归属数组）——需要更大的 DTO，本轮不做。
  - `pvVisits`（pv 各步访问数）——需要扩展 `CandidateMoveDto`，本轮不做。
  - ponder / `genmove` ——不在本轮。
- **性能**：解析器在每次 `interval`（默认 10 厘秒 = 100 ms）被调用一次，行内可能含数十个 `info` 块。当前实现对每个 `info` 块做一次 `MoveVertex` 分配，属可接受量级。**若将来发现瓶颈**，优先测 `gtp_vertex_to_dto` 的调用次数，而不是提前优化。
- **与 Java 的差异（有意为之）**：Java 的解析器（`MoveData.fromInfoKatago`，`src/main/java/featurecat/lizzie/analysis/MoveData.java:199-236`）把 winrate `*100` 并写进一个巨大的 `MoveData` 类（含 UI 状态）。本计划产出的是**纯数据**且**不缩放**，符合本仓库"领域层无 UI"的分层。
