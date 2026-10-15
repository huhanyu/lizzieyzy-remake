# 开发指南

本仓库使用 Tauri 2、Rust、React 和 TypeScript。命令除特别说明外均从仓库根目录执行；本页是开发入口，发布步骤在 [RELEASE_PROCESS](RELEASE_PROCESS.md)。

## 环境与首次启动

需要 Python 3.11+（检查脚本）、Node.js 22+（前端及可剥离 TypeScript 类型的测试运行时）、npm、Rust stable 和对应平台的 Tauri 系统依赖。CI 的工具版本和 Linux 依赖清单见 [tauri-next-ci.yml](../.github/workflows/tauri-next-ci.yml)。Rust manifest 的最低版本声明不等于已验证的完整依赖工具链；当前开发使用 stable。

```sh
python3 --version
node --version
npm --version
cargo --version
cd apps/desktop
npm ci
npm run tauri:dev
```

已有依赖且 lockfile 未变化时可直接启动。`npm ci` 按 lockfile 重装依赖；修改依赖时同步 `package.json` 与 `package-lock.json`。`tauri:dev` 自动启动 Vite 开发服务（127.0.0.1:1420），不要再启动第二份占用该端口。

只调试浏览器界面可在 `apps/desktop` 执行 `npm run dev`；浏览器 fallback 不具备真实引擎、原生文件对话框和 app-data 读写的验收能力。首次运行引擎时在桌面界面配置已有的 KataGo、模型与配置文件，路径不能照抄历史交接。

## 每次改动的检查

先执行结构和文档检查：

```sh
python3 scripts/validate_scaffold.py --verbose
python3 .agents/skills/project-doc-governance/scripts/check_docs.py --root . --managed
```

根据改动选择相关测试：

| 改动 | 检查命令（根目录） |
|---|---|
| 文档路径/校验脚本 | `python3 -m unittest discover -s tests -p 'test_validate_scaffold.py'`；另跑改动脚本对应的测试 |
| SGF 与临时试下 | `cargo test -p sgf --lib` |
| 引擎会话与批量分析 | `cargo test -p engine-manager --lib` |
| 实时分析与云端同步 | `cargo test -p lizzieyzy-next-desktop live_analysis --lib`、`cargo test -p zhizi-socketio --lib` |
| 局面训练 | `cargo test -p sgf --test training_prefix`、`node --experimental-strip-types --test apps/desktop/tests/trainingEpisodes.test.ts`，后端同下列容错测试 |
| HumanSL 容错复盘 | `cargo test -p analysis-core tolerance --lib`、`cargo test -p lizzieyzy-next-desktop tolerance_review --lib`、`node --experimental-strip-types --test apps/desktop/tests/toleranceReview.test.mjs` |
| HumanSL 40 棋力测评 | `cargo test -p lizzieyzy-next-desktop strength_policy --lib`、`node --experimental-strip-types --test apps/desktop/tests/humanStrength*.test.mjs`；协议与私密夹具入口见 [模块说明](engine/humansl40-strength.md) |
| TypeScript 领域逻辑 | `node --experimental-strip-types --test apps/desktop/tests/*.test.mjs apps/desktop/tests/*.test.ts apps/desktop/tests/*.test.cjs` |
| React/TypeScript 界面 | `npm --prefix apps/desktop run build`，并在原生窗口验证受影响交互 |

前端测试从**根目录**运行，部分测试使用根目录相对路径。当前 package 没有 `npm test` 脚本。单元测试通过后不要把被忽略的真实引擎测试算入通过数。

跨模块 Rust 改动及合并前按现有 CI 运行：

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

这些是检查，不要为清理文档顺手格式化整个工作区。若既有修改导致失败，报告具体位置并区分本次回归。

## 验证真实功能

最短桌面链路：打开 SGF → 主线/分支切换 → 编辑注释或新增分支 → 保存并重启打开 → 配置引擎 → 实时分析持续刷新 → 快速换局面不接收旧帧 → 暂停/恢复 → 全盘分析取消后能再次启动。按修改范围加测摆子、让子、贴目、试下滚轮/滑条、背景补线或人机对弈。

[`smoke_user_flows.py`](../scripts/smoke_user_flows.py) 复核代码表面和已保存证据；运行它不会重新执行全部桌面操作。需要真实 KataGo、provider、readboard 或云端环境的脚本由 `scripts/smoke_*.py --help` 查询参数，使用受控测试文件，并记录工具版本、构建、配置和是否访问真实服务。

## 接手时先看

[代码地图](ARCHITECTURE_NEXT.md) 给出模块入口；[QA 状态](qa/README.md) 列出本次观察到的失败；[排查入口](TROUBLESHOOTING.md) 说明定位方法。不要从旧 QA 的通过数推导当前构建可发布。

## 容错复盘远端验收

先检查远端资源及模型路径。将 `ReviewConfig` JSON 保存在仓库外，使用 `TOLERANCE_REMOTE_CONFIG`、`TOLERANCE_REMOTE_SGF`、`TOLERANCE_REMOTE_OUTPUT` 指定配置、棋谱和证据目录，再执行：

```sh
cargo test -p lizzieyzy-next-desktop tolerance_review::tests::remote_acceptance --lib -- --ignored --nocapture
```

默认检查第 139 手前当前局面；`TOLERANCE_REMOTE_TURN` 是已落子数，`TOLERANCE_REMOTE_MODE` 可设 `position`、`scan`、`compare`。测试要求来源为 SSH，不会回退本地引擎，并检查缓存重跑和运行中取消后的退出确认。SSH supervisor 的纯测试进程回收可执行 `python3 -m unittest discover -s tests -p test_tolerance_supervisor.py`。正常单元测试将它标为 ignored；显式运行结果单独记录。配置字段与限制见 [模块说明](engine/tolerance-review.md)。

局面训练远端单手验收沿用同一组外部配置环境变量，执行 `cargo test -p lizzieyzy-next-desktop tolerance_review::tests::remote_training_move_acceptance --lib -- --ignored --nocapture`；`TOLERANCE_REMOTE_TURN` 默认 130。它核对独立副本、应手合法性和退出确认；不替代原生导入、提取、走子及返回原谱验收。全盘测试的 `TOLERANCE_REMOTE_MODE` 也支持 `training`。当前行为见 [局面训练](engine/position-training.md)。
