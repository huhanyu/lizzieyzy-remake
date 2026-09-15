//! A single bounded local curve worker, independent of the foreground engine.
use crate::{
    prepare_katago_batch_analysis, run_katago_analysis_job, AnalysisJobKind, AnalysisJobRegistry,
    EngineProfileDto,
};
use tauri::{AppHandle, State};
use uuid::Uuid;
#[derive(Default)]
pub(super) struct CurveRegistry(pub AnalysisJobRegistry);
#[tauri::command]
pub(super) fn start_background_curve(
    app_handle: AppHandle,
    registry: State<'_, CurveRegistry>,
    mut profile: EngineProfileDto,
    sgf_text: String,
) -> Result<String, String> {
    profile.backend = app_model::EngineBackend::KataGoAnalysis;
    let id = Uuid::new_v4();
    let key = format!("curve-{id}");
    let mut prepared = prepare_katago_batch_analysis(&sgf_text, id, 1)?;
    let mut query: serde_json::Value =
        serde_json::from_str(&prepared.query_jsonl).map_err(|e| e.to_string())?;
    query["includeOwnership"] = false.into();
    query["includePolicy"] = false.into();
    prepared.query_jsonl = serde_json::to_string(&query).map_err(|e| e.to_string())? + "\n";
    // Analysis mode rejects both thread aliases appearing together. Strip them from
    // a private copy rather than overlaying or editing the saved foreground config.
    let source = std::path::Path::new(profile.config_path.as_deref().ok_or("缺少本地补线配置")?);
    let source = if source.is_absolute() {
        source.to_path_buf()
    } else {
        std::path::Path::new(profile.working_dir.as_deref().unwrap_or(".")).join(source)
    };
    let original = std::fs::read_to_string(source).map_err(|e| e.to_string())?;
    let config = std::env::temp_dir().join(format!("lizzie-curve-{id}.cfg"));
    std::fs::write(&config, curve_config(&original)).map_err(|e| e.to_string())?;
    profile.config_path = Some(config.to_string_lossy().into_owned());
    let spec = match engine_manager::build_command_spec(&profile) {
        Ok(spec) => spec,
        Err(e) => {
            let _ = std::fs::remove_file(&config);
            return Err(e.to_string());
        }
    };
    let slot = match registry
        .0
        .try_insert_exclusive(AnalysisJobKind::Batch, key.clone())
    {
        Ok(slot) => slot,
        Err(e) => {
            let _ = std::fs::remove_file(&config);
            return Err(e);
        }
    };
    let result_key = key.clone();
    std::thread::spawn(move || {
        run_katago_analysis_job(app_handle, id, key, spec, prepared, slot);
        let _ = std::fs::remove_file(config);
    });
    Ok(result_key)
}
fn curve_config(source: &str) -> String {
    let mut lines: Vec<&str> = source
        .lines()
        .filter(|line| {
            let key = line.split_once('=').map(|(key, _)| key.trim()).unwrap_or("");
            ![
                "numSearchThreads",
                "numSearchThreadsPerAnalysisThread",
                "numAnalysisThreads",
                "nnMaxBatchSize",
            ]
            .contains(&key)
        })
        .collect();
    lines.push("numSearchThreads = 1\nnumAnalysisThreads = 1\nnnMaxBatchSize = 1");
    lines.join("\n") + "\n"
}
#[tauri::command]
pub(super) fn cancel_background_curve(
    registry: State<'_, CurveRegistry>,
    job_id: String,
) -> Result<bool, String> {
    registry.0.cancel(&job_id)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires explicit local KataGo fixture paths"]
    fn real_curve_exits_while_foreground_remains_responsive() {
        use engine_manager::{AnalysisBatchRunOptions, GtpSession, GtpSessionEvent};
        use std::time::{Duration, Instant};
        let engine = std::env::var("CURVE_QA_ENGINE").unwrap();
        let model = std::env::var("CURVE_QA_MODEL").unwrap();
        let source = std::env::var("CURVE_QA_CONFIG").unwrap();
        let temp = std::env::temp_dir().join(format!("curve-real-{}.cfg", Uuid::new_v4()));
        std::fs::write(&temp, curve_config(&std::fs::read_to_string(source).unwrap())).unwrap();
        let profile = EngineProfileDto {
            name: "curve QA".into(),
            engine_path: engine,
            model_path: Some(model),
            config_path: Some(temp.to_string_lossy().into_owned()),
            working_dir: None,
            backend: app_model::EngineBackend::KataGoGtp,
        };
        let mut live = GtpSession::start(&engine_manager::build_command_spec(&profile).unwrap()).unwrap();
        live.send_command("kata-analyze B 10").unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut initial = false;
        while Instant::now() < deadline {
            if matches!(live.next_event_timeout(Duration::from_millis(100)),Some(GtpSessionEvent::Line(line)) if line.starts_with("info "))
            {
                initial = true;
                break;
            }
        }
        assert!(initial, "foreground did not start");
        let batch = EngineProfileDto {
            backend: app_model::EngineBackend::KataGoAnalysis,
            ..profile
        };
        let spec = engine_manager::build_command_spec(&batch).unwrap();
        let prepared = prepare_katago_batch_analysis(
            "(;GM[1]FF[4]SZ[19]KM[7.5];B[pd];W[dd];B[pp];W[dp])",
            Uuid::new_v4(),
            1,
        )
        .unwrap();
        let worker = std::thread::spawn(move || {
            engine_manager::run_katago_analysis_batch_with_options(
                &spec,
                &prepared.query_jsonl,
                AnalysisBatchRunOptions {
                    expected_responses: prepared.expected,
                    timeout: Duration::from_secs(60),
                    cancel_token: None,
                    on_progress: None,
                },
            )
        });
        let mut concurrent = 0;
        while !worker.is_finished() {
            if matches!(live.next_event_timeout(Duration::from_millis(100)),Some(GtpSessionEvent::Line(line)) if line.starts_with("info "))
            {
                concurrent += 1;
            }
        }
        let result = worker.join().unwrap().unwrap();
        assert_eq!(result.response_jsonl_lines.len(), 5);
        assert!(
            concurrent > 0,
            "foreground must return frames during background work"
        );
        live.send_command("stop").unwrap();
        live.send_command("991 name").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut ack = false;
        while Instant::now() < deadline {
            if matches!(live.next_event_timeout(Duration::from_millis(100)),Some(GtpSessionEvent::Line(line)) if line.starts_with("=991") && line.contains("KataGo"))
            {
                ack = true;
                break;
            }
        }
        assert!(ack, "foreground must survive background exit");
        live.close().unwrap();
        std::fs::remove_file(temp).unwrap();
        println!("real parallel curve: 5 positions; {concurrent} foreground frames during batch; foreground acknowledged after batch exit");
    }
    #[test]
    fn config_has_one_thread_alias_only() {
        let cfg = curve_config(
            "numSearchThreads=8\nnumSearchThreadsPerAnalysisThread=8\nnumAnalysisThreads=2\nrules=chinese",
        );
        assert!(!cfg.contains("numSearchThreadsPerAnalysisThread"));
        assert_eq!(cfg.matches("numSearchThreads = 1").count(), 1);
        assert!(cfg.contains("rules=chinese"));
    }
    #[test]
    fn curve_ownership_and_cancellation_are_independent() {
        let foreground = AnalysisJobRegistry::default();
        let live = foreground
            .try_insert_exclusive(AnalysisJobKind::Live, "live".into())
            .unwrap();
        let background = CurveRegistry::default();
        let curve = background
            .0
            .try_insert_exclusive(AnalysisJobKind::Batch, "curve-one".into())
            .unwrap();
        assert!(background
            .0
            .try_insert_exclusive(AnalysisJobKind::Batch, "curve-two".into())
            .is_err());
        background.0.cancel("curve-one").unwrap();
        assert!(curve.cancel_token.is_cancelled());
        assert!(!live.cancel_token.is_cancelled());
        assert!(background.0.remove_if_owner("curve-one", &curve));
        assert!(foreground.kind_of_first().is_some());
    }
}
