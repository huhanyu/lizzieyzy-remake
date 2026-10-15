# 项目代理入口

<!-- project-doc-governance:begin -->
## 文档与决策维护

本项目采用 [文档治理工具包](tools/doc-governance/README.md)。当用户已授权在本项目开展维护时，首次进入或工具包更新后执行 `python3 tools/doc-governance/scripts/install.py --root . --git-hook`，验证本地 skill 和 Git 提交检查的部署；失败要报告，不能声称已生效。只读浏览或审计不要求安装。

文档审计、迁移或有长期取舍的改动，读取 [project-doc-governance](tools/doc-governance/skills/project-doc-governance/SKILL.md)。先检索相关决策，当前行为与理由各归其位，机械改动不新增 Note；提交前运行 `python3 .agents/skills/project-doc-governance/scripts/check_docs.py --root . --managed`。检查通过仍需复核事实、例外和未验证事项。

练习项目的具体行为从相关模块文档下钻；不要把工具包示例当成其他模块的规则。
<!-- project-doc-governance:end -->

## Tauri 项目维护约定

- 本仓库是 Rust/Tauri/React 重制版；开发入口见 [开发说明](docs/DEVELOPMENT.md)，文档归属及使用步骤见 [维护指南](docs/MAINTENANCE.md)。不要套用 Java 仓库的构建命令。
- 开始改动先检查 Git 差异并保留已有工作；按模块检查相关源码、测试、当前文档和决定记录。
- 用户可见行为、接口或重要取舍改变时，同步其主要文档；机械改动无需新建决定记录。结束任务时说明文档已更新或无需更新的原因。
- 带日期的 QA、旧交接和实施总结是当时证据；不能直接转述成当前状态、云端实测结果或已发布状态。当前维护入口为 [docs/README.md](docs/README.md)。
- 实时分析核对本地、SSH、智子云三条路径及 generation/ACK 边界；云端增量同步约束见 [当前说明](docs/engine/cloud-position-sync.md)。
- 改动按影响运行相应 Rust 测试、前端构建或真实环境验证；结构检查通过不能替代行为验证。
