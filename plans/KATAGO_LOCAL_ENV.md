# 本机 KataGo 环境（T4 交付物）

> 记录者：captain（接管 t4，原执行者 env-engineer 的 brew 路径已放弃）
> 记录时间：2026-09-12
> 用途：供 T5（独立验证）与后续实时复盘计划（plans/003–007）复现真实引擎测试
>
> ⚠️ **给编辑者：本文档被 `plans/VERIFICATION_REPORT.md` 引用。**
> 该报告已改用**锚点式引用**（引节标题与关键词，如「配置视角」节、`勘误（env-engineer`、`--help 退出码陷阱`），**不再依赖行号**。
> 因此你可以自由编辑本文件；但**请勿改动上述锚点文字本身**（节标题与关键词），否则引用会失配。
> 历史教训：本文件曾因插入勘误块导致报告里 4 处行号引用全部偏移失效（偏移量还不一致），故已弃用行号引用。

## 结论速览

**本机 KataGo 可用，无需 brew 安装。** 主路径采用 `/Applications/LizzieYzy Next.app` 内已随包发布的引擎二进制。

brew 路径已放弃：`brew install katago` 需要断点续传一个 **362 MB** 的 bottle（`katago--1.18.2_1.arm64_golden_gate.bottle.tar.gz`），实测下载停滞（长时间 0 字节、重试 40 次仅 35 MB），且**对交付物并非必要**。

## 引擎路径（主路径）

| 项 | 绝对路径 |
|---|---|
| 二进制 | `/Applications/LizzieYzy Next.app/Contents/app/engines/katago/macos-arm64/katago` |
| 权重（主） | `/Applications/LizzieYzy Next.app/Contents/app/weights/default.bin.gz` |
| 配置 | `/Applications/LizzieYzy Next.app/Contents/app/engines/katago/configs/analysis.cfg` |

**同一 bundle 内还自带（备用）**：`.../engines/katago/configs/gtp.cfg`（GTP 用）、`estimate.cfg`。

### 版本

- 二进制自报：**`KataGo v1.16.4`**，`Compile Time: Oct 20 2025 13:40:11`
- 同目录 `VERSION.txt` 写：`KataGo release: v1.16.5`（含各平台 bundle 名），并注明 `Model source: kata1-zhizi-b28c512nbt-muonfd2.bin.gz`、`Prepared at: 2026-06-05`
- **两者不一致（二进制 v1.16.4 / 发布说明 v1.16.5），如实并列记录。**

### 后端与硬件

```
Using Metal backend
Metal backend 0: Apple M5 Pro, Model version 15 zhizi_hzy_b28_muonfd2, 19x19
```

### 权重校验

> **先看这里**：下表第二行（轻量权重）**本机不可用**——引擎版本过低，加载即 abort。仅第一行 `default.bin.gz` 可用于真实分析。详见紧随其后的勘误块。

| 权重 | 大小 | sha256 |
|---|---|---|
| bundle 主权重 `default.bin.gz` | 271,447,864 字节 | `b37f9a56a9b105159a196f9ba72c5328776fb5cf30014495e4d8ac8a5b07654b` |
| 轻量权重 `kata1-tf2-b10c384-s2941M-d5872M.bin.gz` | 38,245,507 字节 | `8015d49bdf45854c94e5f9e22b2b70e8738d3e56a6edca730e5b82509998a5b5` |

**轻量权重路径**：`~/.lizzieyzy-dev/models/kata1-tf2-b10c384-s2941M-d5872M.bin.gz`
（取自官方 `media.katagotraining.org`，即 Java 版 README 所述 "38 MB 官方轻量模型"）

> ⚠️ **勘误（env-engineer 实测证伪，2026-09-13）**
>
> **本机 app 引擎无法加载这个 38 MB 权重**，它会直接 abort。实测（复现两次，exit 134、stdout 0 字节）：
>
> ```
> $ echo '{"id":"recheck","moves":[["B","D4"]],...}' | "$K" analysis -config "$C" -model "$HOME/.lizzieyzy-dev/models/kata1-tf2-b10c384-s2941M-d5872M.bin.gz"
> exit=134   stdout 0 bytes
> stderr: libc++abi: terminating due to uncaught exception of type StringError:
>   Error loading or parsing model file ...kata1-tf2-b10c384-s2941M-d5872M.bin.gz:
>   This neural net requires a newer KataGo version. Obtain a newer KataGo at
>   https://github.com/lightvector/KataGo. Model version: 17
> ```
>
> **根因**：该权重是 **model version 17**，需要 KataGo ≥ 1.17；而本机 app 引擎自报 **v1.16.4**，支持的最大版本低于 17。这是**引擎/权重版本不匹配**，不是文件损坏（文件 sha256 与官方一致、大小 38,245,507 字节正确）。
>
> **结论与影响**：
> - **T5 及后续所有真实引擎测试，只能用 bundle 主权重 `default.bin.gz`。** 不要把轻量权重用于回归。
> - 轻量权重仅在未来装上 KataGo ≥ 1.17（如 brew 版 1.18.2）后才可用；届时它会是有价值的小体积回归权重。
> - 本条属**环境/文档问题**，不是 plans/001 或 002 的实现缺陷。

**两个权重的用途分工（据上勘误修正）**：

- **bundle 主权重（259 MB b28，model version 15）**：本机**唯一可用**权重。更权威，与 Java 版发行包一致。T5 全部真实引擎测试都用它。
- **轻量权重（38 MB b10，model version 17）**：**本机当前不可用**（引擎版本过低）。保留备将来引擎 ≥ 1.17 时使用。

## 配置视角（T5 判定视角正确性的关键前提）

`analysis.cfg` 第 30 行（**生效键值，非注释**）：

```
reportAnalysisWinratesAs = BLACK
```

**含义**：本机分析返回的胜率是**黑视角** 0..1 小数。

这一点对 T5 与 plan 008 极为重要：
- KataGo 的解析逻辑（`cpp/program/setup.cpp:920-925`）：**配置含该键**则按其解析；**键缺失**才回退到 `katago analysis` 传入的默认值 `C_EMPTY`（等价 SIDETOMOVE，见 `cpp/command/analysis.cpp:141`）。
- 官方 analysis 模板（`cpp/configs/analysis_example.cfg:30`）与本机 `analysis.cfg` **都是 `= BLACK`**。
- 因此在本机环境下，`AnalysisFrameDto.winrate_black` 接收到的值**恰是黑视角**，plan 008 所述"相邻帧相减视角错乱"**在当前配置下不触发**。plan 008 的真正价值是消除对配置的隐式依赖（已在其 Why-this-matters 中更正说明）。
- **T5 必须在报告中写明用的是哪份配置及其 `reportAnalysisWinratesAs` 取值**，否则视角结论无法证伪。

## 实测跑通的命令

⚠️ **关键坑**：**不要加 `-quit-without-waiting`**。加上它引擎会立刻退出、只打印启动日志、**不产出任何分析结果**（我最初这样跑，stdout 为空、stderr 出现 `Search quitting due to no visits`）。给引擎喂 JSONL 后它会在处理完请求后自行退出。

```bash
K="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/macos-arm64/katago"
W="/Applications/LizzieYzy Next.app/Contents/app/weights/default.bin.gz"
C="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/configs/analysis.cfg"

# 单点分析（19x19，黑 D4 后分析第 1 手）
echo '{"id":"t1","moves":[["B","D4"]],"rules":"chinese","komi":7.5,"boardXSize":19,"boardYSize":19,"analyzeTurns":[1],"maxVisits":5}' \
  | "$K" analysis -config "$C" -model "$W"
```

### 真实 stdout 片段（19x19，单点）

```json
{"id":"t1","isDuringSearch":false,"moveInfos":[{"edgeVisits":2,"edgeWeight":6.25030032,"lcb":0.877444562,"move":"Q16","order":0,"prior":0.306903511,"pv":["Q16","D16"],"scoreLead":-0.846202427,"scoreMean":-0.846202427,"scoreStdev":13.8977315,"visits":2,"winrate":0.345025576}, ...],"rootInfo":{"winrate":0.34573936,"visits":5,"scoreLead":-0.864772673}
```

**单位确认**：`winrate` / `prior` / `lcb` 是 **0..1 小数**；`scoreLead` / `scoreMean` / `scoreStdev` 是**目数**（不缩放）；`rootInfo` 与 `moveInfos` 均存在。与本仓库 `katago-protocol` 的小数约定一致，**不要乘 100**。

### 让子局端到端（T2 修复的核心验证）

9x9 让三子 + 日本规则（对应 `tests/golden/handicap_9x9.sgf`）：

```bash
# 修复后行为：带 initialStones
echo '{"id":"with","initialStones":[["B","C7"],["B","C3"],["B","G3"]],"moves":[["W","E5"],["B","G7"],["W","C5"]],"rules":"japanese","komi":0.5,"boardXSize":9,"boardYSize":9,"analyzeTurns":[3],"maxVisits":100}' \
  | "$K" analysis -config "$C" -model "$W"
```

**对照实验（maxVisits=100，同一局面）**：

| 查询 | `rootInfo.winrate`（黑视角，0..1） | `scoreLead` | 
|---|---|---|
| **带 `initialStones`（T2 修复后）** | **0.999940** | **+31.129** |
| 不带 `initialStones`（T2 修复前行为） | **0.003212** | **-6.965** |

**结论**：发/不发摆子会让同一局面的分析结论**完全相反**（黑大胜 ↔ 黑大败）。这实证了 plans/001 的修复价值，也说明修复前让子谱的分析结果是**方向性错误**，而不仅是数值偏差。

> 复现提示：`maxVisits` 太小（如 5）时结果噪声大；用 `100` 以上可得到稳定区分。

## 边界与注意事项

1. **`/Applications/LizzieYzy Next.app` 是另一个应用**（Java 版 LizzieYzy Next）的安装目录，**不是本仓库的构建产物**。我们仅**借用**其引擎二进制与权重用于本地验证。**不要修改 bundle 内任何文件**，也不要把它的存在当作本仓库的打包能力证据。
2. **不要提交大文件进 git**：上述权重（259 MB / 38 MB）均在仓库外，勿复制入工作树。
3. **brew 状态**：`katago` formula **未安装**（`brew list katago` 报 `No such keg`）。残留的未完成 `.part` 下载已被清理；不再有下载进程。若将来仍需 brew 版，需自行处理网络稳定性（362 MB bottle、ghcr.io 限速）。
4. **`gtp.cfg` 与 `analysis.cfg` 不可混用**：`katago analysis` 必须用 analysis 配置。用户 `~/Downloads/katago_generic.cfg` 是 GTP 配置（`logDir = gtp_logs`，无 `numAnalysisThreads`），**不能**直接用于 analysis 子命令。
5. **⚠️ `logDir` 是相对路径，会污染你的 cwd（实测踩过两次）**：bundle 配置第 11 行是 `logDir = analysis_logs  # Each run of KataGo will log to a separate file in this dir`——**相对路径，相对启动时的 cwd**。
   - **后果**：若在**仓库根** cwd 跑引擎，会在仓库内创建 `./analysis_logs/`（内含 `*.log`）。它不会出现在 `git status` 里（被 `.gitignore:9` 的 `*.log` 覆盖），所以**不威胁 T2/T3 的验收断言**，但会留下脏目录。
   - **实测**：在 `/tmp` 下跑 → 日志落在 `/tmp/analysis_logs`，仓库内无污染（已验证）。
   - **建议**：跑引擎前 `cd /tmp`，或使用 env-engineer 准备的 `~/.lizzieyzy-dev/configs/app_analysis_repo_external_logdir.cfg`（已把 logDir 指向仓库外）。
   - 若已产生仓库内 `analysis_logs/`：`rm -rf analysis_logs`（env-engineer 的备份在 `~/.lizzieyzy-dev/logs-backup/`）。

## T5 复现清单（建议）

```bash
K="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/macos-arm64/katago"
W="/Applications/LizzieYzy Next.app/Contents/app/weights/default.bin.gz"
C="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/configs/analysis.cfg"

"$K" version                                    # 期望: KataGo v1.16.4 / Using Metal backend
"$K" analysis --help                            # 会打印 analysis 用法，但【退出码非 0】——KataGo 只接受 -help，--help 被视为解析错误。故不要用退出码判定，看输出即可。
echo '{"id":"t1","moves":[["B","D4"]],"rules":"chinese","komi":7.5,"boardXSize":19,"boardYSize":19,"analyzeTurns":[1],"maxVisits":5}' | "$K" analysis -config "$C" -model "$W"
                                                # 期望: stdout 含 moveInfos + rootInfo，winrate 为 0..1 小数
grep -E '^reportAnalysisWinratesAs' "$C"        # 期望: reportAnalysisWinratesAs = BLACK
shasum -a 256 "$W"                              # 期望: b37f9a56...654b
```

> **注意 `--help` 的退出码陷阱**：`"$K" analysis --help` 会正确打印用法，但退出码为 **非 0**（KataGo 的参数解析只认 `-help`，把 `--help` 当错误参数）。**不要用退出码判断子命令是否存在**，否则会误判成"环境不可用"。可靠的判定方式是**实际喂一条 JSONL 看是否产出 `rootInfo`**（上面第 3 条命令）。
