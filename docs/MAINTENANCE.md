# 如何维护这个项目

这套流程已接入 Tauri 仓库。项目入口是 [AGENTS.md](../AGENTS.md)，skill 源文件和安装器放在 [tools/doc-governance](../tools/doc-governance/README.md)，安装后的项目 skill 位于 `.agents/skills/project-doc-governance/`。

## 日常使用

在本项目对话里可以直接说：

> 使用 $project-doc-governance 审计本次改动的文档一致性，先报告问题、证据和影响，不修改文件。

> 修复这个问题，并按项目维护规范同步相关文档；有长期取舍再记录决定，运行相关验证。

> 使用 $project-doc-governance 整理实时分析文档，先建立旧章节到新位置的映射，再迁移和验证，不改动其他模块。

模型不识别技能名时，让它读取 `AGENTS.md` 和 `tools/doc-governance/skills/project-doc-governance/SKILL.md`。Codex 会话若未刷新技能目录，可以新开本仓库对话或直接使用路径。仅复制本指南不会产生自动执行。

每次任务遵循：查看已有差异 → 检索相关文档和决定 → 修改实现及其主要说明 → 运行相关行为验证和文档检查 → 报告结果及未验证项。小修不强制新建 Note。

## 文件放在哪里

| 内容 | 位置 |
|---|---|
| 简短执行规则 | 根 `AGENTS.md`；文档规则为 `docs/AGENTS.md` |
| 当前行为和约束 | `docs/` 对应模块；例如 [云端局面同步](engine/cloud-position-sync.md) |
| 为什么作此选择、代价与重访条件 | `.agents/notes/implemented/`，见 [实际示例](../.agents/notes/implemented/2026-10-04-cloud-position-delta.md) |
| 尚未实施的方案 | `.agents/notes/proposed/`，不要把测试计划写成结果 |
| 历史测试与事故证据 | 现有 `docs/qa/`、`docs/validation/`；保留日期与范围 |

## 安装与检查

当前 checkout 已安装本地 `pre-commit`。新克隆或工具包更新后，在仓库根目录执行：

```sh
python3 tools/doc-governance/scripts/install.py --root . --git-hook
python3 .agents/skills/project-doc-governance/scripts/check_docs.py --root . --managed
```

重复安装会检查已安装 skill 的哈希，保留本地修改；已有第三方 Git hook 或 `core.hooksPath` 会停止安装，由维护者合并检查入口。不要直接编辑生成的 `.agents/skills/`：修改 `tools/doc-governance/skills/` 后运行安装器。

`.doc-governance.json` 定义受管范围；本轮纳入当前文档、工具包、云端当前说明与决定目录，未把全部历史文档视为已审计。添加新的当前文档时更新该清单，或把模块目录加入 `document_roots`。

提交时 hook 检查**暂存区**受管文档的链接、决定状态和必要结构；归档内容的暂存修改/删除也受检查。首次提交必须包含清单、工具包、安装后的 skill 和被引用的新增文档，否则可能出现 `checked: 0` 或断链。本次部署不替你暂存或提交现有工作。

```sh
python3 .agents/skills/project-doc-governance/scripts/check_docs.py --root . --staged
python3 -m unittest discover -s tools/doc-governance/tests -v
```

仓库新增 `.github/workflows/doc-governance.yml`，在 push / pull request 中运行检查与工具包测试。该文件提交并推送后才会在 GitHub 执行；若要强制合并通过，还需在仓库规则中设为必需检查。当前部署未改远端设置。

## 自动化能做什么

| 触发点 | 实际行为 |
|---|---|
| 模型读取 AGENTS 且用户授权维护 | 按入口协议检查部署，检索并维护相关文档 |
| 本地 `git commit` | 可执行 pre-commit 检查暂存区；可被 Git 跳过参数绕过 |
| 推送后的 GitHub CI | 对受管文档和工具包运行检查；当前仅配置已写入本地 |

没有配置 Codex、Claude Code 或 DeepSeek Harness 的原生 SessionStart/Stop 钩子。AGENTS 是模型执行协议，不能保证任意模型一定加载；Git hook 是真实本地触发器。检查器只验证结构，事实、历史理由、标题锚点及真实云端行为仍需复核。

本项目的旧部署记录及本轮清理映射见 [整理记录与旧资料](archive/README.md)。工具包内的 Java 练习只是来源案例，其中测试数字不属于本项目。
