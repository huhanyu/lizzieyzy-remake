use app_model::{EngineBackend, EngineProfileDto};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub working_dir: Option<String>,
    pub env: Vec<(String, String)>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetCheck {
    pub path: String,
    pub exists: bool,
    pub required: bool,
    pub label: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisRunResult {
    pub response_jsonl: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisBatchRunResult {
    pub response_jsonl_lines: Vec<String>,
    pub stderr: String,
    pub exit_code: Option<i32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisBatchProgress {
    pub response_index: usize,
    pub expected_responses: usize,
    pub response_jsonl_line: String,
}
#[derive(Debug, Clone, Default)]
pub struct AnalysisCancelToken {
    cancelled: Arc<AtomicBool>,
}
impl AnalysisCancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Whether `other` is this same token (a clone sharing one flag), not merely a token that
    /// happens to hold the same cancellation state.
    ///
    /// The registry uses this to answer "is the slot still the entry I took it with?" without
    /// minting a second identity: every job gets a fresh token, and the clone handed to the worker
    /// stays pointer-identical to the one stored in the registry.
    pub fn is_same_as(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.cancelled, &other.cancelled)
    }
}
pub struct AnalysisBatchRunOptions<'a> {
    pub expected_responses: usize,
    pub timeout: Duration,
    pub cancel_token: Option<&'a AnalysisCancelToken>,
    pub on_progress: Option<&'a mut dyn FnMut(AnalysisBatchProgress)>,
}
impl<'a> AnalysisBatchRunOptions<'a> {
    pub fn new(expected_responses: usize, timeout: Duration) -> Self {
        Self {
            expected_responses,
            timeout,
            cancel_token: None,
            on_progress: None,
        }
    }
}

/// One line read from a long-lived engine's stdout.
///
/// The variants deliberately separate the three things a GTP reader must distinguish:
/// ordinary lines (GTP `=`/`?` responses and engine-pushed `info` stream lines alike),
/// end-of-stream, and read failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GtpSessionEvent {
    /// A single raw stdout line with its line ending removed.
    ///
    /// This covers both GTP responses (`= ...` / `? ...`) and unsolicited engine output
    /// (the `info ...` stream produced by `kata-analyze`); the caller classifies them.
    Line(String),
    /// The engine closed its stdout.
    ///
    /// For a long-lived session this only happens when the engine exited (crash or a
    /// deliberate quit), so it must be surfaced as an error rather than treated as a
    /// normal end of data. The exit code is always `None` here because the reader thread
    /// does not own the `Child`; [`GtpSession::close`] reaps the process and reports the
    /// code.
    Eof { exit_code: Option<i32> },
    /// Reading stdout failed.
    ReadError(String),
}

/// A long-lived KataGo GTP session.
///
/// Unlike the one-shot `run_katago_analysis_*` helpers, which spawn an engine, write one
/// query and wait for the process to exit, this keeps a single engine process alive across
/// many commands — the prerequisite for streaming `kata-analyze` review.
///
/// Sending and reading are fully decoupled (see `plans/GTP_LIVE_PROBE_FINDINGS.md` §4): a
/// dedicated reader thread drains stdout into [`GtpSessionEvent`]s while
/// [`GtpSession::send_command`] only writes and flushes, never waiting for a `=` response.
/// Blocking on a response would stall the caller for an unbounded time (pipes coalesce
/// responses) and would prevent engine-pushed `info` lines from being observed, destroying
/// live-update latency.
pub struct GtpSession {
    child: Child,
    /// `None` once the session is closed; this is what actually closes the engine's stdin.
    stdin: Option<std::process::ChildStdin>,
    events: Receiver<GtpSessionEvent>,
    stdout_reader: Option<thread::JoinHandle<()>>,
    stderr_snapshot: Arc<std::sync::Mutex<String>>,
    stderr_reader: Option<thread::JoinHandle<()>>,
    closed: bool,
}
#[derive(Debug, Error)]
pub enum EngineManagerError {
    #[error("engine path is required")]
    MissingEnginePath,
    #[error("model path is required for KataGo analysis")]
    MissingModelPath,
    #[error("config path is required for KataGo analysis")]
    MissingConfigPath,
    #[error("engine path does not exist: {path}")]
    EnginePathNotFound { path: String },
    #[error("model path does not exist: {path}")]
    ModelPathNotFound { path: String },
    #[error("config path does not exist: {path}")]
    ConfigPathNotFound { path: String },
    #[error("working directory does not exist: {path}")]
    WorkingDirNotFound { path: String },
    #[error("failed to spawn engine `{program}`: {source}")]
    Spawn {
        program: String,
        #[source]
        source: io::Error,
    },
    #[error(
        "failed to write analysis query to engine stdin: {source}; exit_code={exit_code:?}; stderr={stderr}"
    )]
    StdinWrite {
        #[source]
        source: io::Error,
        exit_code: Option<i32>,
        stderr: String,
    },
    #[error("failed to read engine stdout: {source}; exit_code={exit_code:?}; stderr={stderr}")]
    StdoutRead {
        #[source]
        source: io::Error,
        exit_code: Option<i32>,
        stderr: String,
    },
    #[error("failed while waiting for engine process: {source}")]
    Wait {
        #[source]
        source: io::Error,
    },
    #[error("engine did not write an analysis response; exit_code={exit_code:?}; stderr={stderr}")]
    MissingStdout { exit_code: Option<i32>, stderr: String },
    #[error(
        "engine wrote fewer analysis responses than expected; expected={expected_responses}; received={received_responses}; exit_code={exit_code:?}; stdout={stdout:?}; stderr={stderr}"
    )]
    InsufficientStdout {
        expected_responses: usize,
        received_responses: usize,
        stdout: Vec<String>,
        exit_code: Option<i32>,
        stderr: String,
    },
    #[error("engine exited unsuccessfully; exit_code={exit_code:?}; stdout={stdout:?}; stderr={stderr}")]
    NonZeroExit {
        exit_code: Option<i32>,
        stdout: Option<String>,
        stderr: String,
    },
    #[error(
        "engine analysis timed out after {timeout_ms}ms; exit_code={exit_code:?}; stdout={stdout:?}; stderr={stderr}"
    )]
    Timeout {
        timeout_ms: u128,
        exit_code: Option<i32>,
        stdout: Option<String>,
        stderr: String,
    },
    #[error(
        "engine analysis was cancelled; received_responses={received_responses}; exit_code={exit_code:?}; stdout={stdout:?}; stderr={stderr}"
    )]
    Cancelled {
        received_responses: usize,
        stdout: Vec<String>,
        exit_code: Option<i32>,
        stderr: String,
    },
    #[error("engine session is not running")]
    SessionNotRunning,
    #[error("engine session already exited with code {exit_code:?}: {stderr}")]
    SessionExited { exit_code: Option<i32>, stderr: String },
    #[error("failed to write command to engine session: {source}")]
    SessionWrite {
        #[source]
        source: io::Error,
    },
    #[error("engine session stop was acknowledged without the engine closing the stream")]
    SessionStopUnconfirmed,
}

pub fn run_katago_analysis_batch(
    spec: &CommandSpec,
    query_jsonl: &str,
    expected_responses: usize,
    timeout: Duration,
) -> Result<AnalysisBatchRunResult, EngineManagerError> {
    run_katago_analysis_batch_with_options(
        spec,
        query_jsonl,
        AnalysisBatchRunOptions::new(expected_responses, timeout),
    )
}

pub fn run_katago_analysis_batch_with_options(
    spec: &CommandSpec,
    query_jsonl: &str,
    mut options: AnalysisBatchRunOptions<'_>,
) -> Result<AnalysisBatchRunResult, EngineManagerError> {
    validate_command_spec(spec)?;

    if options.expected_responses == 0 {
        return Ok(AnalysisBatchRunResult {
            response_jsonl_lines: Vec::new(),
            stderr: String::new(),
            exit_code: None,
        });
    }

    let mut command = build_process_command(spec);
    let mut child = command.spawn().map_err(|source| EngineManagerError::Spawn {
        program: spec.program.clone(),
        source,
    })?;

    let stdout = child
        .stdout
        .take()
        .expect("stdout is piped before spawning the engine");
    let stderr = child
        .stderr
        .take()
        .expect("stderr is piped before spawning the engine");
    let stdout_rx = spawn_stdout_lines_reader(stdout);
    let stderr_rx = spawn_stderr_reader(stderr);

    if let Err(source) = write_query(&mut child, query_jsonl) {
        let _ = child.kill();
        let exit_code = child.wait().ok().and_then(|status| status.code());
        let stderr = receive_stderr(stderr_rx);
        return Err(EngineManagerError::StdinWrite {
            source,
            exit_code,
            stderr,
        });
    }

    if is_cancelled(&options) {
        let exit_code = kill_cancelled_child(&mut child)
            .ok()
            .and_then(|status| status.code());
        let stderr = receive_stderr(stderr_rx);
        return Err(EngineManagerError::Cancelled {
            received_responses: 0,
            stdout: Vec::new(),
            exit_code,
            stderr,
        });
    }

    let deadline = Instant::now() + options.timeout;
    let mut response_lines = Vec::new();
    let status = loop {
        if is_cancelled(&options) {
            let exit_code = kill_cancelled_child(&mut child)
                .ok()
                .and_then(|status| status.code());
            let stderr = receive_stderr(stderr_rx);
            return Err(EngineManagerError::Cancelled {
                received_responses: response_lines.len(),
                stdout: response_lines,
                exit_code,
                stderr,
            });
        }

        match receive_available_stdout_line(&stdout_rx) {
            Ok(Some(line)) => {
                push_batch_response_line(&mut response_lines, line, &mut options);
                if response_lines.len() >= options.expected_responses {
                    break wait_for_batch_exit(
                        &mut child,
                        deadline,
                        options.timeout,
                        &response_lines,
                        &stderr_rx,
                        &options,
                    )?;
                }
            }
            Ok(None) => {
                break wait_until_deadline(&mut child, deadline, options.timeout)?;
            }
            Err(BatchStdoutEventError::Read(source)) => {
                let _ = child.kill();
                let exit_code = child.wait().ok().and_then(|status| status.code());
                let stderr = receive_stderr(stderr_rx);
                return Err(EngineManagerError::StdoutRead {
                    source,
                    exit_code,
                    stderr,
                });
            }
            Err(BatchStdoutEventError::NoLineReady) => {}
        }

        if let Some(status) = child
            .try_wait()
            .map_err(|source| EngineManagerError::Wait { source })?
        {
            collect_remaining_stdout(
                &stdout_rx,
                &mut response_lines,
                status.code(),
                &stderr_rx,
                &mut options,
            )?;
            break status;
        }

        if Instant::now() >= deadline {
            let exit_code = kill_timed_out_child(&mut child)
                .ok()
                .and_then(|status| status.code());
            let stderr = receive_stderr(stderr_rx);
            return Err(EngineManagerError::Timeout {
                timeout_ms: options.timeout.as_millis(),
                exit_code,
                stdout: stdout_summary(&response_lines),
                stderr,
            });
        }

        thread::sleep(Duration::from_millis(10));
    };

    collect_remaining_stdout(
        &stdout_rx,
        &mut response_lines,
        status.code(),
        &stderr_rx,
        &mut options,
    )?;
    let stderr = receive_stderr(stderr_rx);

    if !status.success() {
        return Err(EngineManagerError::NonZeroExit {
            exit_code: status.code(),
            stdout: stdout_summary(&response_lines),
            stderr,
        });
    }

    if response_lines.is_empty() {
        return Err(EngineManagerError::MissingStdout {
            exit_code: status.code(),
            stderr,
        });
    }

    if response_lines.len() < options.expected_responses {
        return Err(EngineManagerError::InsufficientStdout {
            expected_responses: options.expected_responses,
            received_responses: response_lines.len(),
            stdout: response_lines,
            exit_code: status.code(),
            stderr,
        });
    }

    response_lines.truncate(options.expected_responses);
    Ok(AnalysisBatchRunResult {
        response_jsonl_lines: response_lines,
        stderr,
        exit_code: status.code(),
    })
}

pub fn build_command_spec(profile: &EngineProfileDto) -> Result<CommandSpec, EngineManagerError> {
    if profile.engine_path.trim().is_empty() {
        return Err(EngineManagerError::MissingEnginePath);
    }
    let working_dir = normalized_optional_path(profile.working_dir.as_deref());
    if let Some(working_dir) = working_dir.as_deref() {
        if !Path::new(working_dir).is_dir() {
            return Err(EngineManagerError::WorkingDirNotFound {
                path: working_dir.to_string(),
            });
        }
    }
    let program = resolve_program_path(&profile.engine_path, working_dir.as_deref());
    match profile.backend {
        EngineBackend::KataGoAnalysis => {
            let (model, config) = resolve_katago_assets(profile, working_dir.as_deref())?;
            let mut args = vec![
                "analysis".into(),
                "-config".into(),
                config.clone(),
                "-model".into(),
                model,
            ];
            // GTP configurations omit two mandatory analysis-mode settings. Supply conservative
            // defaults only for absent keys; never rewrite the user's configuration.
            let defaults = [("numAnalysisThreads", "1"), ("nnMaxBatchSize", "16")];
            let overrides: Vec<String> = defaults
                .into_iter()
                .filter(|(key, _)| !config_defines_key(&config, key))
                .map(|(key, value)| format!("{key}={value}"))
                .collect();
            if !overrides.is_empty() {
                args.push("-override-config".into());
                args.push(overrides.join(","));
            }
            Ok(CommandSpec {
                program,
                args,
                working_dir,
                env: vec![],
            })
        }
        EngineBackend::KataGoGtp => {
            // The GTP backend needs the same weights and a config file as the analysis backend;
            // without them KataGo starts with no neural net and cannot answer `kata-analyze`.
            // It must be given a GTP config (e.g. `gtp.cfg`), not the batch `analysis.cfg`: the two
            // configure different engine behaviour (see plans/GTP_LIVE_PROBE_FINDINGS.md §1).
            let (model, config) = resolve_katago_assets(profile, working_dir.as_deref())?;
            // Pin the reporting perspective to Black. `kata-analyze` reports winrate/score/ownership
            // from the perspective of whichever side the config selects; the shipped `gtp.cfg` leaves
            // `reportAnalysisWinratesAs` commented out, which makes it fall back to side-to-move. The
            // repo DTO convention is fixed black (`winrate_black`, `score_mean_black`), so without this
            // override every white-to-play position is reported inverted - a silent, direction-flipping
            // error. The key is optional in KataGo and cannot be probed from the engine side, so it is
            // forced here rather than left to the user's config. Measured: white to play reports
            // winrate ~0.99 without the override and ~0.004 with it (complements of each other).
            let perspective = "reportAnalysisWinratesAs=BLACK";
            Ok(CommandSpec {
                program,
                args: vec![
                    "gtp".into(),
                    "-model".into(),
                    model,
                    "-config".into(),
                    config,
                    "-override-config".into(),
                    perspective.into(),
                ],
                working_dir,
                env: vec![],
            })
        }
        EngineBackend::GenericGtp | EngineBackend::ReadboardSidecar => Ok(CommandSpec {
            program,
            args: vec![],
            working_dir,
            env: vec![],
        }),
    }
}

/// Resolve and validate the `model`/`config` assets both KataGo backends require.
///
/// Returns the resolved `(model, config)` paths. Missing or non-existent assets are reported with
/// the same `EngineManagerError` variants the analysis backend has always used, so the GTP backend
/// now fails loudly instead of silently starting an engine with no weights.
fn resolve_katago_assets(
    profile: &EngineProfileDto,
    working_dir: Option<&str>,
) -> Result<(String, String), EngineManagerError> {
    let model = profile
        .model_path
        .as_ref()
        .filter(|v| !v.trim().is_empty())
        .ok_or(EngineManagerError::MissingModelPath)?;
    let config = profile
        .config_path
        .as_ref()
        .filter(|v| !v.trim().is_empty())
        .ok_or(EngineManagerError::MissingConfigPath)?;
    let model = resolve_asset_path(model, working_dir);
    let config = resolve_asset_path(config, working_dir);
    if !asset_exists(&model) {
        return Err(EngineManagerError::ModelPathNotFound { path: model });
    }
    if !asset_exists(&config) {
        return Err(EngineManagerError::ConfigPathNotFound { path: config });
    }
    Ok((model, config))
}

// Includes may supply settings externally. Leave those configurations to KataGo rather than
// overriding values we have not resolved. Invalid explicit values also remain engine errors.
fn config_defines_key(config_path: &str, wanted: &str) -> bool {
    let Ok(contents) = std::fs::read_to_string(config_path) else {
        return true;
    };
    contents.lines().any(|line| {
        let line = line.split('#').next().unwrap_or("").trim();
        line.starts_with("@include") || line.split_once('=').is_some_and(|(key, _)| key.trim() == wanted)
    })
}

pub fn check_assets(profile: &EngineProfileDto) -> Vec<AssetCheck> {
    // Both KataGo backends need a model and a config; the GTP backend previously escaped this
    // check, so a wrong weight path only surfaced later as a silently dead session.
    let requires_katago_assets = matches!(
        profile.backend,
        EngineBackend::KataGoAnalysis | EngineBackend::KataGoGtp
    );
    let working_dir = normalized_optional_path(profile.working_dir.as_deref());
    let engine_path = resolve_program_path(&profile.engine_path, working_dir.as_deref());
    let mut checks = vec![AssetCheck {
        path: engine_path.clone(),
        exists: program_exists(&engine_path),
        required: true,
        label: "engine binary".into(),
    }];
    if let Some(working_dir) = working_dir.as_deref() {
        checks.push(AssetCheck {
            path: working_dir.to_string(),
            exists: Path::new(working_dir).is_dir(),
            required: true,
            label: "working directory".into(),
        });
    }
    if requires_katago_assets || profile.model_path.is_some() {
        let model = profile.model_path.as_deref().unwrap_or("");
        let resolved_model = resolve_asset_path(model, working_dir.as_deref());
        checks.push(AssetCheck {
            path: resolved_model.clone(),
            exists: asset_exists(&resolved_model),
            required: requires_katago_assets,
            label: "model".into(),
        });
    }
    if requires_katago_assets || profile.config_path.is_some() {
        let config = profile.config_path.as_deref().unwrap_or("");
        let resolved_config = resolve_asset_path(config, working_dir.as_deref());
        checks.push(AssetCheck {
            path: resolved_config.clone(),
            exists: asset_exists(&resolved_config),
            required: requires_katago_assets,
            label: "config".into(),
        });
    }
    checks
}

fn asset_exists(path: &str) -> bool {
    if path.trim().is_empty() {
        return false;
    }
    Path::new(path).exists()
}

fn normalized_optional_path(path: Option<&str>) -> Option<String> {
    path.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn resolve_program_path(program: &str, working_dir: Option<&str>) -> String {
    let trimmed = program.trim();
    if trimmed.is_empty() || !should_preflight_program_path(trimmed) {
        return trimmed.to_string();
    }
    resolve_path(trimmed, working_dir)
}

fn resolve_asset_path(path: &str, working_dir: Option<&str>) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    resolve_path(trimmed, working_dir)
}

fn resolve_path(path: &str, working_dir: Option<&str>) -> String {
    let path = Path::new(path);
    if path.is_absolute() {
        return path.to_string_lossy().into_owned();
    }

    match working_dir.filter(|value| !value.trim().is_empty()) {
        Some(working_dir) => Path::new(working_dir).join(path),
        None => path.to_path_buf(),
    }
    .to_string_lossy()
    .into_owned()
}

fn program_exists(program: &str) -> bool {
    if program.trim().is_empty() {
        return false;
    }

    if should_preflight_program_path(program) {
        return Path::new(program).exists();
    }

    path_lookup(program).is_some()
}

fn path_lookup(program: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.exists())
}

pub fn run_katago_analysis_once(
    spec: &CommandSpec,
    query_jsonl: &str,
    timeout: Duration,
) -> Result<AnalysisRunResult, EngineManagerError> {
    validate_command_spec(spec)?;

    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(working_dir) = spec.working_dir.as_ref().filter(|value| !value.trim().is_empty()) {
        command.current_dir(working_dir);
    }
    for (key, value) in &spec.env {
        command.env(key, value);
    }

    let mut child = command.spawn().map_err(|source| EngineManagerError::Spawn {
        program: spec.program.clone(),
        source,
    })?;

    let stdout = child
        .stdout
        .take()
        .expect("stdout is piped before spawning the engine");
    let stderr = child
        .stderr
        .take()
        .expect("stderr is piped before spawning the engine");
    let stdout_rx = spawn_stdout_reader(stdout);
    let stderr_rx = spawn_stderr_reader(stderr);

    if let Err(source) = write_query(&mut child, query_jsonl) {
        let _ = child.kill();
        let exit_code = child.wait().ok().and_then(|status| status.code());
        let stderr = receive_stderr(stderr_rx);
        return Err(EngineManagerError::StdinWrite {
            source,
            exit_code,
            stderr,
        });
    }

    let deadline = Instant::now() + timeout;
    let mut stdout = None;
    let status = loop {
        if stdout.is_none() {
            match stdout_rx.try_recv() {
                Ok(Ok(Some(line))) => stdout = Some(line),
                Ok(Ok(None)) => {
                    let status = wait_until_deadline(&mut child, deadline, timeout)?;
                    let stderr = receive_stderr(stderr_rx);
                    if !status.success() {
                        return Err(EngineManagerError::NonZeroExit {
                            exit_code: status.code(),
                            stdout: None,
                            stderr,
                        });
                    }
                    return Err(EngineManagerError::MissingStdout {
                        exit_code: status.code(),
                        stderr,
                    });
                }
                Ok(Err(source)) => {
                    let _ = child.kill();
                    let exit_code = child.wait().ok().and_then(|status| status.code());
                    let stderr = receive_stderr(stderr_rx);
                    return Err(EngineManagerError::StdoutRead {
                        source,
                        exit_code,
                        stderr,
                    });
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    let status = wait_until_deadline(&mut child, deadline, timeout)?;
                    let stderr = receive_stderr(stderr_rx);
                    if !status.success() {
                        return Err(EngineManagerError::NonZeroExit {
                            exit_code: status.code(),
                            stdout: None,
                            stderr,
                        });
                    }
                    return Err(EngineManagerError::MissingStdout {
                        exit_code: status.code(),
                        stderr,
                    });
                }
            }
        }

        if let Some(status) = child
            .try_wait()
            .map_err(|source| EngineManagerError::Wait { source })?
        {
            break status;
        }

        if Instant::now() >= deadline {
            let exit_code = kill_timed_out_child(&mut child)
                .ok()
                .and_then(|status| status.code());
            let stderr = receive_stderr(stderr_rx);
            return Err(EngineManagerError::Timeout {
                timeout_ms: timeout.as_millis(),
                exit_code,
                stdout,
                stderr,
            });
        }

        thread::sleep(Duration::from_millis(10));
    };

    let stdout = match stdout {
        Some(line) => Some(line),
        None => match stdout_rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(Some(line))) => Some(line),
            Ok(Ok(None)) | Err(_) => None,
            Ok(Err(source)) => {
                return Err(EngineManagerError::StdoutRead {
                    source,
                    exit_code: status.code(),
                    stderr: receive_stderr(stderr_rx),
                })
            }
        },
    };
    let stderr = receive_stderr(stderr_rx);

    if !status.success() {
        return Err(EngineManagerError::NonZeroExit {
            exit_code: status.code(),
            stdout,
            stderr,
        });
    }

    match stdout {
        Some(response_jsonl) => Ok(AnalysisRunResult {
            response_jsonl,
            stderr,
            exit_code: status.code(),
        }),
        None => Err(EngineManagerError::MissingStdout {
            exit_code: status.code(),
            stderr,
        }),
    }
}

fn validate_command_spec(spec: &CommandSpec) -> Result<(), EngineManagerError> {
    if spec.program.trim().is_empty() {
        return Err(EngineManagerError::MissingEnginePath);
    }

    if should_preflight_program_path(&spec.program) && !Path::new(&spec.program).exists() {
        return Err(EngineManagerError::EnginePathNotFound {
            path: spec.program.clone(),
        });
    }

    if let Some(working_dir) = spec.working_dir.as_ref().filter(|value| !value.trim().is_empty()) {
        if !Path::new(working_dir).is_dir() {
            return Err(EngineManagerError::WorkingDirNotFound {
                path: working_dir.clone(),
            });
        }
    }

    Ok(())
}

fn should_preflight_program_path(program: &str) -> bool {
    let path = Path::new(program);
    path.is_absolute() || program.contains('/') || program.contains('\\')
}

fn build_process_command(spec: &CommandSpec) -> Command {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(working_dir) = spec.working_dir.as_ref().filter(|value| !value.trim().is_empty()) {
        command.current_dir(working_dir);
    }
    for (key, value) in &spec.env {
        command.env(key, value);
    }

    command
}

fn write_query(child: &mut Child, query_jsonl: &str) -> io::Result<()> {
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(query_jsonl.as_bytes())?;
        if !query_jsonl.ends_with('\n') {
            stdin.write_all(b"\n")?;
        }
        stdin.flush()?;
    }
    Ok(())
}

impl GtpSession {
    /// Start a long-lived GTP engine process from `spec`.
    ///
    /// The reader threads are spawned before this returns, so lines the engine emits
    /// during start-up are already being buffered when the caller sends its first command.
    /// No handshake is performed: `boardsize`/`komi`/setup stones are the caller's to send,
    /// and they must be sent asynchronously (see the type-level note on decoupling).
    pub fn start(spec: &CommandSpec) -> Result<Self, EngineManagerError> {
        validate_command_spec(spec)?;

        let mut child = build_process_command(spec)
            .spawn()
            .map_err(|source| EngineManagerError::Spawn {
                program: spec.program.clone(),
                source,
            })?;

        let stdin = child
            .stdin
            .take()
            .expect("stdin is piped before spawning the engine");
        let stdout = child
            .stdout
            .take()
            .expect("stdout is piped before spawning the engine");
        let stderr = child
            .stderr
            .take()
            .expect("stderr is piped before spawning the engine");

        let stderr_snapshot = Arc::new(std::sync::Mutex::new(String::new()));
        let stderr_reader = spawn_session_stderr_reader(stderr, Arc::clone(&stderr_snapshot));
        let (events_tx, events) = mpsc::channel();
        let stdout_reader = spawn_session_stdout_reader(stdout, events_tx);

        Ok(Self {
            child,
            stdin: Some(stdin),
            events,
            stdout_reader: Some(stdout_reader),
            stderr_snapshot,
            stderr_reader: Some(stderr_reader),
            closed: false,
        })
    }

    /// Send one GTP command, appending the terminating newline. **Does not wait for a response.**
    ///
    /// Any `\r` or `\n` inside `command` is stripped first: an embedded newline would split a
    /// single command into several GTP commands (and a bare newline would also terminate a
    /// running `kata-analyze`), so this is a real injection boundary, not cosmetic tidying.
    ///
    /// Command confirmation, when needed, must be matched asynchronously against the
    /// [`GtpSessionEvent::Line`] stream by command id — never by blocking here.
    pub fn send_command(&mut self, command: &str) -> Result<(), EngineManagerError> {
        let sanitized = sanitize_gtp_command(command);
        let mut payload = String::with_capacity(sanitized.len() + 1);
        payload.push_str(&sanitized);
        payload.push('\n');
        self.write_stdin(payload.as_bytes())
    }

    /// Send a bare newline, the canonical way to terminate a running `kata-analyze`.
    ///
    /// KataGo's `kata-analyze` runs until any new GTP command or a raw newline arrives, so this
    /// stops the stream without ending the session — the engine stays alive for the next command.
    pub fn send_bare_newline(&mut self) -> Result<(), EngineManagerError> {
        self.write_stdin(b"\n")
    }

    /// Wait up to `timeout` for the next session event. `None` means the timeout elapsed.
    pub fn next_event_timeout(&self, timeout: Duration) -> Option<GtpSessionEvent> {
        self.events.recv_timeout(timeout).ok()
    }

    /// A snapshot of everything the engine has written to stderr so far.
    pub fn stderr_snapshot(&self) -> String {
        self.stderr_snapshot
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// The engine process id, for leak diagnostics and lifecycle assertions.
    pub fn child_id(&self) -> u32 {
        self.child.id()
    }

    /// Whether the engine process has already exited.
    pub fn has_exited(&mut self) -> Result<bool, EngineManagerError> {
        self.child
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|source| EngineManagerError::Wait { source })
    }

    fn write_stdin(&mut self, bytes: &[u8]) -> Result<(), EngineManagerError> {
        if self.closed {
            return Err(EngineManagerError::SessionNotRunning);
        }
        let stdin = self.stdin.as_mut().ok_or(EngineManagerError::SessionNotRunning)?;
        stdin
            .write_all(bytes)
            .and_then(|_| stdin.flush())
            .map_err(|source| EngineManagerError::SessionWrite { source })
    }

    /// Shut the session down: stop any running analysis, close stdin, reap the engine and join
    /// the reader threads. Idempotent — a second call returns `Ok(None)`.
    pub fn close(&mut self) -> Result<Option<i32>, EngineManagerError> {
        if self.closed {
            return Ok(None);
        }

        // Best effort: terminate a running `kata-analyze` before closing stdin. Failure here is
        // not fatal because dropping stdin below ends the stream anyway.
        let _ = self.send_bare_newline();

        // Closing stdin is what tells a well-behaved engine to finish and exit.
        self.stdin = None;

        let exit_code = match self
            .child
            .try_wait()
            .map_err(|source| EngineManagerError::Wait { source })?
        {
            Some(status) => status.code(),
            None => {
                // The engine did not exit on its own within a short grace period; kill it so a
                // session can never leak a child process.
                let grace_deadline = Instant::now() + Duration::from_millis(500);
                loop {
                    match self
                        .child
                        .try_wait()
                        .map_err(|source| EngineManagerError::Wait { source })?
                    {
                        Some(status) => break status.code(),
                        None if Instant::now() >= grace_deadline => {
                            let _ = self.child.kill();
                            break self
                                .child
                                .wait()
                                .map_err(|source| EngineManagerError::Wait { source })?
                                .code();
                        }
                        None => thread::sleep(Duration::from_millis(10)),
                    }
                }
            }
        };

        self.closed = true;

        // Join the readers, but never block indefinitely. A killed engine whose stdout pipe is
        // still held open by a surviving grandchild (e.g. the `/bin/sh` wrapper used in tests,
        // where `sh` execs a `sleep`) would otherwise keep `read_line` blocked and make `close()`
        // hang for as long as that grandchild lives. The engine process itself is already reaped
        // above; a reader thread that outlives this call exits on its own once the pipe closes.
        if let Some(handle) = self.stdout_reader.take() {
            join_thread_briefly(handle);
        }
        if let Some(handle) = self.stderr_reader.take() {
            join_thread_briefly(handle);
        }

        Ok(exit_code)
    }
}

impl Drop for GtpSession {
    fn drop(&mut self) {
        // Unconditional: a session must never leak its engine process.
        let _ = self.close();
    }
}

/// Strip the characters that would break GTP command framing.
fn sanitize_gtp_command(command: &str) -> String {
    command
        .chars()
        .filter(|character| *character != '\n' && *character != '\r')
        .collect()
}

/// Join a reader thread, but give up quickly instead of blocking shutdown on it.
///
/// `JoinHandle` has no timed join, so this polls `is_finished()` (stable since Rust 1.61).
/// The handle is dropped if the thread is still running; the thread is detached, not killed,
/// and will exit by itself when the engine's pipe finally closes.
fn join_thread_briefly(handle: thread::JoinHandle<()>) {
    let deadline = Instant::now() + Duration::from_millis(500);
    while !handle.is_finished() {
        if Instant::now() >= deadline {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let _ = handle.join();
}

fn spawn_session_stdout_reader(
    stdout: std::process::ChildStdout,
    tx: mpsc::Sender<GtpSessionEvent>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(GtpSessionEvent::Eof { exit_code: None });
                    break;
                }
                Ok(_) => {
                    if tx.send(GtpSessionEvent::Line(trim_line_ending(line))).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = tx.send(GtpSessionEvent::ReadError(error.to_string()));
                    break;
                }
            }
        }
    })
}

fn spawn_session_stderr_reader(
    stderr: std::process::ChildStderr,
    snapshot: Arc<std::sync::Mutex<String>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(mut guard) = snapshot.lock() {
                        guard.push_str(&line);
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn spawn_stdout_reader(stdout: std::process::ChildStdout) -> Receiver<io::Result<Option<String>>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = reader.read_line(&mut line).map(|bytes| {
            if bytes == 0 {
                None
            } else {
                Some(trim_line_ending(line))
            }
        });
        let _ = tx.send(result);
    });
    rx
}

fn spawn_stdout_lines_reader(stdout: std::process::ChildStdout) -> Receiver<io::Result<Option<String>>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(Ok(None));
                    break;
                }
                Ok(_) => {
                    if tx.send(Ok(Some(trim_line_ending(line)))).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(error));
                    break;
                }
            }
        }
    });
    rx
}

fn spawn_stderr_reader(stderr: std::process::ChildStderr) -> Receiver<io::Result<String>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut output = String::new();
        let result = reader.read_to_string(&mut output).map(|_| output);
        let _ = tx.send(result);
    });
    rx
}

fn trim_line_ending(mut line: String) -> String {
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
    line
}

enum BatchStdoutEventError {
    NoLineReady,
    Read(io::Error),
}

fn receive_available_stdout_line(
    rx: &Receiver<io::Result<Option<String>>>,
) -> Result<Option<String>, BatchStdoutEventError> {
    match rx.try_recv() {
        Ok(Ok(line)) => Ok(line),
        Ok(Err(error)) => Err(BatchStdoutEventError::Read(error)),
        Err(mpsc::TryRecvError::Empty) => Err(BatchStdoutEventError::NoLineReady),
        Err(mpsc::TryRecvError::Disconnected) => Ok(None),
    }
}

fn collect_remaining_stdout(
    rx: &Receiver<io::Result<Option<String>>>,
    response_lines: &mut Vec<String>,
    exit_code: Option<i32>,
    stderr_rx: &Receiver<io::Result<String>>,
    options: &mut AnalysisBatchRunOptions<'_>,
) -> Result<(), EngineManagerError> {
    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(Some(line))) => push_batch_response_line(response_lines, line, options),
            Ok(Ok(None)) | Err(_) => return Ok(()),
            Ok(Err(source)) => {
                return Err(EngineManagerError::StdoutRead {
                    source,
                    exit_code,
                    stderr: receive_stderr_ref(stderr_rx),
                });
            }
        }
    }
}

fn wait_until_deadline(
    child: &mut Child,
    deadline: Instant,
    timeout: Duration,
) -> Result<ExitStatus, EngineManagerError> {
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|source| EngineManagerError::Wait { source })?
        {
            return Ok(status);
        }

        if Instant::now() >= deadline {
            let exit_code = kill_timed_out_child(child).ok().and_then(|status| status.code());
            return Err(EngineManagerError::Timeout {
                timeout_ms: timeout.as_millis(),
                exit_code,
                stdout: None,
                stderr: String::new(),
            });
        }

        thread::sleep(Duration::from_millis(10));
    }
}

fn wait_for_batch_exit(
    child: &mut Child,
    deadline: Instant,
    timeout: Duration,
    response_lines: &[String],
    stderr_rx: &Receiver<io::Result<String>>,
    options: &AnalysisBatchRunOptions<'_>,
) -> Result<ExitStatus, EngineManagerError> {
    loop {
        if is_cancelled(options) {
            let exit_code = kill_cancelled_child(child).ok().and_then(|status| status.code());
            return Err(EngineManagerError::Cancelled {
                received_responses: response_lines.len(),
                stdout: response_lines.to_vec(),
                exit_code,
                stderr: receive_stderr_ref(stderr_rx),
            });
        }

        if let Some(status) = child
            .try_wait()
            .map_err(|source| EngineManagerError::Wait { source })?
        {
            return Ok(status);
        }

        if Instant::now() >= deadline {
            let exit_code = kill_timed_out_child(child).ok().and_then(|status| status.code());
            return Err(EngineManagerError::Timeout {
                timeout_ms: timeout.as_millis(),
                exit_code,
                stdout: stdout_summary(response_lines),
                stderr: receive_stderr_ref(stderr_rx),
            });
        }

        thread::sleep(Duration::from_millis(10));
    }
}

fn is_cancelled(options: &AnalysisBatchRunOptions<'_>) -> bool {
    options
        .cancel_token
        .map(AnalysisCancelToken::is_cancelled)
        .unwrap_or(false)
}

fn push_batch_response_line(
    response_lines: &mut Vec<String>,
    line: String,
    options: &mut AnalysisBatchRunOptions<'_>,
) {
    let response_index = response_lines.len() + 1;
    if response_index <= options.expected_responses {
        if let Some(on_progress) = options.on_progress.as_deref_mut() {
            on_progress(AnalysisBatchProgress {
                response_index,
                expected_responses: options.expected_responses,
                response_jsonl_line: line.clone(),
            });
        }
    }
    response_lines.push(line);
}

fn kill_timed_out_child(child: &mut Child) -> io::Result<ExitStatus> {
    match child.kill() {
        Ok(()) => child.wait(),
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => child.wait(),
        Err(error) => Err(error),
    }
}

fn kill_cancelled_child(child: &mut Child) -> io::Result<ExitStatus> {
    kill_timed_out_child(child)
}

fn receive_stderr(rx: Receiver<io::Result<String>>) -> String {
    receive_stderr_ref(&rx)
}

fn receive_stderr_ref(rx: &Receiver<io::Result<String>>) -> String {
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(stderr)) => stderr,
        Ok(Err(error)) => format!("<failed to read stderr: {error}>"),
        Err(_) => String::new(),
    }
}

fn stdout_summary(lines: &[String]) -> Option<String> {
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    static NEXT_TEST_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn new(label: &str) -> Self {
            let unique = format!(
                "{}-{}-{}",
                std::process::id(),
                NEXT_TEST_TEMP_ID.fetch_add(1, AtomicOrdering::Relaxed),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let path = std::env::temp_dir()
                .join("lizzieyzy-engine-manager-tests")
                .join(format!("{label}-{unique}"));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[cfg(unix)]
    fn fake_engine_spec(temp_dir: &TestTempDir, script: &str) -> CommandSpec {
        let script_path = temp_dir.path().join("fake-engine.sh");
        std::fs::write(&script_path, format!("#!/bin/sh\n{script}\n")).unwrap();

        CommandSpec {
            program: "/bin/sh".into(),
            args: vec![script_path.to_string_lossy().into_owned()],
            working_dir: None,
            env: vec![],
        }
    }

    /// A fake engine that records its own PID, so a test can prove the child was really
    /// reaped rather than merely detached.
    #[cfg(unix)]
    fn fake_engine_spec_with_pid_file(temp_dir: &TestTempDir, script: &str) -> CommandSpec {
        let pid_file = temp_dir.path().join("engine.pid");
        let script_body = format!("echo $$ > \"{}\"\n{script}", pid_file.to_string_lossy());
        fake_engine_spec(temp_dir, &script_body)
    }

    /// Number of live processes for `pid`, using `kill -0` (no signal is delivered).
    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        std::process::Command::new("/bin/sh")
            .args(["-c", &format!("kill -0 {pid} 2>/dev/null")])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(unix)]
    fn wait_for_pid_file(pid_file: &Path, timeout: Duration) -> u32 {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(contents) = std::fs::read_to_string(pid_file) {
                if let Ok(pid) = contents.trim().parse::<u32>() {
                    return pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "fake engine did not write its pid file in time"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn check_assets_resolves_relative_engine_model_and_config_under_working_dir() {
        let temp_dir = TestTempDir::new("assets");
        let working_dir = temp_dir.path();
        let engine_path = "bin/katago".to_string();
        std::fs::create_dir_all(working_dir.join("models")).unwrap();
        std::fs::create_dir_all(working_dir.join("configs")).unwrap();
        std::fs::create_dir_all(working_dir.join("bin")).unwrap();
        std::fs::write(working_dir.join(&engine_path), "").unwrap();
        std::fs::write(working_dir.join("models").join("model.bin"), "").unwrap();
        std::fs::write(working_dir.join("configs").join("analysis.cfg"), "").unwrap();

        let profile = EngineProfileDto {
            name: "test profile".into(),
            engine_path: engine_path.clone(),
            model_path: Some("models/model.bin".into()),
            config_path: Some("configs/analysis.cfg".into()),
            working_dir: Some(working_dir.to_string_lossy().into_owned()),
            backend: EngineBackend::KataGoAnalysis,
        };

        let checks = check_assets(&profile);

        assert_eq!(checks[0].path, working_dir.join(engine_path).to_string_lossy());
        assert_eq!(checks[1].path, working_dir.to_string_lossy());
        assert_eq!(
            checks[2].path,
            working_dir.join("models").join("model.bin").to_string_lossy()
        );
        assert_eq!(
            checks[3].path,
            working_dir.join("configs").join("analysis.cfg").to_string_lossy()
        );
        assert!(checks[0].exists);
        assert!(checks[1].exists);
        assert!(checks[2].exists);
        assert!(checks[3].exists);
    }

    #[test]
    fn check_assets_reports_empty_model_and_config_paths_as_missing() {
        let temp_dir = TestTempDir::new("empty-assets");
        let working_dir = temp_dir.path();

        let profile = EngineProfileDto {
            name: "test profile".into(),
            engine_path: "katago".into(),
            model_path: Some("".into()),
            config_path: Some("   ".into()),
            working_dir: Some(working_dir.to_string_lossy().into_owned()),
            backend: EngineBackend::KataGoAnalysis,
        };

        let checks = check_assets(&profile);

        assert_eq!(checks[2].path, "");
        assert_eq!(checks[3].path, "");
        assert!(!checks[2].exists);
        assert!(!checks[3].exists);
        assert!(checks[2].required);
        assert!(checks[3].required);
    }

    #[test]
    fn check_assets_reports_none_model_and_config_paths_as_missing_for_katago_analysis() {
        let temp_dir = TestTempDir::new("none-assets");
        let working_dir = temp_dir.path();
        let engine_path = working_dir.join("katago");
        std::fs::write(&engine_path, "").unwrap();

        let profile = EngineProfileDto {
            name: "test profile".into(),
            engine_path: engine_path.to_string_lossy().into_owned(),
            model_path: None,
            config_path: None,
            working_dir: Some(working_dir.to_string_lossy().into_owned()),
            backend: EngineBackend::KataGoAnalysis,
        };

        let checks = check_assets(&profile);

        assert_eq!(checks.len(), 4);
        assert_eq!(checks[0].label, "engine binary");
        assert!(checks[0].exists);
        assert!(checks[0].required);
        assert_eq!(checks[1].label, "working directory");
        assert!(checks[1].exists);
        assert!(checks[1].required);
        assert_eq!(checks[2].label, "model");
        assert_eq!(checks[2].path, "");
        assert!(!checks[2].exists);
        assert!(checks[2].required);
        assert_eq!(checks[3].label, "config");
        assert_eq!(checks[3].path, "");
        assert!(!checks[3].exists);
        assert!(checks[3].required);
    }

    #[test]
    fn build_command_spec_resolves_relative_katago_assets_under_working_dir() {
        let temp_dir = TestTempDir::new("command-spec-assets");
        let working_dir = temp_dir.path();
        std::fs::create_dir_all(working_dir.join("bin")).unwrap();
        std::fs::create_dir_all(working_dir.join("models")).unwrap();
        std::fs::create_dir_all(working_dir.join("configs")).unwrap();
        std::fs::write(working_dir.join("bin").join("katago"), "").unwrap();
        std::fs::write(working_dir.join("models").join("model.bin"), "").unwrap();
        // The config carries an explicit `numAnalysisThreads`, so no compatibility override is added
        // and this test stays focused on resolving relative asset paths.
        std::fs::write(
            working_dir.join("configs").join("analysis.cfg"),
            "numAnalysisThreads = 2\nnnMaxBatchSize = 16\n",
        )
        .unwrap();

        let profile = EngineProfileDto {
            name: "test profile".into(),
            engine_path: "bin/katago".into(),
            model_path: Some("models/model.bin".into()),
            config_path: Some("configs/analysis.cfg".into()),
            working_dir: Some(working_dir.to_string_lossy().into_owned()),
            backend: EngineBackend::KataGoAnalysis,
        };

        let spec = build_command_spec(&profile).unwrap();

        assert_eq!(
            spec.program,
            working_dir.join("bin").join("katago").to_string_lossy()
        );
        assert_eq!(spec.working_dir.as_deref(), Some(working_dir.to_str().unwrap()));
        assert_eq!(
            spec.args,
            vec![
                "analysis",
                "-config",
                working_dir.join("configs").join("analysis.cfg").to_str().unwrap(),
                "-model",
                working_dir.join("models").join("model.bin").to_str().unwrap(),
            ]
        );
    }

    /// Build an analysis profile whose config file holds `config_contents`.
    fn analysis_profile_with_config(temp_dir: &TestTempDir, config_contents: &str) -> EngineProfileDto {
        let working_dir = temp_dir.path();
        std::fs::create_dir_all(working_dir.join("models")).unwrap();
        std::fs::write(working_dir.join("models").join("model.bin"), "").unwrap();
        std::fs::write(working_dir.join("analysis.cfg"), config_contents).unwrap();
        EngineProfileDto {
            name: "test profile".into(),
            engine_path: "katago".into(),
            model_path: Some("models/model.bin".into()),
            config_path: Some("analysis.cfg".into()),
            working_dir: Some(working_dir.to_string_lossy().into_owned()),
            backend: EngineBackend::KataGoAnalysis,
        }
    }

    #[test]
    fn build_command_spec_overrides_missing_num_analysis_threads_for_katago_analysis() {
        let temp_dir = TestTempDir::new("analysis-missing-threads");
        // A GTP config: it configures `numSearchThreads` but never `numAnalysisThreads`, which is the
        // exact `gtp_live.cfg` shape the formal GUI full-game entry feeds to the analysis backend.
        let profile = analysis_profile_with_config(
            &temp_dir,
            "numSearchThreads = 6\nmaxVisits = 500\nreportAnalysisWinratesAs = BLACK\n",
        );

        let spec = build_command_spec(&profile).unwrap();

        assert_eq!(
            spec.args,
            vec![
                "analysis",
                "-config",
                temp_dir.path().join("analysis.cfg").to_str().unwrap(),
                "-model",
                temp_dir.path().join("models").join("model.bin").to_str().unwrap(),
                "-override-config",
                "numAnalysisThreads=1,nnMaxBatchSize=16",
            ]
        );
        // The override must be a real `-override-config` flag pair, never a bare positional argument.
        let override_index = spec
            .args
            .iter()
            .position(|arg| arg == "numAnalysisThreads=1,nnMaxBatchSize=16")
            .expect("a config without numAnalysisThreads must get the compatibility override");
        assert_eq!(spec.args[override_index - 1], "-override-config");
    }

    #[test]
    fn build_command_spec_preserves_explicit_num_analysis_threads() {
        let temp_dir = TestTempDir::new("analysis-explicit-threads");
        for contents in [
            // Plain explicit value.
            "numAnalysisThreads = 8\nnnMaxBatchSize=32\n",
            // Leading whitespace and an inline comment must not hide the explicit value.
            "   numAnalysisThreads=4   # tuning note\nnnMaxBatchSize=16\n",
        ] {
            let profile = analysis_profile_with_config(&temp_dir, contents);
            let spec = build_command_spec(&profile).unwrap();

            assert!(
                !spec.args.iter().any(|arg| arg == "-override-config"),
                "an explicit numAnalysisThreads must be preserved, not overridden: {contents:?}"
            );
            assert!(!spec
                .args
                .iter()
                .any(|arg| arg == "numAnalysisThreads=1,nnMaxBatchSize=16"));
        }
    }

    #[test]
    fn analysis_defaults_preserve_invalid_explicit_values_and_includes() {
        let dir = TestTempDir::new("analysis-preserve-config");
        for contents in ["numAnalysisThreads=0\nnnMaxBatchSize=bad", "@include other.cfg"] {
            let profile = analysis_profile_with_config(&dir, contents);
            assert!(!build_command_spec(&profile)
                .unwrap()
                .args
                .iter()
                .any(|a| a == "-override-config"));
        }
        let profile = analysis_profile_with_config(&dir, "numAnalysisThreads=4\n# nnMaxBatchSize=64");
        assert_eq!(
            build_command_spec(&profile).unwrap().args.last().unwrap(),
            "nnMaxBatchSize=16"
        );
    }

    #[test]
    fn build_command_spec_reports_missing_model_path() {
        let temp_dir = TestTempDir::new("missing-model");
        let working_dir = temp_dir.path();
        std::fs::write(working_dir.join("analysis.cfg"), "").unwrap();

        let profile = EngineProfileDto {
            name: "test profile".into(),
            engine_path: "katago".into(),
            model_path: Some("missing.bin".into()),
            config_path: Some("analysis.cfg".into()),
            working_dir: Some(working_dir.to_string_lossy().into_owned()),
            backend: EngineBackend::KataGoAnalysis,
        };

        let err = build_command_spec(&profile).unwrap_err();

        assert!(matches!(err, EngineManagerError::ModelPathNotFound { .. }));
    }

    #[test]
    fn build_command_spec_includes_model_and_config_for_katago_gtp() {
        let temp_dir = TestTempDir::new("gtp-spec-assets");
        let working_dir = temp_dir.path();
        std::fs::create_dir_all(working_dir.join("models")).unwrap();
        std::fs::create_dir_all(working_dir.join("configs")).unwrap();
        std::fs::write(working_dir.join("models").join("model.bin"), "").unwrap();
        // The GTP backend must be pointed at a GTP config, never the batch `analysis.cfg`.
        std::fs::write(working_dir.join("configs").join("gtp.cfg"), "").unwrap();

        let profile = EngineProfileDto {
            name: "test profile".into(),
            engine_path: "katago".into(),
            model_path: Some("models/model.bin".into()),
            config_path: Some("configs/gtp.cfg".into()),
            working_dir: Some(working_dir.to_string_lossy().into_owned()),
            backend: EngineBackend::KataGoGtp,
        };

        let spec = build_command_spec(&profile).unwrap();

        assert_eq!(
            spec.args,
            vec![
                "gtp",
                "-model",
                working_dir.join("models").join("model.bin").to_str().unwrap(),
                "-config",
                working_dir.join("configs").join("gtp.cfg").to_str().unwrap(),
                "-override-config",
                "reportAnalysisWinratesAs=BLACK",
            ]
        );
        // Guard against silently regressing to a bare `gtp` invocation with no weights.
        assert!(spec.args.iter().any(|arg| arg == "gtp"));
        assert!(spec.args.iter().any(|arg| arg == "-model"));
        assert!(spec.args.iter().any(|arg| arg == "-config"));
        // The reporting perspective must stay pinned to Black, otherwise `kata-analyze` falls back to
        // side-to-move and every white-to-play frame is inverted without any error.
        let perspective_index = spec
            .args
            .iter()
            .position(|arg| arg == "reportAnalysisWinratesAs=BLACK")
            .expect("the GTP backend must pin reportAnalysisWinratesAs=BLACK");
        assert_eq!(
            spec.args[perspective_index - 1],
            "-override-config",
            "the perspective must be passed via -override-config, not a bare positional argument"
        );
    }

    #[test]
    fn build_command_spec_reports_missing_model_for_katago_gtp() {
        let temp_dir = TestTempDir::new("gtp-missing-model");
        let working_dir = temp_dir.path();
        std::fs::write(working_dir.join("gtp.cfg"), "").unwrap();

        let profile = EngineProfileDto {
            name: "test profile".into(),
            engine_path: "katago".into(),
            model_path: None,
            config_path: Some("gtp.cfg".into()),
            working_dir: Some(working_dir.to_string_lossy().into_owned()),
            backend: EngineBackend::KataGoGtp,
        };

        let err = build_command_spec(&profile).unwrap_err();

        assert!(matches!(err, EngineManagerError::MissingModelPath));
    }

    #[test]
    fn build_command_spec_reports_missing_config_for_katago_gtp() {
        let temp_dir = TestTempDir::new("gtp-missing-config");
        let working_dir = temp_dir.path();
        std::fs::write(working_dir.join("model.bin"), "").unwrap();

        let profile = EngineProfileDto {
            name: "test profile".into(),
            engine_path: "katago".into(),
            model_path: Some("model.bin".into()),
            config_path: Some("missing-gtp.cfg".into()),
            working_dir: Some(working_dir.to_string_lossy().into_owned()),
            backend: EngineBackend::KataGoGtp,
        };

        let err = build_command_spec(&profile).unwrap_err();

        assert!(matches!(err, EngineManagerError::ConfigPathNotFound { .. }));
    }

    #[test]
    fn check_assets_marks_model_required_for_katago_gtp() {
        let temp_dir = TestTempDir::new("gtp-assets-required");
        let working_dir = temp_dir.path();
        std::fs::write(working_dir.join("katago"), "").unwrap();
        std::fs::create_dir_all(working_dir.join("models")).unwrap();
        std::fs::create_dir_all(working_dir.join("configs")).unwrap();
        std::fs::write(working_dir.join("models").join("model.bin"), "").unwrap();
        std::fs::write(working_dir.join("configs").join("gtp.cfg"), "").unwrap();

        let profile = EngineProfileDto {
            name: "test profile".into(),
            engine_path: "katago".into(),
            model_path: Some("models/model.bin".into()),
            config_path: Some("configs/gtp.cfg".into()),
            working_dir: Some(working_dir.to_string_lossy().into_owned()),
            backend: EngineBackend::KataGoGtp,
        };

        let checks = check_assets(&profile);

        let model = checks.iter().find(|check| check.label == "model").unwrap();
        let config = checks.iter().find(|check| check.label == "config").unwrap();
        assert!(model.required);
        assert!(config.required);
        assert!(model.exists);
        assert!(config.exists);
    }

    #[test]
    fn check_assets_fails_for_missing_model_path_on_katago_gtp() {
        let temp_dir = TestTempDir::new("gtp-assets-missing");
        let working_dir = temp_dir.path();
        std::fs::write(working_dir.join("katago"), "").unwrap();
        std::fs::write(working_dir.join("gtp.cfg"), "").unwrap();

        let profile = EngineProfileDto {
            name: "test profile".into(),
            engine_path: "katago".into(),
            // A weight path that does not exist on disk.
            model_path: Some("models/does-not-exist.bin".into()),
            config_path: Some("gtp.cfg".into()),
            working_dir: Some(working_dir.to_string_lossy().into_owned()),
            backend: EngineBackend::KataGoGtp,
        };

        let checks = check_assets(&profile);

        let model = checks.iter().find(|check| check.label == "model").unwrap();
        assert!(!model.exists, "missing weight path must be reported as absent");
        assert!(
            model.required,
            "the GTP backend must treat the weight as required"
        );
    }

    #[test]
    #[cfg(unix)]
    fn analysis_once_reads_one_json_response() {
        let temp_dir = TestTempDir::new("analysis-once");
        let spec = fake_engine_spec(
            &temp_dir,
            r#"read line; printf '{"id":"ok"}\n'; printf 'debug line\n' >&2"#,
        );

        let result = run_katago_analysis_once(&spec, r#"{"id":"query"}"#, Duration::from_secs(2)).unwrap();

        assert_eq!(result.response_jsonl, r#"{"id":"ok"}"#);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stderr.contains("debug line"));
    }

    #[test]
    #[cfg(unix)]
    fn analysis_batch_reads_multiple_json_responses() {
        let temp_dir = TestTempDir::new("batch-multiple");
        let spec = fake_engine_spec(
            &temp_dir,
            r#"read line; printf '{"id":"batch-1","turnNumber":0}\n'; printf '{"id":"batch-1","turnNumber":1}\n'; printf 'batch debug\n' >&2"#,
        );

        let result =
            run_katago_analysis_batch(&spec, r#"{"id":"query"}"#, 2, Duration::from_secs(2)).unwrap();

        assert_eq!(
            result.response_jsonl_lines,
            vec![
                r#"{"id":"batch-1","turnNumber":0}"#,
                r#"{"id":"batch-1","turnNumber":1}"#
            ]
        );
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stderr.contains("batch debug"));
    }

    /// The GTP probe found that engine responses can arrive in a batch long after the write
    /// (plans/GTP_LIVE_PROBE_FINDINGS.md §4). A `send`-then-`await response` design would stall and
    /// starve the streaming `info` lines, so the read path must be running before/independently of
    /// the write. These two tests pin that property: the engine deliberately delays and coalesces
    /// its output, yet the run still completes without the writer waiting on any response.
    #[test]
    #[cfg(unix)]
    fn analysis_batch_does_not_block_writing_while_reading() {
        let temp_dir = TestTempDir::new("batch-decoupled-write-read");
        // Read every line first, only then emit output. If the implementation waited for a response
        // after writing, this would deadlock until the timeout instead of completing.
        let spec = fake_engine_spec(
            &temp_dir,
            r#"read line; read line; printf '{"id":"decoupled","turnNumber":0}\n'; printf '{"id":"decoupled","turnNumber":1}\n'"#,
        );

        let result = run_katago_analysis_batch(
            &spec,
            "{\"id\":\"query-1\"}\n{\"id\":\"query-2\"}\n",
            2,
            Duration::from_secs(5),
        )
        .unwrap();

        assert_eq!(result.response_jsonl_lines.len(), 2);
        assert_eq!(result.exit_code, Some(0));
    }

    #[test]
    #[cfg(unix)]
    fn analysis_batch_streams_coalesced_burst_without_waiting_for_each_response() {
        let temp_dir = TestTempDir::new("batch-coalesced-burst");
        // All responses are written back-to-back in one burst (mirroring the observed
        // same-timestamp batch arrival) and are only produced after the writer has already
        // finished writing. Reading must proceed independently of writing.
        let spec = fake_engine_spec(
            &temp_dir,
            r#"read line; sleep 1; printf '{"id":"burst","turnNumber":0}\n{"id":"burst","turnNumber":1}\n{"id":"burst","turnNumber":2}\n'"#,
        );

        let started = Instant::now();
        let result =
            run_katago_analysis_batch(&spec, "{\"id\":\"query\"}", 3, Duration::from_secs(5)).unwrap();
        let elapsed = started.elapsed();

        assert_eq!(result.response_jsonl_lines.len(), 3);
        // Completes promptly after the engine's deliberate delay; no response-by-response stall.
        assert!(
            elapsed < Duration::from_secs(4),
            "coalesced burst should not serialize per-response waits, took {elapsed:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn analysis_batch_with_options_reports_progress_for_each_expected_response() {
        let temp_dir = TestTempDir::new("batch-progress");
        let spec = fake_engine_spec(
            &temp_dir,
            r#"read line; printf '{"id":"batch-1","turnNumber":0}\n'; printf '{"id":"batch-1","turnNumber":1}\n'"#,
        );
        let mut progress = Vec::new();
        let mut on_progress = |event: AnalysisBatchProgress| progress.push(event);

        let result = run_katago_analysis_batch_with_options(
            &spec,
            r#"{"id":"query"}"#,
            AnalysisBatchRunOptions {
                expected_responses: 2,
                timeout: Duration::from_secs(2),
                cancel_token: None,
                on_progress: Some(&mut on_progress),
            },
        )
        .unwrap();

        assert_eq!(result.response_jsonl_lines.len(), 2);
        assert_eq!(progress.len(), 2);
        assert_eq!(progress[0].response_index, 1);
        assert_eq!(progress[0].expected_responses, 2);
        assert_eq!(
            progress[0].response_jsonl_line,
            r#"{"id":"batch-1","turnNumber":0}"#
        );
        assert_eq!(progress[1].response_index, 2);
        assert_eq!(
            progress[1].response_jsonl_line,
            r#"{"id":"batch-1","turnNumber":1}"#
        );
    }

    #[test]
    #[cfg(unix)]
    fn analysis_batch_cancel_token_kills_process_and_returns_partial_stdout() {
        let temp_dir = TestTempDir::new("cancel-batch");
        let marker = temp_dir.path().join("marker");
        let mut spec = fake_engine_spec(
            &temp_dir,
            r#"read line; printf '{"id":"batch-1","turnNumber":0}\n'; sleep 2; printf survived > "$MARKER""#,
        );
        spec.env
            .push(("MARKER".into(), marker.to_string_lossy().into_owned()));
        let cancel_token = AnalysisCancelToken::new();
        let callback_token = cancel_token.clone();
        let mut on_progress = move |_event: AnalysisBatchProgress| callback_token.cancel();

        let error = run_katago_analysis_batch_with_options(
            &spec,
            r#"{"id":"query"}"#,
            AnalysisBatchRunOptions {
                expected_responses: 2,
                timeout: Duration::from_secs(5),
                cancel_token: Some(&cancel_token),
                on_progress: Some(&mut on_progress),
            },
        )
        .unwrap_err();

        match error {
            EngineManagerError::Cancelled {
                received_responses,
                stdout,
                ..
            } => {
                assert_eq!(received_responses, 1);
                assert_eq!(stdout, vec![r#"{"id":"batch-1","turnNumber":0}"#]);
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert!(!marker.exists());
    }

    #[test]
    #[cfg(unix)]
    fn analysis_batch_returns_katago_error_json_as_stdout() {
        let temp_dir = TestTempDir::new("batch-error-json");
        let spec = fake_engine_spec(
            &temp_dir,
            r#"read line; printf '{"id":"batch-1","error":"bad query"}\n'"#,
        );

        let result =
            run_katago_analysis_batch(&spec, r#"{"id":"query"}"#, 1, Duration::from_secs(2)).unwrap();

        assert_eq!(
            result.response_jsonl_lines,
            vec![r#"{"id":"batch-1","error":"bad query"}"#]
        );
        assert_eq!(result.exit_code, Some(0));
    }

    #[test]
    #[cfg(unix)]
    fn analysis_batch_truncates_stdout_to_expected_responses() {
        let temp_dir = TestTempDir::new("batch-truncate");
        let spec = fake_engine_spec(
            &temp_dir,
            r#"read line; printf '{"id":"batch-1","turnNumber":0}\n'; printf '{"id":"batch-1","turnNumber":1}\n'; printf '{"id":"batch-1","turnNumber":2}\n'"#,
        );

        let result =
            run_katago_analysis_batch(&spec, r#"{"id":"query"}"#, 2, Duration::from_secs(2)).unwrap();

        assert_eq!(
            result.response_jsonl_lines,
            vec![
                r#"{"id":"batch-1","turnNumber":0}"#,
                r#"{"id":"batch-1","turnNumber":1}"#
            ]
        );
        assert_eq!(result.exit_code, Some(0));
    }

    #[test]
    #[cfg(unix)]
    fn analysis_batch_with_zero_expected_responses_returns_empty_without_spawning() {
        let temp_dir = TestTempDir::new("zero-batch");
        let marker = temp_dir.path().join("marker");
        let mut spec = fake_engine_spec(&temp_dir, r#"printf launched > "$MARKER"; exit 99"#);
        spec.env
            .push(("MARKER".into(), marker.to_string_lossy().into_owned()));

        let result =
            run_katago_analysis_batch(&spec, r#"{"id":"query"}"#, 0, Duration::from_secs(2)).unwrap();

        assert!(result.response_jsonl_lines.is_empty());
        assert_eq!(result.stderr, "");
        assert_eq!(result.exit_code, None);
        assert!(!marker.exists());
    }

    #[test]
    #[cfg(unix)]
    fn analysis_batch_reports_insufficient_stdout() {
        let temp_dir = TestTempDir::new("batch-insufficient");
        let spec = fake_engine_spec(&temp_dir, r#"read line; printf '{"id":"only"}\n'"#);

        let error =
            run_katago_analysis_batch(&spec, r#"{"id":"query"}"#, 2, Duration::from_secs(2)).unwrap_err();

        match error {
            EngineManagerError::InsufficientStdout {
                expected_responses,
                received_responses,
                stdout,
                exit_code,
                ..
            } => {
                assert_eq!(expected_responses, 2);
                assert_eq!(received_responses, 1);
                assert_eq!(stdout, vec![r#"{"id":"only"}"#]);
                assert_eq!(exit_code, Some(0));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    #[cfg(unix)]
    fn analysis_batch_non_zero_exit_includes_stderr() {
        let temp_dir = TestTempDir::new("batch-non-zero");
        let spec = fake_engine_spec(&temp_dir, "read line; printf 'bad batch\\n' >&2; exit 7");

        let error = run_katago_analysis_batch(&spec, "{}", 1, Duration::from_secs(2)).unwrap_err();

        match error {
            EngineManagerError::NonZeroExit {
                exit_code, stderr, ..
            } => {
                assert_eq!(exit_code, Some(7));
                assert!(stderr.contains("bad batch"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    #[cfg(unix)]
    fn analysis_batch_timeout_kills_process() {
        let temp_dir = TestTempDir::new("timeout-batch");
        let marker = temp_dir.path().join("marker");
        let mut spec = fake_engine_spec(&temp_dir, r#"read line; sleep 2; printf survived > "$MARKER""#);
        spec.env
            .push(("MARKER".into(), marker.to_string_lossy().into_owned()));

        let error = run_katago_analysis_batch(&spec, "{}", 1, Duration::from_millis(100)).unwrap_err();

        assert!(matches!(error, EngineManagerError::Timeout { .. }));
        assert!(!marker.exists());
    }

    #[test]
    fn missing_engine_path_is_reported_before_spawn() {
        let temp_dir = TestTempDir::new("missing");
        let path = temp_dir.path().join("katago");
        let spec = CommandSpec {
            program: path.to_string_lossy().into_owned(),
            args: vec![],
            working_dir: None,
            env: vec![],
        };

        let error = run_katago_analysis_once(&spec, "{}", Duration::from_secs(1)).unwrap_err();

        assert!(matches!(error, EngineManagerError::EnginePathNotFound { .. }));
    }

    #[test]
    #[cfg(unix)]
    fn non_zero_exit_includes_stderr() {
        let temp_dir = TestTempDir::new("non-zero");
        let spec = fake_engine_spec(&temp_dir, "read line; printf 'bad news\\n' >&2; exit 7");

        let error = run_katago_analysis_once(&spec, "{}", Duration::from_secs(2)).unwrap_err();

        match error {
            EngineManagerError::NonZeroExit {
                exit_code, stderr, ..
            } => {
                assert_eq!(exit_code, Some(7));
                assert!(stderr.contains("bad news"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    #[cfg(unix)]
    fn timeout_kills_process() {
        let temp_dir = TestTempDir::new("timeout");
        let spec = fake_engine_spec(&temp_dir, "sleep 2");

        let error = run_katago_analysis_once(&spec, "{}", Duration::from_millis(100)).unwrap_err();

        assert!(matches!(error, EngineManagerError::Timeout { .. }));
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_streams_multiple_lines_from_fake_engine() {
        let temp_dir = TestTempDir::new("session-stream");
        let spec = fake_engine_spec(
            &temp_dir,
            "printf 'info move D4 visits 1\\ninfo move Q16 visits 2\\n'\nsleep 5",
        );

        let mut session = GtpSession::start(&spec).unwrap();

        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Line("info move D4 visits 1".into()))
        );
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Line("info move Q16 visits 2".into()))
        );

        session.close().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_send_command_reaches_fake_engine_stdin() {
        let temp_dir = TestTempDir::new("session-send");
        let spec = fake_engine_spec(&temp_dir, "read line\nprintf 'got %s\\n' \"$line\"\nsleep 5");

        let mut session = GtpSession::start(&spec).unwrap();
        session.send_command("kata-analyze B 10").unwrap();

        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Line("got kata-analyze B 10".into()))
        );

        session.close().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_send_command_strips_newlines() {
        let temp_dir = TestTempDir::new("session-sanitize");
        let spec = fake_engine_spec(&temp_dir, "read line\nprintf 'got %s\\n' \"$line\"\nsleep 5");

        let mut session = GtpSession::start(&spec).unwrap();
        // An embedded newline would otherwise become a second GTP command (injection).
        session.send_command("a\nb\r\nc\r").unwrap();

        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Line("got abc".into()))
        );

        session.close().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_reports_eof_when_fake_engine_exits() {
        let temp_dir = TestTempDir::new("session-eof");
        let spec = fake_engine_spec(&temp_dir, "printf 'info move D4 visits 1\\n'");

        let mut session = GtpSession::start(&spec).unwrap();

        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Line("info move D4 visits 1".into()))
        );
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Eof { exit_code: None })
        );

        session.close().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_close_terminates_child_process() {
        let temp_dir = TestTempDir::new("session-close");
        let spec = fake_engine_spec_with_pid_file(&temp_dir, "sleep 30");
        let pid_file = temp_dir.path().join("engine.pid");

        let mut session = GtpSession::start(&spec).unwrap();
        let pid = wait_for_pid_file(&pid_file, Duration::from_secs(5));
        assert!(process_is_alive(pid), "fake engine should be running");

        let started = Instant::now();
        let exit_code = session.close().unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "close() should not block on a sleeping engine"
        );
        assert!(!process_is_alive(pid), "close() must reap the engine");
        // `close()` kills a sleeping engine, so there is no clean exit code to report.
        assert_eq!(exit_code, None);

        // Idempotent: a second close is a no-op.
        assert_eq!(session.close().unwrap(), None);
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_drop_terminates_child_process() {
        let temp_dir = TestTempDir::new("session-drop");
        let spec = fake_engine_spec_with_pid_file(&temp_dir, "sleep 30");
        let pid_file = temp_dir.path().join("engine.pid");

        let pid = {
            // Bound (not just constructed) so the `Drop` impl runs at the end of this block;
            // that drop is precisely what this test exercises. The binding is intentionally
            // never read, hence the underscore prefix.
            let _session = GtpSession::start(&spec).unwrap();
            let pid = wait_for_pid_file(&pid_file, Duration::from_secs(5));
            assert!(
                process_is_alive(pid),
                "fake engine should be running before the drop"
            );
            pid
        };

        // Give the OS a moment to observe the kill, then assert nothing leaked.
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_is_alive(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !process_is_alive(pid),
            "dropping a session must not leak the engine process (pid {pid} still alive)"
        );
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_bare_newline_is_sent_verbatim() {
        let temp_dir = TestTempDir::new("session-newline");
        let spec = fake_engine_spec(&temp_dir, "read line\nprintf 'len %s\\n' \"${#line}\"\nsleep 5");

        let mut session = GtpSession::start(&spec).unwrap();
        session.send_bare_newline().unwrap();

        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Line("len 0".into()))
        );

        session.close().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_send_does_not_block_when_responses_arrive_in_a_batch() {
        let temp_dir = TestTempDir::new("session-batch");
        // Reproduces the coalesced-pipe behaviour measured in the live probe: all three
        // responses appear at once, after all three commands were written.
        let spec = fake_engine_spec(
            &temp_dir,
            "read a\nread b\nread c\nprintf '=\\n\\n=\\n\\n=\\n\\n'\nsleep 5",
        );

        let mut session = GtpSession::start(&spec).unwrap();

        let started = Instant::now();
        session.send_command("boardsize 19").unwrap();
        session.send_command("komi 7.5").unwrap();
        session.send_command("play B D4").unwrap();
        // Three sends must return immediately; a blocking implementation would wait here for
        // responses that only exist after the third command is read.
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "send_command must not wait for responses (took {:?})",
            started.elapsed()
        );

        // The engine only starts emitting after reading all three commands, so nothing can be
        // observed before that; the batch must then arrive in order.
        let mut lines = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while lines.len() < 6 && Instant::now() < deadline {
            if let Some(GtpSessionEvent::Line(line)) = session.next_event_timeout(Duration::from_millis(200))
            {
                lines.push(line);
            }
        }
        assert_eq!(lines, vec!["=", "", "=", "", "=", ""]);

        session.close().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_send_returns_immediately_when_engine_produces_no_output() {
        let temp_dir = TestTempDir::new("session-silent");
        // Degenerate variant of the batch test: the engine never reads stdin and never writes.
        let spec = fake_engine_spec(&temp_dir, "sleep 30");

        let mut session = GtpSession::start(&spec).unwrap();

        let started = Instant::now();
        session.send_command("kata-analyze B 20").unwrap();
        session.send_bare_newline().unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "sends must return without any engine output (took {:?})",
            started.elapsed()
        );

        assert_eq!(session.next_event_timeout(Duration::from_millis(200)), None);

        session.close().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_surfaces_eof_as_event_then_rejects_later_writes() {
        let temp_dir = TestTempDir::new("session-crash");
        // Simulates an engine crash: it exits immediately without answering.
        let spec = fake_engine_spec(&temp_dir, "printf 'boom\\n'");

        let mut session = GtpSession::start(&spec).unwrap();

        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Line("boom".into()))
        );
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Eof { exit_code: None })
        );

        // A dead session must error rather than silently hang. Depending on timing the write
        // either hits our `closed`/`stdin == None` guard or the OS reports a broken pipe.
        let error = session.send_command("boardsize 19").unwrap_err();
        assert!(
            matches!(
                error,
                EngineManagerError::SessionNotRunning | EngineManagerError::SessionWrite { .. }
            ),
            "expected a write error on a dead session, got {error:?}"
        );

        // close() still reaps it and reports the real exit code.
        session.close().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_keeps_one_process_alive_across_many_commands() {
        let temp_dir = TestTempDir::new("session-persist");
        // The engine answers every command and stays alive, reporting its own pid each time.
        let spec = fake_engine_spec_with_pid_file(
            &temp_dir,
            "while read line; do printf 'ok %s\\n' \"$line\"; done",
        );
        let pid_file = temp_dir.path().join("engine.pid");

        let mut session = GtpSession::start(&spec).unwrap();
        let pid = session.child_id();
        assert_eq!(wait_for_pid_file(&pid_file, Duration::from_secs(5)), pid);

        for command in ["boardsize 19", "komi 7.5", "play B D4", "kata-analyze B 10"] {
            session.send_command(command).unwrap();
            assert_eq!(
                session.next_event_timeout(Duration::from_secs(5)),
                Some(GtpSessionEvent::Line(format!("ok {command}")))
            );
            // The engine never restarted, so the pid is stable across commands.
            assert_eq!(session.child_id(), pid);
            assert!(!session.has_exited().unwrap());
        }

        session.close().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn gtp_session_bare_newline_stops_stream_and_session_continues() {
        let temp_dir = TestTempDir::new("session-stop");
        // Mimics `kata-analyze` semantics: an EOF-ish stop on a bare newline, then it keeps
        // serving commands. `read` returning non-zero on a bare newline is modelled by an
        // explicit empty-line branch.
        let spec = fake_engine_spec(
            &temp_dir,
            "while read line; do\n\
             \x20 if [ -z \"$line\" ]; then printf 'stopped\\n'; else printf 'ok %s\\n' \"$line\"; fi\n\
             done",
        );

        let mut session = GtpSession::start(&spec).unwrap();

        session.send_command("kata-analyze B 20").unwrap();
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Line("ok kata-analyze B 20".into()))
        );

        // Bare newline terminates the analysis...
        session.send_bare_newline().unwrap();
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Line("stopped".into()))
        );

        // ...and the very same process still accepts a new analysis.
        session.send_command("kata-analyze W 20").unwrap();
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(5)),
            Some(GtpSessionEvent::Line("ok kata-analyze W 20".into()))
        );

        session.close().unwrap();
    }

    // --- Real-engine session tests -------------------------------------------------------
    //
    // `plans/004` requires `cargo test` to stay green on a machine without KataGo, while the
    // task contract requires the session lifecycle to be proven against the real engine. Both
    // hold by making these opt-in: they run only when the three paths below are exported, and
    // skip cleanly otherwise. The fake-engine tests above pin the same behaviours in CI.
    //
    //   export LIZZIEYZY_KATAGO_ENGINE="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/macos-arm64/katago"
    //   export LIZZIEYZY_KATAGO_MODEL="/Applications/LizzieYzy Next.app/Contents/app/weights/default.bin.gz"
    //   export LIZZIEYZY_KATAGO_CONFIG="/Applications/LizzieYzy Next.app/Contents/app/engines/katago/configs/gtp.cfg"

    /// A real-KataGo `CommandSpec`, or `None` when the environment does not provide one.
    #[cfg(unix)]
    fn real_engine_spec(temp_dir: &TestTempDir) -> Option<CommandSpec> {
        let engine = std::env::var("LIZZIEYZY_KATAGO_ENGINE").ok()?;
        let model = std::env::var("LIZZIEYZY_KATAGO_MODEL").ok()?;
        let config = std::env::var("LIZZIEYZY_KATAGO_CONFIG").ok()?;
        if !Path::new(&engine).exists() || !Path::new(&model).exists() || !Path::new(&config).exists() {
            return None;
        }
        Some(CommandSpec {
            program: engine,
            // The GTP backend shape produced by `build_command_spec` for `EngineBackend::KataGoGtp`.
            args: vec!["gtp".into(), "-model".into(), model, "-config".into(), config],
            // Run inside the temp dir: the bundle config's `logDir` is relative, so this keeps
            // engine logs out of the repository working tree.
            working_dir: Some(temp_dir.path().to_string_lossy().into_owned()),
            env: vec![],
        })
    }

    /// Count `info ...` lines seen within `duration`, without writing anything to the engine.
    #[cfg(unix)]
    fn count_info_lines(session: &GtpSession, duration: Duration) -> usize {
        let deadline = Instant::now() + duration;
        let mut count = 0;
        while Instant::now() < deadline {
            match session.next_event_timeout(Duration::from_millis(200)) {
                Some(GtpSessionEvent::Line(line)) if line.starts_with("info") => count += 1,
                Some(GtpSessionEvent::Eof { .. }) | Some(GtpSessionEvent::ReadError(_)) => break,
                _ => {}
            }
        }
        count
    }

    /// Drain events for `duration`, discarding them, so later assertions look only at the
    /// analysis stream (start-up produces a banner and `=` handshake responses).
    #[cfg(unix)]
    fn drain_events(session: &GtpSession, duration: Duration) {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            // Discard whatever arrives; the call itself bounds each wait.
            let _ = session.next_event_timeout(Duration::from_millis(100));
        }
    }

    /// The engine process must survive many analyses: real GTP sessions are long-lived.
    #[cfg(unix)]
    #[test]
    fn gtp_session_real_engine_keeps_one_process_across_many_analyses() {
        let temp_dir = TestTempDir::new("real-session-persist");
        let Some(spec) = real_engine_spec(&temp_dir) else {
            eprintln!("skipping real-engine test: LIZZIEYZY_KATAGO_* not set");
            return;
        };

        let mut session = GtpSession::start(&spec).unwrap();
        let pid = session.child_id();

        session.send_command("boardsize 9").unwrap();
        session.send_command("komi 7.5").unwrap();
        session.send_command("clear_board").unwrap();
        session.send_command("play B E5").unwrap();
        drain_events(&session, Duration::from_secs(6));

        for round in 1..=3 {
            session.send_command("kata-analyze B 20").unwrap();
            let info_lines = count_info_lines(&session, Duration::from_secs(4));
            assert!(info_lines > 0, "analysis round {round} produced no info lines");
            // The whole point of a long-lived session: same OS process throughout.
            assert_eq!(session.child_id(), pid, "engine restarted during round {round}");
            assert!(
                !session.has_exited().unwrap(),
                "engine exited during round {round}"
            );
            session.send_bare_newline().unwrap();
            drain_events(&session, Duration::from_millis(600));
        }

        assert_eq!(session.close().unwrap(), Some(0), "engine should exit cleanly");
    }

    /// Decoupling: the engine pushes `info` lines on its own. Once `kata-analyze` is running we
    /// write nothing further to stdin, yet the stream keeps arriving.
    #[cfg(unix)]
    #[test]
    fn gtp_session_real_engine_streams_info_without_further_writes() {
        let temp_dir = TestTempDir::new("real-session-stream");
        let Some(spec) = real_engine_spec(&temp_dir) else {
            eprintln!("skipping real-engine test: LIZZIEYZY_KATAGO_* not set");
            return;
        };

        let mut session = GtpSession::start(&spec).unwrap();
        session.send_command("boardsize 9").unwrap();
        session.send_command("komi 7.5").unwrap();
        session.send_command("clear_board").unwrap();
        session.send_command("play B E5").unwrap();
        drain_events(&session, Duration::from_secs(6));

        session.send_command("kata-analyze B 20").unwrap();

        // From here on nothing is written to stdin: all `info` lines are engine-pushed.
        let info_lines = count_info_lines(&session, Duration::from_secs(5));
        assert!(
            info_lines >= 2,
            "expected a stream of unsolicited info lines, got {info_lines}"
        );

        session.close().unwrap();
    }

    /// A bare newline terminates `kata-analyze`, and the same engine then serves a new analysis.
    #[cfg(unix)]
    #[test]
    fn gtp_session_real_engine_bare_newline_stops_and_session_continues() {
        let temp_dir = TestTempDir::new("real-session-stop");
        let Some(spec) = real_engine_spec(&temp_dir) else {
            eprintln!("skipping real-engine test: LIZZIEYZY_KATAGO_* not set");
            return;
        };

        let mut session = GtpSession::start(&spec).unwrap();
        let pid = session.child_id();
        session.send_command("boardsize 9").unwrap();
        session.send_command("komi 7.5").unwrap();
        session.send_command("clear_board").unwrap();
        session.send_command("play B E5").unwrap();
        drain_events(&session, Duration::from_secs(6));

        session.send_command("kata-analyze B 20").unwrap();
        assert!(count_info_lines(&session, Duration::from_secs(4)) > 0);

        // Stop it; the engine must go quiet (its `=` terminator is the last thing seen).
        session.send_bare_newline().unwrap();
        drain_events(&session, Duration::from_secs(2));
        assert!(
            count_info_lines(&session, Duration::from_millis(700)) == 0,
            "info lines must stop after the bare-newline stop"
        );

        // Same process, brand new analysis.
        assert_eq!(session.child_id(), pid, "the engine must not restart on stop");
        session.send_command("kata-analyze W 20").unwrap();
        assert!(
            count_info_lines(&session, Duration::from_secs(5)) > 0,
            "the session must accept a new analysis after a stop"
        );

        session.close().unwrap();
    }

    /// No child process may survive `close()`, and the process is reaped (no zombie).
    #[cfg(unix)]
    #[test]
    fn gtp_session_real_engine_close_leaves_no_process() {
        let temp_dir = TestTempDir::new("real-session-reap");
        let Some(spec) = real_engine_spec(&temp_dir) else {
            eprintln!("skipping real-engine test: LIZZIEYZY_KATAGO_* not set");
            return;
        };

        let pid = {
            let session = GtpSession::start(&spec).unwrap();
            let pid = session.child_id();
            assert!(process_is_alive(pid));
            pid
            // Dropped at the end of this scope; `Drop` must reap it.
        };

        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            // `kill -0` fails for both a reaped process and a zombie's parent-tracked pid,
            // so this asserts the process is gone from the table, not merely stopped.
            let state = std::process::Command::new("/bin/sh")
                .args(["-c", &format!("ps -o state= -p {pid} 2>/dev/null")])
                .output()
                .ok();
            let state_text = state
                .as_ref()
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
                .unwrap_or_default();
            assert!(
                !state_text.starts_with('Z'),
                "engine pid {pid} must not be left as a zombie"
            );
            if !process_is_alive(pid) {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!process_is_alive(pid), "engine pid {pid} leaked after close");
    }
}
