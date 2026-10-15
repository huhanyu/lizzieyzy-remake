mod position;
mod runner;
#[cfg(test)]
mod tests;
pub(crate) mod training;
mod transport;
mod types;

use crate::{AnalysisJobRegistry, LiveReviewSession};
use std::{path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use types::*;

fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tolerance-review"))
}
fn valid_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id.strip_prefix("tolerance-").ok_or("任务编号无效")?).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn tolerance_start(
    app: AppHandle,
    registry: State<'_, AnalysisJobRegistry>,
    live: State<'_, Mutex<LiveReviewSession>>,
    job_id: String,
    request: ReviewRequest,
) -> Result<(), String> {
    valid_id(&job_id)?;
    request.config.validate()?;
    if request.mode == "training" && request.config.source != "ssh" {
        return Err("训练提取使用已保存的 SSH 远端配置".into());
    }
    if !["position", "scan", "compare", "training"].contains(&request.mode.as_str())
        || request.alternatives.len() > 3
    {
        return Err("任务模式或候选数无效".into());
    }
    position::Document::parse(&request.sgf_text)?.input(request.anchor_node_id)?;
    let dir = directory(&app)?;
    let mut report = runner::new_report(job_id.clone(), request);
    runner::save_report(&dir, &report)?;
    let slot = crate::start_batch_analysis(&live, &registry, job_id.clone())?;
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut session = transport::Session::start(&report.request.config, &slot.cancel_token)?;
            report.identity = Some(session.identity.clone());
            let result = {
                let mut emit = |event| {
                    let _ = app.emit("tolerance://progress", event);
                };
                runner::Runner {
                    engine: &mut session,
                    cancel: &slot.cancel_token,
                    dir: dir.clone(),
                    report: &mut report,
                    emit: &mut emit,
                }
                .run()
            };
            let cleanup = session.close();
            report.cleanup_confirmed = cleanup.is_ok();
            match (result, cleanup) {
                (Ok(()), Ok(())) => Ok(()),
                (Err(e), Ok(())) => Err(e),
                (r, Err(e)) => Err(format!("{}；{e}", r.err().unwrap_or_default())),
            }
        }))
        .unwrap_or_else(|_| Err("容错任务异常退出，保留已完成结果".into()));
        report.status = if slot.cancel_token.is_cancelled() {
            "cancelled"
        } else if outcome.is_ok() {
            "complete"
        } else {
            "failed"
        }
        .into();
        report.error = outcome.err();
        report.updated_at = runner::now();
        if let Err(e) = runner::save_report(&dir, &report) {
            report.status = "failed".into();
            report.error = Some(format!("保存结果失败：{e}"));
        }
        crate::release_batch_slot(&app, &job_id, &slot);
        let _ = app.emit("tolerance://progress", runner::event(&report, None, None));
    });
    Ok(())
}
#[tauri::command]
pub fn tolerance_cancel(registry: State<'_, AnalysisJobRegistry>, job_id: String) -> Result<(), String> {
    valid_id(&job_id)?;
    registry.cancel(&job_id)?;
    Ok(())
}
#[tauri::command]
pub fn tolerance_load(
    app: AppHandle,
    job_id: Option<String>,
    sgf_text: Option<String>,
) -> Result<Option<ReviewReport>, String> {
    let dir = directory(&app)?;
    let id = if let Some(id) = job_id {
        id
    } else {
        let hash = transport::hash_bytes(sgf_text.ok_or("缺少棋谱")?.as_bytes());
        let path = dir.join(format!("latest-{hash}.json"));
        if !path.exists() {
            return Ok(None);
        }
        serde_json::from_slice::<String>(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    };
    valid_id(&id)?;
    let path = dir.join("reports").join(format!("{id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let mut r: ReviewReport = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if r.format != FORMAT || r.algorithm != ALGORITHM {
        return Err("结果格式版本不支持".into());
    }
    let active = app
        .state::<AnalysisJobRegistry>()
        .jobs
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&id);
    if active && ["complete", "failed", "cancelled"].contains(&r.status.as_str()) {
        r.status = "running".into();
    }
    if ["starting", "running"].contains(&r.status.as_str()) && !active {
        r.status = "interrupted".into();
        r.error = Some("上次任务被中断；可重新运行并复用已验证缓存".into());
    }
    Ok(Some(r))
}
pub fn cancel_on_close(app: &AppHandle) {
    if let Ok(jobs) = app.state::<AnalysisJobRegistry>().jobs.lock() {
        for (id, entry) in jobs.iter() {
            if id.starts_with("tolerance-") || id.starts_with("training-") {
                entry.cancel_token.cancel();
            }
        }
    }
}

#[tauri::command]
pub fn tolerance_export(path: String, report_json: String) -> Result<(), String> {
    if report_json.len() > 100_000_000 {
        return Err("结果文件过大".into());
    }
    let report: ReviewReport = serde_json::from_str(&report_json).map_err(|e| e.to_string())?;
    if report.format != FORMAT {
        return Err("结果格式无效".into());
    }
    runner::atomic_json(std::path::Path::new(&path), &report)
}

#[tauri::command]
pub fn tolerance_config_load(app: AppHandle) -> Result<Option<ReviewConfig>, String> {
    let path = directory(&app)?.join("config.json");
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn tolerance_config_save(app: AppHandle, config: ReviewConfig) -> Result<(), String> {
    config.validate()?;
    runner::atomic_json(&directory(&app)?.join("config.json"), &config)
}

// Training has its own remote default so expert local settings cannot change it.
pub(super) fn load_training_config(dir: &std::path::Path) -> Result<Option<ReviewConfig>, String> {
    let preset = dir.join("training-config.json");
    let path = if preset.exists() {
        preset.clone()
    } else {
        dir.join("config.json")
    };
    if !path.exists() {
        return Ok(None);
    }
    let config: ReviewConfig = serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if config.source != "ssh" {
        if path == preset {
            return Err("训练默认配置必须使用 SSH 远端".into());
        }
        return Ok(None);
    }
    config.validate()?;
    if config.ssh_route.is_empty() || config.ssh_route.iter().any(|hop| hop.host.trim().is_empty()) {
        return Err("训练默认配置缺少远端 SSH 路线".into());
    }
    if path != preset {
        runner::atomic_json(&preset, &config)?;
    }
    Ok(Some(config))
}

#[tauri::command]
pub fn training_config_load(app: AppHandle) -> Result<Option<ReviewConfig>, String> {
    load_training_config(&directory(&app)?)
}
