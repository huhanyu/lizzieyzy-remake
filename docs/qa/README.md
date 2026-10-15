# 当前验证与开发待办

本页记录 2026-10-04 整理时观察到的状态。Tauri 工作区有未提交实现；保存的旧证据与当前源码不完全同步。KataGo、provider、readboard、认证云端和安装后环境是 external gates，未重跑的验收保持 pending。

## 2026-10-15 安装包更新

HumanSL 40 接入及 0.2.0 发布准备见 [发布 QA](RELEASE_20261015.md)。窗口标题契约和 Windows Actions 版本问题已在本轮修复；下面的 2026-10-04 清单保持历史快照，不代表当前检查结果。

## 2026-10-06 局面训练增量

新增一键提取、按问题段归并与独立续弈。回归、真实远端和原生操作分别见 [本轮 QA](POSITION_TRAINING_20261006.md)。

## 2026-10-05 容错复盘增量

新增 HumanSL 概率损失、全盘扫描与后续分支比较。源码/回归、远端与 GUI 的验证范围分别见 [本轮 QA](TOLERANCE_REVIEW_20261005.md)。以下 2026-10-04 结果仍是整理时快照。

## 接手后可优先处理

| 问题 | 本轮证据 | 下一步 |
|---|---|---|
| 发布标题契约不一致 | `validate_release_assets.py` 要求 `LizzieYzy Next`；当前窗口配置为 `lizze-remake` | 先确定产品命名，再一致地修改配置/检查契约并测试 |
| 旧 UI 文案断言失配 | `smoke_user_flows.py` 为 43 通过、5 失败；整理前已存在 | 逐项判断界面迁移/翻译还是功能回归；不要直接删除断言 |
| 发布 workflow 检查失败 | 新增但原先已有的 `windows-preview.yml` 使用 `actions/checkout@v4`，仓库检查要求 v6+ | 核对整个 workflow 的 Action 版本后维护，避免只改首个报错 |
| 真实环境验收缺口 | 本轮没有启动完整 GUI 流程、认证云端或 HumanSL 模型对局 | 按本次功能范围选择 [发布检查表](../RELEASE_CHECKLIST.md) 场景 |

五项失败是 `sgf_annotation_surface`、`legacy_config_migration_surface`、`runtime_asset_layout_surface`、`legacy_import_capture_helper_surface`、`katago_review_workflow_ux_smoke`，均报告旧组件中缺少特定英文文案。此结果定位检查失配，不能据此断言所有对应功能缺失。

## 验证记录

本轮先记录清理前 smoke 输出，整理后复跑比对，不把文档迁移当成业务修复。最终复核结果：

| 检查 | 结果 |
|---|---|
| 受管文档链接/结构 | 24 篇，0 findings |
| 文档路径相关 Python 测试 | 12 通过（scaffold 2、release candidate 5、legacy parity 5） |
| 脚手架与兼容矩阵 | 分别 10、5 项通过 |
| 前端领域测试 | 87 通过，0 失败/跳过 |
| TypeScript + Vite 生产构建 | 通过；已有大于 500 kB chunk 提示 |
| 保存证据 smoke | 清理前后完整输出逐字节一致：43 通过、5 既有失败 |
| 发布 preflight | 3 通过、1 既有标题契约失败 |
| 发布 workflow | 既有 windows-preview Action 版本失败 |
| 归档与内容保留 | 37 篇 Markdown 归档逐一校验 SHA-256；所有原位保留文件及移动矩阵字节一致 |
| 运行时代码与依赖 | 清理前后哈希一致；没有新增业务修改 |

前一轮相同工作区的实时分析测试为 16 通过、2 环境测试忽略，Socket.IO 为 12 通过；本轮不重复当作新执行结果。

## 证据使用

- [legacy-parity](legacy-parity.md) 是现有脚本读取的范围矩阵，移动时原文不变；其中阶段状态仍须按对应源码和采集日期复核。
- [云端历史 QA](CLOUD_POSITION_LATENCY_20260927.md) 是 [当前云端说明](../engine/cloud-position-sync.md) 的直接历史依据。
- 此目录的 JSON、截图、SGF、受控图片和日志保留原路径及字节，避免破坏脚本或证据哈希。它们不因本轮整理而获得新的验收日期。
- `../validation/` 的 Java 文本助手服务于棋力模型对照，保留原路径；完整对照报告、其他阶段总结及调研在 [历史归档](../archive/README.md)。

新增验收优先更新此页摘要并链接有日期的结果文件；记录具体构建、命令、通过/失败/忽略数量和环境，避免复制大篇幅 schema 到多个文档。
