//! 复盘分析核心。
//!
//! ## 归因方法：`parent_child`
//!
//! [`evaluate_move_losses`] 采用 **parent_child**（父帧 / 子帧）配对方法：
//! 对每个待评估节点，取其同 `document_id` + `analysis_id` 的父节点帧作为基线，
//! 以行棋方视角计算 `child_black - parent_black` 的胜率 / 目差变化。
//!
//! 该方法**不等同于 Java 侧棋力评估**：Java 原实现包含引擎重访、多变着
//! 加权与棋力分档，这里只做冻结数学定义的父子帧差值，不对"棋力"下结论。
//!
//! 节点身份为 `(document_id, analysis_id, node_id)`：同一节点**恰好一个**结果，
//! 重复记录取 `visits` 最高者。父子关系要求 `parent.turn + 1 == child.turn`
//! （反向不成立），自引用（`parent_node_id == node_id`）视为未知。
//!
//! 严重度阈值复用既有 [`severity_for`]，不在此处另立阈值配置。

use app_model::{AnalysisFrameDto, PlayerColor, ProblemMarkerDto, ProblemSeverity};
use std::cmp::Reverse;
use std::collections::HashSet;

/// 一个待评估节点及其显式分析上下文。
///
/// 上下文是**显式**传入的：核心不猜测父帧、不猜测走棋方。
/// 任何一项缺失都会让该节点落入 `unknown_reason`，而不是产生错误归因。
#[derive(Debug, Clone)]
pub struct ReviewedPosition {
    /// 所属文档（棋谱）标识。父帧必须与之相同。
    pub document_id: String,
    /// 分析任务标识。父帧必须与之相同，避免跨次分析误配。
    pub analysis_id: String,
    /// 当前节点标识。
    pub node_id: String,
    /// 父节点标识。`None` 表示根节点或上下文缺失。
    pub parent_node_id: Option<String>,
    /// 该节点对应的行棋方。`None` 表示不足以判断。
    pub mover: Option<PlayerColor>,
    /// 该节点的分析帧。
    pub frame: AnalysisFrameDto,
}

/// 单个节点的评估结果：每个输入节点恰好一个结果。
#[derive(Debug, Clone, PartialEq)]
pub struct MoveLossReview {
    /// 对应 [`ReviewedPosition::node_id`]。
    pub node_id: String,
    /// 行棋方视角的损失（负值已截零）。无法评估时为 `None`。
    pub loss: Option<MoveLoss>,
    /// 无法归因时的原因；可评估时为 `None`。
    pub unknown_reason: Option<String>,
}

/// 行棋方视角的一次损失。
#[derive(Debug, Clone, PartialEq)]
pub struct MoveLoss {
    /// 行棋方视角的胜率损失，`>= 0.0`。
    pub winrate_loss: f32,
    /// 行棋方视角的目差损失，`>= 0.0`。
    pub score_loss: f32,
    /// 复用 [`severity_for`] 得到的分级。
    pub severity: ProblemSeverity,
    /// 分级对应的标签。
    pub label: &'static str,
    /// 该节点实际的行棋方。
    pub mover: PlayerColor,
}

/// 按 visits 降序排序候选着法。
pub fn sort_candidates_by_visits(frame: &mut AnalysisFrameDto) {
    frame
        .candidates
        .sort_by_key(|candidate| Reverse(candidate.visits));
}

/// 以 `parent_child` 方法评估每个节点的行棋损失。
///
/// 节点身份为 `(document_id, analysis_id, node_id)` 三元组：**同一节点恰好一个**
/// [`MoveLossReview`]。输入中同一节点出现多条时（例如同一局面的多次分析更新），
/// 只取 `visits` 最高者参与评估，不产生重复结果；输出顺序按各节点**首次出现**的
/// 顺序排列。
///
/// 可用局面必须同时满足：存在同 `document_id` + `analysis_id` 且
/// `node_id == parent_node_id` 的父帧、`parent_node_id` 不等于自身、`mover` 明确、
/// 父帧回合 +1 恰好等于子帧回合（反向即不相邻）、
/// 双方 `winrate_black` 与 `score_mean_black` 均为有限的 `0..=1` / 有限实数。
///
/// 同一 `parent_node_id` 出现多个父帧候选时，选 `visits` 最高者。
/// 黑方损失 = `parent_black - child_black`；白方损失 = `child_black - parent_black`；
/// 负值截零。目差同向处理。
pub fn evaluate_move_losses(positions: &[ReviewedPosition]) -> Vec<MoveLossReview> {
    let mut seen: HashSet<(&str, &str, &str)> = HashSet::new();
    let mut out = Vec::new();
    for position in positions {
        let key = (
            position.document_id.as_str(),
            position.analysis_id.as_str(),
            position.node_id.as_str(),
        );
        if !seen.insert(key) {
            continue;
        }
        // 同一节点有多条记录时，只有 visits 最高者代表该节点。
        let best = positions
            .iter()
            .filter(|candidate| {
                candidate.document_id == position.document_id
                    && candidate.analysis_id == position.analysis_id
                    && candidate.node_id == position.node_id
            })
            .max_by_key(|candidate| candidate.frame.visits)
            .unwrap_or(position);
        out.push(evaluate_one(best, positions));
    }
    out
}

fn evaluate_one(position: &ReviewedPosition, all: &[ReviewedPosition]) -> MoveLossReview {
    let node_id = position.node_id.clone();
    let unknown = |reason: &str| MoveLossReview {
        node_id: node_id.clone(),
        loss: None,
        unknown_reason: Some(reason.to_string()),
    };

    // 走棋方必须显式给出，否则不足以判断谁损失。
    let Some(mover) = position.mover else {
        return unknown("缺少走棋方，不足以判断");
    };

    // 父节点标识必须显式给出。
    let Some(parent_node_id) = position.parent_node_id.as_deref() else {
        return unknown("缺少父节点标识");
    };

    // 自引用不是有效的父子关系：把节点当作自己的父帧会退化为零损失。
    if parent_node_id == position.node_id {
        return unknown("父子节点相同，不是有效的父子关系");
    }

    // 子帧数值必须有效。
    if let Err(reason) = validate_frame(&position.frame) {
        return unknown(reason);
    }

    // 父帧必须同 document + 同 analysis，且 node_id 匹配；多条候选取最高 visits。
    let parent = all
        .iter()
        .filter(|candidate| {
            candidate.document_id == position.document_id
                && candidate.analysis_id == position.analysis_id
                && candidate.node_id == parent_node_id
        })
        .max_by_key(|candidate| candidate.frame.visits);

    let Some(parent) = parent else {
        return unknown("未找到同文档同分析的父帧");
    };

    if let Err(reason) = validate_frame(&parent.frame) {
        return unknown(reason);
    }

    // 父子回合必须**正向**相邻：parent.turn + 1 == child.turn。
    // 反向（父帧手数大于子帧，abs_diff 同样为 1）不构成父子关系。
    if parent.frame.turn.checked_add(1) != Some(position.frame.turn) {
        return unknown("父子回合不相邻");
    }

    // 行棋方视角的损失：负值截零。
    let (winrate_loss, score_loss) = match mover {
        PlayerColor::Black => (
            parent.frame.winrate_black - position.frame.winrate_black,
            parent.frame.score_mean_black - position.frame.score_mean_black,
        ),
        PlayerColor::White => (
            position.frame.winrate_black - parent.frame.winrate_black,
            position.frame.score_mean_black - parent.frame.score_mean_black,
        ),
    };
    let winrate_loss = winrate_loss.max(0.0);
    let score_loss = score_loss.max(0.0);
    let severity = severity_for(winrate_loss, score_loss);

    MoveLossReview {
        node_id,
        loss: Some(MoveLoss {
            winrate_loss,
            score_loss,
            severity,
            label: label_for(severity),
            mover,
        }),
        unknown_reason: None,
    }
}

/// 帧数值必须有限且胜率落在 `0..=1`。
fn validate_frame(frame: &AnalysisFrameDto) -> Result<(), &'static str> {
    if !frame.winrate_black.is_finite() || !(0.0..=1.0).contains(&frame.winrate_black) {
        return Err("胜率非法或超出 0..1");
    }
    if !frame.score_mean_black.is_finite() {
        return Err("目差非法");
    }
    Ok(())
}

/// 旧接口：仅凭帧序列无法确定走棋方，故不再归因。
///
/// 结构性缺陷：`windows(2)` 配对既不知道父子关系，也不知道谁行棋，
/// **不足以判断**损失归属。生产路径应改用 [`evaluate_move_losses`]。
/// 该函数保留签名以兼容既有调用点，但恒返回空。
pub fn classify_problem_markers(_frames: &[AnalysisFrameDto]) -> Vec<ProblemMarkerDto> {
    // 缺少走棋方等显式上下文，不足以判断，故不产生任何标记。
    Vec::new()
}

pub fn severity_for(winrate_loss: f32, score_loss: f32) -> ProblemSeverity {
    if winrate_loss >= 0.18 || score_loss >= 12.0 {
        ProblemSeverity::Blunder
    } else if winrate_loss >= 0.10 || score_loss >= 7.0 {
        ProblemSeverity::Mistake
    } else if winrate_loss >= 0.05 || score_loss >= 3.0 {
        ProblemSeverity::Inaccuracy
    } else {
        ProblemSeverity::Info
    }
}
fn label_for(severity: ProblemSeverity) -> &'static str {
    match severity {
        ProblemSeverity::Info => "正常波动",
        ProblemSeverity::Inaccuracy => "疑似缓手",
        ProblemSeverity::Mistake => "明显问题手",
        ProblemSeverity::Blunder => "重大失误",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_model::AnalysisFrameDto;
    use uuid::Uuid;

    fn f(t: u32, w: f32, s: f32) -> AnalysisFrameDto {
        AnalysisFrameDto {
            job_id: Uuid::new_v4(),
            game_id: None,
            node_id: None,
            turn: t,
            visits: 100,
            winrate_black: w,
            score_mean_black: s,
            score_stdev: None,
            candidates: vec![],
            ownership: None,
            policy: None,
        }
    }

    fn with_visits(mut frame: AnalysisFrameDto, visits: u32) -> AnalysisFrameDto {
        frame.visits = visits;
        frame
    }

    fn pos(
        node: &str,
        parent: Option<&str>,
        mover: Option<PlayerColor>,
        frame: AnalysisFrameDto,
    ) -> ReviewedPosition {
        ReviewedPosition {
            document_id: "doc-1".into(),
            analysis_id: "ana-1".into(),
            node_id: node.into(),
            parent_node_id: parent.map(str::to_string),
            mover,
            frame,
        }
    }

    #[test]
    fn no_context_no_attribution() {
        // 旧测试改为：无上下文不归因。
        let markers = classify_problem_markers(&[f(1, 0.62, 3.0), f(2, 0.48, -5.0)]);
        assert!(
            markers.is_empty(),
            "缺少走棋方时不足以判断，必须返回空而不是猜测归因"
        );
    }

    #[test]
    fn black_blunder_and_white_blunder_are_symmetric() {
        // 黑方坏手：黑胜率 0.62 -> 0.40，损失 0.22（>=0.18 = Blunder）。
        let black = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::White), f(1, 0.62, 3.0)),
            pos("c", Some("p"), Some(PlayerColor::Black), f(2, 0.40, -5.0)),
        ]);
        let black_loss = black[1].loss.as_ref().expect("黑方局面应可评估");
        assert!((black_loss.winrate_loss - 0.22).abs() < 1e-6);
        assert_eq!(black_loss.severity, ProblemSeverity::Blunder);
        assert_eq!(black_loss.mover, PlayerColor::Black);

        // 白方坏手：黑胜率 0.40 -> 0.62，白损失同为 0.22。
        let white = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::Black), f(1, 0.40, 5.0)),
            pos("c", Some("p"), Some(PlayerColor::White), f(2, 0.62, -3.0)),
        ]);
        let white_loss = white[1].loss.as_ref().expect("白方局面应可评估");
        assert!((white_loss.winrate_loss - 0.22).abs() < 1e-6);
        assert_eq!(white_loss.severity, ProblemSeverity::Blunder);
        assert_eq!(white_loss.mover, PlayerColor::White);
    }

    #[test]
    fn improvement_clamps_loss_to_zero() {
        // 黑胜率 0.40 -> 0.60 是改善，损失截零 => Info。
        let out = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::White), f(1, 0.40, -3.0)),
            pos("c", Some("p"), Some(PlayerColor::Black), f(2, 0.60, 4.0)),
        ]);
        let loss = out[1].loss.as_ref().expect("改善局面应可评估");
        assert_eq!(loss.winrate_loss, 0.0);
        assert_eq!(loss.score_loss, 0.0);
        assert_eq!(loss.severity, ProblemSeverity::Info);
    }

    #[test]
    fn duplicate_parent_nodes_pick_highest_visits() {
        let out = evaluate_move_losses(&[
            // 低 visits 父帧：会造成 Blunder。
            pos(
                "p",
                None,
                Some(PlayerColor::White),
                with_visits(f(1, 0.62, 3.0), 10),
            ),
            // 高 visits 父帧：只看 0.01 损失。
            pos(
                "p",
                None,
                Some(PlayerColor::White),
                with_visits(f(1, 0.41, 1.0), 900),
            ),
            pos("c", Some("p"), Some(PlayerColor::Black), f(2, 0.40, 0.5)),
        ]);
        // 重复父帧本身也被去重：p 只产出一条，交给 p 的结果同样取最高 visits 父帧。
        assert_eq!(out.len(), 2, "重复父节点应被去重");
        let review = out
            .iter()
            .find(|review| review.node_id == "c")
            .expect("子节点应产出结果");
        let loss = review.loss.as_ref().expect("应可评估");
        assert!((loss.winrate_loss - 0.01).abs() < 1e-6);
        assert_eq!(loss.severity, ProblemSeverity::Info);
    }

    #[test]
    fn cross_document_and_cross_analysis_parent_is_rejected() {
        let mut other_doc = pos("p", None, Some(PlayerColor::White), f(1, 0.62, 3.0));
        other_doc.document_id = "doc-2".into();
        let out = evaluate_move_losses(&[
            other_doc,
            pos("c", Some("p"), Some(PlayerColor::Black), f(2, 0.40, -5.0)),
        ]);
        assert!(out[1].loss.is_none());
        assert!(out[1].unknown_reason.is_some());

        let mut other_analysis = pos("p", None, Some(PlayerColor::White), f(1, 0.62, 3.0));
        other_analysis.analysis_id = "ana-2".into();
        let out = evaluate_move_losses(&[
            other_analysis,
            pos("c", Some("p"), Some(PlayerColor::Black), f(2, 0.40, -5.0)),
        ]);
        assert!(out[1].loss.is_none());
        assert!(out[1].unknown_reason.is_some());
    }

    #[test]
    fn missing_parent_reports_unknown() {
        let out = evaluate_move_losses(&[pos(
            "c",
            Some("missing"),
            Some(PlayerColor::Black),
            f(2, 0.40, -5.0),
        )]);
        assert_eq!(out.len(), 1);
        assert!(out[0].loss.is_none());
        assert!(out[0].unknown_reason.is_some());
    }

    #[test]
    fn missing_mover_reports_unknown() {
        let out = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::White), f(1, 0.62, 3.0)),
            pos("c", Some("p"), None, f(2, 0.40, -5.0)),
        ]);
        assert!(out[1].loss.is_none());
        let reason = out[1].unknown_reason.as_deref().unwrap_or_default();
        assert!(reason.contains("走棋方"), "原因应指出缺走棋方: {reason}");
    }

    #[test]
    fn illegal_numbers_and_turn_gap_report_unknown() {
        // 胜率超出 0..1。
        let out = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::White), f(1, 0.62, 3.0)),
            pos("c", Some("p"), Some(PlayerColor::Black), f(2, 1.4, -5.0)),
        ]);
        assert!(out[1].loss.is_none());
        assert!(out[1].unknown_reason.is_some());

        // 目差为 NaN。
        let out = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::White), f(1, 0.62, 3.0)),
            pos("c", Some("p"), Some(PlayerColor::Black), f(2, 0.40, f32::NAN)),
        ]);
        assert!(out[1].loss.is_none());
        assert!(out[1].unknown_reason.is_some());

        // 父帧回合不相邻。
        let out = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::White), f(1, 0.62, 3.0)),
            pos("c", Some("p"), Some(PlayerColor::Black), f(4, 0.40, -5.0)),
        ]);
        assert!(out[1].loss.is_none());
        assert!(out[1].unknown_reason.is_some());
    }

    #[test]
    fn one_result_per_node_in_input_order() {
        let out = evaluate_move_losses(&[
            pos("a", Some("b"), Some(PlayerColor::Black), f(2, 0.40, -5.0)),
            pos("b", None, Some(PlayerColor::White), f(1, 0.62, 3.0)),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].node_id, "a");
        assert_eq!(out[1].node_id, "b");
    }

    #[test]
    fn duplicate_child_nodes_are_deduplicated_by_node_identity() {
        // 同一 (document, analysis, node) 的子帧重复出现：只允许一个结果。
        // 契约是"每个节点恰好一次"，重复子帧不得输出多条。
        let out = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::White), f(1, 0.62, 3.0)),
            pos("c", Some("p"), Some(PlayerColor::Black), f(2, 0.40, -5.0)),
            pos("c", Some("p"), Some(PlayerColor::Black), f(2, 0.41, -4.0)),
        ]);
        let for_c: Vec<_> = out.iter().filter(|review| review.node_id == "c").collect();
        assert_eq!(for_c.len(), 1, "同一节点必须只产出一条结果");
        assert_eq!(out.len(), 2, "输出节点数应等于去重后的节点数");
        // 首次出现的顺序保持。
        assert_eq!(out[0].node_id, "p");
        assert_eq!(out[1].node_id, "c");
    }

    #[test]
    fn duplicate_child_keeps_highest_visits_record() {
        // 重复子帧取 visits 最高者参与评估，而不是第一条或最后一条。
        let out = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::White), f(1, 0.62, 3.0)),
            // 低 visits：看似 Blunder。
            pos(
                "c",
                Some("p"),
                Some(PlayerColor::Black),
                with_visits(f(2, 0.40, -5.0), 10),
            ),
            // 高 visits：实际只有 0.01 损失。
            pos(
                "c",
                Some("p"),
                Some(PlayerColor::Black),
                with_visits(f(2, 0.61, 2.0), 900),
            ),
        ]);
        let review = out
            .iter()
            .find(|review| review.node_id == "c")
            .expect("重复节点应产出唯一结果");
        let loss = review.loss.as_ref().expect("应可评估");
        assert!((loss.winrate_loss - 0.01).abs() < 1e-6);
        assert_eq!(loss.severity, ProblemSeverity::Info);
    }

    #[test]
    fn duplicate_node_in_other_document_is_a_distinct_node() {
        // 去重键包含 document/analysis：不同文档的同名 node 是不同节点。
        let mut other_doc = pos(
            "c",
            Some("p"),
            Some(PlayerColor::Black),
            with_visits(f(2, 0.40, -5.0), 10),
        );
        other_doc.document_id = "doc-2".into();
        let out = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::White), f(1, 0.62, 3.0)),
            pos("c", Some("p"), Some(PlayerColor::Black), f(2, 0.40, -5.0)),
            other_doc,
        ]);
        assert_eq!(out.len(), 3, "跨文档的同名节点不得被合并");
    }

    #[test]
    fn reverse_turn_direction_reports_unknown() {
        // 父帧手数大于子帧：abs_diff 同样是 1，但这不是父子关系。
        let out = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::Black), f(5, 0.62, 3.0)),
            pos("c", Some("p"), Some(PlayerColor::White), f(4, 0.40, -5.0)),
        ]);
        assert!(out[1].loss.is_none(), "反向手数必须未知");
        assert_eq!(out[1].unknown_reason.as_deref(), Some("父子回合不相邻"));
    }

    #[test]
    fn forward_turn_direction_is_accepted() {
        // 正向相邻（parent + 1 == child）必须可评估，确认未把方向修反。
        let out = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::White), f(4, 0.62, 3.0)),
            pos("c", Some("p"), Some(PlayerColor::Black), f(5, 0.40, -5.0)),
        ]);
        assert!(out[1].loss.is_some(), "正向相邻应可评估");
    }

    #[test]
    fn turn_overflow_is_unknown_not_panic() {
        // parent.turn == u32::MAX 时 checked_add 返回 None，必须是未知而非溢出/panic。
        let out = evaluate_move_losses(&[
            pos("p", None, Some(PlayerColor::White), f(u32::MAX, 0.62, 3.0)),
            pos("c", Some("p"), Some(PlayerColor::Black), f(0, 0.40, -5.0)),
        ]);
        assert!(out[1].loss.is_none());
        assert_eq!(out[1].unknown_reason.as_deref(), Some("父子回合不相邻"));
    }

    #[test]
    fn self_referencing_node_reports_unknown() {
        // parent_node_id == node_id 是自引用，不是有效父子关系。
        let out = evaluate_move_losses(&[pos("c", Some("c"), Some(PlayerColor::Black), f(2, 0.40, -5.0))]);
        assert_eq!(out.len(), 1);
        assert!(out[0].loss.is_none(), "自引用必须未知");
        let reason = out[0].unknown_reason.as_deref().unwrap_or_default();
        assert!(reason.contains("父子节点相同"), "原因应指出自引用: {reason}");
    }

    #[test]
    fn severity_thresholds_are_reused() {
        // 直接复用既有 severity_for，不新增阈值配置。
        assert_eq!(severity_for(0.18, 0.0), ProblemSeverity::Blunder);
        assert_eq!(severity_for(0.10, 0.0), ProblemSeverity::Mistake);
        assert_eq!(severity_for(0.05, 0.0), ProblemSeverity::Inaccuracy);
        assert_eq!(severity_for(0.049, 0.0), ProblemSeverity::Info);
        assert_eq!(severity_for(0.0, 3.0), ProblemSeverity::Inaccuracy);
    }
}
