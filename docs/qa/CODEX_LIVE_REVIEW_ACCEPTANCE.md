# 实时分析与热力图独立验收

范围：在现有 Tauri 项目上实现 Java 版的核心复盘流程——当前局面持续分析、候选点、黑方胜率/目差与归属热力图。其他功能不在本轮迁移范围。

DSH 完成主要 Rust/GTP 功能实现；Codex 完成布局、前端实时事件和分支局面接入，复查实现、提供缺陷复现，并运行独立真实引擎与原生 Tauri 验收。DSH 上游额度受限后，Codex 修复最终 GUI 验收发现的让子分支清盘遗漏。下面将自动化证据与桌面目视验收分别记录。

## 当前环境

- macOS arm64，Apple M5 Pro。
- KataGo 1.18.2 Metal：`/opt/homebrew/bin/katago`。
- 权重：`~/.lizzieyzy-dev/models/kata1-tf2-b10c384-s2941M-d5872M.bin.gz`。
- 实时配置：`~/.lizzieyzy-dev/configs/gtp_live.cfg`，`maxTimePondering = 1e20`。
- 应用保存的引擎配置已恢复为有效路径，旧配置有独立备份。
- GTP 启动强制黑视角；分析命令请求 `ownership true rootInfo true`。

## 已完成的独立验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 真实 KataGo 9 路流式输出 | 通过，ownership 81 项 | `codex-live-review-evidence/engine-probe.json` |
| 真实 KataGo 19 路持续刷新 | 通过，9 帧，visits 2→449，ownership 361 项 | `codex-live-review-evidence/engine-stream-19.json` |
| 黑白行棋时统一黑视角、GTP 回应边界 | 通过 | `codex-live-review-evidence/perspective-boundary.json` |
| GtpSession 真实进程生命周期测试 | 4 项通过；流式、同 PID 复用、停止恢复、close 回收 | 显式设置三项 `LIZZIEYZY_KATAGO_*` 环境变量执行 |
| 原生 Tauri IPC 第一轮 | 6/7 通过；发现非法落子未报错 | `codex-live-review-evidence/native-round1.json` |
| 原生 Tauri IPC 第二轮 | 8/8 通过，73 帧，13.208 秒 | `codex-live-review-evidence/native-round2.json` 与 summary |
| 原生 Tauri IPC 第三轮 | 10/10 通过；补充让子和实际示例输出 | `codex-live-review-evidence/native-round3.json` |
| 原生 Tauri IPC 最终第四轮 | **11/11 通过，116 帧，19.057 秒**；补充同尺寸让子分支连续切换 | `codex-live-review-evidence/native-round4.json` |
| 最终 Rust 检查 | fmt、clippy（warnings 为错误）、全工作区 333 tests 通过 | `codex-live-review-evidence/final-rust-tests.log` |
| 最终前端和应用打包 | TypeScript、Vite、`tauri build --debug --bundles app` 通过 | `target/debug/bundle/macos/LizzieYzy Next.app` |

第二轮覆盖：真实运行时和配置、19 路持续收敛、黑白视角、同手数交替贴目无串帧、12 次连续切换取最终目标、摆子与 9→13→9 切盘、非法落子不得继续分析残缺局面、停止安静及重启。

测试入口 `apps/desktop/qa-live-review.html` / `.ts` 独立于生产 App，直接调用真实 Tauri IPC，不能以普通浏览器回退数据通过。报告保存使用既有 `runtime_smoke_report` 环境门禁。

## 验收推动的修正

- 按带编号的 GTP 回应界定新请求，避免把管道中旧输出标成新世代。
- 所有局面准备命令的错误必须报告；不能只检查最后一条 `kata-analyze`。
- 摆子、规则、棋盘尺寸、行棋方及分支走法必须传到引擎。
- 不虚构停着来调整行棋方；显式指定分析方。
- 正式让子使用 `set_free_handicap`，避免丢失让子计分语义。依据：[KataGo 官方 GTP 扩展文档](https://raw.githubusercontent.com/lightvector/KataGo/master/docs/GTP_Extensions.md)。

## 最终桌面验收（2026-09-13）

- 正式打包窗口使用 `tauri://localhost`；打开保存的有效引擎配置后自动进行当前局面分析。19 路示例计算量持续增加，候选点胜率、右侧黑白胜率、目差和图上当前点刷新。
- 设置移入可关闭抽屉；大棋盘位于左侧，胜率图与分析/分支标签位于右侧。小于 760 px 的浏览器窗口改为上下排列，已目视确认没有横向截断。
- 点击归属热力图，蓝色黑方/红色白方及图例显示正确；棋子与候选点保持可见。
- 让子样例通过生产 SGF 源码入口解析。选择第三手 E5，再选择同为第三手的 F5：白棋从 E5 移到 F5，计算量从 2,788 重置到 103 后继续增长，热图随当前分支刷新，无引擎终止。
- 暂停后保留结果并明确显示“分析已暂停”；恢复时建立新分析会话。窗口关闭后的应用及 KataGo 进程回收已经检查。
- 桌面不再自动恢复历史 fake 缓存。走势图只绘制真实收到的局面；没有分析过的手数不补造曲线。

第四轮修复：KataGo 在同尺寸 `boardsize` 后保留棋盘；`set_free_handicap` 前必须先 `clear_board`，否则分支切换报 `Board is not empty`。测试覆盖 E5→F5→E5 三次同手切换，确认让子、后续白棋与行棋方都正确。

## 交付与边界

- 本机可运行应用：`target/debug/bundle/macos/LizzieYzy Next.app`（debug 构建，模型和配置仍使用本机上述路径，未作为跨机器安装包分发）。
- 可见浏览器预览：`http://127.0.0.1:1420/?preview=recorded`。回放的是第三轮真实 KataGo 的 20 帧结果，显式标注回放；浏览器本身不运行引擎，真实分析在桌面应用中进行。
- 当前局面持续分析，不会自动补算整盘的所有历史手数；走势图只呈现已经分析过的局面。
- 根节点让子/摆子、普通走子及 SGF 分支已覆盖。棋谱中途 AB/AW/AE 重新摆子暂不支持实时分析，会明确报错，避免分析错误局面。
- 333 项常规 Rust 测试中，真实引擎环境门禁测试默认会跳过内部执行；真实引擎证据以显式启用的 4 项 GtpSession 测试及上述原生 IPC 报告为准。
- 本轮不扩展对弈平台、棋谱高级编辑等其余 Java 功能。既有入口保留，不将其视为本轮验收承诺。
