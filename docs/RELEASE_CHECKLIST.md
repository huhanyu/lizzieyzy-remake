# 发布候选检查表

对**本次候选构建**逐项填写结果，记录 commit/工作区差异、平台、引擎/模型/配置、命令与证据。KataGo、provider、readboard、云端及安装环境属于 external gates；未执行的项目记为 pending，不复用旧报告的通过数。

## 自动检查

- [ ] `python3 scripts/validate_scaffold.py --verbose`
- [ ] `python3 scripts/validate_release_assets.py --verbose`
- [ ] `python3 scripts/validate_release_workflow.py --verbose`
- [ ] `python3 scripts/validate_legacy_parity.py --verbose`（核对现有矩阵结构，不代表重新验收）
- [ ] `python3 scripts/smoke_user_flows.py --verbose`（复核保存证据与代码表面）
- [ ] `python3 scripts/smoke_release_candidate.py --verbose`
- [ ] 文档受管检查、相关 Python 测试、前端领域测试与构建，命令见 [开发指南](DEVELOPMENT.md)。
- [ ] `cargo fmt --all --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --workspace`。

当前失败项先看 [QA 状态](qa/README.md)，不能为发布通过而删除失败断言或将未执行环境标为通过。

## 原生桌面完整链路

- [ ] 原生打开真实 SGF 和 golden fixture；主线/分支导航、注释/属性/标记、增删节点和分支顺序正确。
- [ ] 保存、退出、重开，验证树与棋盘、摆子、让子、贴目、注释往返一致；保留原生对话框证据。
- [ ] 引擎 profile 新增/选择/重启持久化；缺文件可恢复；启动与配置错误有明确提示。
- [ ] 实时分析持续刷新候选/胜率/归属；快速换手、换文档、切分支不混旧帧；暂停、限制、控制台操作及恢复正确。
- [ ] 全盘分析进度、取消后重启、缓存命中及旧缓存失效；后台补线与前台会话互不越权。
- [ ] 试下滚轮/滑条与取消，复盘五模块的缺失值/覆盖率/黑白视角，原生交互可用。
- [ ] 人机对弈新局/续弈/悔棋/pass/结束与保存；HumanSL 使用真实人类模型，远端对弈独立验证。

## 外部服务与平台

- [ ] KataGo CLI、Tauri 会话和安装后引擎启动分别记录；mock、浏览器 fallback 和本地协议对比标清范围。
- [ ] 智子云用真实认证会话验证局面切换、断线/退出/重连、规则变化和旧帧隔离；速度结论需实际测量。
- [ ] Yike/Fox provider 记录账号/服务范围、成功与失效/超时/错误返回；不记录秘密凭据。
- [ ] readboard 测试运行/停止/重启、局面变化和错误；受控图片导入与任意截图/外部捕获分别验收。
- [ ] 每个目标平台安装后无开发服务也能运行；测试安装/启动/卸载、资源路径、权限和日志。

## 产物与发布

- [ ] 版本同步、artifact 对应 tag/commit/平台、校验和可复验、资源许可和模型大小明确。
- [ ] 签名/公证状态与实际产物一致；unsigned 构建不能称为已签名稳定版。
- [ ] 发布说明包含已完成范围、已知限制、验证结果和升级/回退办法；不能宣称完整 Java 等价。
- [ ] 按 [发布流程](RELEASE_PROCESS.md) 操作，标签推送会触发远端发布，须有相应授权。

旧长篇清单的详细证据 schema、历史状态及完整验收矩阵保存在 [归档](archive/README.md)；当前 schema 的执行依据为 `scripts/smoke_user_flows.py` 和对应测试。
