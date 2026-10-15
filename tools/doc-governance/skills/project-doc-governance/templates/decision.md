# 决策记录模板说明

按项目已有格式调整。下方的括号是填写提示；缺少历史证据时写清未知与查过的来源，不能编造。

## 已实施记录

```markdown
# Agent Note: （具体选择）

Status: implemented

## Problem
（触发条件、受影响的人/系统；脱离方案仍成立的问题。）

## Decision
（已交付的选择、适用条件、主要事实文档链接。）
（补录则写补录日期、最早找到的证据和缺口。）

## Alternatives considered
（真实考虑过或有材料支持的替代路径、优势和未采用理由；未知明确写未知。）

## Consequences
（收益、代价、受影响调用者/文件格式/部署、必要的重访条件。）

## Verification
（实际执行命令、结果、范围及未验证项。）
```

新方案使用 `Status: proposed`，以 `Proposal` 代替 `Decision`，并写 `Acceptance criteria` 和 `Risks`；实施后按真实交付转换。被否方案使用 `Status: rejected — 原因`，保留有价值的提案依据。不要为了演示生命周期给已经完成的改动先补造一个 proposed 文件。
