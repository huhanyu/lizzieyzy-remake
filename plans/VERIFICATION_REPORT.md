# plans/001 与 plans/002 独立验证报告（T5）

> 验证者：verifier（独立于 T2/T3 实现者）
> 验证时间：2026-09-13
> 被测对象：**工作树当前内容**（T2 = commit `96132c9`；T3 = 未提交的工作树改动）
> 基线对照：`b7f33a2`（经 `git archive` 导出到 `/tmp/t5_baseline`，非 `git show` 只读视图）
> 引擎环境：见 `plans/KATAGO_LOCAL_ENV.md`（本报告复核了其路径与配置）
> 本报告**未修改任何源码**；所有命令均为只读或外部 harness。

## 0. 结论摘要

| # | 验收项 | 结论 |
|---|---|---|
| 1 | T2 的 10 条 Done criteria 逐条重放 | **已验证通过**（10/10） |
| 2 | T3 的 10 条 Done criteria 逐条重放 | **已验证通过**（10/10） |
| 3 | 真实引擎端到端（rootInfo/moveInfos + 有效 winrate） | **已验证通过** |
| 4 | 让子局 vs 普通棋谱 `initialStones` 非空/空（含 JSONL） | **已验证通过** |
| 5 | `RU[Japanese]` → `rules` 不再为 `chinese` | **已验证通过** |
| 6 | winrate 未被误乘 100 | **已验证通过** |
| 7 | `frames.at(-1)` 回退已移除且无非空断言 | **已验证通过**（含独立浏览器差分复现） |
| 8 | 2 个 python 失败归因 | **环境/既有问题**（`b7f33a2` 纯净导出 + `TMPDIR` 中和双重实证） |
| 9 | `KATAGO_LOCAL_ENV.md` 的「勘误」块（搜 `勘误（env-engineer`）轻量权重说法 | **环境/文档问题**（独立复现 exit 134；不影响本报告结论，见 §10.3） |

**未发现任何实现缺陷。** 未验证项见 §9。环境/文档问题见 §10（含 §10.3 轻量权重勘误）。

---

## 1. 环境与基线复核

### 1.1 分支与提交

```
$ git branch --show-current
advisor/analysis-baseline

$ git log --oneline b7f33a2..HEAD
96132c9 fix(analysis): carry setup stones, player to play and SGF rules into KataGo queries
```

T2 已提交（`96132c9`）；T3 为工作树未提交改动：

```
$ git status --porcelain
 M apps/desktop/src/App.tsx
 M apps/desktop/src/components/AnalysisPanel.tsx
?? .agent-teams/
?? plans/
```

`?? .agent-teams/`、`?? plans/` 为团队运行时与计划目录（未跟踪、非源码），与 T2/T3 改动面无关。

### 1.2 引擎环境（复核 `KATAGO_LOCAL_ENV.md`）

```
$ K="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/macos-arm64/katago"
$ W="/Applications/LizzieYzy Next.app/Contents/app/weights/default.bin.gz"
$ C="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/configs/analysis.cfg"
$ "$K" version
KataGo v1.16.4
Git revision: <omitted>
Compile Time: Oct 20 2025 13:40:11
Using Metal backend

$ grep -nE '^\s*reportAnalysisWinratesAs' "$C"
30:reportAnalysisWinratesAs = BLACK
```

三个文件均存在：二进制 5,565,360 B；主权重 271,447,864 B；配置 23,613 B。
**本报告全部视角结论均基于此配置的 `reportAnalysisWinratesAs = BLACK`，即 KataGo 返回的是黑视角 0..1 小数。** 若换用不含该键的配置，视角语义会回退为 SIDETOMOVE（见 `KATAGO_LOCAL_ENV.md` 的「配置视角」节），本报告结论不适用。

---

## 2. T2（plans/001）Done criteria 逐条重放

### C1 `cargo fmt --all --check` → exit 0

```
$ cargo fmt --all --check
fmt exit=0
```

### C2 `cargo clippy --workspace --all-targets -- -D warnings` → exit 0

首次运行命中缓存（仅 `Finished`），故 `cargo clean -p` 后强制重编译再跑：

```
$ cargo clippy --workspace --all-targets -- -D warnings
    Checking app-model v0.1.0 (...)
   Compiling lizzieyzy-next-desktop v0.1.0 (...)
    Checking sgf v0.1.0 (...)
    Checking katago-protocol v0.1.0 (...)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.36s
clippy exit=0
```

### C3 `cargo test --workspace` exit 0；5 个新测试存在且通过

```
$ cargo test --workspace   # 汇总
13 × "test result: ok. 0 passed"
1  × "test result: ok. 94 passed; 0 failed"
1  × "test result: ok. 56 passed; 0 failed"
... (其余 crate 全部 0 failed)
exit=0
```

按名核对新测试（T2 实际交付 **7 个**，为计划要求 5 个的超集）：

```
test tests::to_game_dto_carries_setup_stones_and_player_to_play ... ok
test tests::to_game_dto_defaults_to_empty_board_for_normal_game ... ok
test tests::katago_rules_for_sgf_ru_maps_known_aliases ... ok
test tests::katago_rules_for_sgf_ru_falls_back_to_chinese_for_missing_or_blank_text ... ok
test tests::analysis_query_includes_setup_stones ... ok
test tests::analysis_query_omits_setup_stones_for_empty_board ... ok
test tests::analysis_query_rejects_setup_stone_outside_board ... ok
```

### C4 `grep -rn 'rules: "chinese"' apps/desktop/src-tauri/src/lib.rs` 无匹配

```
$ grep -rn 'rules: "chinese"' apps/desktop/src-tauri/src/lib.rs
exit=1   # 无匹配
```

### C5 `grep -rn 'initial_stones: Vec::new()' crates/katago-protocol/src/lib.rs` 无匹配

```
$ grep -rn 'initial_stones: Vec::new()' crates/katago-protocol/src/lib.rs
exit=1   # 无匹配
```

（旁证：全仓 `grep -rn 'initial_stones: Vec::new()' --include=*.rs .` 亦为 0 处。）

### C6 `tests/golden/handicap_9x9.sgf` 存在且含 `HA[`、`AB[`、`PL[`

```
$ ls -l tests/golden/handicap_9x9.sgf
-rw-------@ 1 ice  staff  99 Sep 13 01:20 tests/golden/handicap_9x9.sgf
$ cat tests/golden/handicap_9x9.sgf
(;GM[1]FF[4]SZ[9]KM[0.5]HA[3]AB[cc][gg][cg]PL[W]RU[Japanese]PB[Black]PW[White]
;W[ee];B[gc];W[ce])
```

三个必需属性齐备（另含 `RU[Japanese]`，服务于 C7/§5）。

### C7 `cd apps/desktop && npm run build` exit 0

```
$ npm run build
> tsc && vite build
✓ 39 modules transformed.
dist/assets/index-DtG5LOCJ.js   355.45 kB │ gzip: 103.17 kB
✓ built in 68ms
exit=0
```

### C8 `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed

```
PASS workspace: 1 required files present
... (共 10 条 PASS)
Scaffold validation: 10 passed, 0 failed.
exit=0
```

### C9 `git status` 改动文件全部落在 In-scope 内

T2 提交（`git show 96132c9 --name-only`）恰为 5 个文件，全部在 plan 001 的 In-scope 列表内：

```
apps/desktop/src-tauri/src/lib.rs
crates/app-model/src/lib.rs
crates/katago-protocol/src/lib.rs
crates/sgf/src/lib.rs
tests/golden/handicap_9x9.sgf
```

### C10 `plans/README.md` 中本计划状态行已改为 `DONE`

```
$ grep -n '| 001 |' plans/README.md
28:| 001 | 修正分析查询保真度：视角、让子、规则 | P0 | M | — | DONE |
```

**关于 `plans/README.md` 的越界申报（T2 已主动申报）**：该文件不在 plan 001 的 In-scope 列表内，但 plan 001 Done criteria 末条与 `plans/README.md:92`（通用要求第 4 条）都**强制要求**执行者更新状态行。T2 已显式申报，属**计划要求与 Scope 列表的定义冲突**，非执行者擅自扩权。建议后续计划把 `plans/README.md` 明列进 In-scope。**判定：非缺陷。**

**T2 Done criteria：10/10 通过。**

---

## 3. T3（plans/002）Done criteria 逐条重放

被测对象为**工作树**（`b7f33a2` 只作改前对照）。

### C1 `npm run build` exit 0

见 §2 C7（同一命令，exit 0）。

### C2 `grep -nF '?? frames.at(-1)' App.tsx` 无匹配

```
$ grep -nF '?? frames.at(-1)' apps/desktop/src/App.tsx
exit=1   # 无匹配
```

工作树当前第 204 行：

```ts
const currentFrame = useMemo(() => frames.find((f) => f.turn === currentMove), [frames, currentMove]);
```

### C3 `grep -nF 'payload.frames.at(-1)' App.tsx` 恰 1 处（缓存路径保留）

```
$ grep -nF 'payload.frames.at(-1)' apps/desktop/src/App.tsx
1593:        const cachedMove = clampMoveNumberToPositions(replayed, payload.frames.at(-1)?.turn ?? parsed.moves.length);
exit=0
```

宽口径 `grep -n 'frames\.at(-1)' App.tsx` 亦仅此 1 处 → 回退移除与缓存保留两者同时成立，**无关键回归**。

### C4 `data-analysis-frame-source` 恰 1 处

```
$ grep -c 'data-analysis-frame-source' apps/desktop/src/components/AnalysisPanel.tsx
1
```

实现（`AnalysisPanel.tsx:42`）：

```tsx
data-analysis-frame-source={frame ? `frame:${frame.turn}` : "none"}
```

**语义核对（不止计数）**：`Props.frame?: AnalysisFrameDto`（可选），调用侧 `frame={visibleCurrentFrame}`。两支语义均可达并已在真实浏览器中验证——见 §7。

### C5 `grep -c '!'` 未增加

```
$ grep -c '!' apps/desktop/src/App.tsx          → 82
$ git show b7f33a2:...App.tsx | grep -c '!'     → 82
```

（另一口径 `grep -o '!' | wc -l`：工作树 104、基线 104，同样持平。）**未用非空断言绕过类型。**

### C6 `cargo test --workspace` all pass

见 §2 C3（exit 0，269 tests，0 failed）。

### C7 `validate_scaffold.py` → 10 passed, 0 failed

见 §2 C8。

### C8 `git status` 改动文件仅 App.tsx 与 AnalysisPanel.tsx

T3 的源码改动面：

```
 M apps/desktop/src/App.tsx
 M apps/desktop/src/components/AnalysisPanel.tsx
```

```
$ git diff --stat b7f33a2 -- apps/desktop/src/App.tsx apps/desktop/src/components/AnalysisPanel.tsx
 apps/desktop/src/App.tsx                      | 2 +-
 apps/desktop/src/components/AnalysisPanel.tsx | 1 +
 2 files changed, 2 insertions(+), 1 deletion(-)
```

`crates/`、`apps/desktop/src-tauri/`、`tests/`、`scripts/` 均**未被改动**（`git status --porcelain crates/ apps/desktop/src-tauri/ tests/ scripts/` 为空，除我本次测试产生的 `__pycache__`，已清理）。

### C9 Step 4 的人工核对结果已如实记录

`plans/002-drop-stale-frame-fallback.md:223` 起有 T3 追加的「Step 4 执行记录」，明确记录了原文场景不可复现、替代差分方案与实测数据。我已独立复现该差分（§7），确认记录属实。

### C10 `plans/README.md` 中本计划状态行已改为 `DONE`

```
$ grep -n '| 002 |' plans/README.md
29:| 002 | 移除陈旧分析帧回退，避免错位叠加 | P0 | S | — | DONE |
```

T3 另改了 `plans/README.md` 与 `plans/002-...md`（追加执行记录）——同 §2 C10，属计划强制要求，**非越界**。

**T3 Done criteria：10/10 通过**（计划修订后共 10 条）。

---

## 4. 真实引擎端到端（T4 环境）

### 4.1 直接喂 JSONL（复现 `KATAGO_LOCAL_ENV.md` 的跑法）

```
$ echo '{"id":"t5-single","moves":[["B","D4"]],"rules":"chinese","komi":7.5,"boardXSize":19,"boardYSize":19,"analyzeTurns":[1],"maxVisits":50}' \
    | "$K" analysis -config "$C" -model "$W"
{"id":"t5-single","isDuringSearch":false,"moveInfos":[{"move":"Q16",...}],"rootInfo":{"currentPlayer":"W",...,"rawWinrate":0.344263822,...,"winrate":0.351166247},"turnNumber":1}
exit=0
```

- stdout 含 **`moveInfos`**（13 条候选）与 **`rootInfo`** ✅
- `rootInfo.winrate = 0.351166247` — 落在 0..1 ✅
- stderr 尾部为正常收尾（`All cleaned up, quitting`）

### 4.2 用**生产代码生成**的 JSONL 喂真实引擎（闭环，最强证据）

见 §5。生产查询 `{"id":"t5-handicap_9x9",...,"initialStones":[["B","C7"],["B","C3"],["B","G3"]],"rules":"japanese",...}` 送入引擎：

```
rootInfo.winrate   = 0.999951344
rootInfo.scoreLead = 30.7589498
moveInfos count    = 40
has rootInfo = True ; has moveInfos = True
```

普通棋谱查询（无 `initialStones`）送入引擎：

```
rootInfo.winrate = 0.344879591 ; moveInfos count = 3
```

**端到端链路（SGF → to_game_dto → analysis_query_from_game → JSONL → KataGo → rootInfo/moveInfos）完整跑通。**

### 4.3 让子方向性对照（独立复现 T4 的实验）

同一局面（9x9 让三子，日本规则，`maxVisits=100`），仅切换是否发 `initialStones`：

| 查询 | `rootInfo.winrate`（黑视角） | `scoreLead` |
|---|---|---|
| 带 `initialStones`（T2 修复后） | **0.999943077** | **+30.5844649** |
| 不带（修复前行为） | **0.00319984846** | **-6.94042991** |

与 `KATAGO_LOCAL_ENV.md` 的「让子局端到端」对照表记录（0.999940 / 0.003212）一致（数值差异来自搜索随机性，方向完全一致）。**证明 plans/001 修复把让子谱分析从方向性错误（黑大败 ↔ 黑大胜）纠正为正确。**

---

## 5. 让子局 vs 普通棋谱：查询 JSONL 对照

用**外部 harness**（`/tmp/t5_harness`，通过 path 依赖链接仓库 crate）调用真实生产函数，**未修改仓库任何文件**。

```
### handicap_9x9 ###
summary.initial_stones  = [StoneDto { x: 2, y: 2, color: Black }, StoneDto { x: 2, y: 6, color: Black }, StoneDto { x: 6, y: 6, color: Black }]
summary.to_play         = White
summary.rules (raw RU)  = Some("Japanese")
normalized rules        = japanese
ONCE  initial_stones = [("B", "C7"), ("B", "C3"), ("B", "G3")]
ONCE  JSONL = {"id":"t5-handicap_9x9","moves":[["W","E5"]],"initialStones":[["B","C7"],["B","C3"],["B","G3"]],"rules":"japanese","komi":0.5,"boardXSize":9,"boardYSize":9,"analyzeTurns":[1],"maxVisits":100,"includeOwnership":true,"includePolicy":false}
BATCH initial_stones = [("B", "C7"), ("B", "C3"), ("B", "G3")]
BATCH JSONL = {"id":"t5-handicap_9x9-batch","moves":[["W","E5"],["B","G7"],["W","C5"]],"initialStones":[["B","C7"],["B","C3"],["B","G3"]],"rules":"japanese",...}

### basic_19x19 ###
summary.initial_stones  = []
summary.to_play         = Black
summary.rules (raw RU)  = None
normalized rules        = chinese
ONCE  initial_stones = []
ONCE  JSONL = {"id":"t5-basic_19x19","moves":[["B","Q16"]],"rules":"chinese","komi":7.5,"boardXSize":19,"boardYSize":19,"analyzeTurns":[1],"maxVisits":5,"includeOwnership":true,"includePolicy":false}
BATCH initial_stones = []
BATCH JSONL = {"id":"t5-basic_19x19-batch","moves":[["B","Q16"],["W","D16"],...],"rules":"chinese",...}
```

**结论**：
- 让子局 `initialStones` **非空**（3 子，坐标 `C7/C3/G3`），普通棋谱**为空**（且因 `skip_serializing_if = "Vec::is_empty"`，普通棋谱 JSONL 中**根本不出现** `initialStones` 键——保持了既有查询形状）✅
- 单点（`analysis_query_from_game`）与批量（`analysis_batch_query_from_game`）**两条生产路径**均已修复 ✅

### 5.1 修复前对照（用 `b7f33a2` 纯净导出）

```
BASELINE b7f33a2, same handicap SGF content:
  moves.len = 3
  AnalysisQuery.initial_stones = []
  AnalysisQuery.rules          = "chinese"
  JSONL = {"id":"baseline","moves":[["W","E5"]],"rules":"chinese",...}
```

同一让子 SGF，修复前送出的查询**既无 `initialStones`、规则也是 `chinese`**。修复有效且可归因。

---

## 6. 规则回归（`RU[Japanese]`）

```
$ grep -n 'katago_rules_for_sgf_ru' apps/desktop/src-tauri/src/lib.rs
2147:            rules: sgf::katago_rules_for_sgf_ru(game.summary.rules.as_deref()).to_string(),
2250:            rules: sgf::katago_rules_for_sgf_ru(game.summary.rules.as_deref()).to_string(),
```

两处硬编码均已改为从 SGF `RU` 归一化。生产 harness 输出（§5）：

- 让子 SGF（`RU[Japanese]`）→ `rules = "japanese"` ✅ **不再是 `chinese`**
- 普通 SGF（无 `RU`）→ `rules = "chinese"`（按设计回退默认值）

映射函数（`crates/sgf/src/lib.rs:639`）覆盖 chinese/中国/中国规则/cn/zh、japanese/日本/日本规则/jp/ja、korean/韩国/韩国规则/kr/ko、tromp-taylor/tt，未知值回退 `chinese`；单测 `katago_rules_for_sgf_ru_maps_known_aliases` 与 `..._falls_back_to_chinese_for_missing_or_blank_text` 均通过。

---

## 7. `frames.at(-1)` 回退移除：独立浏览器差分复现

T3 自报的证据我**未直接采信**，而是用仓库外 Playwright 脚本在**两棵真实树**上重跑（fixed = 工作树 `:1420`；baseline = `/tmp/t5_baseline` 导出 `:1421`）。

**注意：原计划 Step 4 场景不可复现**（`Run review` 的假分析对每一手都生成帧，`backend.ts:851`/`lib.rs:1906` 均为 `for turn in 0..=moves.len()`），我复核确认属实。故采用 T3 记录的等效手段：把应用自写缓存裁剪为稀疏帧 `[0,5,10,20]`，再经应用自身缓存恢复路径 reload。

### 7.1 修复树（工作树）

```json
{"label":"fixed","trimmed":{"before":[21],"after":[4]},
 "analysedTurn":5,"analysed":{"frameSource":"frame:5","candidateCount":8,"winrateBlack":"0.5357171501497909","visits":1485,"placeholder":false},
 "unanalysed":[
   {"turn":3,"frameSource":"none","candidateCount":0,"winrateBlack":"","visits":0,"candidateListItems":0,"placeholder":true},
   {"turn":7,"frameSource":"none","candidateCount":0,"winrateBlack":"","visits":0,"candidateListItems":0,"placeholder":true},
   {"turn":15,"frameSource":"none","candidateCount":0,"winrateBlack":"","visits":0,"candidateListItems":0,"placeholder":true}],
 "errors":[]}
```

### 7.2 基线树 `b7f33a2`

```json
{"label":"baseline","trimmed":{"before":[21],"after":[4]},
 "analysedTurn":5,"analysed":{"frameSource":null,"candidateCount":8,"winrateBlack":"0.5357171501497909","visits":1485,"placeholder":false},
 "unanalysed":[
   {"turn":3,"frameSource":null,"candidateCount":8,"winrateBlack":"0.4746899290038038","visits":3540,"placeholder":false},
   {"turn":7,"frameSource":null,"candidateCount":8,"winrateBlack":"0.4746899290038038","visits":3540,"placeholder":false},
   {"turn":15,"frameSource":null,"candidateCount":8,"winrateBlack":"0.4746899290038038","visits":3540,"placeholder":false}],
 "errors":[]}
```

### 7.3 关键判定：基线显示的正是第 20 手的数据

直接读取应用自写缓存中 turn=20 的帧：

```json
{"total":21,"maxTurn":20,"t20":{"visits":3540,"wr":0.4746899290038038,"cands":8}}
```

基线与修复树在**未分析手**（3/7/15）上的差异：

| 手数 | 帧覆盖 | 修复后 | 基线 `b7f33a2` |
|---|---|---|---|
| 5 | 有（对照） | `frame:5`, visits 1485, wr 0.5357 | visits 1485, wr 0.5357（**相同**） |
| 3 | **无** | `none`, visits 0, wr `""`, 0 候选 | visits **3540**, wr **0.4746899290038038**, 8 候选 |
| 7 | **无** | `none`, visits 0, wr `""`, 0 候选 | visits **3540**, wr **0.4746899290038038**, 8 候选 |
| 15 | **无** | `none`, visits 0, wr `""`, 0 候选 | visits **3540**, wr **0.4746899290038038**, 8 候选 |

基线在未分析手显示的 `3540 / 0.4746899290038038 / 8 候选` **逐字段等于 turn=20 的帧**——即升序排序后的最后一帧，与 plan 002 "Why this matters" 描述的错位叠加完全吻合。修复后该叠加消失。

两树在**有帧手（5）**上数值完全一致（1485 / 0.5357），排除环境噪声；两树 console/page errors 均为空。

**`data-analysis-frame-source` 两支语义均已在真实浏览器中验证可达**：有帧 → `frame:<turn>`；无帧 → `none`。

---

## 8. winrate 单位核对（是否误乘 100）

### 8.1 Rust 侧

```
$ grep -rn 'winrate' --include=*.rs crates/ apps/ | grep -E '\* *100|100 *\.0|/ *100|100\.0 *\*'
exit=1   # 无任何匹配
```

`crates/*/src/lib.rs` 中全部 `* 100` / `/ 100` / `100.0` 仅两处，且均与 winrate 无关：
- `crates/provider-yike/src/lib.rs:137` — provider 自身的 0..100 百分点域（外部数据源口径，非分析帧）
- `crates/sgf/src/lib.rs:1093` — `recovered_moves.len() as i32 * 100`，手数评分，与 winrate 无关

`katago-protocol` 的归一化直传不做缩放（`crates/katago-protocol/src/lib.rs:284` `winrate_black: root.winrate`、`:297` `winrate_black: info.winrate`）。

### 8.2 前端 `* 100` 是**显示格式化**，且为**既有**

```
apps/desktop/src/components/AnalysisPanel.tsx:60   {(frame.winrate_black * 100).toFixed(1)}%
apps/desktop/src/components/AnalysisPanel.tsx:82   {(candidate.winrate_black * 100).toFixed(1)}%
apps/desktop/src/components/AnalysisPanel.tsx:109  {(p.winrate_loss * 100).toFixed(1)}%
```

```
$ git show b7f33a2:apps/desktop/src/components/AnalysisPanel.tsx | grep -n 'winrate_black \* 100\|winrate_loss \* 100'
59:  ... (frame.winrate_black * 100).toFixed(1)%
81:  ... (candidate.winrate_black * 100).toFixed(1)%
108: ... (p.winrate_loss * 100).toFixed(1)%
```

三处 `* 100` 在基线 `b7f33a2` 就已存在，是"0..1 → 百分比字符串"的渲染转换，**不是**数据层缩放。数据层（DTO / 缓存 / 阈值）全程 0..1。

### 8.3 内部阈值确认为 0..1 域

```
crates/analysis-core/src/lib.rs:31  pub fn severity_for(winrate_loss: f32, score_loss: f32) -> ProblemSeverity {
crates/analysis-core/src/lib.rs:32      if winrate_loss >= 0.18 || score_loss >= 12.0 {
crates/analysis-core/src/lib.rs:34      } else if winrate_loss >= 0.10 || score_loss >= 7.0 {
crates/analysis-core/src/lib.rs:36      } else if winrate_loss >= 0.05 || score_loss >= 3.0 {
```

`0.18/0.10/0.05` 是 0..1 小数阈值，**正确**（Java 内部用 0..100，本仓库用 0..1；此差异属跨语言约定，非缺陷）。

**结论：本轮未引入任何 winrate ×100 缩放；数据层全链路 0..1。**

---

## 9. 未验证 / 无法验证项

1. **`cargo test --workspace` 的 python 2 例失败**：见 §10，属既有环境问题，**非本轮引入**。
2. **`npm run tauri:dev` GUI 真机启动**：**已在交付后由 rust-engineer 补做并成功**（本条原为"未执行"，现更新）。证据：`cargo build --workspace --all-targets` exit 0（10 crate 全量重编译）、`npm run build` exit 0、`npm run tauri:dev` 启动成功并出现 `LizzieYzy Next` 窗口（1280×840）。加载样例棋谱后经 DOM 读到：
   - `data-analysis-frame-source = frame:20`（**T3 新增属性，有帧支**）
   - `data-visits = 3540`、`data-winrate-black = 0.4746899290038038`、`data-candidate-count = 8`、`data-current-move = 20`
   - 面板文本 `Black winrate 47.5%`（数据层 0..1，**仅显示层 ×100**）
   - captain 独立按 `backend.ts:853` 的公式复算 `turn=20`：`visits = 800+20*137 = 3540`、`winrate = 0.51+sin(12.4)*0.08+cos(4.2)*0.045 = 0.4746899290038038` —— **与 DOM 实测逐位一致**。
   - 截图：`docs/qa/screenshots/app-running-window-t3.png`（2560×1680，即窗口 2× Retina；captain 校验 PNG 结构完整）。
   **注意**：该验证走的是**假分析**路径（`fake_analyze`/`buildBrowserAnalysis`），**不覆盖**"真实 KataGo 经 Tauri 命令产出帧"，故第 3 条仍为未验证。
3. **真实引擎 + 前端 Tauri 命令的完整 GUI 闭环**（点击 Review 后由真实 KataGo 产出帧）：**仍未验证**。浏览器预览与上面的 GUI 启动都走假分析路径；Tauri 命令需在 GUI 中配置真实引擎 profile 并触发。计划 003+ 才建立该链路。
4. **`AE`（删除摆子）在复合让子谱上的语义**：plan 001 维护注记已声明**有意推迟**。我做了基础抽查——`AB[cc][gg][cg]AE[cc]` → `initial_stones` 正确剩 2 子（`(2,6)`、`(6,6)`），未发现缺陷；但非前导摆子节点等变体未穷尽验证。
5. **KataGo `initialStones` 官方格式的联网核对**：未联网核对官方 `docs/Analysis_Engine.md`。但**用真实引擎实证**了格式被接受（§4.2/§5 的带 `initialStones` 查询正常产出结果，且方向性正确），实证强于文档核对。

---

## 10. 环境/既有问题（明确区分于实现缺陷）

### 10.1 2 个 python 测试失败 —— 既有，非本轮引入

```
$ python3 -m unittest discover -s tests -p "test_*.py"
Ran 279 tests in 2.714s
FAILED (failures=2)
```

- `tests/test_smoke_tauri_readboard_live.py::test_run_writes_sanitized_evidence_after_valid_report`
- `tests/test_smoke_tauri_runtime_ui.py::test_run_writes_sanitized_two_launch_evidence_after_valid_reports`

**根因**（实证）：

```
$ ls -ld /tmp
lrwxr-xr-x@ 1 root  wheel  11 Sep  3 18:34 /tmp -> private/tmp

$ python3 -c "import tempfile,os; d=tempfile.mkdtemp(); print(d, '->', os.path.realpath(d))"
/tmp/tmp8afddeab -> /private/tmp/tmp8afddeab
```

脱敏函数只特判 `/private/var/` 与 `/var/`（`scripts/smoke_tauri_readboard_live.py:396-399`），未特判 `/tmp`；而 macOS 上 `/tmp` 是 `/private/tmp` 的符号链接，故 `str(root)` 未被替换为 `<repo>`。

**关键归因证据 1（基线复现）**：把 `b7f33a2` 纯净导出到 `/tmp/t5_baseline` 后直接跑这两个测试：

```
$ cd /tmp/t5_baseline && python3 -m unittest tests.test_smoke_tauri_readboard_live tests.test_smoke_tauri_runtime_ui
Ran 22 tests in 0.007s
FAILED (failures=2)
```

**同样的 2 例在未含任何 T2/T3 改动的基线上原样失败。**

**关键归因证据 2（环境变量中和，决定性）**：把 `TMPDIR` 指向一个**真实目录**（非符号链接）后，同一棵工作树上的全部 279 个测试**全绿**：

```
$ python3 -m unittest discover -s tests -p "test_*.py"            # 默认 TMPDIR（/tmp 为符号链接）
Ran 279 tests in 2.714s
FAILED (failures=2)
exit=1

$ TMPDIR=/Users/ice/t5_tmp_real python3 -m unittest discover -s tests -p "test_*.py"
Ran 279 tests in 2.838s
OK
exit=0
```

**同一棵树、同一份代码，仅改变临时目录是否为符号链接，失败数从 2 变为 0。** 这直接证明失败根因是 macOS 的 `/tmp → /private/tmp` 符号链接与脱敏函数只特判 `/var` 的交互，与 T2/T3 的改动完全无关。

且两个测试文件与其依赖的 sanitizer 脚本本轮均未被修改（`git status --porcelain tests/ scripts/` 为空）。`plans/README.md:75` 亦已预先记录该既有失败。CI 跑 ubuntu（`/tmp` 为真实目录）故不受影响。

**判定：环境/既有问题，非实现缺陷，非本轮引入。** 契约 verify 命令的期望结果应理解为「279 tests, 0 failed（在 `/tmp` 非符号链接的环境下）」或「279 tests, 2 failed（在 macOS 默认 `/tmp` 符号链接下，为既有基线）」，两者均不构成回归。

### 10.2 `plans/README.md` 与 `plans/002-*.md` 被修改 —— 计划强制要求，非越界

见 §2 C10 与 §3 C10。

### 10.3 `KATAGO_LOCAL_ENV.md` 的轻量权重说法被证伪 —— 文档问题，非实现缺陷

env-engineer 报告称该文档**原**"轻量权重（38 MB b10）加载快、可做多轮回归"的结论错误（该说法修订前位于文档「权重校验」节；现行文档已在同处插入勘误块）。我**独立复现**（未采信其结论）：

```
$ LW="$HOME/.lizzieyzy-dev/models/kata1-tf2-b10c384-s2941M-d5872M.bin.gz"
$ ls -l "$LW"
-rw-r--r--@ 1 ice  staff  38245507 Sep 13 01:09 .../kata1-tf2-b10c384-s2941M-d5872M.bin.gz

$ cd /tmp && echo '{"id":"recheck","moves":[["B","D4"]],...}' \
    | "$K" analysis -config "$C" -model "$LW"
exit=134   stdout bytes: 0
stderr: libc++abi: terminating due to uncaught exception of type StringError:
  Error loading or parsing model file ...kata1-tf2-b10c384-s2941M-d5872M.bin.gz:
  This neural net requires a newer KataGo version. ... Model version: 17
```

**复现成立：app 引擎（自报 v1.16.4）无法加载该 38 MB 权重，exit 134、stdout 0 字节；该权重为 Model version 17（需 KataGo ≥ 1.17），属引擎/权重版本不匹配，非文件损坏。**

**反向佐证（bundle 权重确可用）**：同一引擎加载 bundle 主权重正常，其日志自报 model version 15：

```
$ cd /tmp && echo '{"id":"mv","moves":[["B","D4"]],...}' | "$K" analysis -config "$C" -model "$W"
exit=0
Metal backend 0: Apple M5 Pro, Model version 15 zhizi_hzy_b28_muonfd2, 19x19
```

即 bundle 权重（v15）与本机引擎（v1.16.4）兼容、轻量权重（v17）不兼容——与"版本不匹配"的根因解释自洽。

**文档现状**：`plans/KATAGO_LOCAL_ENV.md` 已由 env-engineer 在就地插入带证据的勘误块（搜 `勘误（env-engineer`），并把下方"两个权重的用途分工"修正为「bundle 主权重 = 本机唯一可用；轻量权重 = 本机当前不可用」。**以该文档为准**（captain 已声明其早前消息中关于轻量权重的一句被该文档覆盖）。

**对本报告结论的影响：无。** T5 的全部真实引擎测试（§4、§5、§7）**自始只用 app bundle 权重** `default.bin.gz`（§1.2 列出），从未使用该轻量权重——故 §4/§5 的让子与规则结论不受此勘误影响。

**归类：环境/文档问题，非实现缺陷，非 T2/T3 引入。**

### 10.4 `analysis --help` 退出码陷阱 —— 复核成立

```
$ "$K" analysis --help   → exit=1  (stdout 250 B, 内容为 "PARSE ERROR: Argument: --help")
$ "$K" analysis -help    → exit=0  (stdout 1140 B, 正常用法说明)
```

与 `KATAGO_LOCAL_ENV.md` 的「`--help` 退出码陷阱」注记一致。**不要用退出码判定 analysis 子命令可用性**；可靠方式是喂一条 JSONL 看是否产出 `rootInfo`（本报告 §4.1 即采用此法）。归类：环境/文档注意事项。

### 10.5 仓库卫生：引擎 `logDir` 相对路径污染 —— 机制真实且本轮实测触发过（已被 env-engineer 清理）

`analysis.cfg` 的 `logDir = analysis_logs` 为**相对路径**，若在仓库根目录 cwd 下运行引擎，会在仓库内创建 `./analysis_logs/`。该目录**不会**出现在 `git status`（被 `.gitignore:9` 的 `*.log` 覆盖），故不威胁 T2/T3 的验收断言，但会留下脏目录。

**机制我已实测确认**：在仓库根 cwd 下（不加 `cd`）执行一次 analysis，随即出现 `./analysis_logs/<ts>.log`：

```
$ cd "/Users/ice/Documents/New project/lizzieyzy-next-tauri"   # 仓库根 cwd
$ echo '{"id":"attr","moves":[["B","D4"]],...}' | "$K" analysis -config "$C" -model "$W"
exit=0
$ ls analysis_logs/
20260913-020607-62020F5B.log        # 仓库内被创建
```

**该污染在本轮确实发生过，且无法逐文件归因**：env-engineer 在 `~/.lizzieyzy-dev/logs-backup/` 留有 10 个 01:33–01:44 的仓库内日志备份（内容为 `logDir = analysis_logs` + `Loaded config .../analysis.cfg`，即用 bundle 原配置、在仓库 cwd 下启动）。**就本报告而言需自我更正**：我 §4.3 的让子对照实验是 2 次引擎调用，其命令**未加 `cd`**（§4.3 仅记录了结果，未贴 shell 调用；该调用在 bash 默认 cwd = 仓库根下执行），按上述确定性机制**很可能贡献了仓库内 `analysis_logs/`**。本报告早前称"所有引擎调用均以 `cd /tmp` 执行"是**不准确的**，特此更正。至于那 10 个备份文件具体归属（captain 早期验证 / env-engineer 探针 / 我），**无法判定，不作断言**，交由 reviewer 按需核实。

**当前状态（已核实干净）**：仓库内 `analysis_logs/` 与 `scripts/__pycache__/`、`tests/__pycache__/` **均已不存在**；`git status --porcelain` 仅 T3 的 2 个源码改动 + `?? plans/` + `?? .agent-teams/`。我本轮复核时创建的那份也已删除。

**规避建议**（供后续计划）：跑引擎前 `cd /tmp`，或使用 env-engineer 准备的 `~/.lizzieyzy-dev/configs/app_analysis_repo_external_logdir.cfg`（logDir 已指向仓库外）。

---

## 11. 发现的计划文本缺陷（供后续计划修订，非实现缺陷）

沿用我在 T5 前提交给 captain 的同类排查结论，此处复述与本轮 gate 相关的部分：

1. **plan 002 原 Done criteria 已修订**（`grep -nF '?? frames.at(-1)'` 锚定回退表达式 + `payload.frames.at(-1)` 保留条）。原"文件内 `frames.at(-1)` 零匹配"与 Scope 冲突，会误判 T3 失败或诱导误删 `:1593`。**修订已生效，本轮 T3 按修订后口径通过。**
2. **plan 002 Step 4 场景不可复现**：`Run review` 假分析对每一手都生成帧（`apps/desktop/src/api/backend.ts:851`、`apps/desktop/src-tauri/src/lib.rs:1906` 均为 `for turn in 0..=moves.len()`）。T3 改用稀疏缓存差分，我独立复现确认该替代方案有效。**建议后续修订 Step 4 措辞。**
3. **同类缺陷（计划 006/007，本轮未执行，供其开工前修订）**：
   - `plans/006-realtime-review-commands.md:402` 的 `grep -n 'fn accepts_live_info_line' …` 期望 1 处，但同计划 `:365-368` 强制的 4 个测试名均以此为子串前缀 → 实测将匹配 5 行。修正：锚定 `fn accepts_live_info_line(`。
   - `plans/007-frontend-live-review.md:348` 的 `grep -n 'listenToLiveReviewEvents' …` 期望 1 处，但按仓库惯例（具名导入 + 调用）实为 2 处（对照既有 `listenToKataGoAnalysisEvents` 在基线 App.tsx 为 2 处：导入 `:18` + 调用 `:584`）。修正：期望 2 处或锚定调用 `listenToLiveReviewEvents({`。
   - `plans/007:352` 是**负向** gate（`setFrames` 不得出现在 `setLiveReview(` updater 内），单条 grep 无法表达，需结构化核验。

---

## 12. 复现指引

```bash
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
cd "/Users/ice/Documents/New project/lizzieyzy-next-tauri"

# Rust 门禁
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# 前端
cd apps/desktop && npm run build && npx tsc --noEmit

# 脚手架
python3 scripts/validate_scaffold.py --verbose

# 真实引擎端到端（配置为 BLACK 视角）
K="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/macos-arm64/katago"
W="/Applications/LizzieYzy Next.app/Contents/app/weights/default.bin.gz"
C="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/configs/analysis.cfg"
echo '{"id":"t5","moves":[["B","D4"]],"rules":"chinese","komi":7.5,"boardXSize":19,"boardYSize":19,"analyzeTurns":[1],"maxVisits":50}' \
  | "$K" analysis -config "$C" -model "$W"

# 基线归因（2 个 python 失败为既有）
rm -rf /tmp/t5_baseline && mkdir -p /tmp/t5_baseline && git archive b7f33a2 | tar -x -C /tmp/t5_baseline
cd /tmp/t5_baseline && python3 -m unittest tests.test_smoke_tauri_readboard_live tests.test_smoke_tauri_runtime_ui
```

外部 harness（生产代码路径，仓库外）：`/tmp/t5_harness`（当前树）、`/tmp/t5_harness_base`（基线对照）。
浏览器差分脚本：`/tmp/pw-check/step4.ts`（两树同脚本）。

---

## 13. 补充核对（captain 复派时点名的 4 项）

captain 在 T5 复派消息中点名了 4 项需独立判断、且不应"只数匹配"的核对。以下为逐项实证（本节为报告补充，结论不改变 §0 总判定）。

### 13.1 `handicap_9x9.sgf` 的 `AB[cc][gg][cg]` 是否真落在 9x9 盘内

```
SZ[9]   # 合法坐标范围 x,y ∈ 0..8

cc -> (x=2, y=2)  in-board(0..8)=True
gg -> (x=6, y=6)  in-board(0..8)=True
cg -> (x=2, y=6)  in-board(0..8)=True
```

**三个摆子全部落在盘内** ✅。旁证：§5 的生产 harness 输出 `initial_stones = [(2,2),(2,6),(6,6)]`，坐标 0-based 且与 `MoveDto.vertex` 同一坐标系；`analysis_query_rejects_setup_stone_outside_board` 单测亦证明越界摆子会被 `ProtocolError::InvalidVertex` 拒绝（即该坐标系确有边界校验，非静默接受任意值）。

### 13.2 `PlayerColor` 的 `Default` 是否恰好一份

```
$ grep -rn 'impl Default for PlayerColor' --include=*.rs .
(empty = 0 匹配)
```

**0 匹配是正常的**——T2 用的是 `#[derive(Default)]` + `#[default]` 变体标注，而非手写 impl：

```
crates/app-model/src/lib.rs:9   #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
crates/app-model/src/lib.rs:10  #[serde(rename_all = "snake_case")]
crates/app-model/src/lib.rs:11  pub enum PlayerColor {
crates/app-model/src/lib.rs:12      #[default]
crates/app-model/src/lib.rs:13      Black,
crates/app-model/src/lib.rs:14      White,
```

运行期实测 `PlayerColor::default()` = `Black`（§5 harness 输出末行）。仓库内另有 `ProviderFetchMethod`（`:285-290`）也 derive `Default`，但那是**另一个类型**，与 `PlayerColor` 无关，不构成重复 impl。**判定：恰好一份，语义为 Black ✅。**

### 13.3 `runtimeSmoke.ts:853` 未被动过

```
$ git status --porcelain -- apps/desktop/src/runtimeSmoke.ts
(empty = 未修改)

$ git diff --stat b7f33a2 -- apps/desktop/src/runtimeSmoke.ts
(empty = 与基线逐字节相同)
```

工作树与基线第 853 行内容一致：

```ts
lastFrame: summarizeAnalysisFrame(frames[frames.length - 1])
```

**判定：未被动过 ✅**（该处是 `frames[frames.length - 1]`，与 T3 目标表达式 `?? frames.at(-1)` 写法不同，属另一文件的合法用法。）

### 13.4 `data-analysis-frame-source` 的语义（重点：无值支）

实现（`apps/desktop/src/components/AnalysisPanel.tsx:42`）：

```tsx
data-analysis-frame-source={frame ? `frame:${frame.turn}` : "none"}
```

`Props.frame?: AnalysisFrameDto` 为**可选**，调用侧 `frame={visibleCurrentFrame}`，而 `visibleCurrentFrame = applyPreferencesToFrame(currentFrame, preferences)` 在 `currentFrame === undefined` 时返回 `undefined`（`App.tsx:1971-1979` 的 `if (!frame) return undefined;`）。故两支均可达。

**"无值"支的实证（非计数，真实浏览器）**：§7.1 的修复树差分输出中，未分析手 3/7/15 实测

```json
{"turn":3,"frameSource":"none","candidateCount":0,"winrateBlack":"","visits":0,"candidateListItems":0,"placeholder":true}
```

即 **`"none"` + 0 候选点 + winrate 空串 + 占位提示**——正是"未分析位置不显示别手数据"的可断言状态。对照基线 `b7f33a2`（§7.2）同三手为 `frameSource:null`（属性不存在）+ 8 候选 + `0.4746899290038038`。**"无值"支语义正确且已客观验证 ✅。**

---

## 14. 验证者声明

- 本验证**未修改任何仓库源码**；`plans/VERIFICATION_REPORT.md` 为本任务唯一交付物。
- 报告中的每条结论均附命令与原始输出；数值均逐字引用，未转述。
- 未 push、未开 PR。
- 明确区分了三类结论：「已验证通过」（§2–§8）、「实现缺陷」（**无**）、「环境/既有问题」（§10）。
- 未验证项已在 §9 显式列出，未含糊带过。
- 视角结论已声明所用配置（§1.2：`analysis.cfg:30 reportAnalysisWinratesAs = BLACK`，故返回值为黑视角 0..1）；**未**声称"当前生产路径视角已错"——plan 008 的价值是消除对配置的隐式依赖（详见 §1.2 与 §11）。

**总判定：plans/001 与 plans/002 的实现通过独立验证，无实现缺陷。**
