# 排查入口

本页补齐 README 和开发指南已有的排查链接，2026-10-04 创建。先按现象定位，再记录复现条件、实际命令和结果。

| 现象 | 检查入口 |
|---|---|
| 浏览器预览不能选本地文件或启动引擎 | [开发指南](DEVELOPMENT.md)：区分浏览器 fallback 和原生 Tauri 运行环境 |
| 云端切换慢、旧局面结果或命令被拒绝 | [云端同步说明](engine/cloud-position-sync.md)：核对 generation、ACK、复用条件及完整重建回退 |
| Git 提交被文档检查拒绝 | [维护指南](MAINTENANCE.md)：修复报告的链接或 Note 状态，检查暂存区是否包含依赖文件 |
| 检查输出 `checked: 0` | 确认 `.doc-governance.json` 存在且已暂存；零检查不代表通过验收 |
| 安装器拒绝现有 hook 或 skill | 先保留已有内容，按工具包说明合并，不强制覆盖 |

## 当前已观察问题

2026-10-04 的 `python3 scripts/validate_release_assets.py --verbose` 返回 3 通过、1 失败：检查器要求窗口标题为 `LizzieYzy Next`，当前配置不满足。此问题在本轮未改动的运行时配置中已存在。维护者应统一产品命名与发布检查契约后再作发布判断；本轮文档接入没有更改窗口标题或放宽检查器。

同日开发检查还观察到 5 项旧 UI 文案断言失败，以及 `windows-preview.yml` 的旧 Action 版本失败；路径、复现命令和后续处理见 [当前验证与开发待办](qa/README.md)。文档清理前后保存证据 smoke 的输出完全一致。
