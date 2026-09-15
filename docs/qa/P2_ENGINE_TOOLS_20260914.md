# P2 引擎资源、SSH 和控制台

## 实现与边界

- 资源管理按状态/安装、流式 IO、硬件检测拆成 `engine_assets.rs`、`engine_asset_io.rs`、`engine_hardware.rs`。只写应用 data 目录下 `managed-engines`，安装版本目录以 UUID 隔离，校验完成后原子 rename。升级保留旧版本。
- 官方引擎目录实时读取 GitHub `lightvector/KataGo` latest release；2026-09-14 实查为 v1.18.2，安装包提供 `digest: sha256:...`。模型来源仅 `media.katagotraining.org/uploaded/networks/models/`；用户填写发布方校验值。macOS 可导入已安装的本地 KataGo，不假装 Linux/Windows ZIP 可在 macOS 运行。
- 下载 4 MB 分段，单请求 15 秒超时，64 KB buffer，SHA-256 流式校验；总量/解压 4 GB 上限，进度最多每 250 ms。取消最迟等待当前请求超时。失败清 staging，可以重新开始；未实现断点续传，不把重新下载说成续传。
- ZIP 禁止路径穿越、符号链接，限制文件数。资源删除持有引擎生命周期互斥：连接或任务未结束时拒绝；任何保存的 profile 仍引用时拒绝。仅删除受管目录。清理只移除非活动 staging，导入也登记活动 lease。
- UI 安装后“使用”复用 `EngineSetupPanel.persistProfiles` 写入选中的引擎/模型路径并保存。不是另建一套配置接口。
- SSH 使用系统 `/usr/bin/ssh`（Windows 使用系统 PATH ssh）、BatchMode、StrictHostKeyChecking、ssh-agent 与系统 SSH 配置。路径逐个 POSIX quoting，不接收密码。远程进程依旧 `GtpSession`，KataGo BLACK 输出契约与本地一致；断开沿用原 owner 关闭协议。
- GTP 控制台仅允许只读查询，禁止 play/clear/quit/set-param 等绕过应用状态的命令。owner 串行暂停确认后执行查询，完整匹配 ID 与空行终止；每次响应限 16 KB，界面最多 30 条。暂停事件带该命令 generation，不能给后来请求误发暂停。

## 已执行验证

- 资产 5 项测试通过：本地 HTTP 小 fixture 真实分段下载与正确/错误 SHA、ZIP 提取/穿越拒绝、取消与目录/URL校验、未知 GPU 工具处理。
- SSH 2 项测试通过：参数/路径注入边界及保留 SSH flags 的模拟 SSH 进程复用 GtpSession。
- GTP 控制台只读白名单、多行 ACK 响应、响应大小上限测试。
- 真实私有 KataGo `real_katago_console_stop_query_resume` 明确用环境路径执行通过：收到分析 → stop ACK → name 与 showboard 多行查询 → 同一进程重新分析收到帧 → 关闭。未连接或打断用户正在操作的应用。
- 官方 GitHub 只读取发布 metadata，未下载任何大型引擎/模型。

## 未验证

- 未提供真实 SSH 服务器；SSH 服务器登录、服务器引擎兼容仍需在实际配置验收。
- 大型官方资源下载/平台包依赖未实际安装；通过小 fixture 验证下载校验/提取路径。
- 全部新入口的正式桌面包视觉交互由主代理统一验收。

来源：
- https://github.com/lightvector/KataGo/releases/latest
- https://api.github.com/repos/lightvector/KataGo/releases/latest
- https://katagotraining.org/networks/
- https://github.com/lightvector/KataGo/blob/master/docs/GTP_Extensions.md
