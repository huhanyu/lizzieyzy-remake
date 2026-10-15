use sgf::{parse_sgf, replay_sgf_position_at_node, to_sgf_tree_dto, training_prefix};

#[test]
fn removing_application_metadata_keeps_normalized_legacy_komi() {
    for (app, komi, expected) in [("GNU Go:3.8", "375", 7.5), ("foxwq", "650", 6.5)] {
        let text = format!("(;AP[{app}]SZ[19]KM[{komi}];B[pd];W[dd])");
        let original = parse_sgf(&text).unwrap();
        assert_eq!(original.komi, expected);
        let tree = to_sgf_tree_dto(&original).unwrap().unwrap();
        let copy = training_prefix(&text, tree.nodes[1].id).unwrap();
        assert_eq!(parse_sgf(&copy.sgf_text).unwrap().komi, expected);
        assert!(!copy.sgf_text.contains("AP["));
    }
}

#[test]
fn selected_branch_keeps_setup_pass_and_history_but_removes_answers() {
    let text="\u{feff}(;FF[4]GM[1]SZ[9]KM[0.5]RU[Japanese]AB[aa][bb]PL[W]RE[B+R]C[solution];W[](;B[cc];W[dd])(;B[ee]C[play F5]TR[ff];W[ff]))";
    let tree = to_sgf_tree_dto(&parse_sgf(text).unwrap()).unwrap().unwrap();
    let node = tree
        .nodes
        .iter()
        .find(|n| !n.is_mainline && n.color.is_some())
        .unwrap();
    let before = replay_sgf_position_at_node(text, node.id).unwrap();
    let copy = training_prefix(text, node.id).unwrap();
    let after = replay_sgf_position_at_node(&copy.sgf_text, copy.node_id).unwrap();
    assert_eq!(before, after);
    assert!(after.errors.is_empty());
    assert!(copy.sgf_text.contains("AB[aa][bb]PL[W]"));
    assert!(copy.sgf_text.contains(";W[];B[ee]"));
    for secret in ["RE[", "C[", "TR[", "B[cc]", "W[ff]"] {
        assert!(!copy.sgf_text.contains(secret));
    }
    let copied = to_sgf_tree_dto(&parse_sgf(&copy.sgf_text).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(copied.nodes.len(), 3);
    assert!(copied.nodes.last().unwrap().child_ids.is_empty());
    assert!(text.contains("W[ff]"));
}

#[test]
fn captured_stones_and_ko_history_are_preserved_as_moves() {
    let text = "(;SZ[9]KM[6.5]RU[Chinese];B[ab];W[aa];B[ba];W[dd];B[ee])";
    let tree = to_sgf_tree_dto(&parse_sgf(text).unwrap()).unwrap().unwrap();
    let node = tree.nodes.iter().find(|n| n.move_number == Some(3)).unwrap();
    let copy = training_prefix(text, node.id).unwrap();
    assert_eq!(
        replay_sgf_position_at_node(text, node.id).unwrap(),
        replay_sgf_position_at_node(&copy.sgf_text, copy.node_id).unwrap()
    );
    assert!(copy.sgf_text.contains("W[aa]"));
    assert!(!copy.sgf_text.contains("W[dd]"));
}

#[test]
fn root_start_has_no_future_and_invalid_start_is_rejected() {
    let text = "(;SZ[9]AB[aa]PL[W];W[dd];B[ee])";
    let tree = to_sgf_tree_dto(&parse_sgf(text).unwrap()).unwrap().unwrap();
    let copy = training_prefix(text, tree.root_id).unwrap();
    assert_eq!(
        replay_sgf_position_at_node(&copy.sgf_text, copy.node_id)
            .unwrap()
            .move_number,
        0
    );
    assert!(!copy.sgf_text.contains("W[dd]"));
    assert!(training_prefix(text, uuid::Uuid::new_v4()).is_err());
    let illegal = "(;SZ[9];B[aa];W[aa])";
    let tree = to_sgf_tree_dto(&parse_sgf(illegal).unwrap()).unwrap().unwrap();
    assert!(training_prefix(illegal, tree.nodes.last().unwrap().id).is_err());
}
