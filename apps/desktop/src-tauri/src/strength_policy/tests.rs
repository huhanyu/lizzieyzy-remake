use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("strength-policy-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn request() -> Request {
    let text =
        "(;SZ[19]KM[7.5]RU[Chinese];B[dd];W[pp];B[pd];W[dp];B[cc];W[qq];B[dc];W[pq];B[ce];W[qp];B[cd];W[op])";
    from_text(text)
}
fn from_text(text: &str) -> Request {
    let parsed = sgf::parse_sgf(text).unwrap();
    let tree = sgf::to_sgf_tree_dto(&parsed).unwrap().unwrap();
    let end = tree.nodes.iter().max_by_key(|n| n.depth).unwrap().id;
    Request {
        sgf_text: text.into(),
        end_node_id: end,
        turns: (0..12).collect(),
    }
}
fn response(q: &Value) -> Value {
    let mut p = vec![0.0; 362];
    p[0] = 2.68244003e-6;
    p[361] = 1.0 - p[0];
    json!({"id":q["id"],"humanPolicy":p})
}

#[test]
fn every_profile_is_policy_only_and_replay_does_not_need_an_engine() {
    let dir = Directory::new();
    let input = input(&request()).unwrap();
    let count = AtomicUsize::new(0);
    let cancel = AnalysisCancelToken::new();
    let first = collect(
        &input,
        &dir.0,
        "engine",
        &cancel,
        |q| {
            assert_eq!(q["maxVisits"], 1);
            assert_eq!(q["overrideSettings"]["humanSLRootExploreProbWeightless"], 0.0);
            assert_eq!(q["overrideSettings"]["rootNumSymmetriesToSample"], 2);
            assert_eq!(q["overrideSettings"]["ignorePreRootHistory"], false);
            count.fetch_add(1, Ordering::SeqCst);
            Ok(response(q))
        },
        |_, _| {},
    )
    .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 36);
    assert_eq!(first.len(), 12);
    assert_eq!(first["0"].len(), 3);
    let replay = collect(
        &input,
        &dir.0,
        "engine",
        &cancel,
        |_| panic!("cache replay launched an engine"),
        |_, _| {},
    )
    .unwrap();
    assert!(first == replay, "policy cache replay differs from first response");
}

#[test]
fn cache_isolated_by_komi_and_engine_identity_and_invalid_entries_repaired() {
    let dir = Directory::new();
    let mut input = input(&request()).unwrap();
    let cancel = AnalysisCancelToken::new();
    collect(&input, &dir.0, "engine", &cancel, |q| Ok(response(q)), |_, _| {}).unwrap();
    let file = std::fs::read_dir(&dir.0).unwrap().next().unwrap().unwrap().path();
    std::fs::write(file, "[0.5]").unwrap();
    let mut repaired = 0;
    collect(
        &input,
        &dir.0,
        "engine",
        &cancel,
        |q| {
            repaired += 1;
            Ok(response(q))
        },
        |_, _| {},
    )
    .unwrap();
    assert_eq!(repaired, 1);
    input.komi = 0.0;
    let mut changed = 0;
    collect(
        &input,
        &dir.0,
        "engine",
        &cancel,
        |q| {
            changed += 1;
            Ok(response(q))
        },
        |_, _| {},
    )
    .unwrap();
    assert_eq!(changed, 36);
    let mut engine_changed = 0;
    collect(
        &input,
        &dir.0,
        "other-engine",
        &cancel,
        |q| {
            engine_changed += 1;
            Ok(response(q))
        },
        |_, _| {},
    )
    .unwrap();
    assert_eq!(engine_changed, 36);
}

#[test]
fn cancellation_and_partial_invalid_or_warning_responses_are_not_cached() {
    let dir = Directory::new();
    let input = input(&request()).unwrap();
    let cancel = AnalysisCancelToken::new();
    cancel.cancel();
    assert!(collect(
        &input,
        &dir.0,
        "engine",
        &cancel,
        |_| panic!("cancelled task queried engine"),
        |_, _| {}
    )
    .is_err());
    for field in ["error", "warning", "isDuringSearch"] {
        let cancel = AnalysisCancelToken::new();
        assert!(collect(
            &input,
            &dir.0,
            "engine",
            &cancel,
            |q| {
                let mut v = response(q);
                v[field] = json!(true);
                Ok(v)
            },
            |_, _| {}
        )
        .is_err());
    }
    assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);
    assert!(!valid_policy(&vec![0.0; 362]));
    assert!(!valid_policy(&vec![f64::NAN; 362]));
    assert!(policy(&json!({"id":"wrong","humanPolicy":[]}), "id").is_err());
}

#[test]
fn request_rejects_setup_invalid_turns_and_wrong_branch() {
    let mut r = request();
    r.turns.push(99);
    assert!(input(&r).is_err());
    let mut r = request();
    r.end_node_id = Uuid::new_v4();
    assert!(input(&r).is_err());
    let r = from_text("(;SZ[19]AB[dd];W[pp])");
    assert!(input(&r).is_err());
    let r = from_text("(;SZ[9];B[dd])");
    assert!(input(&r).is_err());
    let mut r = request();
    r.turns = vec![0, 1];
    assert!(input(&r).is_err());
    let mut r = request();
    r.sgf_text = r.sgf_text.replace("W[pp]", "B[pp]");
    assert!(input(&r).is_err());
}

#[test]
fn private_config_has_no_ordinary_judge_or_search_budget() {
    assert!(!CONFIG.contains("maxVisits=500"));
    assert!(CONFIG.contains("humanSLRootExploreProbWeightless=0.0"));
    assert!(CONFIG.contains("rootNumSymmetriesToSample=2"));
}

#[test]
#[ignore = "requires explicit local KataGo/HumanSL paths and private 12-move SGF"]
fn real_engine_one_visit_reuse_acceptance() {
    let engine = PathBuf::from(std::env::var("STRENGTH_POLICY_ENGINE").unwrap());
    let human = PathBuf::from(std::env::var("STRENGTH_POLICY_HUMAN").unwrap());
    let text = std::fs::read_to_string(std::env::var("STRENGTH_POLICY_SGF").unwrap()).unwrap();
    let request = from_text(&text);
    let input = input(&request).unwrap();
    assert_eq!(input.moves.len(), 12);
    let dir = Directory::new();
    let cancel = AnalysisCancelToken::new();
    let started = Instant::now();
    let first = run(&input, &engine, &human, &dir.0, &cancel, |done, total| {
        eprintln!("policy {done}/{total}")
    })
    .unwrap();
    assert_eq!(first.len(), 12);
    let identity = format!(
        "{}|{}",
        file_hash(&engine).unwrap(),
        hash(&std::fs::read(dir.0.join("policy.cfg")).unwrap())
    );
    let replay = collect(
        &input,
        &dir.0.join("cache"),
        &identity,
        &cancel,
        |_| panic!("replay started engine"),
        |_, _| {},
    )
    .unwrap();
    assert!(
        first == replay,
        "real policy cache replay differs from first response"
    );
    let evidence = json!({"positions":12,"policy_queries":36,"max_visits":1,"ordinary_analysis_queries":0,
        "cache_replay_without_engine":true,"engine_closed":true,"elapsed_seconds":started.elapsed().as_secs_f64()});
    if let Ok(path) = std::env::var("STRENGTH_POLICY_EVIDENCE") {
        std::fs::write(path, evidence.to_string()).unwrap();
    }
    eprintln!("{evidence}");
}
