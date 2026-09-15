# Plan 001: 修正分析查询保真度（视角、让子摆子、规则）

> **Executor instructions**: 按步骤执行，每步先跑验证命令、确认预期结果再进入下一步。若出现 "STOP conditions" 中的任一情况，停止并报告，不要即兴发挥。完成后更新 `plans/README.md` 中本计划的状态行。
>
> **Drift check（先跑）**: `git diff --stat b7f33a2..HEAD -- crates/sgf/src/lib.rs crates/katago-protocol/src/lib.rs crates/app-model/src/lib.rs apps/desktop/src-tauri/src/lib.rs`
> 若上述任一文件在基准提交后已变更，先把 "Current state" 里的摘录与现网代码逐条对照；不一致即视为 STOP condition。

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b7f33a2`, 2026-09-12

## Why this matters

当前发给 KataGo 的分析查询会在三个地方丢失或篡改局面信息，导致**分析结果指向错误的局面**：

1. **胜率视角不明（依赖引擎配置，需实测确认）**：`AnalysisFrameDto.winrate_black` 字段名声称是"黑方胜率"，但填入的是 KataGo 返回的原始 `rootInfo.winrate`，**没有任何视角归一化**。该值究竟是黑视角还是 side-to-move 视角，**取决于分析配置里 `reportAnalysisWinratesAs` 的取值**：
   - KataGo 的解析逻辑（`cpp/program/setup.cpp:920-935` 的 `parseReportAnalysisWinrates`）：**配置含该键**则按 `BLACK`/`WHITE`/`SIDETOMOVE` 解析；**键缺失**才回退到调用方传入的 `defaultPerspective`。
   - `katago analysis` 传入的默认值是 `C_EMPTY`（等价 SIDETOMOVE）——见 `cpp/command/analysis.cpp:141`：`loadParams(cfg, defaultParams, defaultPerspective, C_EMPTY);`
   - **但官方 analysis 模板 `cpp/configs/analysis_example.cfg:30` 显式写着 `reportAnalysisWinratesAs = BLACK`**（不是注释，是生效的键值）。
   - **结论**：若实际使用的 analysis 配置来自官方模板，则该值是**黑视角**，字段名 `winrate_black` 恰好正确、没有翻折问题；若配置删掉了该键（或用了不带该键的自定义配置），则退化为 SIDETOMOVE，此时换手处的相邻帧相减会系统性出错。
   
   **因此本条是"配置相关"而非无条件缺陷。** 执行者与验证者**必须**：先确认实际使用的 analysis 配置中 `reportAnalysisWinratesAs` 的取值，再判断是否存在视角问题。plan 008 的立论前提同样依赖这一点，其 Step 2 要求为帧填充 `to_play` 正是为了**不依赖配置**地做归一化（无论配置是 BLACK 还是 SIDETOMOVE，消费侧都能正确归一）——这是比依赖配置更稳的做法，也是 008 的真正价值。
   
   > 更正说明（2026-09-12）：本计划初稿把"默认视角是 SIDETOMOVE"写成无条件事实，并引用了 **GTP** 配置文件（`gtpconfig.cpp`）作为依据。经复核，对 `analysis` 子命令而言该结论**取决于配置**，且官方 analysis 模板恰恰是 `BLACK`。引用 GTP 配置来论证 analysis 路径的默认值是不严谨的，已按上述事实链更正。

2. **让子/摆子丢失**：`to_game_dto` 只搬运 `doc.moves`，而 `SgfDocument` 的摆子信息（`AB`/`AW`/`AE`）只存在于 `root` 节点属性里，未被提取。分析查询构造时硬编码 `initial_stones: Vec::new()`。因此**让子局、以及任何用摆子表达初始局面的棋谱（含大量野狐/弈客导入谱）会被当成空盘分析**，整盘结果全错。

3. **规则硬编码**：分析查询的 `rules` 恒为 `"chinese"`，忽略了 SGF 的 `RU` 属性。日韩规则棋谱（数目法、双活判定、贴目不同）会被按中国规则分析，收官阶段目差与胜负判断偏离。

三者叠加的实际后果：用户看到一条看似正常的胜率曲线和问题手列表，但内容对应的是另一个局面或另一套规则——**这是"静默错误答案"，比报错更危险**。

## Current state

**关键文件与职责**

- `crates/sgf/src/lib.rs` — SGF 解析/回放/序列化。`parse_sgf` 产出 `SgfDocument`（含 `root: Option<SgfNode>`），`to_game_dto` 把 `SgfDocument` 压成 `GameDto`。
- `crates/app-model/src/lib.rs` — 跨 Rust/TS 边界的 DTO 定义。
- `crates/katago-protocol/src/lib.rs` — 构造 KataGo analysis JSONL 查询并归一化响应。
- `apps/desktop/src-tauri/src/lib.rs` — Tauri 网关，四处硬编码 `rules: "chinese"`。

**摘录 1：`to_game_dto` 丢弃摆子**（`crates/sgf/src/lib.rs:577-590`）

```rust
pub fn to_game_dto(doc: SgfDocument) -> GameDto {
    GameDto {
        summary: GameSummaryDto {
            id: Uuid::new_v4(),
            board_size: doc.board_size,
            komi: doc.komi,
            black_name: doc.black_name,
            white_name: doc.white_name,
            result: doc.result,
            move_count: doc.moves.len(),
        },
        moves: doc.moves,
    }
}
```

注意 `SgfDocument` 本身**是有** `root` 字段的（`crates/sgf/src/lib.rs:20`：`pub root: Option<SgfNode>`），摆子数据就在里面，只是没被搬运。

**摘录 2：`GameDto` / `GameSummaryDto` 没有摆子与行棋方字段**（`crates/app-model/src/lib.rs:65-79`）

```rust
pub struct GameSummaryDto {
    pub id: GameId,
    pub board_size: u8,
    pub komi: f32,
    pub black_name: Option<String>,
    pub white_name: Option<String>,
    pub result: Option<String>,
    pub move_count: usize,
}

pub struct GameDto {
    pub summary: GameSummaryDto,
    pub moves: Vec<MoveDto>,
}
```

**摘录 3：查询构造硬编码空摆子 + 中国规则**（`crates/katago-protocol/src/lib.rs:124-150`，`analysis_query_from_game`）

```rust
    Ok(AnalysisQuery {
        id: options.id,
        moves,
        initial_stones: Vec::new(),      // <- 恒空
        rules: options.rules,
        komi: game.summary.komi,
        ...
```

同类问题在 `analysis_batch_query_from_game` 的 `crates/katago-protocol/src/lib.rs:167`（`initial_stones: Vec::new()`）。

**摘录 4：网关四处硬编码规则**（`apps/desktop/src-tauri/src/lib.rs`）

- `:2147` — `katago_analyze_once` 内 `rules: "chinese".to_string()`
- `:2250` — `prepare_katago_batch_analysis` 内 `rules: "chinese".to_string()`

（`crates/katago-protocol/src/lib.rs:349` 和 `:360` 的两处是同名测试内的调用，非生产路径。）

**摘录 5：已存在的正确参照 —— 回放路径处理了摆子**

`replay_sgf_positions`（`crates/sgf/src/lib.rs:290-306`）**确实**调用了 `apply_setup_properties` 并读取 `PL`：

```rust
    for node in &mainline {
        if has_move_property(node) {
            break;
        }
        apply_setup_properties(&mut board, node, document.board_size)?;
        if let Some(color) = player_to_play(node)? {
            to_play = color;
        }
    }
```

`apply_setup_properties`（`:1824`）已完整支持 `AB`/`AW`/`AE`（含 `aa:cc` 矩形区间）。**这些现成逻辑必须复用，不要重写。** 本计划要做的是让 `GameDto` 与分析查询也享受到同样的保真度。

**仓库约定**

- 全部 crate 都是**单文件 `lib.rs`**；`crates/sgf` 已 1,800+ 行。新增代码追加到既有文件，不要新建模块文件。
- 错误类型用 `thiserror`，见 `crates/sgf/src/lib.rs` 的 `SgfError`。
- 单元测试写在每个文件底部的 `#[cfg(test)] mod tests { ... }`，测试名是描述性 snake_case，例如 `replays_setup_and_plays_in_order`、`roundtrips_variations_comments_setup_and_pl`（见 `crates/sgf/src/lib.rs:3507`、`:3658`）。
- DTO 用 `serde`，跨边界字段名默认 snake_case（不要加 `rename_all = "camelCase"`，`AnalysisFrameDto` 就是 snake_case，前端已依赖）。
- 黄金样例棋谱在 `tests/golden/`：`basic_19x19.sgf`、`sgf_compat_variations.sgf`、`sgf_ff4_compat.sgf`。

## Commands you will need

前置：`export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`

| Purpose | Command | Expected on success |
|---|---|---|
| 编译 | `cargo check --workspace --all-targets` | exit 0 |
| 定向测试 | `cargo test -p sgf -p katago-protocol -p app-model` | all pass |
| 全量测试 | `cargo test --workspace` | all pass |
| 格式 | `cargo fmt --all --check` | exit 0 |
| 静态检查 | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| 前端类型检查 | `cd apps/desktop && npm run build` | exit 0 |
| 脚手架校验 | `python3 scripts/validate_scaffold.py --verbose` | 10 passed, 0 failed |

## Scope

**In scope**（只允许改这些）

- `crates/app-model/src/lib.rs` — 给 `GameSummaryDto` 增加 `initial_stones`、`to_play`、`rules` 三个字段
- `crates/sgf/src/lib.rs` — `to_game_dto` 搬运摆子与 `RU`；新增 `katago_rules_for_sgf_ru` 规则归一化函数
- `crates/katago-protocol/src/lib.rs` — `initial_stones` 与 `rules` 来自 `GameDto`
- `apps/desktop/src-tauri/src/lib.rs` — 移除两处 `rules: "chinese"` 硬编码
- `tests/golden/handicap_9x9.sgf`（新建）— 让子局黄金样例

**Out of scope**（不要动）

- `crates/analysis-core/` — 阈值与视角修正分属 plan 008，这里不要改。
- `crates/engine-manager/` — 进程与启动参数分属 plan 003。
- `apps/desktop/src/**` — 前端本次不改。`GameSummaryDto` 加字段是**纯增字段**，前端既有读取不会破坏。
- 不要重构 `parse_sgf` / `replay_sgf_positions` / `apply_setup_properties`。它们是对的，直接调用。
- 不要改动 `AnalysisFrameDto.winrate_black` 的**序列化字段名**。前端 `AnalysisPanel.tsx`、`WinrateChart.tsx` 依赖 `winrate_black`。

## Git workflow

- 分支：`advisor/001-analysis-query-fidelity`（仓库既有惯例为 `codex/<slug>`，此处用 `advisor/` 前缀以区分人工执行）。
- 提交信息风格对齐仓库既有格式，用 conventional commits：`feat:` / `fix:` / `test:` 前缀 + 简短祈使句。参照 `git log --oneline` 中的 `fix(sgf): confirm rules before resuming analysis`、`test: add legacy config migration corpus`。
- 每步一次提交，或每个逻辑单元一次提交。**不要推送、不要开 PR**，除非操作者指示。

## Steps

### Step 1: 给 `GameSummaryDto` 增加摆子与行棋方字段

在 `crates/app-model/src/lib.rs` 的 `GameSummaryDto`（`:65`）中新增两个字段：

```rust
    /// 初始摆子（SGF 的 AB/AW/AE），坐标为 0-based。空表示空盘开局。
    pub initial_stones: Vec<StoneDto>,
    /// 初始行棋方（SGF 的 PL）。缺省为黑。
    pub to_play: PlayerColor,
```

**字段名必须用 `to_play`**，与既有的 `PositionDto.to_play`（`crates/app-model/src/lib.rs:56`）保持一致——同义字段在同一 DTO 层用两个名字会让后续维护者困惑。

注意区分两个名字：**DTO 字段是 `to_play`**，而 `crates/sgf` 内读取 SGF `PL` 属性的**辅助函数**叫 `player_to_play(node)`（`:1387`）——两者不是一回事，不要混用。

`StoneDto` 已存在（`:46`，字段 `x: u8, y: u8, color: PlayerColor`），直接复用，不要新建类型。

为免序列化兼容问题，给两个字段加 `#[serde(default)]`。`PlayerColor` 需要实现 `Default`；若它尚未实现，加：

```rust
impl Default for PlayerColor {
    fn default() -> Self {
        PlayerColor::Black
    }
}
```

**Verify**: `cargo check --workspace --all-targets` → exit 0。

### Step 2: `to_game_dto` 提取摆子与行棋方

在 `crates/sgf/src/lib.rs` 的 `to_game_dto`（`:577`）中，从 `doc.root` 提取摆子与 `PL`。

**必须复用**既有的节点遍历与属性辅助函数。现有可用工具（在 `crates/sgf/src/lib.rs` 内）：

- `has_move_property(node)` — 判断节点是否含 `B`/`W`
- `apply_setup_properties(board, node, board_size)`（`:1824`）— 把 `AB`/`AW`/`AE` 应用到 `Board`
- `player_to_play(node) -> Result<Option<PlayerColor>, SgfError>`（`:1387`）— 读 `PL`
- `stones_from_board(&board)` — 把 `Board` 转为 `Vec<StoneDto>`
- `mainline_nodes(&root)` — 主线下游节点迭代

推荐做法：先用一个临时 `Board` 按**前导非落子节点**应用摆子（与 `replay_sgf_positions` 的 `:296-302` 完全同一模式），再用 `stones_from_board` 取出非空点；`player_to_play` 取首个非空 `PL`，缺省 `PlayerColor::Black`。

注意 `sgf::Board` 有两个来源：`crates/go-core` 的 `Board` 与 `crates/sgf` 内部的 `Board`。`apply_setup_properties` 与 `stones_from_board` 都操作 `crates/sgf` 的内部类型，**沿用同一类型**，不要引入 `go-core::Board`。

`to_game_dto` 的签名是 `pub fn to_game_dto(doc: SgfDocument) -> GameDto`（不返回 `Result`）。提取过程可能失败（如畸形摆子坐标）。**保持签名不变**，用 `unwrap_or_default()` / `ok().flatten()` 容错降级为空摆子——SGF 已被 `parse_sgf` 校验过，这里的失败属异常输入，降级为空盘比让整个命令失败更合理（与 `replay_sgf_positions` 的严格性差异是有意为之，因为那是回放路径）。

**Verify**: `cargo test -p sgf` → all pass（此时既有测试应全绿；若 `roundtrips_variations_comments_setup_and_pl` 失败，说明你改坏了序列化，回退）。

### Step 3: 让分析查询使用真实摆子与规则

在 `crates/katago-protocol/src/lib.rs`：

**3a.** 给 `AnalysisQueryOptions` 与 `AnalysisBatchQueryOptions` 都不需要加字段——规则通过 `analysis_query_from_game` 的 `options.rules` 传入，已存在。真正要改的是 `initial_stones`：

`analysis_query_from_game`（`:124`）中的 `initial_stones: Vec::new()`（`:140`）改为从 `game.summary.initial_stones` 构造 `Vec<KataMove>`。KataGo 的空盘摆子坐标用 `(col, row)` 的 GTP 风格字符串（该文件已有 `move_vertex_to_kata_coordinate` / `point_to_kata_coordinate`，见 `:203`、`:210`），直接用它们把 `StoneDto` 转为 `KataMove`。

同理修改 `analysis_batch_query_from_game`（`:167`）。

**3b.** 在 `apps/desktop/src-tauri/src/lib.rs` 移除两处硬编码：`:2147` 与 `:2250` 的 `rules: "chinese".to_string()`，改为从 SGF 的 `RU` 解析得到的规则名。规则解析放在 `crates/sgf`（DTO 层不应解析 SGF），即在 `GameSummaryDto` 增加 `rules: Option<String>`，由 Step 2 的同一个提取流程填入（`property_values(&root, "RU")`）。

KataGo 接受的规则名是小写标识（如 `chinese`、`japanese`、`tromp-taylor`）。SGF 的 `RU` 是自由文本（可能是 `Chinese`、`Japanese`、`中国规则`）。因此需要一个**小写归一化映射**：把已知别名映射到 KataGo 标识，未知值回退为 `"chinese"`。把该映射实现为 `crates/sgf` 中的纯函数并单测，例如：

```rust
pub fn katago_rules_for_sgf_ru(raw: Option<&str>) -> &'static str
```

至少覆盖：`chinese`/`中国`→`chinese`；`japanese`/`日本`→`japanese`；`tromp-taylor`/`tt`→`tromp-taylor`；未知/None→`chinese`。

**Verify**: `cargo test -p sgf -p katago-protocol -p app-model` → all pass。

### Step 4: 新建让子黄金样例并加端到端断言测试

新建 `tests/golden/handicap_9x9.sgf`，内容为 9x9 让三子局，含 `HA[3]`、`AB[cc][gg][cg]`、`PL[W]`、若干手落子。示例（可微调，但必须含 `HA`/`AB`/`PL`）：

```
(;GM[1]FF[4]SZ[9]KM[0.5]HA[3]AB[cc][gg][cg]PL[W]PB[Black]PW[White]
;W[ee];B[gc];W[ce])
```

在 `crates/sgf/src/lib.rs` 的测试模块中新增测试：

- `to_game_dto_carries_setup_stones_and_player_to_play` — 解析上面的 9x9 让子谱，断言 `summary.initial_stones.len() == 3`、`summary.to_play == PlayerColor::White`、`summary.rules` 解析结果符合预期。
- `to_game_dto_defaults_to_empty_board_for_normal_game` — 解析 `tests/golden/basic_19x19.sgf`，断言 `initial_stones` 为空、`to_play == Black`。
- `katago_rules_for_sgf_ru_maps_known_aliases` — 覆盖 Step 3b 的映射表（含未知值回退）。
- `analysis_query_includes_setup_stones`（放在 `crates/katago-protocol/src/lib.rs` 测试模块）— 构造一个含 3 个 `initial_stones` 的 `GameDto`，调用 `analysis_query_from_game`，断言产出的 `AnalysisQuery.initial_stones.len() == 3`。

**Verify**: `cargo test --workspace` → all pass，且上述 4 个新测试出现在输出中。

### Step 5: 全量门禁

**Verify**（逐条）:

1. `cargo fmt --all --check` → exit 0
2. `cargo clippy --workspace --all-targets -- -D warnings` → exit 0
3. `cargo test --workspace` → all pass
4. `cd apps/desktop && npm run build` → exit 0
5. `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed

## Test plan

- 新增测试文件：无（沿用各 crate 底部内联测试模块）。
- 新增测试：见 Step 4 的 4 个，另在 Step 3b 为规则映射补 1 个边界测试（空字符串 `Some("")` 应回退 `chinese`）。
- 结构参照：`crates/sgf/src/lib.rs:3658` 的 `replay_applies_setup_stones_and_player_to_play`（让子/摆子断言范式）与 `:3507` 的 `roundtrips_variations_comments_setup_and_pl`。
- 验证：`cargo test --workspace` → all pass，含 5 个新测试。

## Done criteria

全部成立才算完成：

- [x] `cargo fmt --all --check` exit 0
- [x] `cargo clippy --workspace --all-targets -- -D warnings` exit 0
- [x] `cargo test --workspace` exit 0；Step 4 的 5 个新测试存在且通过
- [x] `grep -rn 'rules: "chinese"' apps/desktop/src-tauri/src/lib.rs` 无匹配
- [x] `grep -rn 'initial_stones: Vec::new()' crates/katago-protocol/src/lib.rs` 无匹配（生产路径不再硬编码空摆子）
- [x] `tests/golden/handicap_9x9.sgf` 存在且含 `HA[`、`AB[`、`PL[`
- [x] `cd apps/desktop && npm run build` exit 0
- [x] `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed
- [x] `git status` 显示的改动文件全部落在 Scope 的 In-scope 列表内
- [x] `plans/README.md` 中本计划状态行已改为 `DONE`

## STOP conditions

出现以下任一情况，停止并报告，不要即兴发挥：

- "Current state" 摘录与现网代码不一致（代码已漂移）。
- `crates/sgf` 内部 `Board` 类型不提供你需要的构造方式，或 `stones_from_board` 不可用——不要为了绕过而引入 `go-core::Board` 或重写棋盘逻辑，直接报告。
- KataGo 的 `initialStones` 字段格式与你的假设不符（去 KataGo 官方 `docs/Analysis_Engine.md` 核对；若无法联网核对，报告并停下）。
- 发现 `PlayerColor` 已有 `Default` 实现且语义不是 Black——报告，不要覆盖。
- 任何一步的验证连续两次失败且合理修复无效。
- 需要改动 Scope 之外的任何文件。
- `cargo test --workspace` 出现**除** README 所述 2 个既有 macOS `/tmp` 失败之外的新失败。

## Maintenance notes

- **谁会被影响**：`GameSummaryDto` 新增字段后，任何序列化 `GameDto` 的路径（前端 `parseSgfSummary` 的返回、缓存记录）都会多出两个字段。前端是纯增字段读取，不会破坏；但如果将来给 `GameSummaryDto` 加**必填**字段，需同步前端 `apps/desktop/src/domain/types.ts` 的 `GameDto` 类型定义。
- **审阅者重点看**：`to_game_dto` 的容错降级是否会把**正常**棋谱误解为异常（例如 `AE` 删除摆子后 `stones_from_board` 是否仍正确）；`initial_stones` 的坐标是否为 0-based 且与 `MoveDto.vertex` 同一坐标系。
- **与 plan 008 的交互**：008 的问题手判定依赖 `winrate_black` 的**单位与视角语义**。本计划**没有**修正视角（`winrate_black` 仍直接填 KataGo 原始值）。008 必须处理该问题，否则阈值对齐无意义。这是有意拆分：视角修正需要 `AnalysisFrameDto` 携带行棋方（见 plan 008，字段名同为 `to_play`），属接口变更，单独成计划更可控。
- **有意推迟**：`AE`（删除摆子）在让子谱上的复合语义、以及多摆子节点的 SGF 变体（非前导摆子），本轮不处理。若将来出现相关 bug，参照 `replay_sgf_positions` 的节点级处理而非重写。
- **已知保真度缺口：`initialPlayer` 未发送（2026-09-12 由 T2 执行者实测发现，经复核确认）**。
  本计划让 `GameSummaryDto` 携带 `to_play`，但**只落在 DTO 上，没有写进分析查询**——`crates/katago-protocol` 的 `AnalysisQuery` 结构没有 `initialPlayer` 字段（`grep -n 'initial_player\|initialPlayer' crates/katago-protocol/src/lib.rs` 无匹配）。
  KataGo 在未收到 `initialPlayer` 时会自行推导（`cpp/command/analysis.cpp:1145-1150`）：
  ```cpp
  if(initialPlayer == C_EMPTY) {
    if(moveHistory.size() > 0)
      initialPlayer = moveHistory[0].pla;
    else
      initialPlayer = BoardHistory::numHandicapStonesOnBoard(board) > 0 ? P_WHITE : P_BLACK;
  }
  ```
  后果：(a) 棋谱有走法时，引擎取**首手 color**——与本项目的 handicap 谱（`AB` 三子 + `PL[W]` + 首手 `W`）恰好一致，故 golden 样例不暴露问题；(b) 但**当 SGF 的 `PL` 与首手 color 不一致**，或**moves 为空且摆子中不含黑子**时，引擎自推会与 `PL` 分歧。
  这是**真实的保真度缺口**，不是理论问题。修它属接口变更（`AnalysisQuery` 加字段 + 三个构造点 + 可能的测试），故**有意不在本计划内做**。建议单独立计划（prio P2）。
- **`plans/README.md` 的状态行更新属计划强制要求，不是越界**：本计划的执行指令（文件头第 3 行）与 Done criteria 最后一条都要求执行者更新 `plans/README.md` 的状态行。reviewer 若看到该文件被改，应按"计划强制要求"放行，不要判为范围违规。
