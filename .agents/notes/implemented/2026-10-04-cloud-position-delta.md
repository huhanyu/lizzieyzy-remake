# Agent Note: 智子云复用已确认局面并保留完整重建回退

Status: implemented

## Problem

云端切换到相邻局面时，每次完整发送设置与全部落子历史会产生随手数增长的命令量。快速切换还需要区分过期目标与已确认的引擎状态，否则旧分析可能被错误归到新局面。

## Decision

对智子云复用已确认、设置兼容的局面，以公共历史前缀作 undo/play；未确认或不相容时完整重建，并保留 generation 与 ACK 边界。具体条件及失败结果以 [当前行为](../../../docs/engine/cloud-position-sync.md) 为准。

本记录于 2026-10-04 补录，日期代表记录创建时间。最早找到的本地依据是 [2026-09-27 QA](../../../docs/qa/CLOUD_POSITION_LATENCY_20260927.md)；本轮核对的是有未提交修改的工作区，而非声称某个发布包已包含此改动。首次提出方案的时间和完整历史讨论未找到。

## Alternatives considered

历史 QA 明确记载了旧方案：每次 boardsize/rules/komi、clear/setup、全历史重放，再分析。它不依赖已确认旧棋盘，但相邻局面切换的重复命令较多。当前源码继续将其用于回退，以及本地和 SSH 路径。没有材料证明其他候选方案曾被历史作者正式讨论，因此不补造方案比较。

## Consequences

相邻局面只发送变化后缀，可减少客户端命令量；同时需要维护同步/待确认状态、协议边界与分支撤销的相容性。任何改变棋盘的控制路径都要使同步记录失效，新增规则或 setup 语义也需要复核复用条件。

该选择不改变 SGF 文件格式；云端 worker 的行为与测试是直接维护对象，本地/SSH 的完整重放仍需保持原语义。若服务端 undo 或分析 ACK 语义变化，或认证环境仍观察到切换慢，应重访复用策略及端到端测量，不能以命令量减少代替延迟证据。

## Verification

2026-10-04：`cargo test -p lizzieyzy-next-desktop live_analysis --lib` 为 16 通过、2 忽略；`cargo test -p zhizi-socketio --lib` 为 12 通过。测试详情及源码链接见 [当前行为的验证段](../../../docs/engine/cloud-position-sync.md)。

历史 QA 的真实引擎对比本轮未重复，认证云端延迟未测；本轮仅补录文档与部署维护流程，没有修改运行时代码或制作发布包。
