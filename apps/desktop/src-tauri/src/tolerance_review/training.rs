use super::{position::Document, runner, transport::Session, types::ReviewConfig};
use crate::{AnalysisJobRegistry, LiveReviewSession};
use engine_manager::AnalysisCancelToken;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub fn training_position(sgf_text: String, node_id: Uuid) -> Result<Value, String> {
    let doc = Document::parse(&sgf_text)?;
    doc.input(node_id)?;
    let copy = sgf::training_prefix(&sgf_text, node_id).map_err(|e| e.to_string())?;
    let position =
        sgf::replay_sgf_position_at_node(&copy.sgf_text, copy.node_id).map_err(|e| e.to_string())?;
    Ok(json!({"sgfText":copy.sgf_text,"nodeId":copy.node_id,"position":position}))
}

pub(super) fn play_query(
    doc: &Document,
    node_id: Uuid,
    config: &ReviewConfig,
    id: &str,
    visits: u32,
    seconds: f64,
) -> Result<Value, String> {
    if !(1..=131072).contains(&visits) || !seconds.is_finite() || !(0.1..=60.0).contains(&seconds) {
        return Err("训练对弈预算无效".into());
    }
    let p = doc.input(node_id)?;
    let mut query = runner::make_query(&p, config, visits, None);
    query["id"] = json!(id);
    query["overrideSettings"]["maxTime"] = json!(seconds);
    query["overrideSettings"]["humanSLRootExploreProbWeightless"] = json!(0);
    Ok(query)
}

#[allow(clippy::too_many_arguments)] // Keep explicit query inputs aligned with the Tauri boundary.
pub(super) fn play(
    session: &mut Session,
    doc: &Document,
    node_id: Uuid,
    config: &ReviewConfig,
    id: &str,
    visits: u32,
    seconds: f64,
    cancel: &AnalysisCancelToken,
) -> Result<Value, String> {
    let p = doc.input(node_id)?;
    let query = play_query(doc, node_id, config, id, visits, seconds)?;
    let response = session.query(&query, cancel)?;
    if cancel.is_cancelled() {
        return Err("已取消训练计算".into());
    }
    if response["id"] != id
        || response["turnNumber"].as_u64() != Some(u64::from(p.turn))
        || response["rootInfo"]["currentPlayer"] != p.player
    {
        return Err("训练引擎返回了其他局面的结果".into());
    }
    if !response["moveInfos"]
        .as_array()
        .is_some_and(|moves| !moves.is_empty())
    {
        return Err("训练引擎未返回落点".into());
    }
    Ok(response)
}

fn valid_id(id: &str) -> Result<(), String> {
    Uuid::parse_str(id.strip_prefix("training-").ok_or("训练编号无效")?).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri state and IPC arguments are injected separately.
pub async fn training_move(
    app: AppHandle,
    registry: State<'_, AnalysisJobRegistry>,
    live: State<'_, Mutex<LiveReviewSession>>,
    id: String,
    config: ReviewConfig,
    sgf_text: String,
    node_id: Uuid,
    visits: u32,
    seconds: f64,
) -> Result<Value, String> {
    valid_id(&id)?;
    config.validate()?;
    let doc = Document::parse(&sgf_text)?;
    play_query(&doc, node_id, &config, &id, visits, seconds)?;
    let slot = crate::start_batch_analysis(&live, &registry, id.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut session = Session::start(&config, &slot.cancel_token)?;
            let result = play(
                &mut session,
                &doc,
                node_id,
                &config,
                &id,
                visits,
                seconds,
                &slot.cancel_token,
            );
            let cleanup = session.close();
            match cleanup {
                Ok(()) => result,
                Err(e) => Err(format!("训练计算退出未确认：{e}")),
            }
        }))
        .unwrap_or_else(|_| Err("训练计算异常退出".into()));
        crate::release_batch_slot(&app, &id, &slot);
        outcome
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn training_cancel(registry: State<'_, AnalysisJobRegistry>, id: String) -> Result<(), String> {
    valid_id(&id)?;
    registry.cancel(&id)?;
    Ok(())
}
