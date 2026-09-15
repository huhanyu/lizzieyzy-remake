# 交接说明：lizzieyzy-next-tauri 实时复盘迁移

> **读者**：接管本任务的 Codex（或任何后继 agent）。
> **写于**：2026-09-13。**仓库**：`/Users/ice/Documents/New project/lizzieyzy-next-tauri`
> **分支**：`advisor/analysis-baseline`，HEAD = `5f5c99b`，基底 `upstream/dev @ b7f33a2`

---

## 0. 为什么换人（前一位 agent 的已知短板）

前一位 agent（captain）**没有可靠的视觉能力**：无法读取截图（模型不支持图像输入），`modlens` 无 vision provider，后来连 macOS 屏幕录制权限也失效（截图返回全黑）。

它靠**程序化像素/DOM 测量**替代目视，这在几何类缺陷上反而更精确（它据此发现了棋盘被压成 2.19:1），但**对"好不好看、像不像 Java 版"这类主观判断完全无能**。用户明确因此要求换用 Codex 引导。

**给 Codex 的建议**：你若有视觉能力，请把它用在**审美与对照**上——那正是前一位 agent 的盲区。几何/数值问题继续用程序化测量（更快且可复现）。

---

## 1. 用户要什么（原始意图，未变更）

把 Java/Swing 主线（`wimi321/lizzieyzy-next`，294k 行）的**实时复盘分析**迁移到本 Tauri 仓库。用户反复强调**实时复盘是核心目标**：

> 选中某一手 → 胜率/候选点/归属热图**持续刷新并收敛**（流式），而不是等一次性算完。

用户还说过（原话）：**"katago 实时分析功能还是做不到 需要完整测试"**。

**当前状态：实时复盘仍未实现。** 这是最大的未完成项。

---

## 2. ⚠️ 两个必须先知道的阻塞/事实

### 2.1 引擎没了（最高优先级）

**`/Applications/LizzieYzy Next.app` 已被删除**（连同引擎二进制、272MB 权重、`gtp.cfg`/`analysis.cfg`）。前一位 agent 在 14:21 仍成功调用它、14:28 即失败；废纸篓为空；**非本团队所为**（团队只读该路径）。

**连带后果**：`~/.config` 与应用 profile 里保存的引擎路径全部失效；`smoke_tauri_katago_live.py` 等真实引擎冒烟测试**现在跑不了**。

**现存资产**（`~/.lizzieyzy-dev/`）：

| 文件 | 说明 |
|---|---|
| `models/kata1-tf2-b10c384-s2941M-d5872M.bin.gz` | 38 MB，**model version 17** → 需 KataGo ≥1.17 |
| `configs/gtp_forced_black.cfg` | 33,951 B（本团队生成的强制黑视角配置） |
| `configs/analysis.cfg` | 27,784 B，`reportAnalysisWinratesAs = BLACK` |
| `configs/analysis_example.cfg` | 27,829 B，KataGo 官方模板 |
| `configs/app_analysis_repo_external_logdir.cfg` | 23,568 B |

**恢复路径（未验证）**：
1. 重装 Java 版 LizzieYzy Next（应用商店/官网）——最快，且其 bundle 自带匹配的引擎+权重。
2. `brew install katago`（≥1.17）——**实测曾失败**：362 MB bottle、~400 KB/s、40 次重试未下完。但那是可用 ≥1.17 引擎的唯一途径，且**现有 38 MB 权重正好需要它**。
3. 从 KataGo releases 取源码自行编译（无 macOS 预编译产物）。

### 2.2 用户侧的引擎配置曾为空（前一位 agent 已修，但会随重装失效）

应用读 `~/Library/Application Support/org.lizzieyzy.next/lizzieyzy-next-engine-profile.json`。它曾是：
```json
{"engine_path": "", "model_path": null, "config_path": null}
```
**空路径 = 应用从不启动引擎 = 空棋盘无任何候选点**。这就是用户报的"完全不能分析"的根因（引擎侧本身正常：实测空盘 turn=0 返回 362 个 moveInfos）。

前一位 agent 已写入正确路径，但**引擎被删后该配置再次失效**。重装引擎后必须重写此文件（含 `working_dir`，因 config 里 `logDir` 是相对路径）。

---

## 3. 已完成的实质性工作

### 3.1 已提交（13 个 commit，基于 `b7f33a2`）

| commit | 内容 |
|---|---|
| `96132c9` | plan 001：分析查询保真度（摆子/规则/行棋方） |
| `920f723` | plan 002：移除陈旧分析帧回退 |
| `d1d18df` | UI 中文化 + 布局重设计 |
| `92dcfe8` | 截图入库 + `.gitignore` |
| `97ea9a4` | plan 003：GTP 启动带 `-model`/`-config`；分析命令非阻塞 |
| `8331860` `749b6fa` `353d34c` `5f5c99b` `9c940cc` | plans/ 规格修订（含 003–009） |
| `a77041a` | plan 004：`GtpSession` 长驻会话内核 |
| `56d8a37` | **UI 修复**：棋盘正方形 + 候选点分色分尺寸 |
| `dc2a2a1` | 补齐 4 个错误码映射臂（解开跨 crate 死锁） |

### 3.2 计划包（`plans/`，14 文件，已纳入版本控制）

- `plans/GTP_LIVE_PROBE_FINDINGS.md` — **本机真实引擎实测规格，权威文档**（见 §5 勘误）
- `plans/README.md` — 索引与执行顺序
- `plans/001`–`009` — 001/002 已实现验证；**003/004/005 已实现**（005 见 §4）；**006/007 未实现**；008/009 未实现
- `plans/KATAGO_LOCAL_ENV.md` — 引擎环境（**已因引擎被删而过时**）
- `plans/VERIFICATION_REPORT.md` `REVIEW_REPORT.md` — 001/002 的验证与审查

### 3.3 未提交（**3 个文件，就是本次交接的"进行中"改动**）

```
 M apps/desktop/src-tauri/src/lib.rs      ← 我补的错误码映射 + 测试断言改为按 -config 定位
 M crates/engine-manager/src/lib.rs       ← ⚠️ 见 §5.1，force pin 视角
 M crates/katago-protocol/src/lib.rs      ← t9 解析器 + 视角转换（rust-parser 交付，未提交）
```

**门禁状态（实测）**：`cargo fmt --all --check` exit 0 · `cargo clippy --workspace --all-targets -- -D warnings` exit 0 · `cargo test --workspace` **316 passed / 0 failed**（基线 269）· `npm run build` exit 0。

---

## 4. 实时复盘的实现进度（核心目标）

```
plan 003 (GTP 启动规格)      ✅ 已实现  97ea9a4
plan 004 (GtpSession 长驻)   ✅ 已实现  a77041a   — 41 个单测 + 4 个真实引擎测试
plan 005 (kata-analyze 解析) ⏳ 已实现未提交  crates/katago-protocol (+888 行)
                              → parse_kata_analyze_line / kata_analyze_line_to_frame
                              → 视角转换：白视角时 winrate→1-w、score→-s、ownership→-o
plan 006 (Tauri 命令+守卫)   ❌ 未实现   t11 已派给 rust-parser（被打断）
plan 007 (前端实时刷新)      ❌ 未实现   t12
验证 (plan 013/015)          ❌ 未做
```

**`GtpSession` 已有 API**（`crates/engine-manager/src/lib.rs`）：
- `start(spec)` / `send_command(&str)`（**只 write+flush，绝不等待 `=`**）
- `send_bare_newline()`（停止 kata-analyze）
- `next_event_timeout(Duration)`（拉取式，非阻塞）
- `close()` / `Drop`（裸换行停止 → 关 stdin → 超时 kill → wait 回收）

**下一步就是 plan 006**：把 `GtpSession` + 解析器接成 Tauri 命令与事件，并实现**陈旧性守卫**（单调递增世代号 + 目标手数，不匹配的 `info` 行丢弃）。

---

## 5. 实测规格与已知陷阱（**必读，前一位 agent 在这里错过多次**）

### 5.1 ⚠️ 视角是最大的坑（会静默翻转胜率，不报错）

`kata-analyze` 的 `winrate`/`scoreMean`/`scoreLead`/`ownership` 是**引擎配置决定的视角**：

- 本机 `gtp.cfg` 的 `reportAnalysisWinratesAs` **被注释掉** → 回落 **SIDETOMOVE**（走棋方视角）
- 而本仓库 DTO 约定是**固定黑视角**（`winrate_black`/`score_mean_black`）

**实测**（9x9，黑占下方 4 行、白占上方 4 行，黑实地大优）：

| 局面 | 无 override | `-override-config reportAnalysisWinratesAs=BLACK` |
|---|---|---|
| 黑走 | 0.996798 | 0.996719 |
| **白走** | **0.995675** | **0.00435403** |

→ 两者精确互补。**不修就会让每个白走局面胜率翻转。**

**关键实测结论**：`kata-analyze` 的 `player` 参数（`kata-analyze black 20`）**压不过** config——它不改变输出视角。**只有 `reportAnalysisWinratesAs` 可靠。**

**正确的双保险**（缺一即错）：
1. 启动时强制 `-override-config reportAnalysisWinratesAs=BLACK`（**前一位 agent 已在 `crates/engine-manager/src/lib.rs` 的 `build_command_spec` 中加入，未提交**）
2. 解析器 `kata_analyze_line_to_frame(..., perspective)` 的实参**必须恒为常量 `Black`**，**绝不能传"轮谁走棋"的 `player` 变量**

> **违反第 2 条的后果**：override 后引擎已报黑视角，若再按走棋方翻折 = **双重转换**。实测白走局 `0.0044 → 1−0.0044 = 0.9956`，**方向全反且不报错不崩溃**。
> **参数名 `source`/`player`/`perspective` 的选择本身就是这个 bug 的温床**——用 `perspective`（"引擎本次输出所用视角"），不要用 `to_play`。

### 5.2 `rootInfo` 是**请求门控**字段（前一位 agent 曾把规格写错）

它**默认不输出**，必须显式请求 `rootInfo true`。实测：

```
kata-analyze interval 20 ownership true            → 含 rootInfo 行 0/19
kata-analyze interval 20 ownership true rootInfo true → 含 rootInfo 行 23/23
   rootInfo visits 1454 winrate 0.066791   ← 根统计
   同行首块  move F7 visits 426            ← 首块是【最佳手】，不是根
```

**禁止用第一个 `info` 块顶替根统计**——那是最佳手统计，会表现为胜率抖动明显、与批处理路径数值不一致（**隐蔽数值偏差，不崩溃，最难排查**）。解析器已加 `RootSource { RootInfo, FirstInfoBlock }` 标记降级。

### 5.3 其他实测事实

| 事实 | 值 | 影响 |
|---|---|---|
| 一行 `info` 块数 | 最多 **41 个**、行长 **10,463 字符** | 必须按 ` info ` 切分；不能用小缓冲 |
| `ownership` | **默认不输出**，须 `ownership true`；在**行尾**，81 浮点(9x9) | 必须在切分 ` info ` **之前**剥离，否则被当成 `pv` 走法；不请求则热图恒空 |
| 数值单位 | **小数 0..1**（`winrate 0.480018`），与 DTO 一致 | **不要 `*100`**（`lz-analyze` 才是 10000 倍整数） |
| `interval` 单位 | 厘秒（20cs≈200ms，实测 8 秒 36 行） | |
| 终止语义 | 裸换行或任意新命令即终止 | |
| **管道批量缓冲** | 8 行握手响应在同一时间戳批量到达 | **禁止 `send` 后同步等 `=`**——等待期间收不到 `info` 流，实时性尽失。发送/读取必须解耦（`GtpSession` 已如此实现） |
| `gtp.cfg` vs `analysis.cfg` | **不可互换**；`gtp` + `analysis.cfg` 会因缺 `logAllGTPCommunication` **直接崩溃** | 实时复盘必须用 GTP 配置 |

### 5.4 Java 侧对照要点

- **候选点分色**：`MoveRankDefinition.java:23` 的 `Rank` 枚举 —— BEST `(0,180,0)` / GOOD `(140,202,34)` / NORMAL `(180,180,0)` / INACCURACY `(200,140,50)` / MISTAKE `(208,16,19)` / BLUNDER `(155,25,150)`，半径系数 0.10→0.19 **随严重度递增**（`BoardRenderer.java:642-643`）。阈值默认 −1/−3/−6/−12/−24 **百分点**（本仓库用 0..1，需 ÷100）。
- **Java 加载后自动分析**（`Config.java:228 public boolean analyse = true`），故空盘立即出点；**Tauri 版必须手点"运行复盘"**——这是体验差距，不是 bug。
- Java 的候选点是 `kata-analyze <player> <interval>` + `ownership true`，且其**六层陈旧性守卫**（`Leelaz.java`：`analysisOutputRoute`/`hasSameOwner`/`isCurrentAnalysisInfoTarget`/`analysisInfoEpoch`/`analysisOutputGeneration`/`runIfCurrentAnalysisOutputRoute`）。本仓库简化场景**需要一层等价物**：单调世代号 + 目标手数。
- Java 源码只读克隆在 **`/tmp/lz-recon/lizzieyzy-next`（实测仍在，只读参考，勿改其文件）**。若被清理，可从 `wimi321/lizzieyzy-next` 重新 clone。
  - 关键文件：`src/main/java/featurecat/lizzie/analysis/Leelaz.java`（~25k 行，引擎/协议/陈旧性守卫）、`analysis/MoveData.java`（`info` 行解析）、`analysis/MoveRankDefinition.java`（分级色表）、`gui/BoardRenderer.java`（候选点绘制）、`gui/WinrateGraph.java`、`analysis/remote/`（智子远程引擎：socket.io WebSocket + `EngineTransport` 抽象，**本仓库未实现**）。

---

## 6. 已修复的 UI 缺陷（前一位 agent 用像素测量完成）

| 缺陷 | 修复前 | 修复后 | commit |
|---|---|---|---|
| 棋盘被压扁成椭圆 | 宽高比 **2.1918**、格距比 0.4569 | **1.0000 / 1.0000** | `56d8a37` |
| 候选点全是同一蓝色 | 蓝 `(74,144,226)` | 绿/橄榄/红（**蓝=0px**） | `56d8a37` |

**根因**（供参考，勿重犯）：`aspect-ratio: 1` 因 `.board-canvas` 同时写死 `width`+`height` 而**被忽略**（过约束）；canvas 又被 `width/height:100%` 拉伸。修法：canvas 按容器**较小边**显式定尺寸，父容器只约束高度。

**测量工具**：`python3 /tmp/measure2.py <截图>`（按行扫描找最长连续木色区段定位棋盘，避免把其他 UI 木色算进去）。**注意 macOS 屏幕录制权限可能仍失效**——用 headless Chrome + CDP 更稳（见 §7）。
---

## 7. 可复用的验证手法（前一位 agent 摸索出的）

**浏览器预览模式（无需引擎、无需 Tauri）**：
```bash
cd apps/desktop && npm run dev          # http://127.0.0.1:1420
```
预览模式有 `buildBrowserAnalysis` 造的假帧，可验证**渲染层**（棋盘几何、候选点分色、图表），但不能验证真实引擎链路。

**headless Chrome + CDP 驱动**（可点击、可读像素、可测量 DOM）：
```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --remote-debugging-port=9335 \
  --remote-allow-origins=* --user-data-dir=/tmp/cdp_prof \
  --window-size=2560,1316 --force-device-scale-factor=2 about:blank
```
- **需要 `--remote-allow-origins=*`**，否则 WebSocket 握手 403
- Python 的 `websocket-client` **只装在 `/opt/homebrew/opt/python@3.9/bin/python3.9`**，系统 `python3` 没有
- 可用 `Runtime.evaluate` 读 `getContext('2d').getImageData()` 做**像素级断言**（前一位 agent 用这招验证候选点分色：统计色系像素数）
- **现成脚本在 `/tmp/`（实测仍在，可直接改用）**：`cdp_run.py`（驱动 UI + 读 DOM 尺寸）、`cdp_colors.py`（候选点颜色分桶统计）、`cdp_verify.py`（分类采样 + 截图）、`cdp_shot.py`、`measure2.py`（像素测量棋盘几何）。注意它们把端口写死，改动前先 `pkill -f remote-debugging-port`。

**真实引擎冒烟**（**需先恢复引擎**）：
```bash
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
python3 scripts/smoke_tauri_katago_live.py \
  --engine <katago> --model <weight> --config <analysis.cfg> \
  --timeout 600 --evidence-out /tmp/smoke.json
```
此脚本会启动真实 Tauri 应用跑完整链路；曾实测 **6/6 通过**（含 `katago_analyze_once`/`katago_analyze_game`/`katago_start_cancel`）。**它需要 `cargo` 在 PATH 上**（否则报 `cargo metadata` 找不到）。

---

## 8. 环境与工具链

```bash
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"   # cargo 不在默认 PATH
cd apps/desktop && npm run tauri:dev        # 开发态启动（较慢，首次编译久）
```
- 桌面快捷方式：`~/Desktop/LizzieYzy Next (开发模式).command`（已创建）
- 应用数据：`~/Library/Application Support/org.lizzieyzy.next/`
- **仓库内没有 `runtime/` 目录** → 界面上"运行时资源: 异常"是**既有噪音**（它检查的是仓库内捆绑资产），与引擎 profile 无关，别被误导

**门禁基线**（改动后必须全绿）：
```bash
cargo fmt --all --check                                   # exit 0
cargo clippy --workspace --all-targets -- -D warnings      # exit 0
cargo test --workspace                                     # 316 passed / 0 failed  ← 基线 269
cd apps/desktop && npm run build                           # exit 0
python3 scripts/validate_scaffold.py --verbose             # 10 passed / 0 failed
```

**已知既有失败（非本次引入）**：`test_smoke_tauri_readboard_live.py` 与 `test_smoke_tauri_runtime_ui.py` 各 1 例，根因是 macOS `/tmp` → `/private/tmp` 符号链接而脱敏函数只特判了 `/var`。设 `TMPDIR=$HOME/.tmp` 可绕开。

---

## 9. 前一位 agent 的流程教训（**给 Codex 的避坑清单**）

这些是真实踩过的，不是理论：

1. **不要引用行号做审查结论**。计划在多次修订后行号必漂移，前一位 agent 因此连续给出过时引用（`plans/005:67`、`:470`、`:495`、`KATAGO_LOCAL_ENV.md:46-49`）。**改用锚点式**（小节标题 / 可 grep 的断言文本）。
2. **"新增公开枚举变体" × "禁止改某文件" 会死锁**。`engine-manager` 新增 4 个 `EngineManagerError` 变体 → 打破 `apps/desktop/src-tauri` 的无通配臂穷尽 match → E0004 → 而计划禁止碰该文件。**凡给 `crates/*` 加公开枚举变体的计划，必须在计划内列出所有下游穷尽匹配点**。
3. **范围判定用 path-scoped 且必须含全部受影响路径**。曾用 `git status --porcelain -- apps/desktop/src`，**该路径不含 `apps/desktop/src-tauri`**，恰好漏掉真正的阻断点。判据应为 `git status --porcelain -- <本任务 inScope 路径>` **且**单独跑 `--workspace` 门禁——两者不可互替。
4. **共享工作树并行会互相污染**。多个成员在同一树改文件时，`cargo test --workspace`、`git status`、grep 计数都会被他人改动影响。前一位 agent 遇到多次误报。**考虑用独立 git worktree 隔离**。
5. **探针之间会互相"证实"错误结论**。前一位 agent 的 `rootInfo` 结论错在"没请求就当成不存在"；成员的 `-override-config` 结论错在"黑走局面 SIDETOMOVE≡BLACK"。**凡结论都做 A/B 受控对照，只差一个变量**。
6. **验证测试必须能证伪**。成员对每个"验证性测试"注入错误确认它真的会失败——有两次发现测试恒真（Tauri 多线程 runtime 下"并发 ticker 仍在推进"式断言在阻塞实现下也通过）。**这是好实践，请保持**。
7. **不要为了刷绿门禁而越界改文件**。成员多次正确地在范围外文件报 BLOCKED 而不越界——前一位 agent 作为 captain 亲自解了死锁。**边界纪律优先于门禁颜色**。

---

## 10. 团队现状（AgentTeams）

团队 `lizzieyzy-analysis-fixes`（6 成员：rust-engineer / ui-engineer / verifier / reviewer / env-engineer / rust-parser），另有 1 个待跑任务：

- `t11` **已派给 rust-parser**（plan 006：Tauri 实时命令 + 陈旧性守卫）— 前一位 agent 刚改派完即被打断，**可能已开始或未开始**
- `t12` 前端实时复盘（plan 007）— 未派
- `t13`/`t14`/`t15` 验证与审查 — 未派
- `t16` 候选点分色 — **实质工作已由前一位 agent 完成并提交（`56d8a37`）**，该任务可关闭

**建议**：接手后先 `agent_teams_status` 看 t11 真实状态，再决定是继续还是重新派工。**不要重建团队。**

---

## 11. 建议的下一步（按优先级）

1. **恢复引擎**（阻塞一切真实验证）。优先重装 Java 版应用取其 bundle；否则 `brew install katago`（≥1.17，配现有 38MB 权重）。
2. **重写引擎 profile**（`~/Library/Application Support/org.lizzieyzy.next/lizzieyzy-next-engine-profile.json`），确认应用能启动引擎并在空盘产出候选点。
3. **提交 §3.3 的 3 个未提交文件**（先 `git diff` 复核；`crates/engine-manager` 的改动含视角 force-pin，是 §5.1 的关键修复）。
4. **实现 plan 006**（t11）：Tauri 命令 + `katago://live-review-frame` 事件 + 陈旧性守卫；`kata-analyze` 必须带 **`ownership true` 与 `rootInfo true`**；`perspective` 实参**恒为 `Black`**。
5. **实现 plan 007**（t12）：前端在 `currentMove` 上挂 `useEffect`（**不要**在 33 处 `setCurrentMove` 逐个插桩），并用 payload 的 `generation`/`turn` 做**双保险**校验。
6. **端到端验收**：真实应用 + 真实引擎，实测①胜率持续刷新收敛 ②快速连切手数不错位 ③热图真的出现 ④退出无残留 katago 进程。

---

## 12. 用户偏好（观察所得）

- 要**中文界面**；已被前一位 agent 中文化。
- **要亲自核实成员的结论**，不采信二手汇报；会要求 agent 也这么做。
- **讨厌被要求授权**（屏幕录制等）——若有变通办法请先用变通办法。
- **崇尚诚实**：未验证就标注未验证；失败要如实报告，不粉饰。
- 偏好**两个独立提交**而非一个混合提交。
- 明确说过"**不满意就直说，不要迎奉**"。
- **最关心的是视觉效果**（"ui 太丑了元素挤在一起"），因此**你的视觉能力正是本次换人补位的关键**。

---

## 13. 前一位 agent 未能验证的项（如实标注，勿当已确认）

移交时**未经验证**的部分，请接手后自行确认：

| 项 | 状态 |
|---|---|
| **实时复盘端到端** | **从未在真实应用里跑通过**。`GtpSession`（plan 004）与解析器（plan 005）各自有真实引擎单测，但**从未接成完整链路**（plan 006/007 未实现）。 |
| **`-override-config` force-pin 的真实效果** | 改动已写入 `crates/engine-manager/src/lib.rs`，单测通过；但**引擎在验证前被删除**，因此"生产启动命令带该 flag 后引擎确实恒报黑视角"**只有探针级证据**（直接对引擎发 `-override-config`），**未通过应用的 `build_command_spec` 全链路验证**。 |
| 解析器的真机端到端 | 成员用真实引擎 stdout 喂生产函数验证过（34 行/25 候选/81 点 ownership），但**不是**通过 Tauri 应用链路。 |
| 热力图是否真的出现在界面 | **未验证**。`ownership` 需显式 `ownership true` 才输出，而该 flag 由 plan 006（未实现）负责发送——**当前界面热图必然为空**。 |
| 陈旧性守卫 | **未实现、未验证**（plan 006 内容）。 |
| 快速连切手数不错位 | **未验证**（依赖守卫）。 |
| 退出无残留引擎进程 | `GtpSession` 的单测覆盖了（4 个真实引擎测试之一），但**未在完整应用退出路径上验证**。 |
| 引擎删除的具体时间与原因 | 实测 14:21 仍可用、14:28 已消失；**原因未知**，废纸篓为空。非本团队所为（团队对该路径只读）。 |
| `plans/GTP_LIVE_PROBE_FINDINGS.md` §5 的探针脚本 | 除被重跑过的几项外，其余**未逐一复跑**。 |
| 团队任务 t11 | 移交时状态 `claimed`、assignee `rust-parser`，**是否已实际开工未知**。 |

**另需注意**：`plans/` 目录的修订在本轮非常频繁（5 个 commit），且发生过**并发编辑**。接手时若发现计划文本与代码实现不一致，**以代码 + 实测为准**，并顺手订正计划——前一位 agent 已因此纠正多处。

