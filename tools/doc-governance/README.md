# 项目文档与决策治理工具包

从真实改动练习提炼的 `project-doc-governance` skill：核实当前行为，保留决策原因，审计和迁移文档。安装器只使用本地文件；Python 3.10+，Git 钩子另需 Git。本工具包不依赖 DeepSeek Harness 服务、API Key 或联网安装。

## 先看真实练习

本 Tauri 仓库的实例见 [维护指南](../../docs/MAINTENANCE.md) 和 [归档与清理映射](../../docs/archive/README.md)。工具包原始 Java 练习对 KataGo 目录查找修复核对提交、源码和 65 项测试；该 Java 练习文档未复制到此仓库。`skills/project-doc-governance/references/example.md` 是可随包带走的提炼，测试数字属于该次练习，不是本工具包的通用保证。

## 安装到项目

把完整 `doc-governance/` 放在目标仓库的 `tools/` 中。在目标仓库根目录执行：

```sh
python3 tools/doc-governance/scripts/install.py --root . --git-hook
python3 .agents/skills/project-doc-governance/scripts/check_docs.py --root . --managed
```

安装器复制项目级 skill 到 `.agents/skills/project-doc-governance/`，保留根 `AGENTS.md` 的原内容并维护一个有标记的入口区块，首次安装时创建最小 `.doc-governance.json`。现有清单不改写。清单中的 `documents` 是精确文档路径，`document_roots` 是递归文档目录；把希望纳入自动检查的范围添加进去。

`--git-hook` 安装本仓库的 `pre-commit`，不改变 `core.hooksPath`。已有自定义 hook 或 hooksPath 时拒绝覆盖；可省略该参数安装 skill，再把下面的检查命令整合到原有提交流程。安装器的冲突拒绝发生在文件写入前，但不宣称跨目录安装具备全局事务保证。

```sh
python3 .agents/skills/project-doc-governance/scripts/check_docs.py --root . --staged
```

若还希望 Codex 在其他项目发现该 skill：

```sh
python3 tools/doc-governance/scripts/install.py --root . --git-hook --user-codex
```

它使用 `$CODEX_HOME/skills`，未设置时使用 `~/.codex/skills`。重复安装会核对已安装文件的哈希；发现本地修改就停止并保留文件，不能用重装覆盖手工修改。宿主可能需要刷新技能目录或新开会话；安装成功不等于当前会话已加载。

## 给大模型的使用方式

可以直接这样发任务：

> 使用 $project-doc-governance 审计这次提交的文档一致性。先只报告问题、证据和影响，不修改文件。

> 使用 $project-doc-governance 为这次真实改动补齐当前行为说明和决策记录。历史讨论找不到的地方写明未知，运行相关验证。

> 使用 $project-doc-governance 整理 docs/engine 下的文档。建立旧章节到新位置的映射，保留原有约束和独有理由，修复引用并验证；只迁移这个范围。

未自动发现 skill 的代理可直接阅读 `skills/project-doc-governance/SKILL.md`。普通小改不应触发全仓库审计或创建 Note。复用到其他项目时沿用该项目已有 ADR/文档体系。

## 触发与部署的真实边界

| 时机 | 触发方 | 行为 |
|---|---|---|
| 已授权维护项目，首次进入或包更新 | 读取 AGENTS 的代理 | 调用安装器并检查结果；这属于指令协议 |
| 文档审计、迁移、重要取舍 | 代理的 skill 选择 | 按范围检索、核对和编辑 |
| Git 提交 | 可执行的 pre-commit | 对暂存区中的受管文档运行结构检查 |
| CI | 项目自己的流水线 | 可运行工作区 `--managed` 命令；本包不自动改写 CI |

阅读 README 本身不会执行代码，任意大模型也不保证读取 AGENTS。首次引导需要用户让代理阅读本目录并安装，或用户执行命令；之后入口协议才有机会被宿主加载。DeepSeek Harness 原生 SessionStart/Stop、Claude Code 和 Codex 各自事件钩子没有被本安装器配置，不能把 Git 钩子称为原生会话钩子。

Git 钩子只对本地提交生效，可被 Git 的跳过选项绕过；需要团队强制执行时将同一检查加入必需 CI。未暂存 `.doc-governance.json` 时，`--staged` 检查没有受管清单，输出 `checked: 0`；这不能作为文档验收成功。

## 检查范围和迁移

脚本支持普通 Markdown 内联/图片链接、引用式链接目标、Note 状态及必要小节，并检查已提交归档文件是否在暂存区被修改或删除。代码围栏里的示例不当作文档结构。HTML/wiki/复杂括号链接、标题锚点、网站路由、源代码引用和语义正确性需另行复核；输出 `review` 的事项不使结构检查失败，也不能被忽略成已验证。

`--inventory` 输出 Markdown 路径与 SHA-256，排除构建产物、依赖和符号链接目录。文档迁移由 skill 按 [迁移协议](skills/project-doc-governance/references/migration.md) 执行，脚本不批量移动或删除文档；这避免用文件移动冒充内容迁移验收。此前未验证的自动搬移草稿已替换为该只读检查器。

## 验证安装与卸载

```sh
python3 -m unittest discover -s tools/doc-governance/tests -v
python3 .agents/skills/project-doc-governance/scripts/check_docs.py --root . --managed
```

检查 `.agents/skills/project-doc-governance/SKILL.md` 存在、安装器重复执行显示 unchanged，并在临时仓库做一次有效/无效文档提交，才能确认 hook 的真实触发行为。测试脚本包含这项临时仓库验证，不会给业务仓库创建提交。

卸载时仅删除本工具的安装目录和根 AGENTS 有标记区块；移除 `.doc-governance.json` 前确认没有其他流程使用它。只有 `.git/hooks/pre-commit` 内容仍为本安装器生成版本时才删除该文件；有后续编辑则手工合并。用户级安装需单独删除对应 skill 目录。保留实际文档和决策记录。
