# 文档维护约定

- 从 [README](README.md) 接手；当前行为归模块，开发命令归 DEVELOPMENT，发布步骤归 RELEASE_PROCESS/RELEASE_CHECKLIST，结果归 qa/README。避免重复复制整段清单。
- 长期取舍归 [.agents/notes](../.agents/notes/README.md)；普通修正不新建决定记录。
- 历史交接、阶段总结和重复 QA 正文已进入 [archive](archive/README.md)，不重新放回活动目录。冻结归档不改写，用新的记录补充或替代。
- qa 的 JSON、截图、夹具和 validation 助手仍服务于复核/测试；删除前检查脚本、证据 manifest 和哈希引用。
- 迁移需记录路径/章节去向、备份和引用修复。结构检查通过不能代替事实核对或真实环境验收。
