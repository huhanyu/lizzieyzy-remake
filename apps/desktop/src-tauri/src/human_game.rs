//! An isolated analysis process for play. Cancellation invalidates a request before its result can land.
use app_model::EngineProfileDto;
use engine_manager::{GtpSession, GtpSessionEvent};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::State;

#[derive(Default)]
pub struct HumanGameEngine {
    active: Mutex<Option<(String, Arc<AtomicBool>)>>,
    engine: Mutex<Option<(String, GtpSession, PrivateConfig)>>,
}
struct PrivateConfig(std::path::PathBuf);
impl Drop for PrivateConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn play_config(source: &str) -> String {
    let mut threads = 6;
    let mut lines = Vec::new();
    for line in source.lines() {
        let key = line.split_once('=').map(|(k, _)| k.trim()).unwrap_or("");
        if ["numSearchThreads", "numSearchThreadsPerAnalysisThread"].contains(&key) {
            threads = line
                .split_once('=')
                .and_then(|(_, v)| v.split('#').next()?.trim().parse::<u32>().ok())
                .unwrap_or(threads);
            continue;
        }
        if key == "numAnalysisThreads" || key == "nnMaxBatchSize" {
            continue;
        }
        lines.push(line.to_owned());
    }
    lines.push(format!(
        "numAnalysisThreads = 1\nnnMaxBatchSize = 16\nnumSearchThreadsPerAnalysisThread = {}",
        threads.clamp(1, 256)
    ));
    lines.join("\n") + "\n"
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayRequest {
    id: String,
    profile: EngineProfileDto,
    board_size: u8,
    komi: f64,
    rules: String,
    setup: Vec<String>,
    moves: Vec<String>,
    player: String,
    max_visits: u32,
    max_seconds: f64,
    human_model: Option<String>,
    human_rank: Option<String>,
}
fn pairs(values: &[String], size: u8) -> Result<Vec<Value>, String> {
    if values.len() % 2 != 0 {
        return Err("棋谱落子序列不完整".into());
    }
    values
        .chunks(2)
        .map(|p| {
            if !["B", "W"].contains(&p[0].as_str()) {
                return Err("执棋方无效".into());
            }
            let v = &p[1];
            if v != "pass" {
                let x = v
                    .as_bytes()
                    .first()
                    .and_then(|c| b"ABCDEFGHJKLMNOPQRSTUVWXYZ".iter().position(|a| a == c));
                let y = v.get(1..).and_then(|s| s.parse::<u8>().ok());
                if !x.is_some_and(|x| x < size as usize) || !y.is_some_and(|y| y > 0 && y <= size) {
                    return Err("坐标无效".into());
                }
            }
            Ok(json!([p[0], p[1]]))
        })
        .collect()
}
fn query(r: &PlayRequest) -> Result<Value, String> {
    if !(2..=25).contains(&r.board_size)
        || !r.komi.is_finite()
        || !(1..=10_000_000).contains(&r.max_visits)
        || !r.max_seconds.is_finite()
        || !(0.1..=600.).contains(&r.max_seconds)
    {
        return Err("对局参数超出范围".into());
    }
    let player = match r.player.as_str() {
        "black" => "B",
        "white" => "W",
        _ => return Err("执棋方无效".into()),
    };
    let mut q = json!({"id":r.id,"boardXSize":r.board_size,"boardYSize":r.board_size,"komi":r.komi,"rules":r.rules,"initialStones":pairs(&r.setup,r.board_size)?,"moves":pairs(&r.moves,r.board_size)?,"initialPlayer":player,"maxVisits":r.max_visits,"overrideSettings":{"maxTime":r.max_seconds},"includePolicy":r.human_rank.is_some()});
    if let Some(rank) = &r.human_rank {
        let valid =
            (1..=20).any(|n| rank == &format!("rank_{n}k")) || (1..=9).any(|n| rank == &format!("rank_{n}d"));
        if !valid || r.human_model.as_ref().is_none_or(|p| p.trim().is_empty()) {
            return Err("请选择有效 HumanSL 档位和人类模型".into());
        }
        q["overrideSettings"]["humanSLProfile"] = json!(rank);
        q["overrideSettings"]["ignorePreRootHistory"] = json!(false);
    }
    Ok(q)
}
#[tauri::command]
pub fn human_game_cancel(state: State<'_, HumanGameEngine>, id: String) -> Result<(), String> {
    if let Some((active, cancel)) = state.active.lock().map_err(|e| e.to_string())?.as_ref() {
        if *active == id {
            cancel.store(true, Ordering::SeqCst);
        }
    }
    // Idle processes are closed too. Never wait on a running search's lock on the UI thread.
    if let Ok(mut engine) = state.engine.try_lock() {
        *engine = None;
    }
    Ok(())
}
#[tauri::command]
pub async fn human_game_move(app: tauri::AppHandle, request: PlayRequest) -> Result<Value, String> {
    use tauri::Manager;
    let q = query(&request)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<HumanGameEngine>();
        let mut active = state.active.lock().map_err(|e| e.to_string())?;
        if active.is_some() {
            return Err("上一手引擎请求尚未结束".into());
        }
        *active = Some((request.id.clone(), cancel.clone()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<HumanGameEngine>();
        let result = (|| {
            let mut profile = request.profile.clone();
            profile.backend = app_model::EngineBackend::KataGoAnalysis;
            let mut spec = engine_manager::build_command_spec(&profile).map_err(|e| e.to_string())?;
            if let Some(model) = request
                .human_model
                .as_ref()
                .filter(|_| request.human_rank.is_some())
            {
                spec.args.extend(["-human-model".into(), model.clone()]);
            }
            let key = format!("{:?}", spec);
            let mut slot = state.engine.lock().map_err(|e| e.to_string())?;
            if slot.as_ref().is_none_or(|(k, _, _)| k != &key) {
                *slot = None;
                let source = std::path::PathBuf::from(profile.config_path.as_deref().ok_or("缺少引擎配置")?);
                let source = if source.is_absolute() {
                    source
                } else {
                    std::path::Path::new(profile.working_dir.as_deref().unwrap_or(".")).join(source)
                };
                let private = PrivateConfig(
                    std::env::temp_dir().join(format!("lizzie-play-{}.cfg", uuid::Uuid::new_v4())),
                );
                std::fs::write(
                    &private.0,
                    play_config(&std::fs::read_to_string(source).map_err(|e| e.to_string())?),
                )
                .map_err(|e| e.to_string())?;
                if let Some(index) = spec.args.iter().position(|arg| arg == "-config") {
                    spec.args[index + 1] = private.0.to_string_lossy().into_owned();
                }
                *slot = Some((key, GtpSession::start(&spec).map_err(|e| e.to_string())?, private));
            }
            let engine = &mut slot.as_mut().unwrap().1;
            let result = (|| {
                engine.send_command(&q.to_string()).map_err(|e| e.to_string())?;
                let deadline = Instant::now() + Duration::from_secs_f64(request.max_seconds + 90.);
                loop {
                    if cancel.load(Ordering::SeqCst) {
                        return Err("对局请求已取消".into());
                    }
                    if Instant::now() > deadline {
                        return Err("引擎响应超时，请重试或结束对局".into());
                    }
                    match engine.next_event_timeout(Duration::from_millis(25)) {
                        Some(GtpSessionEvent::Line(line)) => {
                            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                                if v["id"].as_str() != Some(&request.id) {
                                    continue;
                                }
                                if let Some(e) = v.get("error") {
                                    return Err(format!("引擎拒绝对局：{e}"));
                                }
                                if v["isDuringSearch"].as_bool() != Some(true) && v.get("moveInfos").is_some()
                                {
                                    return Ok(v);
                                }
                            }
                        }
                        Some(GtpSessionEvent::Eof { .. } | GtpSessionEvent::ReadError(_)) => {
                            return Err("对局引擎已断开".into())
                        }
                        None => {}
                    }
                }
            })();
            if result.is_err() {
                *slot = None;
            }
            result
        })();
        if let Ok(mut active) = state.active.lock() {
            *active = None;
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_bad_move_sequences() {
        assert!(pairs(&["B".into()], 19).is_err());
        assert!(pairs(&["B".into(), "I4".into()], 19).is_err());
        assert!(pairs(&["W".into(), "T19".into()], 19).is_ok());
    }
}

#[cfg(test)]
mod config_tests {
    use super::*;
    #[test]
    fn private_config_normalizes_aliases_without_editing_source() {
        let source="numSearchThreads = 4\nnumAnalysisThreads = 8\nnnMaxBatchSize = 32\nother = true\n";
        let config=play_config(source);
        assert!(config.contains("numSearchThreadsPerAnalysisThread = 4"));
        assert!(!config.contains("numSearchThreads ="));
        assert_eq!(config.matches("numAnalysisThreads =").count(),1);
        assert_eq!(config.matches("nnMaxBatchSize =").count(),1);
        assert!(config.contains("other = true"));
    }
    #[test]
    fn requests_use_initial_player_and_time_override() {
        let r=PlayRequest{id:"test".into(),profile:EngineProfileDto{name:"test".into(),engine_path:"katago".into(),model_path:None,config_path:None,working_dir:None,backend:app_model::EngineBackend::KataGoAnalysis},board_size:19,komi:7.5,rules:"chinese".into(),setup:vec![],moves:vec!["B".into(),"D4".into()],player:"black".into(),max_visits:800,max_seconds:3.,human_model:None,human_rank:None};
        let q=query(&r).unwrap();
        assert_eq!(q["initialPlayer"],"B");
        assert_eq!(q["overrideSettings"]["maxTime"],3.);
        assert!(q.get("maxTime").is_none());
    }
}
