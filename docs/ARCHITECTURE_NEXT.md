# 架构与代码地图

当前工作区是 Tauri 2 + Rust + React/TypeScript 应用。2026-10-04 按源码入口重整；表中表示实现位置，不能单凭文件存在推导完整功能验收。

## 数据流与职责

界面组件 → `src/hooks` 会话/交互逻辑 → `src/api` Tauri 包装 → Rust commands → 领域 crate 或引擎 transport → DTO/事件 → 界面。原生文件、进程、网络和持久化由 Rust 管理；前端消费归一化数据，不自己解析 GTP。

| 功能 | 前端入口（apps/desktop/src） | Rust 入口 |
|---|---|---|
| 工作区、棋盘、树 | `components/LegacyShell.tsx`、`BoardCanvas.tsx`、`SgfNodeGraph.tsx` | `src-tauri/src/lib.rs`、`crates/sgf`、`crates/go-core` |
| 实时分析/热图 | `api/backend.ts`、`domain/reviewFrames.ts`、`domain/analysisPolicy.ts` | `src-tauri/src/live_analysis.rs`、`live_transport.rs`、`crates/katago-protocol` |
| 本地/SSH/智子云 | `hooks/useCloudCompute.ts`、`api/remoteGame.ts`、引擎配置组件 | `live_transport.rs`、`remote_engine.rs`、`zhizi.rs`、`crates/zhizi-socketio` |
| 全盘分析/任务队列 | `hooks/useFullGameReview.ts`、`useResearchQueue.ts` | `lib.rs`、`crates/engine-manager` |
| 后台 1v 补线 | `hooks/useBackgroundCurve.ts` | `background_curve.rs`（独立本地 worker） |
| 临时试下/编辑历史 | `hooks/useTryPlay.ts`、`useSgfHistory.ts` | `try_play.rs`、`crates/sgf` |
| 人机对弈 | `hooks/useHumanGame.ts`、`domain/humanGame.ts`、`api/remoteGame.ts` | `human_game.rs`；远端复用实时会话 |
| 局面训练与容错复盘 | `hooks/useToleranceReview.ts`、`components/ToleranceReviewPanel.tsx`、`domain/tolerance/` | `src-tauri/src/tolerance_review/`、`crates/analysis-core/src/tolerance.rs` |
| 常规复盘模块/棋力模型 | `components/AnalysisModules.tsx`、`components/review/`、`domain/strength/`、`domain/reviewStatistics.ts` | 前端本地模型计算，模型资源在 `apps/desktop/public/models/` |
| 一键设置/下载/性能测试 | `hooks/useOneClickSetup.ts`、`components/setup/` | `setup_apply.rs`、`engine_assets.rs`、`engine_benchmark.rs` 等 |
| 在线棋谱 | `api/onlineKifu.ts`、`components/OnlineKifuImport.tsx` | `online_kifu.rs`、`crates/provider-*` |
| readboard | `api/backend.ts` | `lib.rs`、`crates/readboard-sidecar` |
| DTO/缓存/设置 | `domain/types.ts`、API 包装 | `crates/app-model`、`crates/storage`、`lib.rs` |

Rust 应用入口均相对 `apps/desktop/`，`crates/*` 相对仓库根。具体 commands 注册从 [lib.rs](../apps/desktop/src-tauri/src/lib.rs) 下钻；不要把表中的文件名当作完整 API 契约。

## 分析路径与状态边界

实时复盘使用持续 GTP 会话，批量分析使用 KataGo analysis JSONL。transport 区分本地进程、SSH 和智子云；云端增量同步的全部适用条件、ACK 和错误处理见 [专页](engine/cloud-position-sync.md)。改变其中一条路径时，不能假设其他路径具有相同的启动参数或视角约定。

结果必须匹配当前任务、文档/节点与 generation；发送新目标不等于引擎确认目标。保留带 ID 的 ACK 边界和准备命令错误处理，错误局面不能继续发布分析。摆子与让子保留初始棋盘语义，不能用虚构 pass 修补执棋方。

后台补线使用独立本地 registry 和私有配置，1v 数据用于覆盖走势，不代表深度分析质量；不要改写用户保存的引擎配置。取消、关闭、换局面要清理相应任务；改会话控制时检查前台、后台和人机对弈各自的 ownership。

HumanSL 容错任务使用独立 analysis JSONL 与结果格式，复用 Batch 独占槽；SSH 人类模型能力与现有实时路径分开验证。训练起点归并和独立续弈见 [局面训练](engine/position-training.md)；概率、后续分支、退出确认与缓存边界见 [容错复盘](engine/tolerance-review.md)。

## SGF、人机对弈与复盘统计

SGF 编辑应保留分支、节点属性、注释和摆子；原生保存后需要重新打开验证，不仅检查文本可解析。临时试下有独立游标和历史，不能把试下导航混进原棋谱主线。

人机对弈的本地路径使用独立分析查询，远端路径复用实时会话；`useHumanGame.ts` 对会话、generation 和 request 做过期防护。普通选点取 `order=0`，HumanSL 从 `humanPolicy` 采样，缺失策略时报错；当前前端明确限制 HumanSL 使用本地模型。远端接线已经存在，旧实施文档“远端尚未接入”不能继续当作当前事实；真实远端/HumanSL 对局仍要按实际环境验收。

棋力模型保留 Java full29 特征和 20 个选择索引，模型阶段边界为 60/160；模型好手率使用 loss < 1.2，不能替换成展示质量档位。缺失或不同任务/文档/分支的数据不能拼出虚假统计，覆盖率须使用有效样本分母。原始调研和 Java 对照的完整依据保存在 [历史归档](archive/README.md)，模型测试在 `apps/desktop/tests/strength.test.mjs`。

## 外部集成与持久化

provider/readboard 的命令、解析器和受控夹具测试，与真实服务登录、外部客户端捕获、任意截图 OCR 是不同验证范围。改动时检查相应 Rust crate、Tauri command 和前端 wrapper，错误应清晰且不得返回过期成功数据。

引擎配置和缓存由 app-data 管理，缓存与 SGF/配置关联；数据库格式或配置迁移要检查旧数据和失败恢复。用户私有路径、凭据和临时文件不写进共享文档。版本、签名与安装包验证见 [发布检查](RELEASE_CHECKLIST.md)。
