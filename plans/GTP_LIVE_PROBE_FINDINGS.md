# 实测发现：本机 GTP `kata-analyze` 行为规格

> **本文档是实测记录，不是计划。** 由 captain 于 2026-09-13 在本机真实引擎上探针测得，用于修正 plans/003–007 中若干**未经实测的假设**。
> 所有结论都可用文末的探针脚本复现。凡本文档与既有计划冲突处，**以本文档为准**，并同步修订对应计划。

## 1. 环境（已就绪，勿重装）

```
引擎: /Applications/LizzieYzy Next.app/Contents/app/engines/katago/macos-arm64/katago   (KataGo v1.16.4, Metal)
权重: /Applications/LizzieYzy Next.app/Contents/app/weights/default.bin.gz              (271,447,864 B, model v15)
GTP配置: .../engines/katago/configs/gtp.cfg            ← 实时复盘必须用这个，不是 analysis.cfg
分析配置: .../engines/katago/configs/analysis.cfg      (reportAnalysisWinratesAs = BLACK)
```

启动命令（**plan 003 的 `build_command_spec` 必须产出这个形状**）：

```
<engine> gtp -model <weight> -config <gtp.cfg>
```

## 2. 决定性发现：`kata-analyze` 的视角 = **走棋方**，与 DTO 约定相反

### 实测数据

局面：9x9，黑占下方 4 行（36 子），白占上方 4 行（36 子），黑实地占优。

| 走棋方 | 配置 | `winrate` | `scoreLead` |
|---|---|---|---|
| BLACK | 默认 | **0.988298** | 0.0850384 |
| BLACK | 强制 `=BLACK` | 0.988079 | 0.0267466 |
| WHITE | 默认 | **0.012669** | 0.169398 |
| WHITE | 强制 `=BLACK` | 0.987424 | −0.150276 |

第二组（9x9 / komi 7.5 / 4 子落定，黑走，局面接近）：

| 配置 | `winrate` | `scoreLead` |
|---|---|---|
| 默认 | 0.391752 | **0.196254** |
| 强制 `=BLACK` | 0.340299 | **−0.0902159** |

### 结论

1. **本机 `gtp.cfg:82` 的 `reportAnalysisWinratesAs` 被注释掉**（`# reportAnalysisWinratesAs = SIDETOMOVE`），因此 KataGo 回落到**调用方 defaultPerspective**；`kata-analyze` 的调用方视角是**走棋方**。
2. **`scoreLead` 与 `scoreMean` 同样是走棋方视角**（上表第二组：默认 +0.196，强制 BLACK −0.090）。**两者必须一起转换，不能只转胜率。**
3. 这与 plan 001 修的是**同一类方向性错误**：本仓库 `AnalysisFrameDto.winrate_black` / `CandidateMoveDto.winrate_black` / `score_mean_black` 的语义是**固定黑视角**（`crates/katago-protocol/src/lib.rs:284` 直接填 analysis JSONL 的 `root.winrate`，而 analysis 路径的配置是 `= BLACK`）。
### 必须做的转换（plan 005 遗漏，**必须补上**）

解析器产出帧时，按**显式传入的 `perspective`**（引擎本次输出所用视角）转换。**参数语义是"引擎用的视角"，不是"走棋方"**——带上 `-override-config` 后引擎恒报黑视角，调用方恒传 `Black`：

```rust
// 视角修正：引擎按 `perspective` 报告；DTO 恒要黑视角
let flip = perspective == PlayerColor::White;
if flip {
    winrate_black = 1.0 - winrate;
    score_mean_black = -score_mean;   // scoreLead / scoreMean 同时取反
    // ownership 同样要取反（实测确认，见下）
}
```

**必须同时转换的四处（漏任一处都是方向性错误）**：

1. 根统计的 `winrate` / `score_mean`
2. **每个候选的** `winrate` / `score_mean`（只转根、漏候选 → 候选点与主胜率方向相反）
3. **`ownership` 数组**（实测确认它也随视角整体反号；漏转 → **热力图整体反色且不报错**）
4. 不转 `score_stdev` 与 `prior`（无方向性）

**`ownership` 视角相关性的实测证据**（9x9，黑占下方 4 行、白占上方 4 行；打印 9x9 网格的 `ownership`）：

- 无 override（走棋方视角）：`player=B` → 下方（黑子）行 **−1.0**、上方（白子）行 **+1.0**；`player=W` → **整体反号**（下方 **+1.0**、上方 **−1.0**）。
- 带 `-override-config ...=BLACK`：`player=B` 与 `player=W` **都**得到下方 **−1.0**（一致）。

**只转 `winrate` 不转 `score_mean`/`ownership`（或反之）是错的。** 它们在 KataGo 内部都相对同一个视角。

### 视角：既要 override，也要显式转换（裁定，2026-09-13，已取代本节原结论）

> **本节原结论「不能靠改配置绕过，只能在本仓库侧转换」已被 captain 裁定取代。** 正确做法是**两者都做、互补**——原结论把"二者取一"当成了前提。

**裁定内容**：

1. **GTP 启动参数必须强制写死 `-override-config reportAnalysisWinratesAs=BLACK`**（plan 003 Step 1）。理由：`gtp.cfg:82` 该键被注释 → 引擎报走棋方视角；该键在 KataGo 里是**可选**的，缺失即静默回落，**无法从引擎侧探测当前生效值**。强制写死后引擎输出确定（恒黑视角），不随用户配置漂移。
   - 实测确认在本机 v1.16.4 生效：无 override 时 `player=W` 报 `winrate 0.999629`（走棋方视角）；加 override 后 `player=W` 报 `0.000362`（恒黑视角）。
2. **plan 005 的解析器仍必须接受显式 `perspective: PlayerColor` 参数并做转换**。理由是**可审计性**：若将来有人去掉 override，实参由 `Black` 变为 `White` 是一个**可见的代码改动**，而不是所有白走帧被静默反向。

**二者互补，不会双重转换**：override 生效时引擎报黑视角，调用方传 `Black`，`flip == false`，原样填充。**唯一危险组合**是"override 在、却传 `White`"——那会给每个白走局面多翻一次。启动参数与 `perspective` 实参**必须成对一致**（plan 005 Step 3b 测试 15 锁住该不变量）。

**实测演示双重转换的后果**（黑占下 4 行、白占上 4 行、**白走**、引擎带 override）：
```
引擎原始 rootInfo.winrate（已是黑视角） = 0.000549    ← 正确：黑其实快输了
若再按"走棋方=白"翻折：1 - 0.000549 = 0.999451      ← 错误：变成"黑大胜"
```

> 原结论中仍然成立的部分：该键确实**可选**、确实**无法从引擎侧探测**——这正是要**同时**做显式转换（不把视角寄托在配置的运气上）的原因。原结论唯一错在"因此只能二选一"。

## 3. `kata-analyze` 行格式实测

```
info move G5 visits 530 edgeVisits 530 utility -0.865639 winrate 0.0728968 scoreMean -1.21368
  scoreStdev 5.81519 scoreLead -1.21368 scoreSelfplay -1.94969 prior 0.0237988 lcb 0.0612685
  utilityLcb -0.898198 weight 778.776 order 0 pv G5 D7 C6 F6 F5 C3 F2 F3 G3 E...
  info move ... info move ...
```

| 事实 | 实测值 | 对实现的影响 |
|---|---|---|
| 行内 `info` 块数 | **41 个**（12 秒后） | 一行含多个候选，必须按 ` info ` 切分 |
| 行长度 | 首行 2,486 字符 → 末行 **10,463 字符** | 不能用小缓冲读行；`BufRead::read_line` 可用但要避免固定小缓冲 |
| `rootInfo` | 未请求时不出现；**显式请求 `rootInfo true` 时每行都有** | ⚠️ **本行原结论有误，见 §3.1 勘误**。plan 005 应解析 `rootInfo`；**不要**用第一个 `info` 块代替根信息（两者不是一回事） |
| `ownership` | **默认不输出**；需 `kata-analyze interval <cs> ownership true` | plan 007 的热力图必须显式带 `ownership true`，否则永远没有热图 |
| `ownership` 位置 | 行尾，81 个浮点（9x9） | 必须在按 ` info ` 切分**之前**剥离（plan 005 已正确指出） |
| `interval` 单位 | 厘秒（`interval 20` → 8 秒 36 行） | 20cs=200ms，实测 6 秒 25 行、12 秒 48 行，吻合 |
| `visits` | 单调增长（0 → 530+）；**首个 `info` 块是最佳手，不是根** | 可用于"搜索是否收敛"的判定；根统计请用 `rootInfo`（见 §3.1） |
| 浮点单位 | **小数 0..1**（`winrate 0.480018`） | 与现有 DTO 一致，**不要 `*100`**（plan 005 已正确指出） |
| 终止语义 | 裸换行 / 任意新命令即终止（实测裸换行后 +1 行） | plan 004 的 `stop` 实现正确 |

### 3.1 ⚠️ 勘误：`rootInfo` **是存在的**（原结论为探针假象）

> **由 env-engineer 于 2026-09-13 在真实引擎上独立复核后追加。** 原结论「`rootInfo` 不存在」**不成立**，照它实现会让 plan 005 丢掉根统计。

**原探针的缺陷**：探针发出的命令是 `kata-analyze interval 20`（**没有** `rootInfo true`）。KataGo 的 `rootInfo` 是**按请求输出**的顶层字段——不请求就不输出。原探针因此把"没请求"误判为"不存在"。

**实测（受控 A/B，同一局面、同一 9x9/19x19 棋盘，只差一个 flag）**：

```
cmd: kata-analyze B 100 ownership true
  rootInfo present: False
  1st info block: visits=108 winrate=0.357758 scoreLead=-0.8861

cmd: kata-analyze B 100 ownership true rootInfo true
  rootInfo present: True
  rootInfo: visits=540 winrate=0.356033 scoreLead=-0.9271
  1st info block: visits=114 winrate=0.358241 scoreLead=-0.8934
```

请求 `rootInfo true` 后，**每一行 `info` 都带 `rootInfo`**（实测 9/9 行）：
```
line0: rootInfo=True ownership=True blocks=11 len=6646
line1: rootInfo=True ownership=True blocks=15 len=7712
...
line8: rootInfo=True ownership=True blocks=27 len=10903
```

**另一条被推翻的推断**：原表称「首块是根」。实测**首个 `info` 块是最佳手（`order 0`），不是根**：`rootInfo.visits=540` 而首块 `visits=114`，二者不等且首块带 `order 0`。因此 **plan 005 必须解析 `rootInfo` 取根统计，不能拿第一个 `info` 块顶替**——后者是最佳手的统计，官方文档明确二者语义不同（[GTP_Extensions.md:159](https://raw.githubusercontent.com/lightvector/KataGo/master/docs/GTP_Extensions.md)：根统计跨全部 visits 平滑平均，最佳手会快速波动）。

**对计划的影响**：
- plan 005 的 `KataAnalyzeLine.root` 与 `kata_analyze_line_to_frame` 的"优先用 root"逻辑**保持原设计即可**（它本来就对）——只需把"rootInfo 可能不存在"的措辞改为"**仅在请求 `rootInfo true` 时出现**"，并**要求 plan 006 的 `kata-analyze` 命令必须带 `rootInfo true`**（否则 `root` 恒为 `None`，帧会静默回退到最佳手统计）。
- plan 006 原本已写了 `rootInfo true`，因此**该计划无需为此改动**，但需在验收里明确"缺 `rootInfo true` 会让根统计静默降级"。

**为什么这条勘误重要**：若按原结论实现（拿首块当根），实时复盘的胜率会取**最佳手**而非**根平均**，表现为胜率抖动明显、与批处理路径（用 `rootInfo`）数值不一致——是隐蔽的数值偏差，不是崩溃，最难排查。

## 4. ⚠️ 管道缓冲陷阱（实现必须处理）

**实测**：用 `subprocess` + `select` 非阻塞读时，握手阶段 `boardsize 9` / `komi 7.5` / `play B E5` 的 `=` 响应**不会立即出现**，而是在数秒后**批量**到达（8 行同一时间戳）。

```
[2.83s] =     ← boardsize 9 的响应
[2.83s]
[2.83s] =     ← komi 7.5 的响应
[2.83s]
[2.83s] =     ← play B E5 的响应
...
```

**风险**：若 plan 004 的会话内核在每次 `send` 后**同步阻塞等待 `=` 响应**，就会：
- 等待时间不确定（取决于后续是否有数据冲刷管道）；
- 在等待期间**无法处理**引擎主动推送的 `info` 行 → 实时性丧失。

**要求**（写进 plan 004 的验收）：
1. **绝不 `send` 后同步等响应**。发送与读取必须完全解耦：一个写线程/写路径，一个常驻 stdout 读线程，读到的每一行按类别分发（`=`/`?` 响应 vs `info` 流 vs 空行）。
2. 需要"命令已确认"语义时，用**命令编号**（`kata-analyze` 不需要；`play`/`boardsize` 需要）做异步匹配，而不是阻塞等待。
3. 启动时不做同步握手探测；`boardsize`/`komi`/摆子按序异步发出即可。

> 注：该批量行为可能是 macOS 管道缓冲或 Python 层 `select` 的表现，Rust `BufReader` 读线程模型下未必相同。**执行者必须在 Rust 侧实测确认**，不能直接假定"Rust 就没这个问题"。但"发送与读取解耦"的设计要求无论如何都成立。

## 5. 复现脚本

```bash
python3 /tmp/gtp_probe6.py   # 视角判定（决定性）
python3 /tmp/gtp_probe3.py   # ownership / visits / info 块数
python3 /tmp/gtp_probe7.py   # scoreLead 视角
```

脚本用 `subprocess` + `select` 非阻塞读 + 线程无关的显式 `pump(dur)` 时序，不依赖 `timeout(1)`（macOS 无此命令）。

## 6. 对既有计划的修订要求

| 计划 | 修订 | 状态 |
|---|---|---|
| 003 | 启动规格确认：`gtp -model <w> -config <gtp.cfg>`；**必须附 `-override-config reportAnalysisWinratesAs=BLACK`（裁定）**；补"发送/读取解耦"要求；明确实时复盘用 `gtp.cfg`（用 `analysis.cfg` 会崩溃）；更新 Drift check 基底 | ✅ 已修订 |
| 004 | 补 §4 的异步分发要求；`=` 响应不得同步等待；明确 `kata-analyze` 不需要命令编号；新增测试 8 覆盖"批量响应不阻塞"；**Step 1 裁定**：新增 `EngineManagerError` 变体必须同步补 `apps/desktop/src-tauri` 的 `engine_error_kind` 穷尽 match（否则 `--workspace` E0004 / exit 101），该补臂为本计划**已授权的 In-scope 定向扩展** | ✅ 已修订 |
| 005 | **新增 Step 3b 视角转换**：显式 `perspective: PlayerColor` 入参（**参数名以裁定为准，不是 `to_play`**）；`winrate→1-w`、`score_mean→-score_mean`、**`ownership` 也整体取反**，`score_stdev`/`prior` 不转；根与每个候选都要转；补 6 个视角转换测试（11–16，含**双重转换**与 `ownership` 两向）；`rootInfo` 措辞按 §3.1 勘误改正（**它存在，且首块是最佳手不是根**） | ✅ 已修订 |
| 006 | 事件 payload **采用「已转换的黑视角值 + `to_play` 元数据」方案**（二选一已写死）；`kata-analyze` 必须带 `ownership true` **与** `rootInfo true`；前端禁止二次转换；**`player`（轮谁走）≠ `perspective`（引擎输出视角），后者实参恒为 `Black`** | ✅ 已修订 |
| 007 | `kata-analyze` 必须带 `ownership true`（否则热图恒空）；前端禁止视角二次转换；更新过时的"本机未安装 KataGo" | ✅ 已修订 |

> **视角方案的最终裁定（2026-09-13，取代 §2 原「不能靠改配置绕过」）**：**override 与显式转换两者都做、互补**——`-override-config` 让引擎输出确定（源头），`perspective` 参数让契约可审计（若 override 被移除则是可见的代码改动）。**不会双重转换**（override 生效时传 `Black`，`flip == false`）；唯一危险组合是"override 在却传 `White`"，故启动参数与实参必须成对一致（plan 005 测试 15）。

> **基底漂移提醒**：以上计划原写于 `b7f33a2`，工作树 HEAD 已到 **`92dcfe8`**（含 001 提交 `96132c9`、002 的 `App.tsx`/`AnalysisPanel.tsx` 改动、UI 重构 `d1d18df` 与截图提交），其后又有 plan 003 实现提交 `97ea9a4`。各计划的 Drift check 已按此更新：**以现网代码为准**，且 `crates/katago-protocol/src/lib.rs` 因 001 而变更属**预期**，不是漂移。
