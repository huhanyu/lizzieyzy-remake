//! Isolated one-visit HumanSL policies. Never schedules or publishes ordinary analysis.
use app_model::EngineBackend;
use engine_manager::{AnalysisCancelToken, CommandSpec, GtpSession, GtpSessionEvent};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const HUMAN_SHA: &str = "637746e44f0efe00ad1245a50aa9bbf0716efe364c43965ead97bd6835d84ab5";
const PROFILES: [&str; 3] = ["rank_1d", "rank_5d", "rank_9d"];
const CONFIG: &str = "numAnalysisThreads=1\nnumSearchThreadsPerAnalysisThread=1\nnnMaxBatchSize=32\nnnCacheSizePowerOfTwo=20\nnnMutexPoolSizePowerOfTwo=16\nreportAnalysisWinratesAs=SIDETOMOVE\nhumanSLProfile=rank_5d\nignorePreRootHistory=false\nrootNumSymmetriesToSample=2\nhumanSLRootExploreProbWeightless=0.0\nhumanSLCpuctPermanent=2.0\n";

#[derive(Default)]
pub(crate) struct StrengthPolicyState(Mutex<Option<(String, AnalysisCancelToken)>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    sgf_text: String,
    end_node_id: Uuid,
    turns: Vec<usize>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Availability {
    engine_available: bool,
    human_available: bool,
}
type Policies = BTreeMap<String, BTreeMap<String, Vec<f64>>>;
#[derive(Serialize)]
pub(crate) struct PolicyResult {
    policies: Policies,
}

struct Input {
    moves: Vec<(String, String)>,
    board_size: u8,
    komi: f64,
    rules: String,
    turns: Vec<usize>,
}
fn input(request: &Request) -> Result<Input, String> {
    if request.sgf_text.len() > 10_000_000 {
        return Err("棋谱超过 10 MB".into());
    }
    let parsed = sgf::parse_sgf(&request.sgf_text).map_err(|e| e.to_string())?;
    let tree = sgf::to_sgf_tree_dto(&parsed)
        .map_err(|e| e.to_string())?
        .ok_or("缺少棋谱树")?;
    let game = sgf::to_game_dto(parsed);
    if game.summary.board_size != 19 || !game.summary.initial_stones.is_empty() {
        return Err("HumanSL 40 仅支持无让子、无摆子的 19 路棋谱".into());
    }
    let by_id: BTreeMap<_, _> = tree.nodes.iter().map(|n| (n.id, n)).collect();
    let mut path = Vec::new();
    let mut id = request.end_node_id;
    let mut seen = std::collections::HashSet::new();
    loop {
        if !seen.insert(id) {
            return Err("棋谱节点循环".into());
        }
        let node = by_id.get(&id).ok_or("分析分支已变化")?;
        if node.properties.iter().any(|p| {
            ["AB", "AW", "AE", "PL"].contains(&p.key.as_str())
                || (p.key == "HA" && p.values.first().is_some_and(|v| v != "0"))
        }) {
            return Err("此模型尚未验证让子、摆子和指定行棋方的棋谱".into());
        }
        path.push(*node);
        if let Some(parent) = node.parent_id {
            id = parent;
        } else {
            break;
        }
    }
    if id != tree.root_id {
        return Err("分支未连接根节点".into());
    }
    path.reverse();
    let mut moves = Vec::new();
    for node in path {
        if let (Some(color), Some(vertex)) = (node.color, &node.vertex) {
            let color = match color {
                app_model::PlayerColor::Black => "B",
                app_model::PlayerColor::White => "W",
            };
            if moves.last().is_some_and(|(c, _)| c == color) {
                return Err("此模型暂不支持非交替落子".into());
            }
            moves.push((
                color.to_owned(),
                katago_protocol::move_vertex_to_kata_coordinate(vertex, 19).map_err(|e| e.to_string())?,
            ));
        }
    }
    if moves.len() > 210 {
        return Err("HumanSL 40 最多评估前 210 手".into());
    }
    let position = sgf::replay_sgf_position_at_node(&request.sgf_text, request.end_node_id)
        .map_err(|e| e.to_string())?;
    if !position.errors.is_empty() {
        return Err(position.errors.join("；"));
    }
    let mut turns = request.turns.clone();
    turns.sort_unstable();
    turns.dedup();
    if turns.is_empty() || turns.len() > 210 || turns.iter().any(|&t| t >= moves.len()) {
        return Err("补算手数无效".into());
    }
    for color in ["B", "W"] {
        if turns.iter().filter(|&&t| moves[t].0 == color).count() < 6 {
            return Err("每方至少需要 6 手完整的普通分析".into());
        }
    }
    Ok(Input {
        moves,
        board_size: 19,
        komi: f64::from(game.summary.komi),
        rules: sgf::katago_rules_for_sgf_ru(game.summary.rules.as_deref()).into(),
        turns,
    })
}

fn query(input: &Input, turn: usize, profile: &str) -> Value {
    json!({"id":format!("strength40-{profile}-{turn}"),"boardXSize":input.board_size,"boardYSize":input.board_size,
        "komi":input.komi,"rules":input.rules,"moves":input.moves[..turn],"initialPlayer":input.moves[0].0,
        "maxVisits":1,"includePolicy":true,"includeOwnership":false,"includeMovesOwnership":false,"includePVVisits":false,
        "overrideSettings":{"reportAnalysisWinratesAs":"SIDETOMOVE","humanSLProfile":profile,
            "ignorePreRootHistory":false,"rootNumSymmetriesToSample":2,"humanSLRootExploreProbWeightless":0.0,"humanSLCpuctPermanent":2.0}})
}
fn valid_policy(policy: &[f64]) -> bool {
    policy.len() == 362
        && policy
            .iter()
            .all(|p| p.is_finite() && (*p == -1.0 || (0.0..=1.0).contains(p)))
        && (policy.iter().map(|p| p.max(0.0)).sum::<f64>() - 1.0).abs() <= 0.001
}
fn policy(response: &Value, id: &str) -> Result<Vec<f64>, String> {
    if response.get("error").is_some()
        || response.get("warning").is_some()
        || response["isDuringSearch"].as_bool() == Some(true)
        || response["id"].as_str() != Some(id)
    {
        return Err("HumanSL 返回错误、警告或不完整数据，请检查 KataGo 版本".into());
    }
    let value = response
        .get("humanPolicy")
        .or_else(|| response.get("policy"))
        .ok_or("缺少 HumanSL 策略")?;
    let policy: Vec<f64> = serde_json::from_value(value.clone()).map_err(|_| "HumanSL 策略格式无效")?;
    if !valid_policy(&policy) {
        return Err("HumanSL 策略概率无效".into());
    }
    Ok(policy)
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn collect(
    input: &Input,
    cache: &Path,
    identity: &str,
    cancel: &AnalysisCancelToken,
    mut send: impl FnMut(&Value) -> Result<Value, String>,
    mut progress: impl FnMut(usize, usize),
) -> Result<Policies, String> {
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let mut result = Policies::new();
    for (done, &turn) in input.turns.iter().enumerate() {
        let mut profiles = BTreeMap::new();
        for profile in PROFILES {
            if cancel.is_cancelled() {
                return Err("已取消 HumanSL 补算".into());
            }
            let q = query(input, turn, profile);
            let key = hash(format!("strength40-policy-v1|{HUMAN_SHA}|{identity}|{q}").as_bytes());
            let path = cache.join(format!("{key}.json"));
            let cached = std::fs::metadata(&path)
                .ok()
                .filter(|m| m.len() < 20000)
                .and_then(|_| std::fs::read(&path).ok())
                .and_then(|b| serde_json::from_slice::<Vec<f64>>(&b).ok())
                .filter(|p| valid_policy(p));
            let value = if let Some(cached) = cached {
                cached
            } else {
                let value = policy(&send(&q)?, q["id"].as_str().ok_or("缺少查询 ID")?)?;
                if cancel.is_cancelled() {
                    return Err("已取消 HumanSL 补算".into());
                }
                let temporary = cache.join(format!(".{key}-{}.tmp", Uuid::new_v4()));
                let bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
                // Return the same parsed representation on both first-run and cache replay.
                let normalized = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
                let saved = (|| {
                    if path.exists() {
                        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
                    }
                    std::fs::rename(&temporary, &path).map_err(|e| e.to_string())
                })();
                let _ = std::fs::remove_file(&temporary);
                saved?;
                normalized
            };
            profiles.insert(profile.into(), value);
        }
        result.insert(turn.to_string(), profiles);
        progress(done + 1, input.turns.len());
    }
    Ok(result)
}

fn executable(path: &str, working_dir: Option<&str>) -> Option<PathBuf> {
    if path.trim().is_empty() {
        return None;
    }
    let p = PathBuf::from(path);
    if p.is_file() {
        return p.canonicalize().ok();
    }
    if let Some(base) = working_dir {
        let p = Path::new(base).join(path);
        if p.is_file() {
            return p.canonicalize().ok();
        }
    }
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|dir| dir.join(path))
        .find(|p| p.is_file())
}
fn discover(app: &AppHandle) -> Result<(Option<PathBuf>, Option<PathBuf>), String> {
    let settings = crate::load_engine_profiles_settings(app.clone())?;
    let selected = crate::selected_engine_profile_record(&settings);
    let profiles: Vec<_> = selected
        .into_iter()
        .chain(settings.profiles.iter())
        .map(|r| &r.profile)
        .collect();
    let engine = profiles
        .iter()
        .filter(|p| {
            matches!(
                p.backend,
                EngineBackend::KataGoAnalysis | EngineBackend::KataGoGtp
            )
        })
        .find_map(|p| executable(&p.engine_path, p.working_dir.as_deref()))
        .or_else(|| {
            app.path().resource_dir().ok().and_then(|dir| {
                executable(
                    &dir.join("runtime/katago/bin")
                        .join(if cfg!(windows) { "katago.exe" } else { "katago" })
                        .to_string_lossy(),
                    None,
                )
            })
        })
        .or_else(|| executable(if cfg!(windows) { "katago.exe" } else { "katago" }, None))
        .or_else(|| {
            if cfg!(target_os = "macos") {
                ["/opt/homebrew/bin/katago", "/usr/local/bin/katago"]
                    .into_iter()
                    .find_map(|path| executable(path, None))
            } else {
                None
            }
        });
    let managed = crate::engine_assets::engine_assets_list(app.clone())?;
    let mut human = managed
        .into_iter()
        .find(|a| {
            a.kind == "model"
                && a.sha256 == HUMAN_SHA
                && file_hash(Path::new(&a.path)).is_ok_and(|hash| hash == HUMAN_SHA)
        })
        .map(|a| PathBuf::from(a.path));
    if human.is_none() {
        for p in profiles {
            if let Some(path) = &p.model_path {
                let path = PathBuf::from(path);
                let path = if path.is_absolute() {
                    path
                } else {
                    Path::new(p.working_dir.as_deref().unwrap_or(".")).join(path)
                };
                if let Some(parent) = path.parent() {
                    for candidate in [
                        parent.join("b18c384nbt-humanv0.bin.gz"),
                        parent.join("human-sl-models/b18c384nbt-humanv0.bin.gz"),
                    ] {
                        if file_hash(&candidate).is_ok_and(|hash| hash == HUMAN_SHA) {
                            human = Some(candidate);
                            break;
                        }
                    }
                }
            }
            if human.is_some() {
                break;
            }
        }
    }
    Ok((engine, human))
}

#[tauri::command]
pub(crate) async fn strength_policy_status(app: AppHandle) -> Result<Availability, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (engine, human) = discover(&app)?;
        Ok(Availability {
            engine_available: engine.is_some(),
            human_available: human.is_some(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) fn strength_policy_cancel(app: AppHandle, id: String) -> Result<(), String> {
    if let Some((active, token)) = app
        .state::<StrengthPolicyState>()
        .0
        .lock()
        .map_err(|_| "补算状态不可用")?
        .as_ref()
    {
        if active == &id {
            token.cancel();
        }
    }
    Ok(())
}
pub(crate) fn cancel_on_close(app: &AppHandle) {
    if let Ok(active) = app.state::<StrengthPolicyState>().0.lock() {
        if let Some((_, token)) = active.as_ref() {
            token.cancel();
        }
    }
}

fn run(
    input: &Input,
    engine: &Path,
    human: &Path,
    directory: &Path,
    cancel: &AnalysisCancelToken,
    progress: impl FnMut(usize, usize),
) -> Result<Policies, String> {
    if file_hash(human)? != HUMAN_SHA {
        return Err("HumanSL 模型校验失败，请重新下载".into());
    }
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let config = directory.join("policy.cfg");
    let text = format!(
        "{CONFIG}\nlogDir={}\n",
        serde_json::to_string(&directory.join("logs").to_string_lossy()).map_err(|e| e.to_string())?
    );
    std::fs::write(&config, text.as_bytes()).map_err(|e| e.to_string())?;
    let identity = format!("{}|{}", file_hash(engine)?, hash(text.as_bytes()));
    let spec = CommandSpec {
        program: engine.to_string_lossy().into_owned(),
        args: vec![
            "analysis".into(),
            "-model".into(),
            human.to_string_lossy().into_owned(),
            "-human-model".into(),
            human.to_string_lossy().into_owned(),
            "-config".into(),
            config.to_string_lossy().into_owned(),
            "-quit-without-waiting".into(),
        ],
        working_dir: Some(directory.to_string_lossy().into_owned()),
        env: vec![],
    };
    let mut session: Option<GtpSession> = None;
    let outcome = collect(
        input,
        &directory.join("cache"),
        &identity,
        cancel,
        |q| {
            if session.is_none() {
                session = Some(GtpSession::start(&spec).map_err(|e| e.to_string())?);
            }
            let active = session.as_mut().ok_or("引擎尚未启动")?;
            active.send_command(&q.to_string()).map_err(|e| e.to_string())?;
            let until = Instant::now() + Duration::from_secs(180);
            loop {
                if cancel.is_cancelled() {
                    return Err("已取消 HumanSL 补算".into());
                }
                if Instant::now() >= until {
                    return Err("HumanSL 补算超时".into());
                }
                match active.next_event_timeout(Duration::from_millis(100)) {
                    Some(GtpSessionEvent::Line(line)) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&line) {
                            if v["id"] == q["id"] {
                                return Ok(v);
                            }
                        }
                    }
                    Some(GtpSessionEvent::Eof { .. }) => {
                        return Err(format!("HumanSL 引擎退出：{}", active.stderr_snapshot()))
                    }
                    Some(GtpSessionEvent::ReadError(error)) => return Err(error),
                    None => {}
                }
            }
        },
        progress,
    );
    if let Some(mut active) = session {
        active.close().map_err(|e| e.to_string())?;
    }
    outcome
}

#[tauri::command]
pub(crate) async fn strength_policy_run(
    app: AppHandle,
    id: String,
    request: Request,
) -> Result<PolicyResult, String> {
    Uuid::parse_str(&id).map_err(|_| "补算任务 ID 无效")?;
    let token = AnalysisCancelToken::new();
    {
        let state = app.state::<StrengthPolicyState>();
        let mut active = state.0.lock().map_err(|_| "补算状态不可用")?;
        if active.is_some() {
            return Err("上一个 HumanSL 补算任务仍在退出，请稍后重试".into());
        }
        *active = Some((id.clone(), token.clone()));
    }
    let worker_app = app.clone();
    let worker_id = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let input = input(&request)?;
        let (engine, human) = discover(&worker_app)?;
        let engine = engine.ok_or("未找到本地 KataGo，请通过现有引擎设置安装后重试")?;
        let human = human.ok_or("缺少 HumanSL 模型，请下载后重试")?;
        let directory = worker_app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("strength-humansl40");
        let policies = run(&input, &engine, &human, &directory, &token, |done, total| {
            let _ = worker_app.emit(
                "strength://policy-progress",
                json!({"id":worker_id,"done":done,"total":total}),
            );
        })?;
        Ok(PolicyResult { policies })
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    if let Ok(mut active) = app.state::<StrengthPolicyState>().0.lock() {
        if active.as_ref().is_some_and(|(owner, _)| owner == &id) {
            *active = None;
        }
    }
    result
}

#[cfg(test)]
mod tests;
