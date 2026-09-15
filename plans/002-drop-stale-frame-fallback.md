# Plan 002: 移除陈旧分析帧回退，避免错位叠加

> **Executor instructions**: 按步骤执行，每步先跑验证命令、确认预期结果再进入下一步。若出现 "STOP conditions" 中的任一情况，停止并报告，不要即兴发挥。完成后更新 `plans/README.md` 中本计划的状态行。
>
> **Drift check（先跑）**: `git diff --stat b7f33a2..HEAD -- apps/desktop/src/App.tsx`
> 若该文件在基准提交后已变更，先把 "Current state" 的摘录与现网代码逐条对照；不一致即视为 STOP condition。

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b7f33a2`, 2026-09-12

## Why this matters

前端选帧逻辑在**找不到当前手对应的分析帧时，回退到"最后一个帧"**：

```ts
const currentFrame = useMemo(() => frames.find((f) => f.turn === currentMove) ?? frames.at(-1), [frames, currentMove]);
```

用户跳到一手**尚未分析**的位置时，界面不会显示"此处无分析数据"，而是继续显示**别处**（最后一手）的候选点、ownership 热图与 policy 叠加。后果：

- 棋盘上出现**位置错误的候选点与领地热图**，而棋盘本身是正确的当前局面——两者不一致，用户会据此误判。
- 胜率面板显示的是**另一手**的胜率数值，与棋盘局面不匹配。
- 这是分析类应用里最典型的"静默错误展示"：看起来一切正常，但数据与局面无关。

Java 主线的做法相反且严格：`Leelaz.isCurrentAnalysisInfoTarget`（`src/main/java/featurecat/lizzie/analysis/Leelaz.java:4888-4902`）会逐项校验引擎槽位、棋盘对象身份、**棋盘上下文修订号**、以及**显示节点是否与请求时一致**，任一项不符就丢弃该分析结果。也就是说，Java **宁可什么都不显示，也不显示错位的分析**。

此外 `? frames.at(-1)` 还有第二个隐患：`frames` 在 `mergeAnalysisFrame` 中按 `turn` 升序排序（`apps/desktop/src/App.tsx:2001-2002`），所以 `at(-1)` 是**最大手数**的帧。用户若从第 50 手跳到第 10 手（两者都未分析），会看到第 50 手的数据叠加在第 10 手棋盘上。

## Current state

**关键文件**

- `apps/desktop/src/App.tsx`（2,104 行）— 唯一相关文件。这是整个前端的状态编排中心。

**摘录 1：有问题的回退**（`apps/desktop/src/App.tsx:204-205`）

```ts
  const currentFrame = useMemo(() => frames.find((f) => f.turn === currentMove) ?? frames.at(-1), [frames, currentMove]);
  const visibleCurrentFrame = useMemo(() => applyPreferencesToFrame(currentFrame, preferences), [currentFrame, preferences]);
```

`visibleCurrentFrame` 被传给 `<BoardCanvas analysis={...}>` 与 `<AnalysisPanel frame={...}>`。

**摘录 2：`applyPreferencesToFrame` 已在处理 undefined**（`apps/desktop/src/App.tsx:1971-1979`）

```ts
function applyPreferencesToFrame(frame: AnalysisFrameDto | undefined, preferences: AppPreferences): AnalysisFrameDto | undefined {
  if (!frame) return undefined;
  return {
    ...frame,
    candidates: preferences.showCandidates ? frame.candidates.slice(0, preferences.candidateLimit) : [],
    ownership: preferences.showOwnership ? frame.ownership : null,
    policy: preferences.showPolicy ? frame.policy : null
  };
}
```

**这个函数已经能安全接受 `undefined` 并返回 `undefined`**——所以修掉回退后，下游不需要改造。这是本计划风险低的关键原因。

**摘录 3：下游组件已能处理 undefined**

- `BoardCanvas` 的 props 是 `analysis?: AnalysisFrameDto`（`apps/desktop/src/components/BoardCanvas.tsx:5`），内部用 `analysis?.ownership?.length ?? 0` 与 `analysis?.policy`，且 `effectiveOverlayMode` 在无数据时降级为 `"candidates"`。
- `AnalysisPanel` 用 `frame?.` 可选链，无数据时渲染 `<p className="muted">Run review to show candidate moves and winrate data.</p>`（`apps/desktop/src/components/AnalysisPanel.tsx:30`）。

**摘录 4：帧合并保持升序**（`apps/desktop/src/App.tsx:2001-2002`）

```ts
function mergeAnalysisFrame(frames: AnalysisFrameDto[], frame: AnalysisFrameDto): AnalysisFrameDto[] {
  return [...frames.filter((item) => item.turn !== frame.turn), frame].sort((a, b) => a.turn - b.turn);
}
```

**仓库约定**

- 前端无测试框架（`apps/desktop/package.json` 只有 `dev`/`build`/`preview`/`tauri:dev`/`tauri:build`，devDependencies 只有 `@tauri-apps/cli` 与 `@types/*`）。**不要为本计划引入 vitest/jest**——那会让改动超出 Scope 且需要改 `package.json`。验证靠 `tsc` 类型检查 + 在数据属性上加断言钩子。
- 组件通过 `data-*` 属性暴露可断言状态，已有先例：`AnalysisPanel.tsx:43` 的 `data-winrate-black={frame?.winrate_black ?? ""}`、`WinrateChart.tsx` 的 `data-review-source`/`data-cache-restore-verified`。新增一个 `data-analysis-frame-source` 属性是符合既有约定的做法。

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| 类型检查+构建 | `cd apps/desktop && npm run build` | exit 0（`tsc` 无错误，vite 产出 `dist/`） |
| Rust 门禁（回归确认） | `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" && cargo test --workspace` | all pass |
| 脚手架校验 | `python3 scripts/validate_scaffold.py --verbose` | 10 passed, 0 failed |

注意 `npm run build` 的脚本是 `tsc && vite build`，所以类型错误会让它失败——这就是本计划的主要验证手段。

## Scope

**In scope**（只允许改这些）

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/components/AnalysisPanel.tsx`（仅新增一个 `data-*` 可断言属性）

**Out of scope**（不要动）

- `apps/desktop/package.json` — 不要加测试框架依赖。
- `apps/desktop/src/components/BoardCanvas.tsx` — 已能处理 `undefined`，无需改动。
- `apps/desktop/src/components/WinrateChart.tsx` — 它接收 `frames` 数组而非单帧，行为不受影响（见下方"Maintenance notes"）。
- 任何 Rust 代码。
- 不要改动 `frames` 的排序、合并或缓存逻辑。本次只改"选取哪一帧"。

## Git workflow

- 分支：`advisor/002-drop-stale-frame-fallback`
- 提交信息对齐仓库风格：`fix(ui): stop showing stale analysis frames for unanalysed moves`
- **不要推送、不要开 PR**，除非操作者指示。

## Steps

### Step 1: 移除陈旧帧回退

把 `apps/desktop/src/App.tsx:204` 改为精确匹配，不再回退：

```ts
  const currentFrame = useMemo(() => frames.find((f) => f.turn === currentMove), [frames, currentMove]);
```

`visibleCurrentFrame` 保持不变（`applyPreferencesToFrame` 已能接受 `undefined`）。

**Verify**: `cd apps/desktop && npx tsc --noEmit` → exit 0。
若报 `currentFrame` 类型错误，说明它被传给了期望非空的地方；按 Step 2 处理，不要用 `!` 断言绕过。

### Step 2: 修正类型传播（如需要）

`tsc` 可能会指出 `visibleCurrentFrame` 现在可能是 `undefined`。逐处检查它的使用点（`grep -n 'visibleCurrentFrame' apps/desktop/src/App.tsx`）：

- 传给 `BoardCanvas` / `AnalysisPanel`：这两个 props 本就可选，**不应报错**。
- 若有其他地方直接访问 `visibleCurrentFrame.xxx`：改为可选链 `visibleCurrentFrame?.xxx`，**不要**用非空断言 `!`。

**Verify**: `cd apps/desktop && npm run build` → exit 0。

### Step 3: 增加可断言的帧来源标记

为了让"无分析数据"这一状态可被机器检查（前端没有测试框架，这是本项目既有的替代手段），在 `apps/desktop/src/components/AnalysisPanel.tsx` 增加一个 `data-*` 属性，编码当前帧是否有数据及其手数。

在 `AnalysisPanel` 的组件签名中找到已有的 `frame` prop，并在其根元素（含 `data-winrate-black` 的那个元素）上新增：

```tsx
data-analysis-frame-source={frame ? `frame:${frame.turn}` : "none"}
```

同时在 `appliesPreferences` 的调用侧无需改动。

**Verify**:
1. `cd apps/desktop && npm run build` → exit 0
2. `grep -n 'data-analysis-frame-source' apps/desktop/src/components/AnalysisPanel.tsx` → 1 处匹配

### Step 4: 人工核对行为（不可自动化的部分）

> **⚠️ 剧本修正（2026-09-12，由 T3 执行者实测发现）**：本节原版要求"把滑块移到**未被分析覆盖**的手数"来观察候选点消失。该剧本**不可复现**，因为 `Run review` 的假分析对**每一手**都生成帧：
> - 浏览器预览：`apps/desktop/src/api/backend.ts:853` — `for (let turn = 0; turn <= game.moves.length; turn += 1)`
> - Tauri 网关：`apps/desktop/src-tauri/src/lib.rs:1910`（`fake_analyze`）— `for turn in 0..=document.moves.len() as u32`
>
> 实测 Load sample 后逐手探测 0..20，每手均返回 `frame:<turn>`，`turnsWithoutFrame: []`。唯一能产生**稀疏帧**的用户路径是单点分析（`handleRunKataGo` + `mergeAnalysisFrame`），但它在浏览器预览下被显式拒绝（`apps/desktop/src/api/backend.ts:300` 抛 "requires the Tauri desktop backend"）。
>
> 因此**不要**按下面的原步骤期待"候选点消失"——那样只会得到"未复现"的结论。改用下面的**稀疏缓存差分法**。

**推荐方法：稀疏缓存差分法**（T3 执行者已用此法取得确凿证据，可直接复用）

原理：利用应用**自己的缓存恢复路径**把帧裁成稀疏集合，从而造出"未分析手"。

1. `cd apps/desktop && npm run dev`
2. Load sample → Run review（此时假分析为每一手生成帧）
3. 打开 DevTools，把 localStorage 里的缓存帧**裁剪为稀疏集合**，例如只保留 turn 为 `[0, 5, 10, 20]` 的帧
4. reload → 重新 Load sample（让应用经自己的缓存恢复路径载入稀疏帧）
5. 逐手核对 `AnalysisPanel` 的 `data-analysis-frame-source`：
   - **已分析手**（0/5/10/20）→ 应为 `frame:<turn>`
   - **未分析手**（如 3/7/15）→ 应为 `none`，且候选点数 0、winrate 空
6. **差分对照（关键）**：在 `b7f33a2` 的**独立 worktree** 上跑同一脚本。基线在未分析手应显示**最后已分析手**的数据（即 turn=20 的值），修复后应显示 `none`。两者不同即证明修复生效。
7. 记录：观察到的 `data-analysis-frame-source` 值、未分析手的候选点数/winrate、以及两棵树的差异。

**可选的客观佐证**：对 canvas 取 `toDataURL()` 做像素哈希，比较两棵树在"均无帧的手"上是否不同（相同则说明修复无效或渲染未变）。此法可规避肉眼判读。

若无法运行浏览器预览，**如实报告"未执行人工核对"**，不要跳过或编造。

## Test plan

- 本项目前端无单元测试框架，本计划**不引入**。
- 回归保障依赖：`tsc` 类型检查（Step 1-3）+ 既有 Rust 测试全绿（确认未波及其他层）+ 人工核对（Step 4）。
- 若将来引入 vitest，应为此补一个纯函数测试。**本轮不做**，在 `Maintenance notes` 记录该缺口。

## Done criteria

全部成立才算完成：

- [ ] `cd apps/desktop && npm run build` exit 0
- [ ] `grep -nF '?? frames.at(-1)' apps/desktop/src/App.tsx` 无匹配（**陈旧回退表达式**已移除）
- [ ] `grep -nF 'payload.frames.at(-1)' apps/desktop/src/App.tsx` 有 **1 处**匹配且位于缓存恢复路径（`:1593` 附近的合法用法必须**保留**，不得误删）
- [ ] `grep -n 'data-analysis-frame-source' apps/desktop/src/components/AnalysisPanel.tsx` 有 1 处匹配
- [ ] `grep -c '!' apps/desktop/src/App.tsx` 未因此改动而增加（即没有靠非空断言绕过类型）
- [ ] `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" && cargo test --workspace` → all pass
- [ ] `python3 scripts/validate_scaffold.py --verbose` → 10 passed, 0 failed
- [ ] `git status` 显示的改动文件仅 `apps/desktop/src/App.tsx` 与 `apps/desktop/src/components/AnalysisPanel.tsx`
- [ ] Step 4 的人工核对结果已如实记录（或明确标注未执行）
- [ ] `plans/README.md` 中本计划状态行已改为 `DONE`

## STOP conditions

出现以下任一情况，停止并报告，不要即兴发挥：

- "Current state" 摘录与现网代码不一致。
- `?? frames.at(-1)` 这个**回退表达式**不只在 `App.tsx:204` 出现——先 `grep -rnF '?? frames.at(-1)' apps/desktop/src/` 报告全部出现位置，不要只改一处就宣布完成。
  - **注意区分**：`payload.frames.at(-1)`（缓存恢复路径，`:1593` 附近）与 `runtimeSmoke.ts:853` 的 `frames[frames.length - 1]` 都是**合法用法，必须保留**，不在本计划范围内。只有形如 `?? frames.at(-1)` 的**陈旧回退**才是要移除的目标。
- `tsc` 报出的错误需要用非空断言 `!` 或 `as` 强转才能消除——这说明下游某处确实依赖"帧必定存在"，需要重新评估方案，不要硬压类型。
- 你发现移除回退会让某个**已通过**的既有 smoke 脚本失败。这很有价值，**报告它**（可能意味着某处流程依赖该回退），不要为了让测试变绿而恢复回退。
- 需要改动 Scope 之外的任何文件（尤其是 `package.json`）。

## Maintenance notes

- **谁会被影响**：`WinrateChart` 接收的是整个 `frames` 数组，不是单帧，因此**不受本改动影响**——它仍会绘制所有已分析手数的曲线。这是正确的：胜率图应显示已知的全部数据点。受影响的是"当前手"的候选点/热图叠加。
- **审阅者重点看**：`currentFrame` 从"总有一个值"变成"可能是 `undefined`"后，是否所有使用点都被 `tsc` 覆盖到。若审阅发现某条路径在无帧时行为异常（例如空指针或渲染空白），应在 review 中指出。
- **与本轮其他计划的关系**：plan 007（前端实时复盘 UX）会大量改动词 `App.tsx` 的状态编排，且**依赖本计划先完成**——否则实时刷新会把"错位叠加"从静态变成动态，问题更隐蔽。
- **明确推迟**：前端缺少单元测试框架，导致本次只能靠类型检查 + 数据属性 + 人工核对来保障。补测试框架（vitest + 对 `currentFrame` 选取逻辑做纯函数抽取与单测）是独立工作项，建议单独立计划，不在本轮。
- **一个值得后续观察的关联点**：若将来实现"分析进行中逐手回填"（实时复盘），可能确实希望在某手尚无数据时显示"最近一个已分析手"的参考——但**那时也必须明确标注是参考数据**（例如灰度显示或加 `data-` 标记），而不是像现在这样静默冒充当前手。本计划先恢复"宁可空着也不错位"的正确默认。

## Step 4 执行记录（ui-engineer, 2026-09-13）

**结论：Step 4 按原文描述的观察路径不可复现，已改用等效且更强的差分验证手段完成，结果通过。**

### 发现：原文 Step 4 场景在该路径下不存在

`Run review` 走的是假分析路径，而 `buildBrowserAnalysis`（`apps/desktop/src/api/backend.ts:851-864`）与 Rust 侧 `fake_analyze`（`apps/desktop/src-tauri/src/lib.rs:1906`）都是 `for turn in 0..=moves.len()` —— **每一手都有帧**。实测（Playwright，headless Chromium，`Load sample` 后逐手探测 0..20）：`turnsWithoutFrame: []`，每一手都返回 `frame:<turn>` 且 8 条候选点。

因此原文 Step 4 第 3 步「把滑块移到未被分析覆盖的手数」在该路径下**没有任何可观察区间**，无法据此判定修复有效或无效。这是计划文本的缺口，不是实现缺陷。

### 替代验证：构造真实缺口 + 修复前后差分

唯一能产生稀疏帧的用户路径是 `handleRunKataGo`（单点分析后 `mergeAnalysisFrame` 合并，`App.tsx:504-548`），但它在浏览器预览下被显式拒绝（`backend.ts:300-303` 抛「requires the Tauri desktop backend」）。故改用应用自身写出的缓存：`Load sample` → `Run review` → 把 localStorage 中的帧裁剪为 `[0, 5, 10, 20]` → reload → 重新 `Load sample`，让应用经自己的缓存恢复路径加载稀疏帧。

对同一脚本分别在修复树与 `b7f33a2` 基线 worktree 上运行，结果如下（`data-analysis-frame-source` / `data-visits` / `data-winrate-black`）：

| 手数 | 帧覆盖 | 修复后 | 基线 `b7f33a2` |
|---|---|---|---|
| 5 | 有 | `frame:5`, visits 1485, winrate 0.5357 | visits 1485, winrate 0.5357 |
| 3 | **无** | `none`, visits 0, winrate `""`, 0 候选点 | visits **3540**, winrate **0.4746899290038038**, 8 候选点 |
| 7 | **无** | `none`, visits 0, winrate `""`, 0 候选点 | visits **3540**, winrate **0.4746899290038038**, 8 候选点 |
| 15 | **无** | `none`, visits 0, winrate `""`, 0 候选点 | visits **3540**, winrate **0.4746899290038038**, 8 候选点 |

基线在未分析手数上显示的 `3540 / 0.4746899290038038` 正是**第 20 手**的值（`800 + 20*137 = 3540`，`0.51 + sin(20*0.62)*0.08 + cos(20*0.21)*0.045`），即 `mergeAnalysisFrame` 升序排序后的最后一帧 —— 与计划 "Why this matters" 描述的「从第 50 手跳到第 10 手会看到第 50 手数据」完全一致。修复后该错位叠加消失。

**棋盘像素级佐证**（对 canvas 做 `toDataURL` 哈希，规避截图肉眼判读）：

| 手数 | 修复后 hash | 基线 hash | 说明 |
|---|---|---|---|
| 5（两树均有帧，对照） | `bc24f847` | `bc24f847` | **相同** → 无环境噪声，对照成立 |
| 3（两树均无帧） | `8013c93a` (26,526 B) | `b54f9258` (33,778 B) | **不同** → 基线在棋盘上多画了叠加层 |
| 15（两树均无帧） | `2b964841` | `ee20cbf1` | **不同** → 同上 |
| 20（两树均有帧，对照） | `4bd82130` | `4bd82130` | **相同** → 对照成立 |

两处对照手数（5、20）在两棵树上哈希一致，排除渲染/环境差异；两处无帧手数（3、15）哈希不同，与面板数值一致地证明基线存在错位叠加。

### 缓存恢复路径（`App.tsx:1593`）未被误伤的实测证据

计划修订后的 Done criteria 要求保留 `payload.frames.at(-1)`（缓存恢复合法用法）。除 grep 计数外，另做行为级验证 —— 该行决定「缓存命中后定位到哪一手」，若被误删/改坏，恢复后的 currentMove 会落到错误手数：

- 逐字节比对：工作树 `:1593` 与 `b7f33a2` 同一行 `diff` 输出 **IDENTICAL**；且 `git diff -- apps/desktop/src/App.tsx` 中**不出现**该行（我的 App.tsx 改动只有 `:204` 一处，1 增 1 删）。
- 行为实测（Playwright，headless Chromium）：把缓存帧裁剪为 `[0,5,10,20]`（最后一帧 = 第 20 手）→ reload → `Load sample` 走缓存命中路径。结果：
  `data-current-move = "20"`、滑块 value = 20、`data-analysis-frame-source = "frame:20"`、`visits = 3540`、`data-cache-restore-verified = "true"`、状态文本为 "Showing restored cache review data; no live engine is running."
  即 currentMove 精确落在缓存最后一帧的手数（20），证明 `:1593` 的解算逻辑完好。

### 未执行项

- **未截图人工肉眼核对**：本会话模型不支持图像输入（`read_image` 返回 "does not declare image input"），截图已生成但无法由执行者肉眼判读，故改用上述 DOM 属性断言 + canvas 像素哈希作为客观证据。原始截图见 `/tmp/pw-check/board-turn3-{fixed,baseline}.png`（临时目录，未纳入仓库）。
- 无 console/page error（两棵树均 `errors: []`）。
