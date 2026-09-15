//! Official KataGo thread tuning, sharing the application's exclusive analysis budget.
use crate::{AnalysisJobKind, AnalysisJobRegistry};
use app_model::{EngineBackend, EngineProfileDto};
use serde::Serialize;
use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    job_id: String,
    phase: String,
    line: String,
    recommended_threads: Option<u32>,
}
fn recommendation(line: &str) -> Option<u32> {
    if !line.contains("(recommended)") {
        return None;
    }
    let (_, rest) = line.split_once("numSearchThreads")?;
    let value = rest
        .trim_start()
        .strip_prefix('=')?
        .trim_start()
        .split(':')
        .next()?
        .trim()
        .parse::<u32>()
        .ok()?;
    (value > 0 && value <= 65536).then_some(value)
}
fn validate(profile: &EngineProfileDto) -> Result<(), String> {
    if !matches!(
        profile.backend,
        EngineBackend::KataGoGtp | EngineBackend::KataGoAnalysis
    ) {
        return Err("测速只支持本地 KataGo".into());
    }
    for path in [
        Some(profile.engine_path.as_str()),
        profile.model_path.as_deref(),
        profile.config_path.as_deref(),
    ] {
        let path = path.ok_or("请选择引擎、模型和配置文件")?;
        if !Path::new(path).is_absolute() || !Path::new(path).is_file() {
            return Err("测速需要存在的本地绝对文件路径".into());
        }
    }
    Ok(())
}
#[tauri::command]
pub(super) fn setup_benchmark_start(app: AppHandle, profile: EngineProfileDto) -> Result<String, String> {
    validate(&profile)?;
    let snapshot = crate::benchmark_settings::capture(&app, &profile)?;
    let registry = app.state::<AnalysisJobRegistry>();
    let _guard = registry.lifecycle.lock().map_err(|_| "分析状态不可用")?;
    let id = format!("benchmark-{}", uuid::Uuid::new_v4());
    // Deliberately do not displace any existing live or batch analysis.
    let slot = registry.try_insert_exclusive(AnalysisJobKind::Batch, id.clone())?;
    let worker_app = app.clone();
    let job_id = id.clone();
    std::thread::spawn(move || {
        let emit = |phase: &str, line: String, recommended_threads| {
            let _ = worker_app.emit(
                "setup-benchmark-progress",
                Progress {
                    job_id: job_id.clone(),
                    phase: phase.into(),
                    line,
                    recommended_threads,
                },
            );
        };
        let result = run(&profile, &slot.cancel_token, |line| emit("running", line, None));
        worker_app
            .state::<AnalysisJobRegistry>()
            .remove_if_owner(&job_id, &slot);
        match result {
            Ok(n) => {
                let results = worker_app.state::<crate::benchmark_settings::BenchmarkResults>();
                match results.0.lock() {
                    Ok(mut results) => {
                        if results.len() >= 8 {
                            results.clear();
                        }
                        results.insert(
                            job_id.clone(),
                            crate::benchmark_settings::Completed { snapshot, threads: n },
                        );
                        emit("complete", "测速完成，可应用推荐线程数".into(), Some(n));
                    }
                    Err(_) => emit("failed", "无法保存测速结果".into(), None),
                };
            }
            Err(e) => emit(
                if slot.cancel_token.is_cancelled() {
                    "cancelled"
                } else {
                    "failed"
                },
                e,
                None,
            ),
        }
        worker_app
            .state::<AnalysisJobRegistry>()
            .remove_if_owner(&job_id, &slot);
    });
    Ok(id)
}
#[tauri::command]
pub(super) fn setup_benchmark_cancel(app: AppHandle, job_id: String) -> Result<bool, String> {
    if !job_id.starts_with("benchmark-") {
        return Err("无效的测速任务".into());
    }
    app.state::<AnalysisJobRegistry>().cancel(&job_id)
}
fn run(
    profile: &EngineProfileDto,
    token: &engine_manager::AnalysisCancelToken,
    mut progress: impl FnMut(String),
) -> Result<u32, String> {
    let mut command = Command::new(&profile.engine_path);
    command.args([
        "benchmark",
        "-config",
        profile.config_path.as_deref().unwrap(),
        "-model",
        profile.model_path.as_deref().unwrap(),
        "-s",
        "-n",
        "6",
        "-v",
        "800",
        "-time",
        "5",
        "-override-config",
        "logToStderr=false,logAllGTPCommunication=false,logSearchInfo=false",
    ]);
    if let Some(dir) = &profile.working_dir {
        command.current_dir(dir);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 KataGo 测速：{e}"))?;
    let (tx, rx) = mpsc::sync_channel(128);
    let streams: Vec<Box<dyn std::io::Read + Send>> = vec![
        Box::new(child.stdout.take().unwrap()),
        Box::new(child.stderr.take().unwrap()),
    ];
    for stream in streams {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if tx.send(line.chars().take(2048).collect::<String>()).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);
    let started = Instant::now();
    let mut recommended = None;
    loop {
        if token.is_cancelled() || started.elapsed() > Duration::from_secs(600) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if token.is_cancelled() {
                "测速已停止"
            } else {
                "测速超过 10 分钟，已停止"
            }
            .into());
        }
        while let Ok(line) = rx.try_recv() {
            if let Some(n) = recommendation(&line) {
                recommended = Some(n);
            }
            progress(line);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                // Drain both pipe readers after process exit; they close naturally at EOF.
                for line in rx {
                    if let Some(n) = recommendation(&line) {
                        recommended = Some(n);
                    }
                    progress(line);
                }
                if !status.success() {
                    return Err(format!("KataGo 测速退出：{status}"));
                }
                return recommended.ok_or("测速没有返回官方推荐线程数，未修改配置".into());
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_generic_engine_before_spawn() {
        let profile = EngineProfileDto {
            name: "x".into(),
            engine_path: "/bin/echo".into(),
            model_path: None,
            config_path: None,
            working_dir: None,
            backend: EngineBackend::GenericGtp,
        };
        assert!(validate(&profile).unwrap_err().contains("KataGo"));
    }
    #[test]
    fn only_explicit_recommendation() {
        assert_eq!(
            recommendation("numSearchThreads = 8: +12 Elo (recommended)"),
            Some(8)
        );
        assert_eq!(recommendation("numSearchThreads = 8: 6/6 positions"), None);
        assert_eq!(recommendation("numSearchThreads = 0: (recommended)"), None);
        assert_eq!(
            recommendation("Your GTP config is currently set to use numSearchThreads = 8"),
            None
        );
    }
}
