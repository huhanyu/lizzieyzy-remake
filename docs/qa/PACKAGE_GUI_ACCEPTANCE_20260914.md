# 正式包交互验收（进行中）

构建：npm run tauri:build -- --bundles app,dmg 成功。修复本地ad-hoc签名后codesign --verify --deep --strict通过，重新生成DMG且hdiutil verify通过。未进行Apple公证。

## 正式窗口已验证
- 实时分析计算量增长、候选/胜率更新。
- 第3手定位；进入试下并停一手，局面第4手实时更新。
- 试下热力图可显示；退出后恢复第3手。
- 保存试下变化新增第4手PASS分支，21→22节点。
- 另存并重新解析后22节点含PASS分支。
- 文件打开恢复20手21节点备份。

## 修复与复测
Codex补齐仅缺失时生效的numAnalysisThreads=1和nnMaxBatchSize=16，保留显式配置（含无效值，由引擎报错），不覆写用户文件；含@include配置不猜测覆盖。
正式包使用原gtp_live.cfg完成21/21局面并自动恢复实时。第二轮于4/21取消，界面显示已取消并恢复实时。此启动阻断已修复。
同时实测发现KataGo根局面返回scoreLead而非scoreMean，新增兼容解析，保留旧scoreMean并兼容同时存在两字段；对应测试通过。该追加修复已触发新包重建。

## 待测
修复后全盘完成/取消及自动恢复；短窗口布局、主题切换、候选PV与菜单移出完整回归。

用户授权验收前另存：~/Downloads/Lizzie-验收前备份-20260914.sgf。测试变化单独保存：~/Downloads/Lizzie-试下保存验收-20260914.sgf。窗口已重新打开前者，不覆盖备份。
