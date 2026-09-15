# P1 实时引擎控制交付

## 接口与职责

- `live_controls.rs`：参数边界、选点 GTP 后缀、限额判断、匹配命令 ID 的 ACK 确认及暂停事件。
- `live_analysis.rs`：已有 owner 线程调度，依旧单一读取 GTP 流；控制调用通过 channel 交给 owner，Tauri 使用 blocking task 等待，避免阻塞 UI。
- `api/liveControls.ts`：桌面 IPC 与暂停订阅。
- `EngineSearchControls.tsx`：受控设置表单；会话归调用方管理。

`katago_live_review_set_position` 增加可选 `options`：

```ts
{ restriction?: { mode: 'allow' | 'avoid', vertices: string[] }, maxVisits?: number, maxSeconds?: number }
```

限制仅根节点一手，切换位置使用该次请求的 options；未传无约束。先验证，再发送棋局命令。非法坐标、越界坐标、换行注入、0 Visits、非有限秒数拒绝。

`katago_live_review_pause` 返回确认后的新 generation，保留引擎/云租用连接和 job；`katago_live_review_stop` 仍彻底释放连接。暂停保留独占槽，调用方退出任务时必须 stop。

自动限额以本 generation 首次 `kata-analyze` ACK 为起点，时间/总 Visits 任一达到后发送 stop，并等待 ACK。成功发 `katago://live-review-paused {job_id,generation,reason:'limit'}`。停止失败会关闭连接，并发送 ended；不会让 UI 已暂停但后台仍耗算。

`katago_live_review_configure` 接收可选 `numSearchThreads` (1–256)、`analysisWideRootNoise` (0–5)、`playoutDoublingAdvantage` (-3–3)。先暂停，再逐项发送 `kata-set-param` 并等待 ACK；成功后调用方重新 setPosition 恢复分析。云端线程数明确拒绝，其他云参数以服务实际 ACK 为准。中途失败会明确提示可能部分应用，不能报成功。

## 验证

- 6 个控制测试覆盖参数、坐标注入、allow 后缀实际发送、无效选项不改变引擎、错 ID ACK 和旧帧忽略、引擎拒绝，以及并发请求按 generation 顺序入队。
- 13 个现有 live_review 测试通过；含依赖环境的真实引擎测试，未设环境时可跳过，因此不是本次真实引擎验收证据。
- 前端 build 通过。已有 500 KB chunk 提示。
- 私有真实 KataGo 进程：线程/广度/PDA set/get 一致；allow D4 16 帧仅 D4；avoid D4 19 帧不含 D4；两次 stop ACK 后 400ms 无帧；同进程恢复收到 5 帧；退出码 0。详见 `P1_ENGINE_REAL_20260914.json`。
- 云端 allow/avoid、PDA/广度，以及限额的桌面操作尚需验收。

协议依据：KataGo 官方 `docs/GTP_Extensions.md` 的 `allow/avoid ... UNTILDEPTH` 与 `kata-set-param`。https://github.com/lightvector/KataGo/blob/master/docs/GTP_Extensions.md
