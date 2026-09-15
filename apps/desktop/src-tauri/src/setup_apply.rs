//! Compare-and-swap commit shared with all engine profile writers.
use crate::{
    benchmark_settings::PROFILE_WRITES, engine_profile_path, load_engine_profiles_settings,
    save_engine_profiles_settings_at_path, AnalysisJobRegistry, EngineProfilesSettingsDto,
};
use tauri::{AppHandle, Manager};
fn assert_current(
    expected: &EngineProfilesSettingsDto,
    current: &EngineProfilesSettingsDto,
) -> Result<(), String> {
    if serde_json::to_value(expected).map_err(|e| e.to_string())?
        != serde_json::to_value(current).map_err(|e| e.to_string())?
    {
        return Err("引擎配置已改变，下载已保留，请重新确认并应用".into());
    }
    Ok(())
}
#[tauri::command]
pub(super) fn setup_apply_profiles(
    app: AppHandle,
    expected: EngineProfilesSettingsDto,
    settings: EngineProfilesSettingsDto,
) -> Result<EngineProfilesSettingsDto, String> {
    let registry = app.state::<AnalysisJobRegistry>();
    let _lifecycle = registry.lifecycle.lock().map_err(|_| "分析状态不可用")?;
    if registry.kind_of_first().is_some() {
        return Err("请先停止分析再应用配置".into());
    }
    let _writes = PROFILE_WRITES.lock().map_err(|_| "配置状态不可用")?;
    assert_current(&expected, &load_engine_profiles_settings(app.clone())?)?;
    if !settings
        .profiles
        .iter()
        .any(|record| record.id == settings.selected_profile_id)
    {
        return Err("所选引擎配置不存在".into());
    }
    save_engine_profiles_settings_at_path(&engine_profile_path(&app)?, settings)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compare_and_swap_rejects_concurrent_edits() {
        let expected = crate::default_engine_profiles_settings();
        assert!(assert_current(&expected, &expected).is_ok());
        let mut current = expected.clone();
        current.profiles[0].max_visits += 1;
        assert!(assert_current(&expected, &current).is_err());
        current = expected.clone();
        current.selected_profile_id = "other".into();
        assert!(assert_current(&expected, &current).is_err());
    }
}
