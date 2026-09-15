# CODEX_DSH_DELIVERY — 本地 KataGo 实时分析 + 归属热图后端交付

> **交付者**：captain（DSH agent） **日期**：2026-09-13
> **范围**（用户收敛后）：**只做 Java 式本地 KataGo 实时分析 + 归属热图**，不迁移其他功能。
> **状态**：后端代码完成，门禁全绿，**未提交**。等待 Codex 最终全量 + GUI 验收。

---

## 1. 稳定验收快照

```
仓库: /Users/ice/Documents/New project/lizzieyzy-next-tauri
分支: advisor/analysis-baseline
HEAD: 0f18fab   (未提交改动在下面列出；本快照即为请 Codex 验收的点)
```

**本快照的未提交文件**（这是我这一轮的全部改动面）：

| 文件 | 内容 |
|---|---|
| `apps/desktop/src-tauri/src/lib.rs` | 实时复盘命令的竞态修复 + SGF 保真契约 + 退出清理 |
| `crates/engine-manager/src/lib.rs` | GTP 启动强制 `-override-config reportAnalysisWinratesAs=BLACK` |
| `crates/katago-protocol/src/lib.rs` | （上一轮 rust-parser 交付）`kata-analyze` 解析器 + 视角转换 |
| `apps/desktop/src/api/backend.ts` | （t11 交付）实时复盘 wrapper |
| `apps/desktop/src/**` | ui-engineer 的前端接线与布局（进行中） |

**门禁实测**（本快照）：

| 命令 | 结果 |
|---|---|
| `cargo fmt --all --check` | exit 0 |
| `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo test --workspace` | **333 passed / 0 failed**（基线 269） |
| `cd apps/desktop && npm run build` | exit 0 |
| `python3 scripts/validate_scaffold.py --verbose` | 10 passed / 0 failed |

**真实引擎端到端**（`/opt/homebrew/bin/katago` v1.18.2 + `~/.lizzieyzy-dev/` 权重与配置）：
- 摆子局面 `set_position B D4 B G3 W E5` + `kata-analyze W 10 ownership true rootInfo true`
  → `showboard` 保留三子、`Next player: White`、`rootInfo visits=2924 winrate=0.0434212`、**ownership 81 点**
- Codex 第 2 轮独立真实 Tauri IPC 验收 **8/8 PASS**（13.2 秒）

---

## 2. 本轮修复的问题（全部经实测证实）

### 2.1 ⚠️ 旧 stdout 被误标成新 generation（用户点名要求审查的竞态）

**这是本轮最重要的一处。** 用户的质疑原文：「*不能只清一次队列就当安全；请用 GTP 命令 ID 响应边界等可证伪机制*」——**质疑成立**。

**竞态机制**：`kata-analyze` 的行是**流水线输出**。当请求 A 正在推 `info`，用户跳到 B，owner 线程把 A 的后续行打上 B 的 generation/target_turn → 该行**通过原有全部守卫**（世代与手数都匹配），但内容是 A 局面的。棋盘显示 B，叠加的却是 A 的候选点与热图。管道还有批量缓冲（实测 8 行握手响应同一时间戳到达），使这些行更可能在切换后才被读到。

**修复**（三层，均可证伪）：
1. **GTP 命令 ID**：每条命令带唯一 id（`4 kata-analyze ...`）。实测 KataGo 回显：`=1 `…`=8`。
2. **响应边界门控**：`LiveReviewGuardState.stream_ready`。handler 发布新请求时**同步**清零；只有 owner 线程读到**该请求自己 `kata-analyze` 的 `=` 确认**才重新打开。边界之前的 `info` 一律丢弃。
3. **ID 区间**（Codex 第 2 处发现，见 2.2）。

**测试**：`accepts_live_info_line_rejects_before_the_response_boundary`（其余维度全部匹配、仅 stream_ready=false，必须被拒）；`stream_ready_closes_on_publish_and_reopens_only_for_the_matching_generation`。

### 2.2 准备命令的错误被忽略（Codex 发现，采纳）

**Codex 原文**：「*当前 owner 对匹配 ?ID 也 publish_stream_ready，不应将引擎错误当成功*」以及「*你只按 pending_ack_id==ack.id 检查错误，准备命令的错误 ID 均小于最终 analyze ID，仍会被忽略！需要记录本请求 first..last ID 区间*」。

**两条都成立**，且第 2 条让第一版修复形同虚设。

**修复**：`apply_live_review_position` 返回 **`LiveReviewCommandIds { first, analyze }`** 区间；owner 对区间内**任一 `?id`** 都视为失败 → 关闭会话并发出 `katago://live-review-ended`，理由含引擎原话。
- 只有 `=analyze_id` 才打开流；`?` 永远不打开。
- 实测引擎错误格式：`? Could not parse vertex: 'Z99'`。

**测试**：`live_review_command_ids_cover_the_whole_batch_and_only_the_analyze_opens_the_stream`、`parse_gtp_ack_separates_success_from_error_and_keeps_the_id`。
**Codex 独立验收确认**：非法 `B Z99` 现被正确报告，且**无错误局面的分析帧**。

### 2.3 双重 ID 前缀（Codex 发现，采纳）

`send()` 已统一加 id，而 `live_review_kata_analyze_command()` 又返回带 id 的串 → 发出 `4 4 kata-analyze ...`，引擎会整条拒绝。**已改为只在 `send()` 一处加前缀**，并加测试 `live_review_kata_analyze_command_carries_no_command_id` 与 `live_review_position_sends_board_moves_and_flagged_kata_analyze_to_the_engine`（断言 id 严格递增、无重复前缀）。

### 2.4 虚构 `play B pass` 会污染历史（Codex 发现，采纳）

我原实现为表达 `PL[W]`，在 `set_position` 后插入 `play B pass`（因为 `set_position` 固定留黑方走）。

**Codex 指出**：官方 `GTP_Extensions.md` 里 `kata-analyze` 的 `player` **本来就指定搜索方**；虚构 pass 会污染历史，且 `request.player` 是最终行棋方、不是 setup 后行棋方。

**我查了官方原文**（`:86`，lz-analyze 节，kata-analyze `:108` 声明同）：
> "Assumes the normal player to move next **unless otherwise specified**."

**实测证实 Codex 正确**（同一摆子局面）：

| 命令 | 根胜率 |
|---|---|
| `kata-analyze W`（**无** pass） | 0.0362307 |
| `kata-analyze W`（**有** pass，我原实现） | 0.0364330 |
| `kata-analyze B`（无 pass） | 0.999018 |

`player` 确实选择搜索方（W↔B 翻转），且不插 pass 即可正确表达。**已删除虚构 pass**，改为直接用 `player` 参数。测试改为断言**不存在** `play B pass`。

### 2.5 handicap 必须用 `set_free_handicap`（Codex 发现，采纳 + 加固）

**Codex 原文**：「*官方还明确 handicap 应用 set_free_handicap，不能把 HA 的黑让子仅当普通 set_position，否则中国规则 whiteHandicapBonus 不对*」以及「*handicap>=2 当前不检查 setup color，把 AW 也变黑且奇数 pair 被忽略，请验证全为 B、pair 完整、数量符合 HA，不合条件就明确拒绝*」。

**两条都成立**。官方 `set_position` 文档明确："It is NOT recommended to use this command to place the starting stones for handicap games."

**修复**：`HA >= 2` → `set_free_handicap <vertices>`；并新增 `live_review_handicap_stones()` **严格校验**：全为黑子、pair 完整、空顶点拒绝、**数量必须等于 HA**。任一不满足 → 明确报错（走 `live-review-ended`），**绝不静默改局面**。

`HA < 2` 或无 HA → 走 `set_position`（摆子谱/死活题）。两条路径语义分明。

**测试**：`handicap_validation_rejects_anything_that_would_change_the_position_silently`（5 个拒绝分支 + happy path）、`live_review_handicap_game_uses_set_free_handicap_not_set_position`。

### 2.6 退出清理未接线（Codex 发现，采纳）

**Codex 原文**：「*现有 builder 结尾 .run(...)，尚未看到 RunEvent::Exit/CloseRequested 的 live session teardown，owner 持有 AppHandle 可能使仅靠 state Drop 无效；退出清理请显式接好，registry job 也要移除*」。

**成立**——`GtpSession` 由 owner 线程持有，`LiveReviewSession` 挂在 app 上，单靠 `Drop` 不会在进程回收前执行。

**修复**：
- `tear_down_live_review(state, registry)` 现在**同时**移除 registry job（`registry.remove(&job_id)`），避免泄漏 cancel token。
- 新增 `tear_down_live_review_with_app(&AppHandle)`，走 `app.state::<..>()` 拿两个 state。
- 接线两处：`.on_window_event(.. Destroyed ..)`（关窗）与 `.run(|app, event| .. ExitRequested/Exit ..)`（Cmd-Q / `Exit`）。

### 2.7 GTP 启动强制固定黑视角（我上轮补，plan 003 要求）

`build_command_spec` 的 `KataGoGtp` 分支加 `-override-config reportAnalysisWinratesAs=BLACK`。

**理由**：本机 `gtp.cfg` 的该键被注释 → 回落 **SIDETOMOVE**；而 DTO 约定是固定黑视角。实测（白走局面）无 override 报 0.995675、有 override 报 0.00435403（精确互补）。该键在 KataGo 中可选、**无法从引擎侧探测**，所以必须强制。

---

## 3. 最终 API 契约（Codex 要求写清，供真实 Tauri IPC 验收）

### 3.1 命令

| 命令 | 参数 | 返回 |
|---|---|---|
| `katago_start_live_review` | `profile: EngineProfileDto`, `boardSize: u8`, `turn: u32`, `intervalCentisec: u32` | `jobId: string` |
| `katago_live_review_set_position` | 见下表 | `generation: number` |
| `katago_live_review_stop` | — | `()` |

**`katago_live_review_set_position` 完整参数**：

| 参数 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `moves` | `string[]` | 当前**分支**的着法 | GTP 对：`["B","D4","W","Q16"]` |
| `turn` | `number` | 目标手数 | 世代校验 |
| `intervalCentisec` | `number` | 0 = 会话默认 10cs | |
| `player` | `PlayerColor?` | SGF `PL` | **同时**决定 `kata-analyze` 搜索方 |
| `komi` | `number?` | SGF `KM` | 无则不发该命令 |
| `boardSize` | `number?` | SGF `SZ` | 不传则沿用会话尺寸 |
| `setup` | `string[]?` | `AB`/`AW` | GTP 对：`["B","D4","W","E5"]` |
| `rules` | `string?` | SGF `RU` → KataGo 规则名 | `kata-set-rules` |
| `handicap` | `number?` | SGF root `HA` | **仅 `>= 2` 时传**，且 `setup` 必须全 B |

### 3.2 引擎命令序列（生产路径实际发出，已由回显引擎测试断言）

**普通对局**（无 setup）：
```
<id> boardsize <SZ>
<id> komi <KM>            (仅当提供)
<id> kata-set-rules <RU>  (仅当提供)
<id> clear_board
<id> play <C> <V> ...     (分支着法)
<id> kata-analyze <player> <interval> ownership true rootInfo true
```

**摆子局面**（setup 非空、HA<2）：
```
<id> boardsize / komi / kata-set-rules
<id> set_position <C V C V ...>      ← 摆子，无历史；不用 clear_board
<id> play <C> <V> ...                (setup 之后的着法，若有)
<id> kata-analyze <player> <interval> ownership true rootInfo true
```

**让子局**（HA>=2，校验全 B 且数量==HA）：
```
<id> boardsize / komi / kata-set-rules
<id> set_free_handicap <V V V ...>   ← 让子，保留 whiteHandicapBonus 语义
<id> kata-analyze <player> <interval> ownership true rootInfo true
```

**停止**：裸换行（`send_bare_newline`），引擎进程保留。

### 3.3 事件

| 事件 | payload |
|---|---|
| `katago://live-review-frame` | `{ job_id, generation, turn, to_play, frame }`。**`frame` 已是黑视角**（`winrate_black`/`score_mean_black`），前端**不得二次转换**。`to_play` 仅元数据。 |
| `katago://live-review-ended` | `{ job_id, generation, reason }`。`reason` 含引擎原话（如 `engine rejected ? Could not parse vertex: 'Z99'`）。 |

### 3.4 陈旧性守卫（三重 + 边界）

`info` 行被接受需**全部**成立：
1. `stream_ready == true`（GTP 响应边界已过）
2. `line_generation == current_generation`
3. `current_target_turn.is_some() && line_target_turn == current_target_turn`

前端**另需**用 payload 的 `generation`/`turn` 再校验一次（双方之间仍有异步间隙）。

---

## 4. 用户要求逐条对照

| 用户要求 | 状态 |
|---|---|
| 支持**空盘** | ✅ `clear_board` + `kata-analyze`，实测空盘出 362 候选（19 路） |
| 支持**落子 / 切手 / 分支 / 换谱自动更新** | ✅ 每次 `set_position` bump 世代，旧帧立即失效；分支着法由 `moves` 表达 |
| **SGF 初始摆子**保真 | ✅ `set_position`（实测 `showboard` 保留 AB/AW） |
| **规则**保真 | ✅ `kata-set-rules <RU>` |
| **贴目**保真 | ✅ `komi <KM>`（无则不发，不覆盖引擎默认） |
| **行棋方**保真 | ✅ `kata-analyze <player>`（实测 W/B 改变搜索方，根胜率 0.036↔0.999） |
| **ownership true + rootInfo true** | ✅ 强制携带，有测试断言 |
| **生产 perspective 常量 Black** | ✅ `kata_analyze_line_to_frame(..., PlayerColor::Black)` |
| **请求变化立刻清旧帧** | ✅ handler 同步 `stream_ready=false` + bump 世代 |
| **job/generation/turn 三重校验** | ✅ 见 3.4 |
| **停止/换引擎/退出正确回收** | ✅ 裸换行停止；`tear_down` 走 Shutdown 命令 + join + registry 移除；关窗与 Exit 双接线 |
| **旧 stdout 不可误标新 generation** | ✅ GTP 命令 ID 响应边界（见 2.1/2.2） |
| **UI 中文开始/停止 + 热图开关** | ⏳ ui-engineer 进行中 |
| **正常 profile 可自动启动分析** | ⏳ 前端（ui-engineer） |
| **运行时资源缺失不遮盖有效外置引擎** | ⏳ 前端（ui-engineer） |
| 空盘 9 帧 visits 2→449、ownership 361 | ✅ Codex 已独立实测 |

---

## 5. 未验证 / 未完成项（如实标注）

| 项 | 状态 |
|---|---|
| **前端接线**（App.tsx 仍为旧 moves-only 调用） | ⏳ **未完成**，已把冻结契约发给 ui-engineer。`GameSummaryDto` 的 TS 类型缺 `initial_stones`/`rules`/`to_play`，`HA` 需从 SGF root properties 取 |
| 布局（大棋盘、折叠面板、首屏可见开关） | ⏳ ui-engineer |
| 热图图例 | ⏳ ui-engineer |
| 白棋候选评级方向（Codex 发现，成立） | ⏳ ui-engineer |
| 窗口缩放重绘（Codex 发现，成立） | ⏳ ui-engineer |
| **GUI 目视验收** | ❌ 未做（Codex 负责） |
| `handicap` 真实引擎端到端 | ⚠️ 仅单测 + 命令序列断言；**未用真实引擎跑 `set_free_handicap` 全链路**（好消息：Codex 第 2 轮已独立验证 setup/ownership 与 9→13→9 切盘） |
| `boardSize` 切换（9→13→9）真实链路 | ✅ Codex 独立验收通过 |
| 退出清理的**真实进程回收** | ⚠️ 接线与注册已加，**未实测**「关窗后 `ps` 无残留 katago」 |
| `plans/` 与旧计划的冲突 | 已按用户指令「**以本指令和真实代码为准**」处理，未因旧计划边界制造死锁 |

---

## 6. 本轮未做的事（遵守边界）

- **未提交、未推送、未开 PR。**
- **未安装引擎**（Codex 已恢复 `/opt/homebrew/bin/katago` v1.18.2）。**未覆盖 Codex 的有效 profile 配置。**
- **未启动 GUI**（Codex 独立验收）。
- **未碰** `apps/desktop/qa-live-review.html`、`apps/desktop/qa-live-review.ts`、`docs/qa/codex-live-review-*`。
- 验收服务端口 1421 未打扰（本地预览用 1420）。
- 未迁移本轮范围外功能（provider 抓谱、readboard、远程算力、引擎对弈、AI 老师、打包）。

---

## 7. 给我的下一棒

生产代码**到此停手**（等 ui-engineer 的前端完成后我会再确认一次门禁，然后不再改动），以便 Codex 做最终全量与 GUI 验收。

前端完成后需要复跑的门禁：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace`、`cd apps/desktop && npm run build`、`python3 scripts/validate_scaffold.py --verbose`。
