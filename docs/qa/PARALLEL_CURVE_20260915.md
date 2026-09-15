# 并行补线与远程配置 — 2026-09-15

## 实现

- 独立 CurveRegistry 与本地 analysis 子进程，复用既有批量 runner、事件监听及退出回收；不停止、重连或切换实时 GTP/云会话。
- 后台每局面 maxVisits=1，1 个分析线程和搜索线程，batch size=1，关闭 policy/ownership 输出；完成或取消后 runner 回收子进程，再释放任务槽。
- 临时配置剔除两种互斥线程键，保留单一 numSearchThreads；不改原配置，结束删除临时文件。修复测速生成配置同时写两种线程键的问题。
- 默认优先 one-click-quick；也可从研究队列显式选择本地配置后台补线。未安装 quick 时沿用已选择的本地模型，以单线程 1v 运行；大模型仍可能占较多内存。
- 曲线帧独立存储，仅合入走势图，实时帧优先；不覆盖候选点、当前局面指标或实时会话。切换/编辑棋谱取消旧任务，过期结果不写入。
- 远程连接不触发自动全盘分析。完整分析保留手动入口；本地自动 1v 开关默认关闭。
- SSH 使用指定服务端 -config；只保留 BLACK 输出视角适配，不注入本地线程/Apple 调优参数。云和 SSH 在后端拒绝运行参数 Configure，界面显示服务端配置并禁用线程/广度/PDA 应用。
- 本地、SSH、云的搜索限额与选点范围状态分开。

## Java 对照

next-2026-09-13.2 的 KataGoRuntimeHelper 中 applyEntryLaunchPolicy 与 Apple 调优入口均对 EngineThreadPolicy.isRemoteManaged 提前返回原命令。发布说明也明确远程沿用服务端配置：
https://github.com/wimi321/lizzieyzy-next/releases/tag/next-2026-09-13.2

## 验证

- 前端 72 通过。
- Rust 190 通过、2 个依赖环境测试默认忽略。其中新增真实引擎测试已通过显式 --ignored 单独运行。
- 实际 KataGo 双进程：5 个局面 1v，后台运行期间前台收到 22 帧；后台 runner 完成并回收后，前台仍成功应答 name 命令。真实测试约 3.12 秒。
- 单元测试覆盖独立任务取消不影响前台、同一时间只允许一个补线任务、线程键去重、SSH 命令不注入本地调优、远程禁止自动扫描。
- 原生 UI 首轮发现线程别名冲突，已修复并由上述真实测试验证。后续 GUI 操作被外部窗口/棋谱切换打断，因此未宣称最终 GUI 全流程或智子云＋补线组合完成了真人操作验收。
- 正式 app 已重新构建；没有替换 /Applications 或强制重启用户当前窗口。

证据：evidence/parallel-curve/。
