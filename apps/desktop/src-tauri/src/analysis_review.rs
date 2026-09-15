//! Bind batch-analysis frames to the SGF's real mainline, then grade each move.
//!
//! The batch path (`katago_analyze_game`) returns frames keyed by **turn**, not by SGF node. A
//! turn alone is not a position identity: reaching the same board by a different move order (a
//! variation) is a different node. This module is the adapter that supplies the context
//! `analysis_core::evaluate_move_losses` demands - document, analysis job, real node, real parent,
//! and the actual mover - instead of letting the caller guess it from turn parity.
//!
//! ## Turn convention (measured, not assumed)
//!
//! `frame.turn` is KataGo's `turnNumber`, carried through
//! `katago_protocol::normalize_responses_for_turns`. **`turn == N` is the position after move N has
//! been played.** `turn == 0` is the empty board, and a game of M moves yields turns `0..=M`.
//!
//! Verified against KataGo v1.18.2 directly: for `moves=[B D4, W Q16, B A1, W T19]`, the response
//! for `turnNumber 3` is the position *after* `B A1` (it collapses to `winrate 0.0068`, while
//! `turnNumber 2` and `turnNumber 4` sit at ~0.36), so `turnNumber 3` grades `B A1`.
//!
//! The SGF side is counted the same way by `SgfTreeNodeDto.move_number`, which is the number of
//! moves played **at** that node. Therefore:
//!
//! - `frame.turn == N` (N >= 1) grades the node whose `move_number == N`, and its baseline is that
//!   node's **parent** frame, i.e. `turn == N - 1`.
//! - `frame.turn == 0` grades the root, which has no move behind it and is therefore never a
//!   problem hand. It only exists when the caller explicitly analysed it.
//! - A setup or comment node has `move_number == None` and is never graded. When such a node sits
//!   between two move nodes it changes `parent_id` without consuming a turn, which is exactly why
//!   the parent is read from the tree instead of assumed from `turn - 1`.
//!
//! With this convention, move N is graded by the frame pair `(N-1, N)`: parent = position before
//! the move, child = position after it. Getting the convention backwards would grade every move
//! against the wrong position while still producing plausible-looking numbers.
//!
//! ## What is deliberately *not* done
//!
//! - **No guessing across gaps.** If the mainline has a node with no frame, that node stays
//!   unknown. Frames on either side of the gap are still graded against *their own* parent, which
//!   is correct by construction: a node is graded against its parent's frame, and the parent is
//!   known from the tree. Nothing is inferred for the frame-less node.
//! - **No mixing of jobs.** Every node's parent frame must belong to the same job as the node's own
//!   frame (`analysis_id = frame.job_id`), so a stale job's frame cannot serve as another job's
//!   baseline.
//! - **Only `Info` is filtered, nothing is fabricated.** A node that cannot be graded produces no
//!   marker; `unknown_reason` is not turned into a problem.

use analysis_core::{evaluate_move_losses, MoveLoss, ReviewedPosition};
use app_model::{AnalysisFrameDto, NodeId, ProblemMarkerDto, SgfTreeDto, SgfTreeNodeDto};
use std::collections::HashMap;

/// Grade every mainline move of `sgf_text` against its real parent position.
///
/// Returns one [`ProblemMarkerDto`] per mainline move whose loss grades above
/// [`app_model::ProblemSeverity::Info`], in mainline move order. Moves that cannot be graded
/// (missing parent frame, frame from another job, missing frame) are simply absent - never
/// reported as problems.
///
/// `document_id` is the caller's own `sgf_text`: the document identity is the exact text that was
/// analysed, so a revised SGF can never reuse another revision's review.
pub fn classify_sgf_problems(
    sgf_text: &str,
    frames: &[AnalysisFrameDto],
) -> Result<Vec<ProblemMarkerDto>, String> {
    let document = sgf::parse_sgf(sgf_text).map_err(|err| err.to_string())?;
    let tree = sgf::to_sgf_tree_dto(&document)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "SGF has no game tree".to_string())?;

    let markers = evaluate_mainline(&tree, sgf_text, frames)
        .into_iter()
        .filter(|(node, _)| node.move_number.is_some())
        .filter_map(|(node, loss)| {
            // `Info` is "normal fluctuation", not a problem hand. Filtering here rather than in the
            // core keeps the severity ladder in exactly one place.
            (loss.severity != app_model::ProblemSeverity::Info).then(|| ProblemMarkerDto {
                turn: node.move_number.unwrap_or(0),
                severity: loss.severity,
                winrate_loss: loss.winrate_loss,
                score_loss: loss.score_loss,
                label: loss.label.to_string(),
            })
        })
        .collect::<Vec<_>>();

    Ok(markers)
}

/// Every mainline node that could be graded, paired with its loss.
fn evaluate_mainline(
    tree: &SgfTreeDto,
    sgf_text: &str,
    frames: &[AnalysisFrameDto],
) -> Vec<(SgfTreeNodeDto, MoveLoss)> {
    // Every mainline node that has a matching frame is reviewed, *including the root*: the root's
    // frame (turn 0) is the baseline move 1 is measured against. The root is only excluded from
    // being *reported*, because it has no move of its own to blame.
    //
    // Only mainline nodes are reviewed, and only through frames the caller actually supplied. A
    // frame that binds to no mainline move (a turn past the end of the mainline) is dropped rather
    // than attached to the nearest node.
    let positions = tree
        .nodes
        .iter()
        .filter(|node| node.is_mainline)
        .filter_map(|node| {
            frame_turn(node)
                .and_then(|turn| best_frame_for_turn(frames, turn))
                .map(|frame| (node.clone(), reviewed_position(node, frame, sgf_text)))
        })
        .collect::<Vec<_>>();

    let by_id = positions
        .iter()
        .map(|(node, _)| (node.id, node.clone()))
        .collect::<HashMap<_, _>>();

    let reviews = positions
        .iter()
        .map(|(_, position)| position.clone())
        .collect::<Vec<_>>();

    evaluate_move_losses(&reviews)
        .into_iter()
        .filter_map(|review| {
            let node = by_id.get(&review.node_id.parse::<NodeId>().ok()?)?.clone();
            Some((node, review.loss?))
        })
        .collect()
}

/// The frame turn that describes this mainline node's position.
///
/// The root's position is the empty board, turn 0. A move node's position is reached after its own
/// move, so it is turn `move_number`. A setup or comment node sits *at* an existing position and
/// introduces no new one, so it defers to its parent - that keeps it consistent with the frames,
/// which have no entry for a board edit.
fn frame_turn(node: &SgfTreeNodeDto) -> Option<u32> {
    node.move_number.or(node.parent_id.is_none().then_some(0))
}

/// The frame to grade a turn with: the highest-`visits` record for that turn.
///
/// Repeated analysis of one turn is normal (re-runs, cached records), and the highest-visit record
/// is the most converged evaluation of that position. Ties keep the first record supplied.
fn best_frame_for_turn(frames: &[AnalysisFrameDto], turn: u32) -> Option<&AnalysisFrameDto> {
    frames
        .iter()
        .filter(|frame| frame.turn == turn)
        .max_by_key(|frame| frame.visits)
}

/// Build the explicit analysis context for one mainline node.
///
/// `mover` is the colour of the move played **at** this node (`SgfTreeNodeDto.color`): the frame
/// bound here is turn `move_number`, the position *after* that move, so the loss it carries is
/// charged to whoever just played. Getting this backwards would attribute every loss to the wrong
/// player while still producing plausible numbers.
///
/// A setup or comment node has no colour. Such a node is never bound to a frame in the first place
/// (`move_number` is `None`), so it cannot reach this function; the `None` mover is the consistent
/// fallback that makes `evaluate_move_losses` report the position as unknown rather than inventing
/// an owner.
fn reviewed_position(node: &SgfTreeNodeDto, frame: &AnalysisFrameDto, sgf_text: &str) -> ReviewedPosition {
    ReviewedPosition {
        document_id: sgf_text.to_string(),
        analysis_id: frame.job_id.to_string(),
        node_id: node.id.to_string(),
        // The root is the one node without a parent. `evaluate_move_losses` documents a
        // self-reference as invalid rather than a zero loss, so collapse both cases to `None`.
        parent_node_id: match node.parent_id {
            Some(parent_id) if parent_id != node.id => Some(parent_id.to_string()),
            _ => None,
        },
        mover: node.color,
        frame: frame.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_model::{PlayerColor, ProblemSeverity};
    use uuid::Uuid;

    /// A 3-move mainline: black, white, black. Every test that needs "the real move order" uses
    /// this document, because the whole point of the module is to read the order out of the SGF.
    const BLACK_WHITE_BLACK: &str = "(;GM[1]FF[4]SZ[19]KM[7.5];B[dd];W[pp];B[dp])";
    /// The same moves with a colourless comment node wedged before the last move. The comment node
    /// shifts `parent_id` without contributing a move number.
    const WITH_COMMENT_NODE: &str = "(;GM[1]FF[4]SZ[19]KM[7.5]C[root];B[dd];W[pp];C[note];B[dp])";
    /// White moves first (handicap-style `PL[W]`), so nothing may assume black opens.
    const WHITE_FIRST: &str = "(;GM[1]FF[4]SZ[19]KM[0.5]AB[dd][pp]PL[W];W[pq];B[qq];W[qp])";

    fn frame(
        job_id: Uuid,
        turn: u32,
        winrate_black: f32,
        score_mean_black: f32,
        visits: u32,
    ) -> AnalysisFrameDto {
        AnalysisFrameDto {
            job_id,
            game_id: None,
            node_id: None,
            turn,
            visits,
            winrate_black,
            score_mean_black,
            score_stdev: None,
            candidates: vec![],
            ownership: None,
            policy: None,
        }
    }

    fn tree_of(sgf_text: &str) -> SgfTreeDto {
        let document = sgf::parse_sgf(sgf_text).unwrap();
        sgf::to_sgf_tree_dto(&document).unwrap().unwrap()
    }

    /// The id of the mainline node whose move number is `move_number`.
    fn node_of(sgf_text: &str, move_number: u32) -> String {
        tree_of(sgf_text)
            .nodes
            .iter()
            .find(|node| node.is_mainline && node.move_number == Some(move_number))
            .unwrap_or_else(|| panic!("no mainline node for move {move_number}"))
            .id
            .to_string()
    }

    /// The reviewed positions the module builds, exposed so the context can be asserted directly.
    fn reviews(sgf_text: &str, frames: &[AnalysisFrameDto]) -> Vec<ReviewedPosition> {
        tree_of(sgf_text)
            .nodes
            .iter()
            .filter(|node| node.is_mainline)
            .filter_map(|node| {
                frame_turn(node)
                    .and_then(|turn| best_frame_for_turn(frames, turn))
                    .map(|frame| reviewed_position(node, frame, sgf_text))
            })
            .collect()
    }

    #[test]
    fn same_sgf_binds_each_move_to_its_real_colour() {
        // The frame with turn == N grades the node whose move_number is N, so the mover is that
        // node's own colour - read from the SGF, never inferred from turn parity.
        let job = Uuid::new_v4();
        let frames = vec![
            frame(job, 1, 0.62, 3.0, 100),
            frame(job, 2, 0.48, -5.0, 100),
            frame(job, 3, 0.30, -12.0, 100),
        ];
        let positions = reviews(BLACK_WHITE_BLACK, &frames);
        assert_eq!(positions.len(), 3);
        assert_eq!(
            positions
                .iter()
                .map(|position| position.mover.unwrap())
                .collect::<Vec<_>>(),
            vec![PlayerColor::Black, PlayerColor::White, PlayerColor::Black],
            "each frame must be graded for the player who actually made that move"
        );
        // Parents come from the SGF's real links.
        assert_eq!(
            positions[0].parent_node_id.as_deref(),
            Some(tree_of(BLACK_WHITE_BLACK).root_id.to_string().as_str()),
            "move 1's parent is the root node"
        );
        assert_eq!(
            positions[1].parent_node_id.as_deref(),
            Some(node_of(BLACK_WHITE_BLACK, 1).as_str())
        );
        assert_eq!(
            positions[2].parent_node_id.as_deref(),
            Some(node_of(BLACK_WHITE_BLACK, 2).as_str())
        );
    }

    #[test]
    fn white_first_sgf_is_graded_for_white_not_black() {
        // Nothing may assume black opens. White plays move 1 here, so move 1 is judged for white.
        let job = Uuid::new_v4();
        let frames = vec![frame(job, 1, 0.62, 3.0, 100), frame(job, 2, 0.44, -6.0, 100)];
        let positions = reviews(WHITE_FIRST, &frames);
        assert_eq!(
            positions
                .iter()
                .map(|position| position.mover.unwrap())
                .collect::<Vec<_>>(),
            vec![PlayerColor::White, PlayerColor::Black]
        );

        // `WHITE_FIRST` is `;W[pq];B[qq];W[qp]`, so white moves 1 and 3, black moves 2. A 3-move
        // game yields turns 0..=3.
        //
        // `winrate_black` rising means black is doing better, i.e. the mover is losing; each loss
        // below is read in the mover's own terms, which is what makes a white-first game come out
        // right without ever assuming black opened:
        // - turn 0 -> 1: black 0.44 -> 0.62, so white's move 1 lost 0.18.
        // - turn 1 -> 2: black 0.62 -> 0.44, so black's move 2 lost 0.18.
        // - turn 2 -> 3: black 0.44 -> 0.20, so white's move 3 gained 0.24 - not reported.
        let frames = vec![
            frame(job, 0, 0.44, -6.0, 100),
            frame(job, 1, 0.62, 3.0, 100),
            frame(job, 2, 0.44, -6.0, 100),
            frame(job, 3, 0.20, -12.0, 100),
        ];
        let markers = classify_sgf_problems(WHITE_FIRST, &frames).unwrap();
        assert_eq!(markers.len(), 2, "{markers:?}");
        assert_eq!(markers[0].turn, 1, "white's move 1 lost 0.18: {markers:?}");
        assert!((markers[0].winrate_loss - 0.18).abs() < 1e-6, "{:?}", markers[0]);
        assert_eq!(markers[0].severity, ProblemSeverity::Blunder);
        assert_eq!(markers[1].turn, 2, "black's move 2 lost 0.18: {markers:?}");
        assert!((markers[1].winrate_loss - 0.18).abs() < 1e-6, "{:?}", markers[1]);
        assert!(
            markers.iter().all(|marker| marker.turn != 3),
            "white improved on move 3, so it is not a problem: {markers:?}"
        );

        // Flipping the last frame makes white lose on move 3, confirming the attribution follows
        // the actual mover rather than a fixed colour.
        let flipped = vec![
            frame(job, 0, 0.44, -6.0, 100),
            frame(job, 1, 0.62, 3.0, 100),
            frame(job, 2, 0.44, -6.0, 100),
            frame(job, 3, 0.76, 8.0, 100),
        ];
        let markers = classify_sgf_problems(WHITE_FIRST, &flipped).unwrap();
        let move_three = markers
            .iter()
            .find(|marker| marker.turn == 3)
            .expect("white's move 3 is now a loss");
        assert!((move_three.winrate_loss - 0.32).abs() < 1e-6, "{move_three:?}");
        assert_eq!(move_three.severity, ProblemSeverity::Blunder);

        // With the same two frames but white improving on move 1, move 1 must not be reported -
        // confirming the attribution follows the actual mover rather than a fixed colour.
        let improving = vec![frame(job, 0, 0.62, 3.0, 100), frame(job, 1, 0.44, -6.0, 100)];
        let markers = classify_sgf_problems(WHITE_FIRST, &improving).unwrap();
        assert!(
            markers.iter().all(|marker| marker.turn != 1),
            "white improved on move 1, so it is not white's problem: {markers:?}"
        );
    }

    #[test]
    fn black_and_white_losses_use_the_actual_mover() {
        // Black plays move 1, white plays move 2. Each loss is measured in that player's own terms:
        // black loss = parent_black - child_black, white loss = child_black - parent_black.
        let job = Uuid::new_v4();
        let losing = vec![
            // Turn 0 is the empty board, black's baseline for move 1.
            frame(job, 0, 0.76, 7.0, 100),
            // Black's move: black winrate 0.76 -> 0.62, black loses 0.14.
            frame(job, 1, 0.62, 3.0, 100),
            // White's move: black winrate 0.62 -> 0.80, white loses 0.18.
            frame(job, 2, 0.80, 2.0, 100),
        ];
        let markers = classify_sgf_problems(BLACK_WHITE_BLACK, &losing).unwrap();
        assert_eq!(markers.len(), 2, "both moves are losses: {markers:?}");
        assert_eq!(markers[0].turn, 1);
        assert!((markers[0].winrate_loss - 0.14).abs() < 1e-6, "{:?}", markers[0]);
        assert_eq!(markers[0].severity, ProblemSeverity::Mistake);
        assert_eq!(markers[1].turn, 2);
        assert!((markers[1].winrate_loss - 0.18).abs() < 1e-6, "{:?}", markers[1]);
        assert_eq!(markers[1].severity, ProblemSeverity::Blunder);

        // Reversing the direction turns both into improvements, which are not problems at all.
        let improving = vec![
            frame(job, 0, 0.30, -8.0, 100),
            frame(job, 1, 0.48, -5.0, 100),
            frame(job, 2, 0.30, -8.0, 100),
        ];
        let markers = classify_sgf_problems(BLACK_WHITE_BLACK, &improving).unwrap();
        assert!(markers.is_empty(), "improvements are not problems: {markers:?}");
    }

    #[test]
    fn cross_job_frames_are_never_mixed() {
        // Turn 1 was produced by a different job. A stale run's frame must not become turn 2's
        // baseline, and the mismatched frame must not be graded at all.
        let job = Uuid::new_v4();
        let stale = Uuid::new_v4();
        // Turn 0 comes from the *current* job, so move 1 is reviewable; turn 1 comes from a stale
        // job, so move 2's baseline is missing and must not be substituted.
        let frames = vec![
            frame(job, 0, 0.70, 5.0, 100),
            frame(stale, 1, 0.30, -9.0, 900),
            frame(job, 2, 0.10, -20.0, 100),
        ];
        let markers = classify_sgf_problems(BLACK_WHITE_BLACK, &frames).unwrap();
        // Move 1's baseline is turn 0 (same job) and move 1 is unknown because its own frame is
        // the stale one; move 2's baseline (turn 1) is stale, so it is unknown too.
        assert!(
            markers.is_empty(),
            "a parent frame from another job must yield unknown, not a fabricated loss: {markers:?}"
        );

        // The review really did see move 2, so the empty result is the job guard and not a failed
        // lookup.
        let positions = reviews(BLACK_WHITE_BLACK, &frames);
        assert_eq!(positions.len(), 3, "turns 0, 1 and 2 were reviewed");
        let evaluations = analysis_core::evaluate_move_losses(&positions);
        let for_move_two = evaluations
            .iter()
            .find(|review| review.node_id == node_of(BLACK_WHITE_BLACK, 2))
            .expect("move 2 was reviewed");
        assert!(for_move_two.loss.is_none());
        assert_eq!(
            for_move_two.unknown_reason.as_deref(),
            Some("未找到同文档同分析的父帧")
        );
    }

    #[test]
    fn missing_frame_does_not_guess_across_the_gap() {
        // Frames exist for turns 0 and 1 only. Turn 1 grades move 1, a real loss; move 2 has no
        // frame of its own and must simply be absent, not bridged from move 1's frame.
        let job = Uuid::new_v4();
        let frames = vec![frame(job, 0, 0.62, 3.0, 100), frame(job, 1, 0.30, -9.0, 100)];
        let markers = classify_sgf_problems(WITH_COMMENT_NODE, &frames).unwrap();
        assert_eq!(markers.len(), 1, "only move 1 is gradeable: {markers:?}");
        assert_eq!(markers[0].turn, 1);
        assert_eq!(markers[0].severity, ProblemSeverity::Blunder);
        assert!(best_frame_for_turn(&frames, 2).is_none(), "move 2 has no frame");

        // The comment node has no move number, so it can never be bound to a frame - and move 3's
        // real parent link still points at the comment node, which is why the tree, not `turn - 1`,
        // is the source of the parent.
        let tree = tree_of(WITH_COMMENT_NODE);
        let comment = tree
            .nodes
            .iter()
            .find(|node| node.comment.as_deref() == Some("note"))
            .expect("comment node");
        assert_eq!(comment.move_number, None);
        let move_three = tree
            .nodes
            .iter()
            .find(|node| node.is_mainline && node.move_number == Some(3))
            .unwrap();
        assert_eq!(
            move_three.parent_id.map(|id| id.to_string()),
            Some(comment.id.to_string()),
            "the comment node sits between move 2 and move 3"
        );
    }

    #[test]
    fn a_gap_still_reviews_the_frames_on_either_side() {
        // Frames for turns 0 and 2, none for turn 1. Move 2's parent turn is 1, which has no frame,
        // so move 2 stays unknown; the gap is not bridged.
        let job = Uuid::new_v4();
        let frames = vec![frame(job, 0, 0.62, 3.0, 100), frame(job, 2, 0.30, -9.0, 100)];
        let markers = classify_sgf_problems(BLACK_WHITE_BLACK, &frames).unwrap();
        assert!(markers.is_empty(), "move 2 has no parent frame: {markers:?}");

        let positions = reviews(BLACK_WHITE_BLACK, &frames);
        assert_eq!(positions.len(), 2, "turns 0 and 2 were both reviewed");
        assert_eq!(positions[1].node_id, node_of(BLACK_WHITE_BLACK, 2));
    }

    #[test]
    fn root_turn_zero_is_never_reported_as_a_problem() {
        // Turn 0 is the empty position. A loss is defined relative to a *played* move, so the root
        // can never itself be a problem hand, however extreme its frame. It still serves as the
        // baseline move 1 is measured against.
        let job = Uuid::new_v4();
        let frames = vec![frame(job, 0, 0.90, 20.0, 900), frame(job, 1, 0.40, -5.0, 100)];
        let markers = classify_sgf_problems(BLACK_WHITE_BLACK, &frames).unwrap();
        assert_eq!(
            markers.iter().map(|marker| marker.turn).collect::<Vec<_>>(),
            vec![1],
            "move 1 is the loss, the root is only the baseline: {markers:?}"
        );
        assert!((markers[0].winrate_loss - 0.50).abs() < 1e-6, "{:?}", markers[0]);
    }

    #[test]
    fn variation_frames_are_not_attached_to_the_mainline() {
        // Turn 3 exists on the mainline (`B[qp]`) and on a variation (`B[pp]`). A frame bound to
        // turn 3 is graded once, for the mainline node; the variation never sees it.
        let job = Uuid::new_v4();
        let frames = vec![frame(job, 2, 0.62, 3.0, 100), frame(job, 3, 0.30, -12.0, 100)];
        let sgf_text = "(;GM[1]FF[4]SZ[19]KM[7.5];B[dd];W[pp](;B[qp])(;B[pp]))";
        let markers = classify_sgf_problems(sgf_text, &frames).unwrap();
        assert_eq!(markers.len(), 1, "{markers:?}");
        assert_eq!(markers[0].turn, 3);
        assert_eq!(markers[0].severity, ProblemSeverity::Blunder);

        let positions = reviews(sgf_text, &frames);
        assert_eq!(positions.len(), 2, "the variation adds no reviewed position");
        assert_eq!(positions[1].node_id, node_of(sgf_text, 3));
    }

    #[test]
    fn highest_visits_frame_wins_per_turn() {
        // Repeated analysis of one turn: the most converged frame decides, so a low-visit false
        // alarm cannot manufacture a problem.
        let job = Uuid::new_v4();
        let frames = vec![
            frame(job, 2, 0.20, -20.0, 10),
            frame(job, 2, 0.60, 2.5, 900),
            frame(job, 3, 0.58, 2.0, 900),
        ];
        let markers = classify_sgf_problems(BLACK_WHITE_BLACK, &frames).unwrap();
        assert!(
            markers.is_empty(),
            "the 900-visit frames show no real loss: {markers:?}"
        );
    }

    #[test]
    fn info_loss_produces_no_marker() {
        let job = Uuid::new_v4();
        // 0.62 -> 0.60 is a 0.02 winrate loss, below every threshold.
        let frames = vec![frame(job, 1, 0.62, 3.0, 100), frame(job, 2, 0.60, 2.8, 100)];
        let markers = classify_sgf_problems(BLACK_WHITE_BLACK, &frames).unwrap();
        assert!(markers.is_empty(), "Info is not a problem: {markers:?}");
    }

    #[test]
    fn one_marker_per_node_in_move_order() {
        // Black moves 1 and 3, white moves 2. Black loses 0.18 on move 1, white gains it back on
        // move 2, black loses 0.20 on move 3 - so moves 1 and 3 are the two problem hands.
        let job = Uuid::new_v4();
        let frames = vec![
            frame(job, 0, 0.80, 9.0, 100),
            frame(job, 1, 0.62, 3.0, 100),
            frame(job, 2, 0.30, -12.0, 100),
            frame(job, 3, 0.10, -20.0, 100),
        ];
        let markers = classify_sgf_problems(BLACK_WHITE_BLACK, &frames).unwrap();
        assert_eq!(
            markers.iter().map(|marker| marker.turn).collect::<Vec<_>>(),
            vec![1, 3],
            "move 2 gained for white, so only black's moves are problems"
        );
    }

    #[test]
    fn invalid_sgf_is_an_error_not_an_empty_review() {
        let job = Uuid::new_v4();
        let frames = vec![frame(job, 1, 0.62, 3.0, 100)];
        assert!(classify_sgf_problems("", &frames).is_err());
        assert!(classify_sgf_problems("not an sgf", &frames).is_err());
    }

    #[test]
    fn empty_frames_produce_no_markers() {
        assert!(classify_sgf_problems(BLACK_WHITE_BLACK, &[]).unwrap().is_empty());
    }
}
