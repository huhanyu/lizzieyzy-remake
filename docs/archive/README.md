# 历史归档与本轮整理记录

归档日期：2026-10-04。这里保存旧交接、计划、QA、研究及治理记录，用于追溯。直接接手开发从 [docs/README](../README.md) 开始。

## 本次清理

原目录有 136 个文件、37 篇 Markdown。移出活动目录的历史 Markdown 共 26 篇；根目录 Markdown 从 14 篇收敛为 8 篇。所有原 Markdown（包括本轮重写文件的旧版）共 37 篇均按原路径、原字节保存在 [压缩归档](2026-10-04-docs-before-cleanup.tar.gz)。删除的普通文件仅 Finder `.DS_Store`。

原始文件逐项路径、SHA-256、处理方式、去向及原因见 [迁移映射](2026-10-04-migration-map.json)。归档 TAR 内的路径和陈述属于旧快照；不得把旧“通过”“未实现”直接当作当前状态，也不要改写归档。

| 原内容（全部章节） | 活动文档去向 | 处理依据 |
|---|---|---|
| HANDOVER_TO_CODEX、CODEX_DSH_DELIVERY、AGENT_EXECUTION_SUMMARY、MIGRATION_PLAN | README + DEVELOPMENT + ARCHITECTURE_NEXT | 清除过期接力安排与阶段状态；完整约束/API历史、失败原因和原计划留在归档 |
| QA_REPORT 及 17 篇 qa 历史总结 | qa/README | 当前结果集中记录；旧日期、测试范围和唯一证据原文归档 |
| LEGACY_PARITY_MATRIX | qa/legacy-parity.md | 仍被检查器读取，字节不变，只更新入口路径 |
| DEVELOPMENT 原长流程、RELEASE_CHECKLIST 原重复 schema | DEVELOPMENT + RELEASE_CHECKLIST | 开发命令与验收清单各归其位；详细 schema 以脚本/测试为执行依据，旧正文完整留存 |
| ARCHITECTURE_NEXT | 同名代码地图 | 加入 GTP/云端、后台补线、人机对弈和五模块入口，保留状态/持久化/外部边界 |
| implementation/human-game、validation/review-modules、research/zhangqi-review-modules | ARCHITECTURE_NEXT 的功能入口与约束 | 按当前源码核对已变更事实；完整研究依据、模型语义、验收缺口留在归档 |
| maintenance/2026-10-04-adoption | 本页 + MAINTENANCE | 使用说明继续维护；安装时的测试记录冻结归档 |
| qa 的非 Markdown 证据、images、validation Java 助手 | 原位置 | 有脚本、图片展示或历史证据依赖，保留字节与哈希 |

一份原文包含多个主题时不逐段删除独有理由；全篇保存在对应 TAR 成员中，活动文档仅承接接手开发所需的当前事实和入口。

## 查看或恢复旧资料

在仓库根目录执行，先解压到单独目录，再选择需要的文件，避免覆盖当前文档：

```sh
tar -tzf docs/archive/2026-10-04-docs-before-cleanup.tar.gz
tar -xOf docs/archive/2026-10-04-docs-before-cleanup.tar.gz docs/HANDOVER_TO_CODEX.md
mkdir -p /tmp/tauri-docs-history
tar -xzf docs/archive/2026-10-04-docs-before-cleanup.tar.gz -C /tmp/tauri-docs-history
```

本机另有清理前完整 docs 备份 `/tmp/tauri-docs-cleanup-20261004/docs-before.tar.gz`；临时目录不作为长期存储保证。仓库内 TAR 是原 Markdown 的长期可恢复副本。旧文中的源码/图片链接按当时仓库相对位置记录，查看时结合保留的工作区资源。

## 引用与验证

调整了根 README、文档导航和工具包入口；脚手架检查改读当前 README/DEVELOPMENT，发布候选检查改读 qa/README，兼容矩阵检查改读 qa/legacy-parity。对应测试 fixture 和 CI 路径一起调整；没有放宽检查规则或修改运行时代码。

归档成员已经逐一与清理前 SHA-256 比对。最终测试、链接与保留文件检查结果见 [qa/README](../qa/README.md)。
