---
name: project-doc-governance
description: Audit and migrate project documentation, record durable engineering decisions from real changes, and keep current behavior separate from rationale and historical evidence. Use for documentation governance, decision backfills, document restructuring, and code-to-document consistency reviews; ordinary prose edits and mechanical code changes do not require new decision records.
---

# Project documentation governance

遵守用户范围和项目已有规范。先查清证据和文档归属，再决定是否修改；审计请求默认只报告。不要为了套目录重排全仓库，也不要把读取文档当作安装或执行任意命令的授权。

## 入口与模式

1. 确认仓库、适用的 `AGENTS.md`、当前差异和目标提交/模块；保护已有修改。缺少明确范围时选与用户目标直接相关的最小范围，说明选择。
2. 按模块名、方法名、配置项查找已有 docs、ADR/notes、测试、生成源和翻译。先查事实，不把能检索的问题抛回用户。
3. 选择模式：**audit** 输出证据与缺口；**record** 补齐真实改动的当前行为及决策；**migrate** 按 [迁移协议](references/migration.md) 处理已授权的文档重组。方法依据与适配取舍见 [方法说明](references/methodology.md)。

## 文档归属

根/子目录 AGENTS 保存短规则；当前行为归模块 README 或 docs；操作步骤归 cookbook；原因、真实备选、代价归决定记录；事故经过归 postmortem。现有 `docs/adr` 等体系有清晰职责就沿用，不强制改名。每个事实选一个主要维护位置，其他入口链接过去；局部调用者需要的关键条件仍应在使用处说明。

## 记录真实改动

- 先问是否有代码、测试和现有文档解释不了的长期取舍。机械修改不新建 Note；已有归属能承接就更新。
- 未落地用 proposed；已在源码实现可直接用 implemented，并区分源码、运行验证和发布状态。补录要注明补录日期、最早找到的证据日期、来源和缺口，不能假造预先提案。
- 当前行为逐项核对代码、测试和配置；命令是否可执行要实跑。保留主体、条件、顺序、例外、负面保证和失败结果。文件名或提交标题不能替代行为证据。
- Alternatives 只记录真实材料支持的候选。历史材料缺失就明确未知；本次复核考虑的替代方案单独标注，不冒充历史讨论，也不凑固定数量。
- Consequences 同时写收益、代价、受影响调用者/格式/部署流程及必要的重访条件。验证写实际命令、结果及范围；未运行的项目清楚列为未验证。
- implemented 原地更新路径、名称等实现事实；核心决定逆转需新记录和关系链接。归档记录保持冻结且不充当当前规范，部分被替代的理由继续保留。

需要结构时使用 [Note 模板](templates/decision.md)。阅读 [实练提炼](references/example.md) 了解“概括过强”“历史未知”“测试通过但未发布”的处理方式。

## 审计与验证

报告每项问题的路径、具体证据、影响、建议和验证方式。区分断链等确定问题与疑似过时等待复核判断；不按关键词直接删句。

随附脚本仅检查 Markdown 文件链接、Note 状态与必要结构，可作为文档检查的一部分：

```sh
python3 <skill目录>/scripts/check_docs.py --root <仓库> --files <相对文档路径> ...
```

项目若配置 `.doc-governance.json`，可用 `--managed` 检查选定文档；Git 提交检查用 `--staged`，读取暂存区而非工作区。脚本不会安装依赖、改写文档或验证实际运行行为。链接锚点、生成文档、新增源代码引用、翻译语义和历史理由仍要人工/代理复核；没有问题的结构报告不能称为完整语义审计通过。

按改动选最小相关行为检查，不重复通过的测试。报告最终改动、保留项、未验证项和实际检查结果。迁移若有未映射内容或失去依据的断言，不宣称完成。
