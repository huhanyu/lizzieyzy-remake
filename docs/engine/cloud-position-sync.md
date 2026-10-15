# 智子云局面同步：当前行为

2026-10-04 按当前工作区源码核对。实现入口为 [live_analysis.rs](../../apps/desktop/src-tauri/src/live_analysis.rs) 的 `run_live_review` 与 `apply_cloud_position_delta`；网络收发见 [zhizi-socketio](../../crates/zhizi-socketio/src/lib.rs)。选择原因见 [决定记录](../../.agents/notes/implemented/2026-10-04-cloud-position-delta.md)。

## 复用条件与命令

仅智子云路径尝试增量。本地及 SSH 路径仍调用完整重放逻辑。旧局面必须已收到分析命令的成功 ACK；棋盘尺寸、setup、规则、贴目、让子数必须与新请求一致。旧、新局面还都必须通过行棋方与末手历史相容检查：有末手且显式指定 player 时，player 不能与末手同色。

通过检查后，取颜色/坐标对的最长公共前缀，发送 `stop`，撤销旧分支后缀，落入新分支后缀，再发 `kata-analyze`。若需撤销的手数大于 `新局面总手数 + 4`，直接完整重建；旧局面尚未确认或上述条件不满足时也完整重建。

## 过期请求、确认与错误

出队的 generation 若不是当前值则跳过。发送前取走已确认旧局面，新的目标进入 pending；只有分析命令对应的成功 ACK 才将 pending 升为已同步局面。命令 ID 单调递增，前序输出不能靠旧 ACK 打开新局面的结果流。

请求范围内任何命令返回错误都会关闭连接并报告结束，不把失败目标标为可分析。分析行还要通过 generation、目标手数和 stream-ready 条件。暂停、参数配置及控制台命令会清除同步记录，后续不能假定棋盘可直接复用。

Socket worker 每次至多排出 512 条待发送命令，然后处理读取；读取 tick 为 20 ms。这是队列与等待行为，不是经过认证云端测得的延迟数字。

## 验证

2026-10-04 执行：

- `cargo test -p lizzieyzy-next-desktop live_analysis --lib`：16 通过，2 忽略（显式本地引擎环境测试），181 过滤；其中两项 delta 测试覆盖前进、后退、分支，以及贴目变化/未确认旧局面时完整重建。
- `cargo test -p zhizi-socketio --lib`：12 通过，含 mock WebSocket、队列及超时行为。

[2026-09-27 历史 QA](../qa/CLOUD_POSITION_LATENCY_20260927.md) 记录过真实本地引擎的 delta/full `showboard` 对比；本轮未重跑该环境测试，也未测量认证云端切换前后延迟，未重新构建或发布应用。上述条件中尚未被这两项 delta 测试单独覆盖的分支以源码核对为证据，不声称全路径测试。
