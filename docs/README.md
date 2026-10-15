# 开发接手入口

这是 LizzieYzy 的 Tauri 2 / Rust / React / TypeScript 重制仓库。先读本页和开发指南，再按要改的模块下钻；无需通读历史交接。源码、工作区修改和本次实测决定当前状态，历史报告只用于追溯。

## 开始工作

1. 阅读根 [AGENTS.md](../AGENTS.md)，执行 `git status --short`，保护现有未提交修改。运行时代码目前有大量开发中修改，不能用 HEAD 单独代表当前应用。
2. 按 [开发指南](DEVELOPMENT.md) 检查工具链、启动桌面端并运行相应检查。浏览器预览只能做前端开发，真实引擎、原生文件和持久化验证使用 Tauri 桌面端。
3. 在 [架构与代码地图](ARCHITECTURE_NEXT.md) 定位入口、状态归属及不能破坏的约束，再查相关测试。
4. 读 [当前验证与待办](qa/README.md)，确认已知失败及环境验收缺口。选择用户要求的功能继续，不把旧计划中的“未实现”当作当前待办。
5. 按 [维护指南](MAINTENANCE.md) 更新对应说明并验证；准备发布时再使用发布检查表。

## 常用文档

| 要做什么 | 文档 |
|---|---|
| 安装依赖、启动、选择测试 | [DEVELOPMENT](DEVELOPMENT.md) |
| 找代码、理解数据流与边界 | [ARCHITECTURE_NEXT](ARCHITECTURE_NEXT.md) |
| 棋谱自动提取问题段并续弈 | [engine/position-training](engine/position-training.md) |
| HumanSL 概率损失与后续分支比较 | [engine/tolerance-review](engine/tolerance-review.md) |
| 复用已有分析的 HumanSL 40 棋力测评 | [engine/humansl40-strength](engine/humansl40-strength.md) |
| 修改云端局面同步 | [engine/cloud-position-sync](engine/cloud-position-sync.md) |
| 查看当前已知问题、记录本轮结果 | [qa/README](qa/README.md)、[TROUBLESHOOTING](TROUBLESHOOTING.md) |
| 使用 skill、Git hook 和文档检查 | [MAINTENANCE](MAINTENANCE.md) |
| 验收候选构建 | [RELEASE_CHECKLIST](RELEASE_CHECKLIST.md) |
| 打包、标签、发布与回退 | [RELEASE_PROCESS](RELEASE_PROCESS.md) |
| 查询长期决定 | [.agents/notes](../.agents/notes/README.md) |
| 找旧交接、旧验收或迁移记录 | [archive](archive/README.md) |

## 目录约定

`engine/` 保存模块当前行为；`qa/` 保存验证入口及测试仍消费的证据；`images/` 保存 README 使用的截图；`validation/` 保留 Java 模型对照助手；`archive/` 存放按原路径可恢复的历史文本。旧截图、JSON、SGF 夹具和日志不是新的验收结论，读取时检查采集日期和边界。

文档整理只调整说明和检查脚本的文档入口，没有修复业务缺陷或重新进行完整 GUI/云端验收。继续开发时，以目标模块的源码与相关测试为准。
