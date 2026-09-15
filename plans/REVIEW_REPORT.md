# plans/001 与 plans/002 审查报告（T6）

> 审查者：reviewer（技术负责人级审查，独立于 T2/T3 实现者与 T5 验证者）
> 审查时间：2026-09-13
> 被测对象：T2 = commit `96132c9`（基于 `b7f33a2`）；T3 = 工作树未提交改动
> 基线对照：`b7f33a2`（`upstream/dev` tip，已核实 `git rev-list --count b7f33a2..upstream/dev` = 0）
> 输入：`plans/VERIFICATION_REPORT.md`（T5）+ 实际 diff + 我自己的复跑
> **本报告未修改任何源码**；唯一写入文件为本报告。

---

## 0. Verdict

| 任务 | Verdict | 理由摘要 |
|---|---|---|
| **T2（plans/001）** | **pass** | 5 个文件全部在 In-scope；`to_play` 命名合规；`player_to_play(node)` 未改名；依赖零新增；视角语义未越界；10/10 Done criteria 独立复跑通过；真实引擎端到端方向性对照由我独立复现 |
| **T3（plans/002）** | **pass** | 仅 2 个文件；回退表达式确已移除且缓存恢复用法保留；`tsc`/`build` 通过；未用非空断言；`!` 计数与基线持平；T5 的浏览器差分结论与我的代码路径核对一致 |

**对 T5 报告的裁定：T5 未过度报告。** 它标记「实现缺陷」的条目为 **0 条**，我逐条复核了它的关键结论（见 §5），全部成立。T5 唯一应受批评的是**漏报**（§6 的 G1/G2），而非误报。

**无 blocker / high 级缺陷。** 以下 findings 均为 low 级、且不属 T2/T3 的实现缺陷（属计划文本或后续计划范围），故不构成 needs_revision。

---

## 1. 范围合规（Acceptance #1）

### 1.1 T2 改动面

```
$ git show --name-only --format='' 96132c9
apps/desktop/src-tauri/src/lib.rs
crates/app-model/src/lib.rs
crates/katago-protocol/src/lib.rs
crates/sgf/src/lib.rs
tests/golden/handicap_9x9.sgf
```

逐条对照 t2 的 In-scope 列表 —— **5/5 完全匹配，零越界**。

`git diff --name-only b7f33a2..HEAD` 亦恰为这 5 个文件（该区间只有 `96132c9` 一个提交）。

### 1.2 T3 改动面

```
$ git status --porcelain -- apps/desktop/src/
 M apps/desktop/src/App.tsx
 M apps/desktop/src/components/AnalysisPanel.tsx
```

对照 t3 的 In-scope（仅这两个文件）—— **完全匹配**。`crates/`、`apps/desktop/src-tauri/`、`tests/`、`scripts/` 均未改动。

### 1.3 关于 `plans/` 下的改动 —— **不判越界（已裁定）**

T2/T3 都改了 `plans/README.md` 的状态行，T3 另追加了 `plans/002-*.md` 的 Step 4 执行记录。这两处**不在**各自 t2/t3 的 inScope 列表内，但：

- `plans/001` 文件头执行指令第 3 行与 Done criteria 最后一条**都强制要求**更新 `plans/README.md` 状态行；
- `plans/README.md:117`「对执行者的通用要求」第 4 条同样强制；
- `plans/002` Step 4 要求「如实记录观察结果」，执行记录写在计划文件内是该要求的自然落点；
- 且 `plans/` **完全未跟踪**（`git ls-files plans/` 为空），不进任何 `git status` 的受控改动列表。

**裁定：计划强制要求，非执行者扩权。不判越界。** 建议后续计划把 `plans/README.md` 明列进 In-scope，消除该定义冲突。

### 1.4 关于 `__pycache__` —— 非任何计划的改动

`tests/__pycache__/`、`scripts/__pycache__/` 是**我本次运行 Python 测试**产生的副产物（未被 `.gitignore` 覆盖，`git check-ignore` 报 NOT ignored）。与 T2/T3 无关，非越界。

---

## 2. 命名一致性（Acceptance #2）

### 2.1 DTO 字段名 `to_play` ✅

```
$ grep -n 'pub to_play' crates/app-model/src/lib.rs
57:    pub to_play: PlayerColor,     ← PositionDto（既有）
79:    pub to_play: PlayerColor,     ← GameSummaryDto（T2 新增）
```

两处同名同义，符合计划要求。反查 `player_to_play` 在 `app-model` 中**无匹配** —— 未误用。

### 2.2 辅助函数 `player_to_play(node)` 未改名 ✅

```
$ grep -n 'fn player_to_play' crates/sgf/src/lib.rs
1450:fn player_to_play(node: &SgfNode) -> Result<Option<PlayerColor>, SgfError>
$ git show b7f33a2:crates/sgf/src/lib.rs | grep -n 'fn player_to_play'
1387:fn player_to_play(node: &SgfNode) -> Result<Option<PlayerColor>, SgfError>
```

函数名与签名**逐字未变**；行号 1387 → 1450 的偏移是 T2 在其上方插入新代码的必然结果，非改名。**判定：合规，严重度无。**

`grep -rn 'player_to_play' crates/ apps/ --include=*.rs` 的其余匹配全部是：新 helper 名 `setup_stones_and_player_to_play`、既有测试名 `replay_applies_setup_stones_and_player_to_play`、以及 `player_to_play(node)` 调用点 —— 均为合法用法，无字段/函数混用。

### 2.3 字段语义复核（超出「只数匹配」）

`GameSummaryDto.to_play` 的**语义**与 `PositionDto.to_play` 一致（该局面轮到谁走）。我用生产函数实测三组对照，`to_game_dto` 与 `replay_sgf_positions` 的初始位置 `to_play` **完全一致**：

| SGF | `to_game_dto` to_play | `replay_sgf_positions[0]` to_play |
|---|---|---|
| `HA[3]AB[cc][gg][cg]`（无 PL） | Black | Black |
| `HA[3]AB[cc][gg][cg]PL[W]` | White | White |
| `;B[cc];B[gg];B[cg]`（连续黑） | Black | Black |

**判定：语义一致，无命名混用缺陷。**

---

## 3. 依赖零新增（Acceptance #3）

```
$ git diff --stat b7f33a2..HEAD -- Cargo.toml Cargo.lock apps/desktop/package.json \
    apps/desktop/package-lock.json 'crates/*/Cargo.toml' 'apps/*/Cargo.toml'
(空)
```

工作树侧 `git status --porcelain -- apps/desktop/package.json Cargo.toml` 亦为空。**判定：零新增，合规。** 与 T2/T3 自报一致。

---

## 4. 视角语义未越界（Acceptance #4）

plans/001 **有意不修** winrate 视角（属 plan 008）。逐项核实无越界：

```
$ git diff --stat b7f33a2..HEAD -- crates/analysis-core/
(空)                                   ← 阈值文件完全未动
$ git diff b7f33a2..HEAD -- crates/katago-protocol/src/lib.rs | grep 'winrate|perspective'
(无匹配)                                ← 未触碰 winrate 归一化
$ grep -n 'winrate_black: root.winrate' crates/katago-protocol/src/lib.rs
```

`normalize_response` 仍为 `winrate_black: root.winrate` 直传，未加任何视角换算。`analysis-core` 阈值仍为 `0.18/0.10/0.05`（0..1 域，正确值），未改。

**判定：未越界。** T2 严格遵守了「视角修正属 plan 008」的边界。

---

## 5. 对 T5 findings 的独立裁定（Acceptance #4）

T5 报告的 §0 结论是「**未发现任何实现缺陷**」，即它**没有**标记任何「实现缺陷」条目。故本节的裁定对象是 T5 的**关键正面结论**——我按「亲自打开被引用的代码确认」的原则逐条复核，而非照单全收。

| # | T5 结论 | 我的独立复核方法 | 裁定 |
|---|---|---|---|
| 5.1 | 让子 JSONL 走生产路径，含 `initialStones` | 自建仓库外 harness（`/tmp/t6_harness`，path 依赖真实 crate）调用 `to_game_dto` + `analysis_query_from_game` + `analysis_batch_query_from_game` | **成立** ✅ |
| 5.2 | 普通棋谱 `initialStones` 为空且键不出现 | 同上，实测 `basic_19x19` 输出无 `initialStones` 键 | **成立** ✅ |
| 5.3 | `RU[Japanese]` → `rules="japanese"` | 生产 harness 实测 + 13 组映射边界用例 | **成立** ✅ |
| 5.4 | 让子方向性反转（带/不带 initialStones） | 用真实 KataGo v1.16.4 独立重跑同一局面 | **成立** ✅ |
| 5.5 | 陈旧帧双树差分（未分析手基线显示最后一帧） | 代码路径核对（`frames.find(...)` + `mergeAnalysisFrame` 升序） | **成立** ✅ |
| 5.6 | 2 个 python 失败为既有环境问题 | 双重归因：基线纯净导出复现 + `TMPDIR` 中和 | **成立** ✅ |
| 5.7 | winrate 无 ×100 缩放 | 全仓 grep + 前端基线对照 | **成立** ✅ |
| 5.8 | `PlayerColor` Default 恰好一份 | 全树 grep `impl Default for PlayerColor` + `pub enum PlayerColor` | **成立** ✅ |
| 5.9 | `handicap_9x9.sgf` 的 AB 坐标落在 9x9 盘内 | 手工坐标换算 + 生产 harness 输出 | **成立** ✅ |

### 5.1 / 5.2 我的独立实测输出

我**没有**采信 T5 引用的文本，而是自建 harness 重跑：

```
[handicap_9x9] board=9 komi=0.5 to_play=White rules_raw=Some("Japanese")
               initial_stones=[StoneDto { x: 2, y: 2, .. }, StoneDto { x: 2, y: 6, .. }, StoneDto { x: 6, y: 6, .. }]
[handicap_9x9] ONCE  {"id":"..","moves":[["W","E5"]],"initialStones":[["B","C7"],["B","C3"],["B","G3"]],
                       "rules":"japanese","komi":0.5,"boardXSize":9,"boardYSize":9,"analyzeTurns":[1],..}
[handicap_9x9] BATCH {.."initialStones":[["B","C7"],["B","C3"],["B","G3"]],"rules":"japanese",..}
[basic_19x19]  board=19 komi=7.5 to_play=Black rules_raw=None initial_stones=[]
[basic_19x19]  ONCE  {"id":"..","moves":[["B","Q16"]],"rules":"chinese",..}     ← 无 initialStones 键
[basic_19x19]  BATCH {.."rules":"chinese",..}                                    ← 无 initialStones 键
```

与 T5 §5 逐字一致。**单点与批量两条生产路径均确已修复。**

### 5.4 真实引擎方向性对照 —— 我独立复现（未采信 T4/T5 数字）

```
### WITH initialStones（T2 修复后的生产查询形状）
  winrate=0.999959594 scoreLead=30.4140443 visits=111 moveInfos=36
### WITHOUT initialStones（修复前行为）
  winrate=0.00383162832 scoreLead=-6.4684749 visits=111 moveInfos=81
```

与 T4 记录（0.999940 / 0.003212）和 T5 记录（0.999943077 / 0.00319984846）**方向完全一致**，数值差异来自 MCTS 随机性。**判定：修复把让子谱分析从方向性错误（黑大胜 ↔ 黑大败）纠正为正确。T5 结论成立。**

### 5.6 既有失败的独立双重归因

```
$ ls -ld /tmp
lrwxr-xr-x@ 1 root wheel 11 Sep 3 18:34 /tmp -> private/tmp

$ python3 -m unittest discover -s tests -p "test_*.py"           # 默认环境
Ran 279 tests in 2.793s
FAILED (failures=2)
   AssertionError: '<repo>/sample.sgf' != '/tmp/tmpjb909_93/repo/sample.sgf'

$ TMPDIR=/Users/ice/t6_tmp_real python3 -m unittest discover -s tests -p "test_*.py"
Ran 279 tests in 2.520s
OK                                                                ← 同一棵树，全绿

$ cd /tmp/t6_baseline && python3 -m unittest tests.test_smoke_tauri_readboard_live \
                                         tests.test_smoke_tauri_runtime_ui
Ran 22 tests in 0.007s
FAILED (failures=2)                                               ← b7f33a2 纯净导出上原样失败
```

根因确认：`scripts/smoke_tauri_readboard_live.py:396-399` 的脱敏只特判 `/private/var/` 与 `/var/`，未特判 `/tmp`。**判定：环境/既有问题，非 T2/T3 引入。T5 归因正确。**

### 5.8 / 5.9 复核

- `grep -rn 'impl Default for PlayerColor' --include=*.rs .` → 0 处手写；`grep -n 'pub enum PlayerColor'` → 全局仅 `crates/app-model/src/lib.rs:11` 一处。T2 用 `#[derive(..., Default)]` + `#[default] Black`（`:12`），**恰好一份，语义 Black** ✅。另核：`app-model` 内其余 `Default` derive 属其他类型，不构成重复。
- `AB[cc][gg][cg]` + `SZ[9]`：`cc→(2,2)`、`gg→(6,6)`、`cg→(2,6)`，合法域 0..8，**三点全部在盘内** ✅。旁证：生产 harness 输出同坐标；单测 `analysis_query_rejects_setup_stone_outside_board` 证明越界摆子确被 `ProtocolError::InvalidVertex` 拒绝（有边界校验，非静默接受）。

### 5.10 我**驳回**的条目

**无。** T5 未标记任何「实现缺陷」，故无条目可驳回。T5 未过度报告。

---

## 6. T5 未覆盖的缺口（Acceptance #5）

以下是我主动核查、T5 报告**未涉及**的关注点。均**不构成** T2/T3 的实现缺陷（不改变 verdict），但应记录在案。

### G1 — `to_play` 落在 DTO 上但未写进查询，存在残余保真度缺口（low）

`GameSummaryDto.to_play` 已正确填充（§2.3 实测），但**没有任何生产消费者**：

```
$ grep -rn 'summary\.to_play' crates/ apps/ --include=*.rs | grep -v '#\[cfg(test)\]'
(无匹配，仅测试断言)
```

`AnalysisQuery` 无 `initialPlayer` 字段，查询里也不发。后果是引擎自行推导走棋方（`cpp/command/analysis.cpp:1145-1150`：有 moves → 取 `moveHistory[0].pla`；无 moves → `numHandicapStonesOnBoard>0 ? White : Black`）。

我用真实引擎实测了分歧确实存在：

| 局面 | DTO `to_play` | 生产查询发出的 | 引擎实际 `currentPlayer` | 是否一致 |
|---|---|---|---|---|
| `AB[cc][gg][cg]PL[W]`（golden 让子谱，首手 W） | White | 无 `initialPlayer` | **W** | ✅ 恰好一致 |
| `AB[cc][gg]AW[ee]PL[W]`（混摆 + PL[W]） | White | 无 `initialPlayer` | **B** | ❌ **分歧** |
| `PL[W]`（无子无着） | White | 无 `initialPlayer` | **B** | ❌ **分歧** |
| 混摆 + 显式 `initialPlayer:"W"` | White | — | **W** | ✅ 证明 `initialPlayer` 能纠正 |

同局面加 `initialPlayer:"W"` 后 winrate 从 0.998（黑视角大胜）变为 0.060（白视角大优）——**分析结论完全反转**，即错位是实质性的。

**裁定：这不是 T2/T3 的缺陷** —— plans/001 的 Maintenance notes（`:312-324`）**已显式记录该缺口**并声明「有意不在本计划内做，建议单独立计划（prio P2）」，T2 也主动上报了。属**已申报的范围外缺口**，不判 needs_revision。

**但 T5 报告完全未提及此项**（`grep -n 'initialPlayer' plans/VERIFICATION_REPORT.md` → 无匹配）。T5 的契约要求「主动指出 T5 未覆盖但应关注的地方」，此项应在列。**建议**：为 `AnalysisQuery` 增加 `initialPlayer` 字段（由 `GameSummaryDto.to_play` 填充）单独立计划。

### G2 — 根节点同时含摆子与首手时，摆子被静默丢弃（low，属计划有意推迟）

`setup_stones_and_player_to_play` 复用 `replay_sgf_positions` 的前导节点遍历：遇到第一个含 `B`/`W` 的节点即 `break`。若 SGF 把摆子与首手写在**同一节点**（紧凑写法），该节点含 move 属性 → 直接 break → **摆子丢失**：

```
$ # (;GM[1]FF[4]SZ[9]AB[cc][gg][cg]PL[W]W[ee];B[gc])
compact: initial_stones=0  to_play=Black
compact: replay position0 stones=0  to_play=Black      ← 回放路径同样为 0（行为一致，非新增回归）
```

**关键点**：`replay_sgf_positions` 在同一输入上**行为完全相同**（也是 0 摆子）。plans/001 明确要求「复用 `replay_sgf_positions` 的模式，不要重写」，且 Maintenance notes 声明「多摆子节点的 SGF 变体（非前导摆子）本轮不处理」。**故这是 by-design 的一致行为，不是 T2 引入的缺陷**，且它让两条路径保持同源——若 T2 自行「修正」反而会破坏计划要求的复用。

**建议**（供后续计划，非本轮修复）：`setup_stones_and_player_to_play` 在遇到含 move 的节点时，可先 `apply_setup_properties` 再 break，使 `AB` 与 `B` 同节点的紧凑谱也正确。需同步评估 `replay_sgf_positions`，避免两路径分叉。

### G3 — 浏览器预览路径的 `GameDto` 不含新字段（low，by-design）

`apps/desktop/src/api/backend.ts:663-671` 的 `parseSgfLocally`（Tauri 不可用时的降级路径）构造的 `summary` 只有旧字段，无 `initial_stones`/`to_play`/`rules`。因 `GameSummaryDto` 的 TS 类型（`domain/types.ts:16`）本就把新字段标为可选/未声明，`tsc` 通过，无运行时错误。该路径不构造分析查询（浏览器预览走假分析），**无实际影响**。

**建议**：plan 008 引入视角归一化时，若前端需要 `to_play`，须同时补 `parseSgfLocally` 与 `domain/types.ts` 的新字段——否则浏览器预览下 `to_play` 恒为 `undefined`。plans/001 Maintenance notes 已提示「将来加必填字段需同步 types.ts」，此项是其具体化。

### G4 — 我在 T5 之外额外验证通过的项（无缺口）

- **`serde(default)` 向后兼容**：旧 `GameSummaryDto` JSON（无三个新字段）反序列化成功，得 `to_play=Black / rules=None / initial_stones=[]` —— 缓存/持久化记录不会因新增字段而读取失败 ✅
- **规则映射边界**（13 组）：`"chinese rules"`→chinese、`"Japanese rules"`→japanese、`"KOREAN"`→korean、`"Tromp Taylor"`→tromp-taylor、`""`/`"   "`/`None`/未知值→chinese ✅（`trim_end_matches(" rules")` 的归一化按设计工作）
- **T3 无新增类型逃逸**：`git diff` 的 T3 新增行中无 `as` 强转、无非空断言 `!` ✅

---

## 7. `plans/README.md` 状态行（Acceptance #5）

```
$ grep -n '^| 001\|^| 002' plans/README.md
28:| 001 | 修正分析查询保真度：视角、让子、规则 | P0 | M | — | DONE |
29:| 002 | 移除陈旧帧回退，避免错位叠加 | P0 | S | — | DONE |
```

**两条状态行均已更新为 `DONE`** ✅。plan 001 文件内 10 条 Done criteria 亦已勾选（`[x]`）。

---

## 8. 门禁独立复跑（我自己跑的，未引用他人输出）

```
$ export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
$ cargo fmt --all --check                                    → exit 0 ✅
$ cargo clippy --workspace --all-targets -- -D warnings       → exit 0 ✅
$ cargo test --workspace                                      → exit 0，269 passed / 0 failed ✅
$ cd apps/desktop && npx tsc --noEmit                         → exit 0 ✅
$ cd apps/desktop && npm run build                            → exit 0，✓ built in 66ms ✅
$ python3 scripts/validate_scaffold.py --verbose              → 10 passed, 0 failed ✅
```

新增测试（7 个，为计划要求 5 个的超集）全部存在且通过：

```
test tests::to_game_dto_carries_setup_stones_and_player_to_play ... ok
test tests::to_game_dto_defaults_to_empty_board_for_normal_game ... ok
test tests::katago_rules_for_sgf_ru_maps_known_aliases ... ok
test tests::katago_rules_for_sgf_ru_falls_back_to_chinese_for_missing_or_blank_text ... ok
test tests::analysis_query_includes_setup_stones ... ok
test tests::analysis_query_omits_setup_stones_for_empty_board ... ok
test tests::analysis_query_rejects_setup_stone_outside_board ... ok
```

T3 关键断言（工作树，非基线）：

```
$ grep -nF '?? frames.at(-1)' apps/desktop/src/App.tsx        → 无匹配（exit 1）✅ 回退已移除
$ grep -nF 'payload.frames.at(-1)' apps/desktop/src/App.tsx   → 1593:...（1 处）✅ 缓存恢复保留
$ grep -c 'data-analysis-frame-source' .../AnalysisPanel.tsx  → 1 ✅
$ grep -c '!' apps/desktop/src/App.tsx                        → 82（基线 82）✅ 无非空断言
$ grep -c '!' .../AnalysisPanel.tsx                           → 2（基线 2）✅
```

T3 的 `data-analysis-frame-source` **语义**（非只数匹配）：`frame ? \`frame:${frame.turn}\` : "none"`。`frame` 为 `visibleCurrentFrame = applyPreferencesToFrame(currentFrame, ...)`，而 `applyPreferencesToFrame` 在 `!frame` 时返回 `undefined`（`App.tsx:1971-1974`），故两支均可达；无帧时 `AnalysisPanel` 渲染 `"Run review to show candidate moves and winrate data."` 占位（`AnalysisPanel.tsx:62`），`BoardCanvas` 因 `analysis?.` 可选链与 `analysis?.candidates.slice(0,8) ?? []`（`:94`）不再绘制叠加层。**语义正确。**

---

## 9. 我对「计划文本缺陷」的裁定（与 T5 §11 呼应）

T5 §11 列出的计划文本缺陷我复核后**全部成立**，且均**非**实现缺陷：

1. **plan 002 原 Done criteria 与 Scope 互斥** —— 我独立复核：基线 `App.tsx` 确有两处 `at(-1)`（`:204` 待移除、`:1593` 合法缓存恢复），原「文件内零匹配」gate 与 Scope「不要改缓存逻辑」不可兼得。**该缺陷已由 captain 修订计划解决**（我在团队邮箱中核实了修订授权与内容），T3 按修订后口径通过。**此条不再构成 T3 的验收障碍。**
2. **plan 002 Step 4 原场景不可复现** —— 我复核 `apps/desktop/src/api/backend.ts:851`（`for turn in 0..=game.moves.length`）与 `apps/desktop/src-tauri/src/lib.rs:1906`（`for turn in 0..=document.moves.len()`）：假分析**对每一手都生成帧**，不存在「未被分析覆盖的手数」。T3 改用稀疏缓存差分是合理且更强的替代。**成立。**
3. **plan 006/007 的同类 gate 缺陷** —— 属后续计划范围，本轮未执行，不影响本次 verdict。建议其开工前按 captain 的修订执行。

---

## 10. 结论

- **T2（plans/001）：pass。** 5 个 In-scope 文件，零越界；`to_play` 命名与 `player_to_play` 辅助函数均合规；依赖零新增；视角语义未越界；10/10 Done criteria 独立复跑通过；真实引擎方向性对照由我独立复现成立。
- **T3（plans/002）：pass。** 2 个 In-scope 文件；回退表达式确已移除、缓存恢复用法确已保留；`tsc`/`build`/Rust 回归全绿；未用非空断言；`data-analysis-frame-source` 两支语义正确。
- **T5：未过度报告。** 其「无实现缺陷」的结论我逐条复核成立；无被驳回条目。唯一不足是**漏报**了 G1（`initialPlayer` 未发送，T5 报告完全未提及）——该缺口 plans/001 已申报为有意推迟，不改变 verdict。
- **无 blocker / high 级 finding。** G1–G3 均为 low 级、非本轮实现缺陷，供后续计划（尤其 plan 008 与 `initialPlayer` 独立计划）参考。
- **未修改任何源码**；未 push、未开 PR。

### Findings 汇总（均不影响 verdict，故不触发 needs_revision）

| id | severity | problem | requiredFix | file:line |
|---|---|---|---|---|
| G1 | low | `GameSummaryDto.to_play` 无生产消费者；查询不发 `initialPlayer`，混摆/空盘 + `PL` 时引擎自推与 SGF 分歧（实测 `currentPlayer` B↔W 反转，winrate 0.998↔0.060） | 单独立计划：`AnalysisQuery` 加 `initialPlayer`，由 `summary.to_play` 填充；补混摆/空盘回归测试 | `crates/katago-protocol/src/lib.rs`（`AnalysisQuery` 定义处）、`crates/app-model/src/lib.rs:79` |
| G2 | low | 根节点同时含摆子与首手时摆子被静默丢弃（`break` 早于 `apply_setup_properties`）；`replay_sgf_positions` 行为相同，属 by-design | 后续计划：遇含 move 的节点先 `apply_setup_properties` 再 break；须同步评估 `replay_sgf_positions` 避免两路径分叉 | `crates/sgf/src/lib.rs:610-633` |
| G3 | low | 浏览器降级路径 `parseSgfLocally` 不产出新字段；若 plan 008 前端需要 `to_play` 将恒为 `undefined` | plan 008 落地时同步补 `parseSgfLocally` 与 `domain/types.ts` | `apps/desktop/src/api/backend.ts:663-671`、`apps/desktop/src/domain/types.ts:16` |

---

## 11. 审查者声明

- 本审查**未修改任何源码**；`plans/REVIEW_REPORT.md` 为唯一写入文件。
- 所有结论附命令与原始输出；T5 的关键数字我均以自建仓库外 harness 或真实引擎独立重跑，未直接引用其文本。
- 明确区分了「T2/T3 实现缺陷」（**无**）、「计划文本缺陷」（§9，已由 captain 修订）、「范围外/后续计划缺口」（§6 G1–G3）。
- 未 push、未开 PR。
- 视角相关结论基于本机 `analysis.cfg:30 reportAnalysisWinratesAs = BLACK`；未声称当前生产路径视角已错。

---

## 12. 审查后复核（交付后 T5 报告扩写至 765 行）

本报告定稿后，T5 的 `plans/VERIFICATION_REPORT.md` 由 625 行扩写至 **765 行**（新增 §10.3–§10.5 与 §13）。我据此重新逐条复核本报告的引用与结论，结果如下：

**结论不变：T2 pass、T3 pass。**

| 复核项 | 结果 |
|---|---|
| T5 是否新增标记「实现缺陷」 | **否**。`grep -n '实现缺陷'` 全部为「无」或「非实现缺陷」的否定式表述；§0 与 §14 总判定仍为「未发现任何实现缺陷」 |
| 我引用的 T5 §5 让子 JSONL | 仍逐字一致（`initialStones":[["B","C7"],["B","C3"],["B","G3"]],"rules":"japanese"`）✅ |
| 我引用的 T5 §11 计划文本缺陷节 | 仍存在且内容一致 ✅ |
| **G1（`initialPlayer`）** | `grep -c 'initialPlayer' plans/VERIFICATION_REPORT.md` → **0**，T5 扩写后**仍未提及**，G1 的漏报判定成立 ✅ |
| **G2（同节点摆子+首手）** | T5 扩写后仍无相关讨论 ✅ |
| **G3（`parseSgfLocally`）** | T5 扩写后仍无相关讨论 ✅ |
| 一处引用修正 | 原引用 `plans/README.md:92` 为「通用要求第 4 条」，因 README 后续编辑该行已变为发布预检表格行；**已更正为 `:117`**（实测该行为「每个计划完成前，逐条核对 "Done criteria"，并把本索引中自己的状态行改为 `DONE`。」） |
| 其余行号引用 | `crates/sgf/src/lib.rs:610`、`crates/app-model/src/lib.rs:79`、`crates/katago-protocol/src/lib.rs:184`、`AnalysisPanel.tsx:42`、`App.tsx:204`、`backend.ts:663`、`backend.ts:851`、`src-tauri/src/lib.rs:1906` 全部实测仍指向所述代码 ✅ |
| T5 新增 §10.3（轻量权重勘误）/§10.4（`--help` 退出码）/§10.5（`logDir` 污染） | 均为**环境/文档**类，与我 §9 的裁定一致；§10.5 的仓库污染已被清理，我复核 `ls -d analysis_logs` → 仓库根无该目录，`git status` 无引擎残留 ✅ |

**本次复核未修改任何源码**，仅修正本报告内一处失效行号引用。

---

## 13. 对 env-engineer 提醒的裁定（T4 文档改动 + 行号失效）

env-engineer 来信提出两点，我逐项独立复核如下。

### 13.1 本报告**不**受行号失效影响

`plans/VERIFICATION_REPORT.md` 对 `KATAGO_LOCAL_ENV.md` 的行号引用曾因插入勘误块而失效（env-engineer 报告 4 处、偏移量不一致）。**本报告全程按「节」而非行号引用 T5**：

```
$ grep -n 'KATAGO_LOCAL_ENV' plans/REVIEW_REPORT.md          → 无匹配
$ grep -nE 'VERIFICATION_REPORT\.md:[0-9]' plans/REVIEW_REPORT.md → 无匹配
```

**结论：env-engineer 提示的误判风险在本报告中不存在。** 且 T5 已自行改用锚点式引用（`grep -nE 'KATAGO_LOCAL_ENV\.md:[0-9]' plans/VERIFICATION_REPORT.md` → 无匹配；文档头部已声明锚点策略），该问题**已解决**，无需我按旧表逐项换算。我不据此判 verifier 报告不可靠。

### 13.2 T4 对 `plans/KATAGO_LOCAL_ENV.md` 的改动 —— **在 T4 In-scope 内，合规**

```
$ # t4 契约（team.json）
inScope: ['plans/KATAGO_LOCAL_ENV.md', 'apps/desktop/src-tauri/engines/', '.gitignore']
```

`plans/KATAGO_LOCAL_ENV.md` 是 **t4 交付物本身**，且被 t4 的 inScope **明列**。勘误属修正交付物错误，**不判越界**。补充事实：

- 该文件完全**未跟踪**（`git ls-files plans/KATAGO_LOCAL_ENV.md` 无输出），位于 `?? plans/` 下，故不进 T2「改动文件全在 In-scope」与 T3「改动仅 2 个文件」两条验收断言的判定范围；
- `.gitignore` **未被改动**（`git diff --stat b7f33a2..HEAD -- .gitignore` 与 `git status --porcelain -- .gitignore` 均为空）——即 env-engineer 遵守了 captain 后来收窄的「绝对不要修改 `.gitignore`」要求。

### 13.3 「轻量权重本机不可用」—— 我独立复现，env-engineer 结论成立

```
$ LW="$HOME/.lizzieyzy-dev/models/kata1-tf2-b10c384-s2941M-d5872M.bin.gz"
$ ls -l "$LW"  →  38,245,507 字节（存在、大小正确）
$ echo '{"id":"w2",...}' | "$K" analysis -config "$C" -model "$LW"
exit=134
stdout bytes: 0
stderr: ... This neural net requires a newer KataGo version. ...
        Model version: 17
        Abort trap: 6
```

**与我用 bundle 主权重跑通的分析（exit 0、含 `rootInfo`）形成对照。** 即 env-engineer 的勘误（及 T5 §10.3）**成立**，captain 交付版本中「加载快、适合多轮回归」的说法**确为错误**。

**对 T2/T3 结论无影响**：T5 自始只用 bundle 主权重，我本次审查的所有引擎实验（让子方向性对照、`initialPlayer` 分歧探针）同样只用 bundle 主权重。

### 13.4 「`analysis_logs/` 不威胁 In-scope 断言」—— 我独立复现，成立

```
$ grep -n 'log' .gitignore
9:*.log
$ mkdir -p analysis_logs && touch analysis_logs/analysis.log
$ git status --porcelain | grep analysis_logs          → 无输出（不可见）
$ git check-ignore -v analysis_logs/analysis.log
.gitignore:9:*.log	analysis_logs/analysis.log
$ git status --porcelain --untracked-files=all | grep analysis_logs → 无输出（-uall 下仍隐藏）
```

因 `*.log` 覆盖其全部内容，该目录即便存在也不会出现在 `git status` 中，**确不威胁** T2/T3 的两条 In-scope 断言。且我复核当前 `ls -d analysis_logs` → 仓库根无该目录，残留已清理。

**本节复核未修改任何源码。**
