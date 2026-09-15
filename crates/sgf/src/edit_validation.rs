//! Full-tree edit validation: parse once and replay each edge once.
use super::*;

pub fn validate_sgf_tree_legality(input: &str) -> Result<(), SgfError> {
    let document = parse_sgf(input)?;
    let root = document.root.as_ref().ok_or(SgfError::Malformed)?;
    let mut pending = vec![(root, SgfReplayState::new(document.board_size)?)];
    while let Some((mut node, mut state)) = pending.pop() {
        loop {
            replay_sgf_node(node, &mut state)?;
            if !state.errors.is_empty() {
                return Err(SgfError::IllegalMove(state.errors.join("; ")));
            }
            match node.children.as_slice() {
                [] => break,
                [child] => node = child,
                children => {
                    for child in children {
                        pending.push((child, SgfReplayState {
                            board_size: state.board_size,
                            board: state.board.clone(),
                            captures_black: state.captures_black,
                            captures_white: state.captures_white,
                            to_play: state.to_play,
                            move_number: state.move_number,
                            last_move: state.last_move.clone(),
                            errors: Vec::new(),
                        }));
                    }
                    break;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_every_sibling_and_initial_setup() {
        assert!(validate_sgf_tree_legality("(;SZ[9]AB[aa];W[bb](;B[cc])(;B[aa]))").is_err());
        assert!(validate_sgf_tree_legality("(;SZ[9]AB[aa];W[bb](;B[cc])(;B[dd]))").is_ok());
    }
    #[test]
    fn catches_earlier_illegal_move_before_legal_leaf() {
        assert!(validate_sgf_tree_legality("(;SZ[9];B[aa];W[aa];B[bb])").is_err());
    }
    #[test]
    fn accepts_capture_reoccupation_and_expanded_setup_edits() {
        assert!(validate_sgf_tree_legality("(;SZ[5];B[aa];W[ba];B[];W[ab];B[];W[aa])").is_ok());
        assert!(validate_sgf_tree_legality("(;SZ[9]AB[aa][ab][ba][cc];W[ee])").is_ok());
        assert!(validate_sgf_tree_legality("(;SZ[9]AB[aa][ab][ba][ee];W[ee])").is_err());
    }

}
