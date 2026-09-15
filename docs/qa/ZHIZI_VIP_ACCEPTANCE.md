# 智子云 VIP 接入验收

状态：代码已集成并构建正式 App；工作区 417 项测试通过，前端生产构建通过。没有真实账号登录或云端分析通过的结论。

## 协议依据

Java `RemoteComputeConfig.DEFAULT_ZHIZI_ARGS` 指定 VIP 共享、TensorRT、28bnbt；`ZhiziApiClient` 实现账号登录与单独获取 Socket.IO 令牌；`ZhiziGtpTransport` 使用 `/socket.io.v4` 的 ready/stdin/stdout/stderr。

Java `Leelaz` 的 `kata-analyze` 指定本次局面执棋方，`MoveData` 保留输出视角，`WebBoardDataCollector` 再按执棋方转为黑方胜率与目差。云端不能直接沿用本地启动时强制 BLACK 的假设。输出视角必须绑定对应任务与局面世代。

## 验收分层

| 检查 | 通过证据要求 | 当前状态 |
| --- | --- | --- |
| 认证与注销 | 令牌不经 IPC；迟到登录不能恢复已注销状态 | 自动测试通过，真实云待测 |
| 传输 | 本机 WebSocket 模拟服务握手、心跳、stdout 分片、关闭 | 6 项本机模拟测试通过 |
| 任务生命周期 | 未登录拒绝；批量互斥；失败释放；断开等待传输退出 | 自动测试通过，真实云待测 |
| 棋局一致性 | 复用本地 SGF 重放与世代过滤；黑白视角转换测试 | 自动测试通过，真实云待测 |
| 界面 | 登录和分配分离；连接/断开正确；无自动云重连 | 正式窗口登录面板可见；连接/断开待真实账号 |
| 真实服务 | 用户在应用内登录后，候选、计算量与热力图更新 | 未测试 |

模拟服务证明协议实现的受测分支，不证明当前供应商部署、会员资格或真实 GPU 输出。构建通过也不代替正式窗口验收。

## 正式窗口观察

已观察到 Tauri 正式窗口的智子云手机号/邮箱、密码、登录、VIP 连接控件；未登录时登录空表单与连接按钮不可用。本地分析计算量从 11,595 增长到 13,647，候选点与胜率正常更新。未输入账号、未连接真实云服务。

## 真实账号接入发现（2026-09-14）

用户已在应用内完成登录。首次运行采样显示云会话分配完成、WebSocket TLS 握手通过，随后等待就绪超时。增加阶段化静态错误后，用户截图明确显示非默认 Socket.IO namespace 被拒绝。

根因：Java IO.socket(URI) 会把 URI path 作为 Socket.IO namespace；初版 Rust 将它覆盖为传输 path，只实现默认 namespace，遗漏该协议行为。修复需保留 namespace，在 connect/event/binary/disconnect 全链路使用，传输 path 独立保持 /socket.io.v4/。模拟默认 namespace 通过不构成真实供应商兼容证明。

另已将停止命令改为异步阻塞任务，避免等待连接生命周期锁阻塞界面。下一次真实账号验收仍需确认候选、ownership、黑白视角和断开释放。

非默认 namespace 修复已完成：URI 解码路径用于 namespace，握手/文本与二进制事件/退出均携带该 namespace；忽略其他 namespace 并吞完其二进制附件。10/10 传输测试通过（包含自定义 namespace 真实本机 WebSocket 流程）。真实供应商复测仍待更新后登录。
