# Plan 009: 向 KataGo 分析查询发送 `initialPlayer`（修复摆子谱走棋方分歧）

> **Executor instructions**: 按步骤执行，每步先跑验证命令、确认预期结果再进入下一步。若出现 "STOP conditions" 中的任一情况，停止并报告，不要即兴发挥。完成后更新 `plans/README.md` 中本计划的状态行。
>
> **Drift check（先跑）**: `git diff --stat b7f33a2..HEAD -- crates/katago-protocol/src/lib.rs crates/app-model/src/lib.rs apps/desktop/src-tauri/src/lib.rs`
> 预期看到 plan 001 的提交 `96132c9` 已改这三个文件。若 `AnalysisQuery` 已含 `initial_player` 字段，说明本计划已被他人实现——**停止并报告**，不要重复实现。

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-analysis-query-fidelity.md（已完成，commit `96132c9`）
- **Category**: bug（残余保真度缺口）
- **Planned at**: commit `96132c9`, 2026-09-12

## Why this matters

plan 001 让 `GameSummaryDto` 携带了正确的初始行棋方（`to_play`），但**这个值没有任何生产消费者**——它只落在 DTO 上，从未写进发给 KataGo 的分析查询。实测确认：

```
$ grep -rn 'summary\.to_play' crates/ apps/ --include=*.rs | grep -v 'cfg(test)'
(无匹配；仅 crates/sgf/src/lib.rs:3792、:3805 的测试断言)
```

`AnalysisQuery` 结构（`crates/katago-protocol/src/lib.rs:11-27`）**没有** `initialPlayer` 字段。因此 KataGo 只能自行推导走棋方（`cpp/command/analysis.cpp:1145-1150`）：

```cpp
if(initialPlayer == C_EMPTY) {
  if(moveHistory.size() > 0)
    initialPlayer = moveHistory[0].pla;                    // 有走法 → 取首手方
  else
    initialPlayer = BoardHistory::numHandicapStonesOnBoard(board) > 0 ? P_WHITE : P_BLACK;
}
```

**后果：摆子谱（死活题、布局图）的走棋方会被推错，分析结论可能反转。**

| 局面 | SGF 的 `PL` | 引擎实际推出 | 是否一致 |
|---|---|---|---|
| `AB[cc][gg][cg]PL[W]`（golden 让子谱，首手 W） | White | **W** | ✅ 恰好一致 |
| `AB[cc][gg]AW[ee]PL[W]`（**混摆** + `PL[W]`） | White | **B** | ❌ **分歧** |
| `PL[W]`（**无子无着**，空盘） | White | **B** | ❌ **分歧** |

> **为什么现有测试没暴露它**：`tests/golden/handicap_9x9.sgf` 恰好是"`AB` 三子 + 首手 W"的形态，引擎的"取首手方"规则**碰巧**给出正确的 W。只有**混摆**（`AB`+`AW` 同时存在）或**空盘带 `PL`** 的谱才会分歧——而这两类正是死活题与摆子研究谱的常见形态。

**分歧的实质影响（真实引擎实测，KataGo v1.16.4，见 `plans/KATAGO_LOCAL_ENV.md`）**：

- 混摆 `AB[cc][gg]AW[ee]PL[W]`（无 `initialPlayer`）→ 引擎 `currentPlayer = B`，与 SGF 的 `W` **相反**
- 同一局面加 `initialPlayer: "W"` → `currentPlayer = W`
- **结论会反转**：reviewer 在 `plans/REVIEW_REPORT.md` 的 G1 记录该局面 winrate 从 0.998 变 0.060；captain 独立复现确认方向性风险真实存在（平衡局面 `scoreLead` 从 −0.649 变为 −12.434，约 12 目摆幅）。**具体数值依赖局面构造，不要引用任一方的数字作为断言基准**——本计划的测试应断言 `currentPlayer` 字段，而非 winrate 数值。

**这是 plan 001 有意推迟的缺口**（其 Maintenance notes 已申报），本计划补齐。

## Current state

**关键文件**

- `crates/katago-protocol/src/lib.rs` — `AnalysisQuery`（`:11`）、`AnalysisQueryOptions`（`:31`）、`AnalysisBatchQueryOptions`（`:41`）、`analysis_query_from_game`（`:124`）、`analysis_batch_query_from_game`（`:152`）。单文件 crate，依赖仅 `app-model`/`serde`/`serde_json`/`thiserror`/`uuid`。
- `crates/app-model/src/lib.rs` — `GameSummaryDto`（`:65`，含 plan 001 新增的 `to_play`、`initial_stones`、`rules`）。
- `apps/desktop/src-tauri/src/lib.rs` — 两处构造查询的调用点（`katago_analyze_once` 与 `prepare_katago_batch_analysis`）。

**摘录 1：`AnalysisQuery` 当前字段**（`crates/katago-protocol/src/lib.rs:11-27`）

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisQuery {
    pub id: String,
    pub moves: Vec<KataMove>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub initial_stones: Vec<KataMove>,
    pub rules: String,
    pub komi: f32,
    pub board_x_size: u8,
    pub board_y_size: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analyze_turns: Option<Vec<u32>>,
    pub max_visits: Option<u32>,
    ...
```

**注意**：`initial_stones` 用了 `skip_serializing_if = "Vec::is_empty"`（空盘时不发该键）。**新字段 `initial_player` 应采用同样的可选语义**（见 Step 1 的设计决定）。

**摘录 2：查询构造（两个 builder 都要改）**（`crates/katago-protocol/src/lib.rs:124` 与 `:152`，节选）

```rust
pub fn analysis_query_from_game(game: &GameDto, options: AnalysisQueryOptions) -> Result<AnalysisQuery, ProtocolError> {
    ...
    Ok(AnalysisQuery {
        id: options.id,
        moves,
        initial_stones: setup_stones_to_kata_moves(&game.summary.initial_stones, board_size)?,
        rules: options.rules,
        komi: game.summary.komi,
        ...
```

**摘录 3：`GameSummaryDto` 已有 `to_play`**（plan 001 引入）

```rust
    /// 初始行棋方（SGF 的 `PL`）。缺省为黑。
    #[serde(default)]
    pub to_play: PlayerColor,
```

**仓库约定**

- 单文件 `lib.rs`；**不新增依赖**（`regex` 不在 `katago-protocol` 的依赖里）。
- 错误用 `thiserror` 的 `ProtocolError`（`crates/katago-protocol/src/lib.rs:101`）。
- 测试内联 `#[cfg(test)] mod tests`，浮点用容差比较。
- 本仓库内部**所有**分析值用 **0..1 小数**（Java 用 0..100）。**不要引入 `×100`**。
- 现有测试范例：`analysis_query_includes_setup_stones`、`analysis_query_omits_setup_stones_for_empty_board`（plan 001 新增）、`analysis_query_rejects_setup_stone_outside_board`。

## Commands you will need

前置：`export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`

| Purpose | Command | Expected on success |
|---|---|---|
| 编译 | `cargo check --workspace --all-targets` | exit 0 |
| 定向测试 | `cargo test -p katago-protocol -p sgf` | all pass |
| 全量测试 | `cargo test --workspace` | all pass |
| 格式 | `cargo fmt --all --check` | exit 0 |
| 静态检查 | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| 前端构建 | `cd apps/desktop && npm run build` | exit 0 |
| 脚手架校验 | `python3 scripts/validate_scaffold.py --verbose` | 10 passed, 0 failed |

**真实引擎可选验证**：本机已有可用 KataGo，见 `plans/KATAGO_LOCAL_ENV.md`。若做真实引擎验证，**先 `cd /tmp`**（bundle 配置的 `logDir` 是相对路径，否则会在仓库内创建 `./analysis_logs/`），且**只用 bundle 主权重**（38 MB 轻量权重本机不可用）。

## Scope

**In scope**

- `crates/katago-protocol/src/lib.rs` — `AnalysisQuery` 加字段、两个 builder 填充、新增测试
- `apps/desktop/src-tauri/src/lib.rs` — 若 builder 签名变化则同步调用点
- `plans/README.md` — 状态行

**Out of scope**

- **不要**改 `crates/sgf/`（`to_game_dto` 已正确填充 `to_play`，plan 001 已验）。
- **不要**改 `crates/analysis-core/`（属 plan 008）。
- **不要**改任何前端文件（`apps/desktop/src/**`）。
- **不要**改 `AnalysisFrameDto`（属 plan 008 的接口变更）。
- **不要**新增依赖。
- **不要**顺手修 G2（根节点同时含摆子与首手时摆子被丢弃）——那是另一件事，见 Maintenance notes。

## Git workflow

- 分支：`advisor/009-initial-player`（基于 `advisor/analysis-baseline`）
- 提交示例：`fix(protocol): send initialPlayer so setup diagrams analyze from the right side`
- **不要推送、不要开 PR**，除非操作者指示。

## Steps

### Step 1: 给 `AnalysisQuery` 增加 `initial_player` 字段

在 `crates/katago-protocol/src/lib.rs:11` 的 `AnalysisQuery` 中，紧跟 `initial_stones` 之后新增：

```rust
    /// 初始行棋方。KataGo 在缺省时会自行推导（有走法则取首手方，
    /// 否则按摆子数猜白/黑），但推导在「混摆 AB+AW 且 PL[W]」或「空盘带 PL」
    /// 的局面下会与 SGF 分歧，故显式下发。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_player: Option<String>,
```

**设计决定（务必照做）**：

- 用 `Option<String>` 且 `skip_serializing_if = "Option::is_none"`，**与 `analyze_turns` 等既有可选字段一致**。理由：让"不指定"成为合法状态，避免在无 `PL` 的普通棋谱上**改变**现有行为（KataGo 的推导对普通棋谱是正确的，不该被覆盖）。
- 值为 `"B"` 或 `"W"`（KataGo 的 `initialPlayer` 接受 `B`/`W`/`BLACK`/`WHITE`，用单字母与 Java 版一致）。
- `serde(rename_all = "camelCase")` 会把 `initial_player` 序列化为 **`initialPlayer`**——这正是 KataGo 期望的键名，无需额外 rename。

**Verify**: `cargo check -p katago-protocol` → exit 0。

### Step 2: 定义 `PlayerColor` → `"B"/"W"` 的转换

`PlayerColor` 已实现 `Serialize`（`#[serde(rename_all = "snake_case")]` → `"black"`/`"white"`），但 KataGo 要 `"B"`/`"W"`。新增一个纯函数（放 `crates/katago-protocol/src/lib.rs`，与 `move_vertex_to_kata_coordinate` 等同类转换函数并列）：

```rust
/// KataGo 的 `initialPlayer` 用单字母 B/W。
fn player_color_to_kata_initial(color: PlayerColor) -> &'static str {
    match color {
        PlayerColor::Black => "B",
        PlayerColor::White => "W",
    }
}
```

**Verify**: `cargo check -p katago-protocol` → exit 0。

### Step 3: 两个 builder 都填充该字段

**关键设计决定：只在"摆子谱/无走法"这类会分歧的局面下发 `initialPlayer`，普通棋谱保持不发。**

理由：KataGo 的推导对普通棋谱（有走法且首手方即当前方）是正确的，且它是**久经验证的默认行为**。若对每个查询都强制下发，等于用我们的推导替换引擎的推导——在罕见边缘情形（如引擎对让子奖励的处理）反而可能引入新差异。**最小侵入**是只在引擎会推错的局面下发。

判定条件（写成纯函数便于单测）：

```rust
/// 是否需要在查询里显式指定 initialPlayer。
/// 仅当「没有走法」时才需要：此时 KataGo 只能靠摆子数猜（有摆子→白，无摆子→黑），
/// 与 SGF 的 PL 可能不符。有走法时引擎取首手方，与 SGF 语义一致。
fn should_send_initial_player(moves_is_empty: bool) -> bool {
    moves_is_empty
}
```

**注意**：混摆 `AB+AW` + `PL[W]` 的局面，若**同时有走法**（如死活题的解答手顺），引擎取首手方——而首手方由 `PL` 决定，故也一致。因此**"无走法"是唯一需要显式指定的情形**。

在 `analysis_query_from_game`（`:124`）与 `analysis_batch_query_from_game`（`:152`）中：

```rust
        initial_player: if should_send_initial_player(moves.is_empty()) {
            Some(player_color_to_kata_initial(game.summary.to_play).to_string())
        } else {
            None
        },
```

注意 `moves` 在 `analysis_query_from_game` 里是 `.take(turn)` 后的结果——**判断应基于原始棋谱是否有走法**（`game.moves.is_empty()`），而非截断后的 `moves`。请用 `game.moves.is_empty()`，避免 `turn = 0` 时误判。

**Verify**: `cargo check -p katago-protocol` → exit 0；`cargo test -p katago-protocol` → all pass。

### Step 4: 补单元测试

新增至少以下测试：

1. `analysis_query_sends_initial_player_for_setup_only_position`
   - 构造 `GameDto`：`moves` 为空、`initial_stones` 非空（混摆）、`to_play = White`。
   - 断言产出的 `AnalysisQuery.initial_player == Some("W".to_string())`。
   - 并断言序列化后的 JSON **含** `"initialPlayer":"W"`（验证 camelCase 生效）。

2. `analysis_query_omits_initial_player_when_there_are_moves`
   - 构造 `moves` 非空的普通棋谱，`to_play = Black`。
   - 断言 `initial_player == None`，且序列化 JSON **不含** `initialPlayer` 键（验证 `skip_serializing_if` 生效）。

3. `analysis_batch_query_sends_initial_player_for_setup_only_position`
   - 同测试 1，但走 `analysis_batch_query_from_game` 路径。**两个 builder 都必须覆盖**。

4. `player_color_to_kata_initial_maps_both_colors`
   - `Black → "B"`、`White → "W"`。

5. `should_send_initial_player_only_for_empty_move_list`
   - `true` 当且仅当 `moves_is_empty`。

**Verify**: `cargo test -p katago-protocol` → all pass，且 5 个新测试出现在输出中。

### Step 5: 真实引擎端到端验证（推荐，非强制）

若本机引擎可用（见 `plans/KATAGO_LOCAL_ENV.md`），验证分歧确已消除：

```bash
cd /tmp   # 必须：bundle 配置的 logDir 是相对路径
K="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/macos-arm64/katago"
W="/Applications/LizzieYzy Next.app/Contents/app/weights/default.bin.gz"
C="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/configs/analysis.cfg"

# 混摆 + PL[W] + 无走法，带上 initialPlayer
echo '{"id":"p","initialStones":[["B","C3"],["B","G7"],["W","E5"]],"moves":[],"initialPlayer":"W","rules":"japanese","komi":6.5,"boardXSize":9,"boardYSize":9,"analyzeTurns":[0],"maxVisits":50}' \
  | "$K" analysis -config "$C" -model "$W" 2>/dev/null \
  | python3 -c "import json,sys; d=json.loads(sys.stdin.readline()); print('currentPlayer =', d['rootInfo']['currentPlayer'])"
```

**期望**：输出 `currentPlayer = W`（而非 `B`）。

**不要**把 winrate 数值写进报告作为断言——它依赖局面与 MCTS 随机性，不是稳定的判据。**判据是 `rootInfo.currentPlayer`**。

**Verify**: 上面命令输出 `currentPlayer = W`。若无法运行引擎，**如实报告"未执行真实引擎验证"**，不要跳过或编造。

### Step 6: 门禁

**Verify**（逐条）:

1. `cargo fmt --all --check` → exit 0
2. `cargo clippy --workspace --all-targets -- -D warnings` → exit 0
3. `cargo test --workspace` → all pass
4. `cd apps/desktop && npm run build` → exit 0
5. `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed

## Test plan

- 新增 5 个测试（Step 4），全部纯数据构造，**不需要真实引擎**。
- 结构参照：`crates/katago-protocol/src/lib.rs` 中 plan 001 新增的 `analysis_query_includes_setup_stones` 与 `analysis_query_omits_setup_stones_for_empty_board`（同类的"有/无"对照范式）。
- 验证：`cargo test -p katago-protocol` → all pass，含 5 个新测试。

## Done criteria

全部成立才算完成：

- [ ] `cargo fmt --all --check` exit 0
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` exit 0
- [ ] `cargo test --workspace` exit 0；Step 4 的 5 个新测试通过
- [ ] `grep -n 'initial_player' crates/katago-protocol/src/lib.rs` 有匹配（字段已加）
- [ ] `grep -n 'should_send_initial_player' crates/katago-protocol/src/lib.rs` 有匹配
- [ ] `grep -c 'initial_player:' crates/katago-protocol/src/lib.rs` ≥ 2（**两个 builder 都填充**）
- [ ] `cd apps/desktop && npm run build` exit 0
- [ ] `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed
- [ ] `grep -rn '×100\|\* 100' crates/katago-protocol/src/lib.rs` 无与 winrate 相关的匹配（未引入缩放）
- [ ] Step 5 的真实引擎结果已如实记录（或明确标注未执行）
- [ ] `git status` 的改动文件全部落在 In-scope 列表内（`plans/` 未跟踪，不算）
- [ ] `plans/README.md` 中本计划状态行已改为 `DONE`

## STOP conditions

出现以下任一情况，停止并报告，不要即兴发挥：

- `AnalysisQuery` 已含 `initial_player` 字段（本计划已被实现）。
- `GameSummaryDto` 没有 `to_play` 字段（plan 001 未合入）——先确认 `git log --oneline b7f33a2..HEAD` 含 `96132c9`。
- KataGo 的 `initialPlayer` 字段名或取值格式与假设不符（去 `docs/Analysis_Engine.md` 核对 `initialPlayer`；若无法联网，报告并停下）。
- 你发现"只在无走法时下发"的判断会让某个既有测试失败——**报告具体测试**，不要为了让测试过而改成"总是下发"（那是行为变更，需重新评估）。
- 真实引擎验证输出 `currentPlayer` 仍与 `PL` 不符——报告完整命令与输出，这可能是 KataGo 版本行为差异。
- 需要改动 Scope 之外的任何文件，或需要新增依赖。
- `cargo test --workspace` 出现除 `plans/README.md` 所述 2 个既有 macOS `/tmp` 失败之外的新失败。

## Maintenance notes

- **为什么用 `Option` + `skip_serializing_if`**：让"不指定"保持为合法且**默认**的状态。普通棋谱（有走法）的行为**完全不变**——这一点是审阅重点，若有 diff 显示普通棋谱的查询 JSON 变了，说明实现偏离了设计。
- **与 plan 008 的交互**：plan 008 会给 `AnalysisFrameDto` 加 `to_play` 并在**消费侧**归一化视角。本计划改的是**发送侧**（查询）。两者独立且互补：008 保证"收到的值被正确解释"，009 保证"引擎在正确的走棋方视角下搜索"。**不要**在本计划里改 `AnalysisFrameDto`。
- **G2 仍未修（有意）**：根节点**同时**含摆子与首手时，摆子会被丢弃——`setup_stones_and_player_to_play` 遇到含 move 的节点即 break（实测 `(;...AB[cc][gg][cg]PL[W]W[ee];B[gc])` → `initial_stones=0`）。但 `replay_sgf_positions` 对同输入行为**相同**（也是 0），属 plan 001 刻意复用既有遍历逻辑带来的一致行为，**非回归**。修它需同时改两条路径的语义，属独立工作项。
- **未实现的相邻能力**：`AnalysisQuery` 也不支持 `overrideSettings`（KataGo 允许按查询覆盖 `reportAnalysisWinratesAs` 等参数）。若将来要让"视角"完全由本项目控制而不依赖配置文件，这是路径——但那与 plan 008 的消费侧归一化重复，**优先级低**。
- **审阅者重点看**：(a) 普通棋谱的查询 JSON **未被改动**（只有无走法局面新增 `initialPlayer`）；(b) 两个 builder 都改了（`grep -c 'initial_player:'` ≥ 2）；(c) 没有引入 `×100` 缩放。
