# P2 研究效率验收记录

日期：2026-09-14。范围：多棋谱队列、全分支扫描、独立轻量模型补线。仅 KataGo。

## 已实现与源码边界

- `domain/fullGameReview.ts`：主线/全部分支遍历。同手数的兄弟分支保留不同 nodeId。
- `hooks/useFullGameReview.ts`：提供 sgfText 时按 `replaySgfPositionAtNode` 真实重放节点，避免按 turn 错用主线位置；保留 job/generation/turn 回执门控。
- `hooks/useResearchQueue.ts`：冻结提交棋谱和 profile；请求 acquire 停止前景，逐文件串行执行 JSONL 分析，最后 release 恢复。取消必须等待实际终止事件，不因取消请求已发送就释放。
- `api/researchBatch.ts`、`api/researchEvents.ts`：先装完整监听再启动，按实际 job 接受提前到达的终止事件，清理部分安装失败的监听。
- 每份棋谱独立计算缓存键，携 profileId 持久化；不复用 App 当前缓存键。已完成结果先保留，再写磁盘，因此缓存失败仍可导出。
- 队列遇到单文件分析或保存错误停止，不默默略过；前面成功结果仍可导出，界面明确该策略。
- 轻量补线由用户选择独立本地 KataGo profile，固定 32 visits 全主线，完整结果通过当前回调交付；不声称与前景并行占用 GPU。
- `onCurrentResult` 使用 latest.current 回调，避免提交时捕获旧文档回调；App 仍应对实时 documentKey 再校验。

## 自动测试

命令：

```
node --experimental-strip-types --test apps/desktop/tests/researchBatch.test.mjs apps/desktop/tests/fullGameReview.test.mjs
```

11 项通过。包括范围/门控/分支节点、早到回执与异 job 隔离、取消等待确认、串行与逐文档缓存、部分监听失败清理、缓存失败保留导出和恢复前景。

这些测试是传输 mock 和纯逻辑测试，不等同 GUI 交互验收。

## 真实本地 KataGo 协议检查

独立运行两个顺序进程，不操作或重启用户应用、不使用云账号。

- 引擎：`/opt/homebrew/bin/katago`，实际 `version` 为 **v1.18.2，Metal backend**。
- 模型：`/Users/ice/.lizzieyzy-dev/models/kata1-tf2-b10c384-s2941M-d5872M.bin.gz`。
- 临时独立配置：`docs/qa/evidence/p2-research/analysis.cfg`，单分析线程、单搜索线程、BLACK 视角。
- 两份 9 路短 SGF：`a.sgf` 中国规则 7.5 目；`b.sgf` 日本规则 6.5 目。
- 查询分别 id `p2-queue-a`、`p2-queue-b`，analyzeTurns `[0,1,2,3]`，maxVisits 8，ownership/policy 开启。
- 结果：两进程退出码均 0；各 4 帧，共 **8/8** 目标局面；每帧 visits 至少 8，ownership 长度 81、policy 长度 82，winrate 在 0..1。
- 耗时约 0.80 秒、0.97 秒，非性能基准。
- 原始回执、标准错误、摘要均在 `docs/qa/evidence/p2-research/`。

注意：旧 `plans/KATAGO_LOCAL_ENV.md` 关于 b10 模型与 v1.16 不兼容的说明是旧环境结论；本次 v1.18.2 已真实加载并返回以上帧，不修改原历史记录。

## 尚未证明的项目

- 上述真实检查验证独立 KataGo JSONL 协议和本机轻量模型可用性，**未经过 Tauri IPC、GUI 文件选择、GUI 取消或数据库回读**。
- App 研究集成的完整GUI验收仍需执行：运行期间旧菜单/快捷键不可置换任务；更换文档不串谱；暂停/启用状态恢复；异配置结果不当作同 job 损失比较。
- 全分支各节点真实引擎扫描尚未单独进行 GUI 端到端验证；其节点重放与帧门控已代码接线和自动测试。
