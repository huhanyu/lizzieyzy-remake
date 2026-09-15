# 一键设置验收 — 2026-09-15

已完成设计 1 的模块化实现；正式 app 构建成功。未替换或重启用户正在使用的正式窗口。独立验收标识 org.lizzieyzy.next.setup-qa，独立配置与下载目录。

## 已验证

| 功能 | 证据 |
| --- | --- |
| 三种分析方案、按需模块、模型管理、下载任务、速度优化 | 浏览器交互和 native-final.jpg |
| 推荐模型及快速补算模型真实下载、SHA-256、实际加载 | native-download-verification.json；94,281,753 和 38,245,488 字节 |
| 主分析与快速补算分离 | 独立 one-click-quick 配置，研究队列刷新可复用 |
| 已安装资源复用 | 更新后的原生包重复应用成功，预计下载 0 MB |
| 官方 KataGo 实际 benchmark | 完成，推荐 8 线程；native-benchmark-verification.json |
| 推荐参数应用 | 独立 cfg 中 numSearchThreads=8、numAnalysisThreads=1、numSearchThreadsPerAnalysisThread=8；原始 cfg 保持 6 |
| 并发修改与失败保护 | expected/current 原子比较；失败或取消不提交；单元测试覆盖 |
| 自动化回归 | 前端 70/70；Rust 187 通过、1 忽略；见测试日志 |
| 构建 | TypeScript/Vite 与正式 Tauri app 通过；production-build.log |
| 用户环境隔离 | 原始引擎配置与验收前字节一致 |

## 模块边界

- domain/modelCatalog.json：Rust/TypeScript 共用固定目录。
- domain/setupPlan.ts、setupWorkflow.ts：选择、资源去重和事务流程。
- hooks/useOneClickSetup.ts：UI 状态与异步生命周期。
- components/setup：总览、模型列表、测速、导航分别维护；按需加载。
- Rust engine_model_catalog、setup_model_probe、setup_apply、engine_benchmark、benchmark_settings：目录、加载验证、原子提交、测速、应用分别维护。
- 复用既有下载校验、GTP 会话、引擎配置与任务互斥，不另建引擎执行通路。

## 明确边界

- HumanSL 本次仅下载资源，不自动启用人类风格分析。
- 固定官方模型目录，不是远端目录自动同步；并非每种模型均在本机完整下载验收。
- 使用已有本地 KataGo/配置；首次无引擎时进入高级设置，不宣称任意空白机器自动部署成功。
- 模型检查取消有任务 token 与单元测试；实际本机加载太快，未成功停在加载中点击取消，因此不宣称原生取消交互已实测。
- 深入研究与 HumanSL 的目录校验/交互已检查，本轮真实端到端下载覆盖推荐与快速模型。
- 原有编译警告仍存在（未使用代码及主包体积）；新增设置入口采用懒加载。

视觉验收：../../design-qa.md。
