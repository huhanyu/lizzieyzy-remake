# 方法依据及适配

核验日期：2026-10-04。DSH 源码快照：`5badb15009ae1756c3afe0ae0cef1faafc290ccc`。这些是提炼依据，目标项目的用户指令与现有约定优先；使用本 skill 不要求安装 DSH。

| 原则 | 应对的问题 | 本 skill 如何执行 |
|---|---|---|
| 当前事实与选择理由分开 | 历史叙事遮蔽当前行为 | 为事实找维护位置，为长期取舍找 Note |
| 先检索再改变 | 新会话重走被否路线 | 按模块/机制检索，按需读具体笔记 |
| 规则短且有详情入口 | 根指令膨胀且互相矛盾 | 全局只留常用约束，模块细节下放 |
| 更新与替代有区别 | 旧记录被改成相反结论 | 事实更新就地做，决定逆转另建记录 |
| 结构检查与语义评审分工 | 模板齐全却内容虚假 | 脚本查确定结构，人/代理判断真实理由 |
| 验证与影响对应 | 单测通过被扩成发布成功 | 标记验证范围，保留未覆盖事项 |

## 来源

- [DSH 文档规范](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/AGENTS.md)：内容分工与主要维护位置。
- [DSH Agent Notes](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/.agents/notes/README.md)：创建条件和生命周期。
- [DSH 已实施笔记](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/.agents/notes/implemented/AGENTS.md)：事实更新与决定逆转的区别。
- [DSH 检查选择](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/.agents/skills/dsh-pre-push-checks/SKILL.md)：按受影响行为选择证据。
- 用户提供的 [维护分析](https://linux.do/t/topic/2904342) 与 [社区工具介绍](https://linux.do/t/topic/2874256) 用于理解动机；实际规则以上游和目标仓库为准。
- [社区 skill](https://github.com/czm15053/write-notes-like-deepseek/blob/main/SKILL.md) 用于对照可迁移工作流；未直接复制其实现。

## 有意不照搬的要求

不统一要求先提案再等待确认：已有用户授权可继续，补录已实施改动也不伪造提案。不中断普通修复来写无长期价值的笔记。不要求固定数量的备选方案。不强制全仓库双语、DSH 的六类目录和固定字数上限；这些依目标项目而定。不把“历史词”扫描当作正确性判断，也不对日期较老的文档自动归档。
