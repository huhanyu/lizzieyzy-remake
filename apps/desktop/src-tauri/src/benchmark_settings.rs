//! Trusted benchmark results and copy-on-write application to the selected profile.
use crate::{
    engine_profile_path, load_engine_profiles_settings, save_engine_profiles_settings_at_path,
    selected_engine_profile_record, AnalysisJobRegistry, EngineProfileRecordDto, EngineProfilesSettingsDto,
};
use app_model::EngineProfileDto;
use std::{collections::HashMap, fs, io::Write, sync::Mutex};
use tauri::{AppHandle, Manager};
pub(super) static PROFILE_WRITES: Mutex<()> = Mutex::new(());
#[derive(Default)]
pub(super) struct BenchmarkResults(pub(super) Mutex<HashMap<String, Completed>>);
pub(super) struct Completed {
    pub(super) snapshot: Snapshot,
    pub(super) threads: u32,
}
pub(super) struct Snapshot {
    record: String,
    config: String,
}
fn record_identity(record: &EngineProfileRecordDto) -> Result<String, String> {
    serde_json::to_string(record).map_err(|e| e.to_string())
}
pub(super) fn capture(app: &AppHandle, profile: &EngineProfileDto) -> Result<Snapshot, String> {
    let settings = load_engine_profiles_settings(app.clone())?;
    let record = selected_engine_profile_record(&settings).ok_or("未选择引擎配置")?;
    if serde_json::to_value(&record.profile).ok() != serde_json::to_value(profile).ok() {
        return Err("请先保存并选中需要测速的引擎配置".into());
    }
    let config = fs::read_to_string(profile.config_path.as_deref().ok_or("未选择配置文件")?)
        .map_err(|e| e.to_string())?;
    Ok(Snapshot {
        record: record_identity(record)?,
        config,
    })
}
fn verify(snapshot: &Snapshot, record: &EngineProfileRecordDto, config: &str) -> Result<(), String> {
    if snapshot.record != record_identity(record)? || snapshot.config != config {
        return Err("引擎、模型或配置已改变，请重新测速".into());
    }
    Ok(())
}
fn tuned_config(source: &str, threads: u32) -> Result<String, String> {
    if threads == 0 || threads > 65536 {
        return Err("无效的推荐线程数".into());
    }
    let mut result = String::new();
    for line in source.lines() {
        let key = line.split_once('=').map(|(key, _)| key.trim());
        if matches!(
            key,
            Some("numSearchThreads" | "numAnalysisThreads" | "numSearchThreadsPerAnalysisThread")
        ) {
            continue;
        }
        result.push_str(line);
        result.push('\n');
    }
    result.push_str(&format!("\n# Applied from KataGo benchmark\nnumSearchThreads = {threads}\nnumAnalysisThreads = 1\n"));
    Ok(result)
}
#[tauri::command]
pub(super) fn setup_benchmark_apply(
    app: AppHandle,
    job_id: String,
) -> Result<EngineProfilesSettingsDto, String> {
    let registry = app.state::<AnalysisJobRegistry>();
    let _lifecycle = registry.lifecycle.lock().map_err(|_| "分析状态不可用")?;
    if registry.kind_of_first().is_some() {
        return Err("请先停止分析再应用测速结果".into());
    }
    let results = app.state::<BenchmarkResults>();
    let mut results = results.0.lock().map_err(|_| "测速结果不可用")?;
    let completed = results.get(&job_id).ok_or("测速结果已失效，请重新测速")?;
    let _writes = PROFILE_WRITES.lock().map_err(|_| "配置状态不可用")?;
    let mut settings = load_engine_profiles_settings(app.clone())?;
    let record = settings
        .profiles
        .iter_mut()
        .find(|record| record.id == settings.selected_profile_id)
        .ok_or("未选择引擎")?;
    let source = fs::read_to_string(record.profile.config_path.as_deref().ok_or("未选择配置")?)
        .map_err(|e| e.to_string())?;
    verify(&completed.snapshot, record, &source)?;
    let config = tuned_config(&source, completed.threads)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("setup-configs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(format!("benchmark-{}.cfg", uuid::Uuid::new_v4()));
    record.profile.config_path = Some(target.to_string_lossy().into_owned());
    let write_result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| e.to_string())?;
        file.write_all(config.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        save_engine_profiles_settings_at_path(&engine_profile_path(&app)?, settings)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&target);
    } else {
        results.remove(&job_id);
    }
    write_result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replaces_duplicates_and_preserves_unrelated_configuration() {
        let result = tuned_config("# numSearchThreads = 99\nnumSearchThreads=2\nnumSearchThreads = 4 # old\nnumAnalysisThreads=8\nnumSearchThreadsPerAnalysisThread=2\nreportAnalysisWinratesAs = BLACK", 6).unwrap();
        assert!(result.contains("# numSearchThreads = 99"));
        assert!(result.contains("reportAnalysisWinratesAs = BLACK"));
        assert_eq!(
            result
                .lines()
                .filter(|line| line.starts_with("numSearchThreads ="))
                .count(),
            1
        );
        assert!(result.contains("numAnalysisThreads = 1"));
        assert!(!result.contains("numSearchThreadsPerAnalysisThread"));
        assert!(tuned_config("", 0).is_err());
    }
    #[test]
    fn stale_profile_or_config_is_rejected() {
        let record = crate::default_engine_profile_record();
        let snapshot = Snapshot {
            record: record_identity(&record).unwrap(),
            config: "old".into(),
        };
        assert!(verify(&snapshot, &record, "old").is_ok());
        assert!(verify(&snapshot, &record, "new").is_err());
        let mut changed = record.clone();
        changed.profile.model_path = Some("new-model".into());
        assert!(verify(&snapshot, &changed, "old").is_err());
    }
}
