# 涨棋网全局分析五模块调研

调研日期：2026-09-15。范围为用户指定页面的「测评、吻合度、胜率走势、问题手、发挥水准」。仅读取公开前端资源和已有本地代码，没有启动分析、购买服务、调用预测 API，也没有操作用户当前 Chrome。

## 证据与边界

以下“已证实”来自直接读取当前公开 JS；资源名含构建哈希，网站升级后可能变化。交互由事件处理代码证明，未在此次任务中逐项实点验收。不能从客户端推导服务端模型训练、段位校准和预测真实性。

- 页面：[AiAnalysisView-DscdzLX0.js](https://zhangqi.com.cn/assets/AiAnalysisView-DscdzLX0.js)
- 模块容器：[FullChart-b9G1D_us.js](https://zhangqi.com.cn/assets/FullChart-b9G1D_us.js)，`FullChart`。
- 五模块组件：[WinrateChart-D_dvA9-i.js](https://zhangqi.com.cn/assets/WinrateChart-D_dvA9-i.js)，`SummaryChart`、`SummaryChartDetail`、`MatchChart`、`QuestionChart`、`SkillChart`、胜率组件。
- 统计实现：[white-stone-CRPSjTws.js](https://zhangqi.com.cn/assets/white-stone-CRPSjTws.js)，GoAnalysis 类（压缩类名 `wt`），方法名在下文列出。已重新下载并确认与此前 `/tmp/zq-engine.js` 完全相同。
- 质量分档：[aiUtils-EYz7P17k.js](https://zhangqi.com.cn/assets/aiUtils-EYz7P17k.js)，`getAnswerLevel` / `wrapAnswers`（局部名 A/C）。
- 图表辅助与预测请求：[chartUtils-luGvu2XN.js](https://zhangqi.com.cn/assets/chartUtils-luGvu2XN.js)，问题箭头、tooltip、`fe` 预测请求包装。
- 预测 API 声明：[predictService-CvNX2jVq.js](https://zhangqi.com.cn/assets/predictService-CvNX2jVq.js)，`getRank` 等。
- 等级名称和颜色：[index-CR5GMTGo.js](https://zhangqi.com.cn/assets/index-CR5GMTGo.js)，`getLevelConfig` / `listLevelConfigs`。

## 共用数据与质量标准（已证实）

`globalHash` 按局面序号存储结果，核心字段 `turnNumber/color/visits/answers`。候选字段包含 `pos/winrate/scoreLead/visits/human/level/real`；`real` 标记导入棋谱实际落点。候选没有实战落点时，`createAnswerFromNext` 可用下一局面第一候选的评估构造实战候选，访问次数设零；这属于后局面估计，不能等同于前局面已经充分搜索该着法。

候选先将胜率四舍五入至千分之一；访问占比 `recommend=visits/sum(all answers.visits)`。设 dS 为相对第一候选目差绝对差，dW 为相对第一候选胜率绝对差（0–1），p 为访问占比：

| 档位 | 名称 | 条件（按顺序） | 原站颜色 |
|---|---|---|---|
| 1 | 最佳 | 第一候选 | green / #008000 |
| 2 | 好手 | dS≤2 且 dW≤0.05 且 p>0.05 | #77C103 |
| 3 | 一般 | dS≤2 且 dW≤0.05 且 p≤0.05 | #A2B537 |
| 4 | 欠佳 | 未进入前档且 dS≤6 且 dW≤0.15 | #FFBD00 |
| 5 | 不好 | 未进入前档且 dS≤10 且 dW≤0.30 | #CE6C0C |
| 6 | 恶手 | 其余 | #BA2121 |

原函数的4/5档以两个 OR 分支表达上述范围。统计中的“好手命中”仅包含 level≤2，**不包含第3档“一般”**。当前本地首选蓝色是用户明确指定的风格差异，应保留。

阶段标准：全盘；布局1–60；中盘61–150；官子151及以后。`getProcessType` 使用零基序号 `<60` / `<150`。注意 `loadQuestions` 传入的是一基 turnNumber，这使问题手阶段边界可能在60/150处提前一手；不要复制这个疑似边界错误。

## 1. 测评

**界面**：黑白两行，棋力、平均目差、吻合度（一选/好手）、难度。全盘/布局/中盘/官子/自选。自选弹窗输入起止，至少40手（end-begin≥39），不能超过棋谱总手数；选自选需先开始分析。尚未到中盘/官子时提示并恢复旧选择。

**客户端统计：`getSummary`**：仅统计有实际落点和后继局面结果的有效记录，按颜色独立分母，不将缺失结果记为0。

- 一选命中率 = level1实际手数 / 有效实际手数。
- 好手命中率 = level≤2实际手数 / 有效实际手数。
- 平均目差实际上是**平均非负目数损失**。若 S_before/S_after 是相邻局面第一候选的黑方目差：黑方损失 max(0,S_before-S_after)，白方 max(0,S_after-S_before)。并计算样本标准差，但主表显示平均值。
- 胜率损失也按相邻首选评估计算并将改善截为0；函数返回负向变化百分数，不要直接套用本地“损失为正”的接口。
- 难度 = `100 * (1 - sum(human probability of level≤2 answers))`，再按颜色平均，排除前4手。这里 `human` 是候选的人类策略概率，**不是访问占比**。没有人类模型数据不能伪造难度；源码默认缺失为0会导向100%，本地应明确缺失。

**服务端部分**：棋力段位、±差值、分段棋力、疑似AI结果取自 `blackPredict/whitePredict` 的 `total/part/diff/dog/highlight`。`chartUtils.fe` 将 SGF、每局面候选 `[pos,scoreLead,winrate,index]`、visits 发给 `predict/rank`（跳过visits≤15），自选附 `customRange`。没有公开段位公式或模型参数。

**提示边界**：少于100手提示全局手数不足；部分结果手数不足提示低于20手不能计算；可能显示尚未计算、算力不足、等待海量计算；源码有切换卡塔狗×10提示。疑似AI区间链接切换吻合度页。误差 `diff` 的统计置信水平未公开，不能称95%置信区间。

## 2. 吻合度

**界面**：全盘横向手数轴，按黑/白分别显示一选、好手、疑似AI轨道及平均命中率；连续命中连成区间，高光时段可悬停。`MatchChart` 当前直接调用 `loadMatch("全盘")`，没有在本组件提供阶段筛选，虽底层方法支持阶段和自选。

**公式**：`loadMatch` 遍历实战候选，level1置一选命中，level≤2置好手命中；分母是该颜色有实战候选的手数。黑白交替的连续同方命中合并成段，不是滑动窗口百分比。

**交互**：点击命中点跳 `globalJump(point.x)`；点击空白根据横坐标取最近手数；当前局面垂线另由容器绘制。预测 `dog` 区间映射为手数段；`highlight` 还根据初始行棋方调整偏移。悬停可显示AI相似度或高光水平。

**边界**：一选/好手轨道可完全本地计算；疑似AI和高光水平来自服务端。原站 tooltip 明确“基于大模型推测，不能作为使用AI的证据”，且没检出也不能证明没用AI。本地不应根据高吻合度自行贴疑似作弊标签。

## 3. 胜率走势

**界面**：同一图叠加黑胜率与黑领先目，双纵轴、图例、悬停tooltip、当前手垂线。胜率轴0–1（标签百分数），目差轴对称，范围至少±10目，再按最大绝对目差向上取整到10目。图例是Chart.js常规图例，可切换数据集显示；没有发现本组件的阶段筛选。

**数据**：`loadWinrates` 在每个globalHash局面选 `real` 候选，没有时用首选；输出 `labels=0..maxIndex`、winrates、scoreLeads。这与“每个局面直接使用根评估”的曲线语义不同，应在本地明确统一，不能混用而导致上一手损失错位。

**交互**：点数据或横轴最近位置跳到该局面；悬停同一索引展示黑胜率、黑领先目，并绘蓝色竖线；当前局面另有白色竖线。结果刷新复用Chart实例。

## 4. 问题手

**界面**：阶段筛选全盘/布局/中盘/官子；颜色双方/黑方/白方；默认勾选“不指出重复恶手”。散点颜色按4–6档，黑/白边框和箭头区分落子方；箭头从首选胜率指向实战胜率；tooltip显示手数、类型、前后胜率与目差。

**筛选算法：`loadQuestions`**：
1. 只收集 `real && level>=4` 的着法。
2. 统一成黑方图表视角：黑走直接取候选数值，白走将胜率取1-p、目差取负；保存首选和实际差值。
3. 重复恶手：仅level6，连续同方问题手（间隔不超过2手），且 `color + 首选pos` 相同，合并为第一手的 `turnNumbers`。不是同一区域、不是所有欠佳手、不是整盘同坐标都合并。
4. 阶段/颜色过滤，按显式优先手集合、等级降序、`floor(diffWinrate)`、diffScoreLead升序排序。**默认最多10条**，随后按手数升序展示。胜率差floor在0–1输入上很粗，这不是精确按胜率降幅排序，迁移可修正但需明确差异。
5. 勾选去重只保留链首，并通过multiX显示合并手数；关闭时各手单列。

**点击跳转**：跳到 `turnNumber-1`，即问题发生前的局面，便于看推荐和试下；不是跳到落完问题手之后。

**额外过滤边界**：源码还有“棋力过滤问题手”弹窗和适用状态，提示须高级复盘且≥100手。然而当前读取的 `loadQuestions` 未使用 `suitableQuestion`，组件ready状态也未看到置true；不能宣布这项已经有效实现，应视为未核实/可能未启用路径。

## 5. 发挥水准

**实际含义**：六档着法质量分布，**不是段位曲线**。全盘/布局/中盘/官子筛选，每档并列黑白柱，显示手数和占各自有效手数比例。

**公式：`sumSkills` + `SkillChart`**：对有real候选的局面按level1–6计数；黑百分比=本档黑手数/黑总手数，白同理；柱高按黑白所有档最大计数归一化后乘0.9，以在同一图比较绝对计数。无数据置0。组件无节点点击跳转事件。

## 容器、更新与分析进度

`FullChart` 统一标签、折叠、进度和刷新；刷新节流1000ms，只刷新当前挂载组件，重置/窗口变化使用requestAnimationFrame。各组件暴露refresh/getData，便于报告导出复用。

分析等级来自每局面visits，而非累计总计算量：阈值75/750/2400/4500/9000/15000，界面目标80/800/2400/4500/9000/15000。统计就绪和全局最小访问量需分开；`summaryReady` 是结果数量覆盖，`getGlobalVisitReady` 是最小访问量≥75。不要让本地1v补线直接宣称完整深度测评。

## 本地Tauri迁移建议（建议，不是已实现）

已读本地 `domain/reviewStatistics.ts`、`domain/candidateColors.ts`。现有 `reviewMoves` 已有按document/node/job绑定分析帧、当前分支祖先+主延续、缺失结果null、同任务取较深样本的保护，必须复用。

1. **先抽公共质量函数**：candidateColors目前只返回颜色。抽 `classifyCandidateQuality` 返回level+标签，颜色作为独立映射；保留首选蓝色。发挥水准、吻合度、问题手复用同一等级判断，避免三份阈值。
2. **扩展现有ReviewMove**：增加实际落点/首选坐标/qualityLevel/候选来源/visits；不要另按全局手数数组绑定，防止分支和换谱串数据。相邻帧推断的着法质量需标明估计；没有数据保持unknown。
3. **先实现本地可靠部分**：测评中的平均损失与一选/好手；吻合度命中轨道；问题手过滤和跳转前局面；六档发挥分布。人类难度缺少policy时显示—。
4. **不伪造云模型**：段位、误差、AI相似区间、高光棋力先明确未支持，未来接有证据的模型接口。KataGo胜率不是段位。
5. **组件职责**：共用ReviewRangeFilter（阶段/自选/颜色），独立MatchTimeline、MistakeChart、QualityHistogram、ReviewSummary；沿用当前tab容器；派生统计按document/tree/frame revision memo，不在每个绘图组件里重新遍历树。流式刷新节流、图表点点击只dispatch节点选择。
6. **应测试边界**：第60/61/150/151手、让子/首手白、pass、分支切换、零visits、缺失human、前后帧来源不一致、同首选连续恶手与间断恶手、最后一手无后继结果、1v与深算覆盖率、候选第一项不是visits最大项。

本次仅形成调查报告；未修改功能源代码、未声称上述建议已实现。
