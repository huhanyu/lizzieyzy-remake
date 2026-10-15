use super::{
    position::Document,
    runner::{self, QueryEngine, Runner},
    transport,
    types::*,
};
use analysis_core::tolerance::{distribution, HumanResponse};
use engine_manager::AnalysisCancelToken;
use serde_json::{json, Value};
fn config() -> ReviewConfig {
    ReviewConfig {
        source: "ssh".into(),
        engine_path: "katago".into(),
        model_path: "model".into(),
        human_model_path: "human".into(),
        config_path: "config".into(),
        working_dir: None,
        ssh_route: vec![SshHop {
            host: "host".into(),
            user: None,
            port: None,
        }],
        identity_file: None,
        use_agent_identities: false,
        human_profile: "proyear_2023".into(),
        screen_visits: 128,
        deep_visits: 512,
        min_candidate_visits: 32,
        target_coverage: 0.97,
        max_supplemental_moves: 0,
        max_deep_positions: 2,
        max_alternatives: 1,
        future_decisions: 3,
    }
}
#[test]
fn training_default_survives_expert_local_settings() {
    let dir = std::env::temp_dir().join(format!("training-config-{}", uuid::Uuid::new_v4()));
    let remote = config();
    runner::atomic_json(&dir.join("config.json"), &remote).unwrap();
    let first = super::load_training_config(&dir).unwrap().unwrap();
    assert_eq!(first.source, "ssh");
    assert!(dir.join("training-config.json").exists());
    let mut local = remote.clone();
    local.source = "local".into();
    local.engine_path = "local-engine".into();
    runner::atomic_json(&dir.join("config.json"), &local).unwrap();
    let next = super::load_training_config(&dir).unwrap().unwrap();
    assert_eq!(next.engine_path, remote.engine_path);
    assert_eq!(next.ssh_route[0].host, remote.ssh_route[0].host);
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn training_default_never_falls_back_to_local_or_empty_route() {
    let dir = std::env::temp_dir().join(format!("training-config-{}", uuid::Uuid::new_v4()));
    let mut cfg = config();
    cfg.source = "local".into();
    runner::atomic_json(&dir.join("config.json"), &cfg).unwrap();
    assert!(super::load_training_config(&dir).unwrap().is_none());
    runner::atomic_json(&dir.join("training-config.json"), &cfg).unwrap();
    assert!(super::load_training_config(&dir).is_err());
    cfg.source = "ssh".into();
    cfg.ssh_route.clear();
    runner::atomic_json(&dir.join("training-config.json"), &cfg).unwrap();
    assert!(super::load_training_config(&dir).is_err());
    std::fs::remove_dir_all(dir).unwrap();
}
#[test]
fn real_waffle_golden_probabilities() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/tolerance/waffle-20261005.json"
    ))
    .unwrap();
    for p in fixture["positions"].as_array().unwrap() {
        let r: HumanResponse = serde_json::from_value(p["response"].clone()).unwrap();
        let d = distribution(&r, 19, 256).unwrap();
        let e = &p["expected"];
        let close = |name: &str, value: f64| {
            assert!(
                (value - e[name].as_f64().unwrap()).abs() < 1e-8,
                "{name}: {value} != {}",
                e[name]
            )
        };
        close("coverage", d.coverage);
        close("unknown", d.unknown);
        close(
            "good",
            d.candidates
                .iter()
                .filter(|m| m.score_loss.is_some_and(|v| v <= 1.))
                .map(|m| m.probability)
                .sum(),
        );
        close(
            "win_good5",
            d.candidates
                .iter()
                .filter(|m| m.win_loss_pp.is_some_and(|v| v <= 5.))
                .map(|m| m.probability)
                .sum(),
        );
        close(
            "bad3",
            d.candidates
                .iter()
                .filter(|m| m.score_loss.is_some_and(|v| v >= 3.))
                .map(|m| m.probability)
                .sum(),
        );
        close(
            "win_bad10",
            d.candidates
                .iter()
                .filter(|m| m.win_loss_pp.is_some_and(|v| v >= 10.))
                .map(|m| m.probability)
                .sum(),
        );
        close(
            "expected_known",
            d.candidates
                .iter()
                .map(|m| m.probability * m.score_loss.unwrap_or(0.))
                .sum(),
        );
    }
}
#[test]
fn position_preserves_setup_pass_side_branch_and_rules() {
    let text = "\u{feff}(;GM[1]FF[4]SZ[9]KM[0.5]RU[Japanese]AB[aa][bb]PL[W];W[](;B[cc];W[dd])(;B[ee]))";
    let d = Document::parse(text).unwrap();
    let side = d
        .tree
        .nodes
        .iter()
        .find(|n| !n.is_mainline && n.vertex.is_some())
        .unwrap();
    let p = d.input(side.id).unwrap();
    assert_eq!(p.initial_player, "W");
    assert_eq!(p.initial_stones.len(), 2);
    assert_eq!(p.moves[0], ("W".into(), "pass".into()));
    assert_eq!(p.moves[1], ("B".into(), "E5".into()));
    assert_eq!(p.player, "W");
    assert_eq!(p.komi, 0.5);
    let q = runner::make_query(&p, &config(), 512, None);
    assert_eq!(q["initialPlayer"], "W");
    assert_eq!(q["moves"][0][1], "pass");
    let bad = Document::parse("(;SZ[9];B[aa];AB[dd])").unwrap();
    assert!(bad.input(bad.tree.nodes.last().unwrap().id).is_err());
}
#[test]
fn ssh_hosts_are_validated_and_arguments_quoted() {
    let mut c = config();
    c.ssh_route[0].host = "--help".into();
    assert!(transport::ssh_spec(&c).is_err());
    c.ssh_route[0].host = "host".into();
    c.model_path = "path with ' quote; $(echo no)".into();
    let s = transport::ssh_spec(&c).unwrap();
    assert!(s
        .args
        .last()
        .unwrap()
        .contains("'path with '\\'' quote; $(echo no)'"));
    c.source = "cloud".into();
    assert!(c.validate().is_err());
}
struct Fake {
    calls: usize,
    fail_after: usize,
}
impl QueryEngine for Fake {
    fn ask(&mut self, q: &Value, cancel: &AnalysisCancelToken) -> Result<Value, String> {
        self.calls += 1;
        if self.calls > self.fail_after {
            cancel.cancel();
            return Err("已取消".into());
        }
        let size = q["boardXSize"].as_u64().unwrap() as u8;
        let moves = q["moves"].as_array().unwrap();
        let player = moves
            .last()
            .map(|m| if m[0] == "B" { "W" } else { "B" })
            .unwrap_or("B");
        let vertices: Vec<_> = (0..usize::from(size).pow(2))
            .map(|i| analysis_core::tolerance::vertex_at(i, size))
            .filter(|v| !moves.iter().any(|m| m[1] == *v))
            .collect();
        let mut policy = vec![-1.; usize::from(size).pow(2) + 1];
        for v in &vertices {
            policy[analysis_core::tolerance::policy_index(v, size).unwrap()] = 1. / vertices.len() as f64;
        }
        let infos: Vec<_> = vertices
            .iter()
            .enumerate()
            .map(|(i, v)| json!({"move":v,"visits":100,"winrate":0.6,"scoreLead":1.0,"order":i,"pv":[v]}))
            .collect();
        Ok(
            json!({"id":q["id"],"turnNumber":moves.len(),"rootInfo":{"currentPlayer":player,"visits":512,"winrate":0.6,"scoreLead":1.0},"humanPolicy":policy,"moveInfos":infos}),
        )
    }
}
#[test]
fn runner_generates_legal_isolated_branches_cache_and_partial_checkpoint() {
    let doc = Document::parse("(;SZ[9]KM[6.5]RU[Chinese];B[ee];W[dd])").unwrap();
    let request = ReviewRequest {
        sgf_text: doc.text.clone(),
        anchor_node_id: doc.tree.root_id,
        mode: "compare".into(),
        config: config(),
        alternatives: vec!["F5".into()],
    };
    let dir = std::env::temp_dir().join(format!("tolerance-test-{}", uuid::Uuid::new_v4()));
    let mut report = runner::new_report("test".into(), request.clone());
    report.identity = Some(ModelIdentity {
        engine_version: "mock".into(),
        engine_sha256: "1".into(),
        model_sha256: "2".into(),
        human_model_sha256: "3".into(),
        config_sha256: "4".into(),
        cache_safe: true,
    });
    let token = AnalysisCancelToken::new();
    let mut fake = Fake {
        calls: 0,
        fail_after: 999,
    };
    let mut events = vec![];
    Runner {
        engine: &mut fake,
        cancel: &token,
        dir: dir.clone(),
        report: &mut report,
        emit: &mut |e| events.push(e),
    }
    .run()
    .unwrap();
    assert_eq!(report.branches.len(), 4);
    assert!(report.branches.iter().all(|b| b.states.len() == 3));
    assert_eq!(report.request.sgf_text, doc.text);
    for b in &report.branches {
        for id in &b.node_ids {
            assert!(sgf::replay_sgf_position_at_node(&b.sgf_text, *id)
                .unwrap()
                .errors
                .is_empty());
        }
    }
    let mut cached = runner::new_report("again".into(), request.clone());
    cached.identity = report.identity.clone();
    let mut unused = Fake {
        calls: 0,
        fail_after: 0,
    };
    Runner {
        engine: &mut unused,
        cancel: &AnalysisCancelToken::new(),
        dir: dir.clone(),
        report: &mut cached,
        emit: &mut |_| {},
    }
    .run()
    .unwrap();
    assert_eq!(unused.calls, 0);
    assert!(cached.cache_hits > 0);
    let mut partial = runner::new_report("partial".into(), request);
    let mut failing = Fake {
        calls: 0,
        fail_after: 3,
    };
    assert!(Runner {
        engine: &mut failing,
        cancel: &AnalysisCancelToken::new(),
        dir: dir.clone(),
        report: &mut partial,
        emit: &mut |_| {}
    }
    .run()
    .is_err());
    assert_eq!(partial.positions.len(), 1);
    assert!(dir.join("reports/partial.json").exists());
    std::fs::remove_dir_all(dir).unwrap();
}
/// Explicit remote-only acceptance; configuration lives outside the repository.
#[test]
#[ignore = "requires TOLERANCE_REMOTE_CONFIG and TOLERANCE_REMOTE_SGF"]
fn remote_acceptance() {
    let c: ReviewConfig =
        serde_json::from_slice(&std::fs::read(std::env::var("TOLERANCE_REMOTE_CONFIG").unwrap()).unwrap())
            .unwrap();
    assert_eq!(c.source, "ssh");
    let text = std::fs::read_to_string(std::env::var("TOLERANCE_REMOTE_SGF").unwrap()).unwrap();
    let doc = Document::parse(&text).unwrap();
    let turn: usize = std::env::var("TOLERANCE_REMOTE_TURN")
        .unwrap_or("138".into())
        .parse()
        .unwrap();
    let p = doc
        .mainline()
        .unwrap()
        .into_iter()
        .find(|p| p.turn as usize == turn)
        .unwrap();
    let request = ReviewRequest {
        sgf_text: text,
        anchor_node_id: p.node_id,
        mode: std::env::var("TOLERANCE_REMOTE_MODE").unwrap_or("position".into()),
        config: c,
        alternatives: vec![],
    };
    let mut report = runner::new_report(format!("tolerance-{}", uuid::Uuid::new_v4()), request);
    let cancel = AnalysisCancelToken::new();
    let mut session = transport::Session::start(&report.request.config, &cancel).unwrap();
    report.identity = Some(session.identity.clone());
    let dir = std::path::PathBuf::from(std::env::var("TOLERANCE_REMOTE_OUTPUT").unwrap());
    let result = Runner {
        engine: &mut session,
        cancel: &cancel,
        dir: dir.clone(),
        report: &mut report,
        emit: &mut |e| {
            eprintln!(
                "{} {}/{} queries {}",
                e.phase, e.completed, e.total, e.query_count
            )
        },
    }
    .run();
    if result.is_ok() {
        // Replaying the same frozen request should issue no new queries.
        let mut cached = runner::new_report(
            format!("tolerance-{}", uuid::Uuid::new_v4()),
            report.request.clone(),
        );
        cached.identity = report.identity.clone();
        Runner {
            engine: &mut session,
            cancel: &cancel,
            dir: dir.clone(),
            report: &mut cached,
            emit: &mut |_| {},
        }
        .run()
        .unwrap();
        assert_eq!(cached.query_count, 0);
        assert!(cached.cache_hits > 0);
        eprintln!("CACHE_REPLAY {} hits / 0 queries", cached.cache_hits);
        let cancel_later = cancel.clone();
        let waiter = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            cancel_later.cancel();
        });
        let mut query = runner::make_query(&p, &report.request.config, 131072, None);
        query["id"] = json!("cancel-acceptance");
        assert_eq!(session.query(&query, &cancel).unwrap_err(), "已取消");
        waiter.join().unwrap();
    }
    let close = session.close();
    report.cleanup_confirmed = close.is_ok();
    report.status = if result.is_ok() { "complete" } else { "failed" }.into();
    report.error = result.as_ref().err().cloned();
    runner::save_report(&dir, &report).unwrap();
    close.unwrap();
    result.unwrap();
    assert!(report
        .positions
        .iter()
        .all(|p| !p.response.human_policy.is_empty()));
    eprintln!(
        "REPORT {}",
        dir.join("reports")
            .join(format!("{}.json", report.job_id))
            .display()
    );
}

#[cfg(unix)]
#[test]
fn local_transport_relative_assets_and_cancelled_query_use_owned_process_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("tolerance-local-mock-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("mock-engine");
    std::fs::write(&script, r#"#!/usr/bin/env python3
import sys,json
if 'version' in sys.argv:
    print('mock test engine 1');sys.exit(0)
for line in sys.stdin:
    if not line.strip(): continue
    q=json.loads(line)
    print(json.dumps({'id':q['id'],'turnNumber':0,'rootInfo':{'currentPlayer':'B','visits':128,'winrate':0.5,'scoreLead':0},'moveInfos':[{'move':'A2','visits':128,'winrate':0.5,'scoreLead':0,'order':0}],'humanPolicy':[1,0,0,0,0]}),flush=True)
"#).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    for name in ["model", "human", "config"] {
        std::fs::write(dir.join(name), "# test fixture\n").unwrap();
    }
    let mut c = config();
    c.source = "local".into();
    c.engine_path = script.to_string_lossy().into();
    c.working_dir = Some(dir.to_string_lossy().into());
    let token = AnalysisCancelToken::new();
    let mut session = transport::Session::start(&c, &token).unwrap();
    assert_eq!(
        session.query(&json!({"id":"test"}), &token).unwrap()["id"],
        "test"
    );
    token.cancel();
    assert!(session.query(&json!({"id":"cancelled"}), &token).is_err());
    session.close().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn full_scan_keeps_mainline_and_deepens_without_duplicate_positions() {
    let doc = Document::parse("(;SZ[9];B[ee](;W[dd];B[ff])(;W[aa]))").unwrap();
    let request = ReviewRequest {
        sgf_text: doc.text.clone(),
        anchor_node_id: doc.tree.root_id,
        mode: "scan".into(),
        config: config(),
        alternatives: vec![],
    };
    let mut report = runner::new_report("scan".into(), request);
    let dir = std::env::temp_dir().join(format!("tolerance-scan-{}", uuid::Uuid::new_v4()));
    let mut fake = Fake {
        calls: 0,
        fail_after: 999,
    };
    Runner {
        engine: &mut fake,
        cancel: &AnalysisCancelToken::new(),
        dir: dir.clone(),
        report: &mut report,
        emit: &mut |_| {},
    }
    .run()
    .unwrap();
    assert_eq!(report.positions.len(), 4);
    assert_eq!(report.completed, 6);
    assert_eq!(report.total, 6);
    assert_eq!(report.positions.iter().filter(|p| p.stage == "deep").count(), 2);
    assert!(report
        .positions
        .iter()
        .all(|p| !p.input.moves.iter().any(|(_, v)| v == "A9")));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn training_query_preserves_history_setup_and_budget_without_future() {
    let source = "(;SZ[9]KM[0.5]RU[Japanese]AB[aa][bb]PL[W];W[];B[cc];W[dd])";
    let doc = Document::parse(source).unwrap();
    let node = doc.tree.nodes.iter().find(|n| n.move_number == Some(2)).unwrap();
    let copy = super::training::training_position(source.into(), node.id).unwrap();
    let isolated = Document::parse(copy["sgfText"].as_str().unwrap()).unwrap();
    let id = uuid::Uuid::parse_str(copy["nodeId"].as_str().unwrap()).unwrap();
    let query = super::training::play_query(&isolated, id, &config(), "test", 800, 3.).unwrap();
    assert_eq!(query["moves"], json!([["W", "pass"], ["B", "C7"]]));
    assert_eq!(query["initialStones"].as_array().unwrap().len(), 2);
    assert_eq!(query["initialPlayer"], "W");
    assert_eq!(query["komi"], 0.5);
    assert_eq!(query["overrideSettings"]["maxTime"], 3.);
    assert_eq!(query["overrideSettings"]["humanSLRootExploreProbWeightless"], 0);
    assert!(super::training::play_query(&isolated, id, &config(), "test", 0, 3.).is_err());
    assert!(super::training::play_query(&isolated, id, &config(), "test", 800, f64::NAN).is_err());
}

#[test]
fn training_mode_skips_opening_and_keeps_checkpoint_counts() {
    let doc = Document::parse("(;SZ[9];B[aa];W[ii];B[ba];W[hi];B[ca];W[gi];B[da];W[fi];B[ea];W[ei];B[fa];W[di];B[ga];W[ci];B[ha];W[bi];B[ia])").unwrap();
    let request = ReviewRequest {
        sgf_text: doc.text.clone(),
        anchor_node_id: doc.tree.root_id,
        mode: "training".into(),
        config: config(),
        alternatives: vec![],
    };
    let dir = std::env::temp_dir().join(format!("training-test-{}", uuid::Uuid::new_v4()));
    let mut report = runner::new_report("training".into(), request);
    let mut fake = Fake {
        calls: 0,
        fail_after: 999,
    };
    Runner {
        engine: &mut fake,
        cancel: &AnalysisCancelToken::new(),
        dir: dir.clone(),
        report: &mut report,
        emit: &mut |_| {},
    }
    .run()
    .unwrap();
    assert_eq!(report.positions.len(), 3);
    assert!(report.positions.iter().all(|p| p.input.moves.len() >= 14));
    assert_eq!(report.completed, report.total);
    assert!(report.branches.is_empty());
    assert!(report
        .positions
        .iter()
        .all(|p| p.stage == "training-screen" || p.stage == "deep"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "requires TOLERANCE_REMOTE_CONFIG and TOLERANCE_REMOTE_SGF"]
fn remote_training_move_acceptance() {
    let config: ReviewConfig =
        serde_json::from_slice(&std::fs::read(std::env::var("TOLERANCE_REMOTE_CONFIG").unwrap()).unwrap())
            .unwrap();
    assert_eq!(config.source, "ssh");
    let text = std::fs::read_to_string(std::env::var("TOLERANCE_REMOTE_SGF").unwrap()).unwrap();
    let doc = Document::parse(&text).unwrap();
    let turn: u32 = std::env::var("TOLERANCE_REMOTE_TURN")
        .unwrap_or("130".into())
        .parse()
        .unwrap();
    let p = doc
        .mainline()
        .unwrap()
        .into_iter()
        .find(|p| p.turn == turn)
        .unwrap();
    let copy = super::training::training_position(text, p.node_id).unwrap();
    let isolated = Document::parse(copy["sgfText"].as_str().unwrap()).unwrap();
    let id = uuid::Uuid::parse_str(copy["nodeId"].as_str().unwrap()).unwrap();
    let cancel = AnalysisCancelToken::new();
    let mut session = transport::Session::start(&config, &cancel).unwrap();
    let response = super::training::play(
        &mut session,
        &isolated,
        id,
        &config,
        "training-acceptance",
        800,
        3.,
        &cancel,
    )
    .unwrap();
    assert_eq!(response["turnNumber"], turn);
    let infos = response["moveInfos"].as_array().unwrap();
    let vertex = infos.iter().find(|m| m["order"] == 0).unwrap()["move"]
        .as_str()
        .unwrap();
    let mut prefix = isolated.text.clone();
    let mut input = isolated.input(id).unwrap();
    super::position::advance(&mut prefix, &mut input, vertex).unwrap();
    session.close().unwrap();
    eprintln!(
        "TRAINING_MOVE_ACK turn={turn} player={} move={vertex} visits={}",
        p.player, response["rootInfo"]["visits"]
    );
    let output = std::env::var("TOLERANCE_REMOTE_OUTPUT").unwrap();
    runner::atomic_json(
        &std::path::PathBuf::from(output).join("training-move.json"),
        &json!({"prefix":copy,"response":response,"continuedSgf":prefix,"cleanupConfirmed":true}),
    )
    .unwrap();
}
