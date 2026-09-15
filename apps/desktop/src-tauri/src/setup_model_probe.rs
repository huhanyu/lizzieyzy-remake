//! Load a selected model through the existing managed GTP transport before applying it.
use crate::{AnalysisJobKind, AnalysisJobRegistry};
use app_model::{EngineBackend, EngineProfileDto};
use engine_manager::{build_command_spec, GtpSession, GtpSessionEvent};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
#[tauri::command]
pub(super) async fn setup_model_probe(
    app: AppHandle,
    mut profile: EngineProfileDto,
    id: Option<String>,
) -> Result<String, String> {
    if !matches!(
        profile.backend,
        EngineBackend::KataGoGtp | EngineBackend::KataGoAnalysis
    ) {
        return Err("仅支持本地 KataGo 模型检查".into());
    }
    profile.backend = EngineBackend::KataGoGtp;
    let spec = build_command_spec(&profile).map_err(|e| e.to_string())?;
    let id = probe_id(id.as_deref())?;
    let slot = {
        let registry = app.state::<AnalysisJobRegistry>();
        let _guard = registry.lifecycle.lock().map_err(|_| "分析状态不可用")?;
        registry.try_insert_exclusive(AnalysisJobKind::Batch, id.clone())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<AnalysisJobRegistry>();
        let result = (|| {
            let mut session = GtpSession::start(&spec).map_err(|e| e.to_string())?;
            session.send_command("901 name").map_err(|e| e.to_string())?;
            session.send_command("902 version").map_err(|e| e.to_string())?;
            let started = Instant::now();
            let mut name_ok = false;
            while started.elapsed() < Duration::from_secs(120) {
                if slot.cancel_token.is_cancelled() {
                    return Err("模型检查已取消".into());
                }
                match session.next_event_timeout(Duration::from_millis(50)) {
                    Some(GtpSessionEvent::Line(line)) => {
                        if line.starts_with("=901") {
                            name_ok = line.to_lowercase().contains("katago");
                        }
                        if line.starts_with("=902") && name_ok {
                            return Ok(line.trim_start_matches("=902").trim().chars().take(128).collect());
                        }
                        if line.starts_with("?901") || line.starts_with("?902") {
                            return Err("引擎未通过 GTP 握手".into());
                        }
                    }
                    Some(GtpSessionEvent::Eof { .. }) | Some(GtpSessionEvent::ReadError(_)) => break,
                    _ => {}
                }
            }
            Err(format!(
                "模型未在 120 秒内通过加载检查：{}",
                session
                    .stderr_snapshot()
                    .chars()
                    .rev()
                    .take(2000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            ))
            // GtpSession Drop kills and reaps the child, including all early returns.
        })();
        registry.remove_if_owner(&id, &slot);
        result
    })
    .await
    .map_err(|e| format!("模型检查任务失败：{e}"))?
}

fn probe_id(id: Option<&str>) -> Result<String, String> {
    let id = match id {
        Some(id) => uuid::Uuid::parse_str(id).map_err(|_| "无效的模型检查任务")?,
        None => uuid::Uuid::new_v4(),
    };
    Ok(format!("model-probe-{id}"))
}
#[tauri::command]
pub(super) fn setup_model_probe_cancel(app: AppHandle, id: String) -> Result<bool, String> {
    app.state::<AnalysisJobRegistry>().cancel(&probe_id(Some(&id))?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_ids_cannot_target_other_jobs() {
        assert!(probe_id(Some("benchmark-other")).is_err());
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(probe_id(Some(&id)).unwrap(), format!("model-probe-{id}"));
        let registry = AnalysisJobRegistry::default();
        let key = probe_id(Some(&id)).unwrap();
        let slot = registry
            .try_insert_exclusive(AnalysisJobKind::Batch, key.clone())
            .unwrap();
        assert!(registry.cancel(&key).unwrap());
        assert!(slot.cancel_token.is_cancelled());
    }
}
