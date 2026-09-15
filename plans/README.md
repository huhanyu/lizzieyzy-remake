# 实现计划索引（LizzieYzy Next · 实时复盘分析迁移）

由 improve skill 于 2026-09-12 生成。**基底分支：`upstream/dev`，基准提交 `b7f33a2`。**

## 本轮目标（已与维护者确认）

把 Java/Swing 主线（`wimi321/lizzieyzy-next`，294,016 行 Java）的**实时复盘分析**能力迁移到本 Tauri 仓库，具体三件事：

1. **实时复盘**：长驻 GTP 引擎 + `kata-analyze` 流式输出，胜率随选点/悬停持续刷新（当前 Tauri 完全没有）。
2. **问题手分级对齐 Java**：按 Java 的 `getBlunderColor` 阈值与单位。
3. **主胜率图 + 底部热力概览**：含 Java 的 `swing` 驱动热力条。

**不在本轮范围**：野狐抓谱（provider）、readboard 同步、远程算力（智子）、引擎对弈、AI 老师、打包发布。这些另立计划。

## 背景：Java 侧有两条分析路径，别混淆

| 路径 | 协议 | 用途 | 本仓库现状 |
|---|---|---|---|
| 主引擎 `Leelaz` | `katago gtp` + `kata-analyze` **流式** | 实时复盘：选中某手，胜率持续刷新、思考中分析(ponder) | ❌ 不存在 |
| `AnalysisEngine` | `katago analysis` + **JSONL 批处理** | 全盘闪电分析：一次算完整盘出概览 | ✅ 已实现（`katago_analyze_game` 等） |

本轮做的是**第一条**（流式）。第二条已存在，但存在若干正确性缺陷（见 001）。

## 执行顺序与状态

| Plan | 标题 | 优先级 | 工作量 | 依赖 | 状态 |
|---|---|---|---|---|---|
| 001 | 修正分析查询保真度：视角、让子、规则 | P0 | M | — | DONE |
| 002 | 移除陈旧分析帧回退，避免错位叠加 | P0 | S | — | DONE |
| 003 | GTP 启动规格补全 + 分析命令非阻塞化 | P1 | M | — | TODO |
| 004 | engine-manager 长驻 GTP 会话内核 | P1 | L | 003 | TODO |
| 005 | `kata-analyze` info 行流式解析器 | P1 | M | 004 | TODO |
| 006 | Tauri 实时复盘命令、事件与陈旧性守卫 | P1 | M | 004, 005 | TODO |
| 007 | 前端实时复盘 UX（胜率实时刷新） | P1 | M | 002, 006 | DONE |
| 008 | 问题手阈值对齐 Java + 底部热力概览条 | P2 | M | 001 | TODO |
| 009 | 向分析查询发送 `initialPlayer`（摆子谱走棋方分歧） | P2 | S | 001 | TODO |

**001/002 的执行结果与证据**（2026-09-12 完成）：

- `plans/VERIFICATION_REPORT.md` — 独立验证报告（759 行）。总判定：001/002 **通过验证，无实现缺陷**。
- `plans/REVIEW_REPORT.md` — 技术负责人审查报告（若已生成）。
- **源码落地**：001 的改动提交为 `96132c9`（基于 `b7f33a2`，5 个文件）；002 的改动为 `apps/desktop/src/App.tsx` + `apps/desktop/src/components/AnalysisPanel.tsx`（**尚未提交**，仍在工作树）。
- **修复的实质**：让子/摆子谱此前被按空盘分析。同一让子局面发/不发 `initialStones` 的分析结论**方向性反转**（`winrate` 0.99994 ↔ 0.00321，`scoreLead` +30.76 ↔ −6.94），即修复前是**方向性错误**而非数值偏差。

## 本机 KataGo 环境已就绪（执行 003–008 前必读）

`plans/KATAGO_LOCAL_ENV.md` 记录了**本机已可用**的 KataGo 环境（无需再安装）：

```
引擎: /Applications/LizzieYzy Next.app/Contents/app/engines/katago/macos-arm64/katago   (v1.16.4, Metal)
权重: /Applications/LizzieYzy Next.app/Contents/app/weights/default.bin.gz              (259 MB, model v15)
GTP配置: .../engines/katago/configs/gtp.cfg          ← 实时复盘（003–007）用这个
分析配置: .../engines/katago/configs/analysis.cfg    (reportAnalysisWinratesAs = BLACK，批处理用)
```

**已知坑**（详见该文档）：

1. **不要加 `-quit-without-waiting`** —— 引擎会立即退出、不产出任何结果。
2. **`analysis --help` 退出码非 0**（KataGo 只认 `-help`）—— 不要用退出码判定环境可用性，应实际喂一条 JSONL 看是否产出 `rootInfo`。
3. **`logDir` 是相对路径** —— 在仓库根跑引擎会创建 `./analysis_logs/`；先 `cd /tmp` 或改用 logDir 指向仓库外的配置。
4. **38 MB 轻量权重本机不可用**（model version 17，需引擎 ≥1.17；本机是 v1.16.4，加载即 abort）。只用 bundle 主权重。
5. 该 `.app` 属**另一应用**（Java 版 LizzieYzy Next），仅借用其引擎，**不是本仓库构建产物**，勿修改其文件。
6. **`gtp.cfg` 与 `analysis.cfg` 不可互换** —— `katago gtp -config analysis.cfg` 会因缺 `logAllGTPCommunication` 等键**直接崩溃**。实时复盘（GTP 流式）用 `gtp.cfg`，批处理（`analysis` JSONL）用 `analysis.cfg`。

### 实时复盘（003–007）的实测规格：`plans/GTP_LIVE_PROBE_FINDINGS.md`

captain 在真实引擎上做了 GTP `kata-analyze` 探针，**推翻了 003–007 中若干未经实测的假设**。**凡该文档与计划冲突，以该文档为准**（计划已按它修订）。三条最关键的：

1. **`kata-analyze` 的 `winrate`/`scoreMean`/`scoreLead`/`ownership` 的视角由引擎 `reportAnalysisWinratesAs` 决定**（本机 `gtp.cfg:82` 该键**被注释** → 回落到走棋方视角），而 DTO 约定是**黑视角** → **必须转换**（`w → 1-w`、`score → -score`、`ownership` 整体取反；**必须一起转**）。原 plan 005 对此完全沉默，会产出方向性错误的实现。**已在 plan 005 新增 Step 3b**。
2. **`ownership` 与 `rootInfo` 默认都不输出**，必须显式请求（`kata-analyze ... ownership true rootInfo true`）。漏 `ownership true` → 热图恒空；漏 `rootInfo true` → 根统计静默降级为最佳手统计。
3. **管道存在批量缓冲**：`=` 响应会同一时间戳批量到达 → **禁止 send 后同步阻塞等待响应**，发送与读取必须解耦（已写入 plan 003 Step 1b 与 plan 004 Step 4b）。

> **视角方案的最终裁定（2026-09-13，captain）**：**override 与显式转换两者都做、互补**。
> - plan 003 的 `build_command_spec`（`KataGoGtp` 分支）**必须**附 `-override-config reportAnalysisWinratesAs=BLACK`，让引擎输出确定（恒黑视角），不随用户配置漂移。
> - plan 005 的解析器**仍必须**接受显式 `perspective: PlayerColor` 参数（**参数名是 `perspective`，不是 `to_play`**），把视角当作可审计的契约。
> - **不会双重转换**：override 生效时引擎报黑视角 → 调用方传 `Black` → `flip == false`，原样填充。
> - **⚠️ 唯一危险组合**：「override 在、却传走棋方 `White`」→ 每个白走局面多翻一次（不报错、不崩溃，只是方向全反）。实测：白走局面引擎报 `0.000549`，误翻后成 `0.999451`。**启动参数与 `perspective` 实参必须成对一致**（plan 005 测试 15 锁住）。
> - **务必区分** `player`（轮谁走棋，影响搜索）与 `perspective`（引擎输出视角，影响编码）——不是同一个值。

> **勘误**：该文档原称「`rootInfo` 不存在」**有误**——原探针没请求它。实测请求 `rootInfo true` 后**每行都有**，且首个 `info` 块是**最佳手**（`order 0`）而非根。详见该文档 §3.1。
>
> **勘误**：该文档 §2 原称「不能靠改配置绕过，只能在本仓库侧转换」**已被上述裁定取代**——正确做法是**两者都做**，原结论把"二选一"当成了前提。


状态取值：`TODO` | `IN PROGRESS` | `DONE` | `BLOCKED`（附一行原因） | `REJECTED`（附一行理由）

## 依赖说明

- **003 → 004**：004 需要 003 先建立 `CommandSpec` 能表达 `gtp -model ... -config ...`，否则长驻会话启动的就是一个没有权重的空引擎。
- **004 → 005**：005 的解析器需要一个可注入的读取循环来做单元测试；004 提供该循环的 `LineSink` 抽象。若 004 未完成，005 只能测纯函数，无法测时序。
- **004, 005 → 006**：006 把会话暴露为 Tauri 命令与事件，依赖会话生命周期（004）与协议解析（005）。
- **002, 006 → 007**：007 在 002 修好的帧选取逻辑上接入实时刷新；顺序反了会把错位叠加放大成"实时错位"。
- **001 → 008**：008 的阈值判定建立在正确的视角与单位上。若视角未修正，阈值再对也会把正常手判成失误。
- **005 → 008**：**008 的范围已收窄（2026-09-13 裁定）**——流式（GTP）路径的视角转换归 **005 Step 3b**（显式 `perspective` 入参）；008 只负责**消除对配置文件的隐式依赖**（让帧自带 `to_play`，消费侧可归一化）+ 阈值对齐 + 热力概览条。008 **不要**重复流式转换，也不要重复 plan 003 的 `-override-config` 职责。

**建议执行策略**：001 与 002 可立即并行（互不冲突，都是小范围修正）。003 可与它们并行。004 是最重的一块，建议在 003 合入后单独开工。005/006/007 串行。008 可在 001 合入后随时插入。

## 仓库现状速览（供执行者建立坐标）

- 语言：Rust 2021（MSRV 1.82）+ TypeScript/React 18 + Vite。
- 工作区 12 个 crate，全部是**单文件 lib.rs**（无多模块惯例）。
- 14 个 crate 的 `src/lib.rs` 均为单文件；新增代码应沿用单文件风格，除非单个文件超过约 2,000 行再考虑拆分。
- 现有分析链路：`apps/desktop/src-tauri/src/lib.rs`（7,752 行，48 个 Tauri 命令）→ `crates/engine-manager`（1,445 行）→ `crates/katago-protocol`（545 行）→ `crates/analysis-core`（78 行）。
- **全部 48 个 Tauri 命令都是同步 `fn`，没有任何 `async fn`。**
- 前端无测试框架（无 vitest / playwright），只有 `tsc && vite build`。

## 验证命令基线（已在基准提交上实测）

| 用途 | 命令 | 实测结果 |
|---|---|---|
| Rust 格式 | `cargo fmt --all --check` | 通过 |
| Rust 静态检查 | `cargo clippy --workspace --all-targets -- -D warnings` | 通过 |
| Rust 测试 | `cargo test --workspace` | 通过（全部包） |
| 前端构建 | `cd apps/desktop && npm ci && npm run build` | 通过（205 KB JS） |
| 脚手架校验 | `python3 scripts/validate_scaffold.py --verbose` | 10 passed, 0 failed |
| 发布预检 | `python3 scripts/validate_release_assets.py --verbose` | 4 passed, 0 failed |
| 兼容性台账 | `python3 scripts/validate_legacy_parity.py --verbose` | 5 passed, 0 failed |
| Python 测试 | `python3 -m unittest discover -s tests -p "test_*.py"` | 279 tests，**2 failed（见下）** |

**环境注意（重要）**：

- `cargo` **不在 PATH 上**，需 `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`。
- **本机已安装可用 KataGo**（v1.16.4，见上方「本机 KataGo 环境已就绪」与 `plans/KATAGO_LOCAL_ENV.md`）。需要真实引擎的验证**可以**跑；但单元测试仍应优先用计划中给出的**假引擎脚本**（`/bin/sh` 驱动）以保持可移植，并在报告中如实标注哪些环节用了真实引擎、哪些没有。
- **2 个已知失败**：`tests/test_smoke_tauri_readboard_live.py` 与 `tests/test_smoke_tauri_runtime_ui.py` 各 1 例失败。根因是 macOS 上 `/tmp` 是指向 `/private/tmp` 的符号链接，而脱敏函数（`scripts/smoke_tauri_readboard_live.py:396-399`）只特判了 `/var` 前缀、未特判 `/tmp`。CI 跑在 ubuntu（`runs-on: ubuntu-latest`）上 `/tmp` 是真实目录，因此 CI 不受影响。**这 2 个失败是既有的，与本轮任何计划的改动无关；执行者应把它们视为基线，不得声称是自己引入或已修复。**

## 本次审计中"考虑过但否决"的条目

以下事项经过核查后**不构成需要本轮修复的问题**，记录下来避免重复审计：

- **provider/readboard 无实测**：`docs/ARCHITECTURE_NEXT.md` 已明确记录为"离线契约 + 运行时路径"两级门槛，属**已决定的设计**，不是缺陷。本轮不做。
- **`storage` crate 建了 `game_nodes`/`assets`/`engine_profiles` 表但网关未全部写入**：属提前设计，schema 稳定前不动。本轮不做。
- **同步命令阻塞 IPC 线程**：确认为真实缺陷，**已纳入 003**，故不单列为"考虑否决"。
- **README 引用不存在的 `docs/TROUBLESHOOTING.md`**：文档瑕疵，优先级低于本轮目标，不立计划。
- **`analysis-core` 仅 1 个测试**：覆盖不足，但已在 001/008 的测试计划中一并补足，不单独立项。

## 对执行者的通用要求

1. **不要跨计划改动**。每个计划的 "Out of scope" 是硬边界。
2. **不要修改 `plans/` 之外的文档**，除非该计划的步骤明确要求。
3. **不要推送、不要开 PR**，除非操作者明确指示。
4. 每个计划完成前，逐条核对 "Done criteria"，并把本索引中自己的状态行改为 `DONE`。
5. 遇到 "STOP conditions" 时**停下并报告**，不要即兴发挥。
