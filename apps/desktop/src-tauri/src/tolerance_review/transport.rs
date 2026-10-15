use super::types::{ModelIdentity, ReviewConfig, SshHop};
use engine_manager::{AnalysisCancelToken, CommandSpec, GtpSession, GtpSessionEvent};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn file_hash(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("无法读取 {}: {e}", path.display()))?;
    let mut h = Sha256::new();
    let mut b = [0; 65536];
    loop {
        let n = f.read(&mut b).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn quote(s: &str) -> Result<String, String> {
    if s.contains('\0') {
        return Err("参数包含 NUL".into());
    }
    Ok(format!("'{}'", s.replace('\'', "'\\''")))
}
fn destination(h: &SshHop) -> Result<String, String> {
    let valid = |s: &str| {
        !s.is_empty()
            && !s.starts_with('-')
            && s.len() <= 255
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    };
    if !valid(&h.host) || h.port == Some(0) {
        return Err("SSH 主机或端口无效".into());
    }
    match h.user.as_deref().filter(|v| !v.is_empty()) {
        Some(u) if valid(u) && !u.contains(':') => Ok(format!("{u}@{}", h.host)),
        Some(_) => Err("SSH 用户名无效".into()),
        None => Ok(h.host.clone()),
    }
}
pub fn ssh_spec(c: &ReviewConfig) -> Result<CommandSpec, String> {
    if c.ssh_route.is_empty() || c.ssh_route.len() > 4 {
        return Err("SSH 路线需要 1–4 个节点".into());
    }
    let args = [
        "python3",
        "-u",
        "-c",
        include_str!("ssh_worker.py"),
        &c.engine_path,
        &c.model_path,
        &c.human_model_path,
        &c.config_path,
        c.working_dir.as_deref().unwrap_or(""),
    ];
    let mut remote = format!(
        "exec {}",
        args.iter()
            .map(|s| quote(s))
            .collect::<Result<Vec<_>, _>>()?
            .join(" ")
    );
    let mut outer = vec![];
    for (i, hop) in c.ssh_route.iter().enumerate().rev() {
        let mut args: Vec<String> = [
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=15",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
        ]
        .iter()
        .map(|v| v.to_string())
        .collect();
        if i + 1 < c.ssh_route.len() {
            args.push("-A".into());
        }
        if c.use_agent_identities {
            args.extend(["-o".into(), "IdentitiesOnly=no".into()]);
        }
        if let Some(p) = hop.port {
            args.extend(["-p".into(), p.to_string()]);
        }
        if i == 0 {
            if let Some(path) = c.identity_file.as_deref().filter(|s| !s.is_empty()) {
                if !Path::new(path).is_file() {
                    return Err("SSH 私钥路径不存在".into());
                }
                args.extend(["-i".into(), path.into()]);
            }
        }
        args.extend(["--".into(), destination(hop)?, remote]);
        remote = format!(
            "exec ssh {}",
            args.iter()
                .map(|s| quote(s))
                .collect::<Result<Vec<_>, _>>()?
                .join(" ")
        );
        outer = args;
    }
    Ok(CommandSpec {
        program: if cfg!(windows) { "ssh" } else { "/usr/bin/ssh" }.into(),
        args: outer,
        working_dir: None,
        env: vec![],
    })
}

pub struct Session {
    inner: GtpSession,
    pub identity: ModelIdentity,
    remote: bool,
    closed: bool,
}
impl Session {
    pub fn start(c: &ReviewConfig, cancel: &AnalysisCancelToken) -> Result<Self, String> {
        c.validate()?;
        if c.source == "ssh" {
            let mut inner = GtpSession::start(&ssh_spec(c)?).map_err(|e| e.to_string())?;
            let until = Instant::now() + Duration::from_secs(120);
            loop {
                if cancel.is_cancelled() {
                    let _ = inner.close();
                    return Err("已取消".into());
                }
                if Instant::now() > until {
                    let _ = inner.close();
                    return Err("远端模型握手超时".into());
                }
                match inner.next_event_timeout(Duration::from_millis(100)) {
                    Some(GtpSessionEvent::Line(line)) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&line) {
                            if let Some(id) = v.get("riskHandshake") {
                                return Ok(Self {
                                    inner,
                                    identity: serde_json::from_value(id.clone())
                                        .map_err(|e| e.to_string())?,
                                    remote: true,
                                    closed: false,
                                });
                            }
                        }
                    }
                    Some(GtpSessionEvent::Eof { .. }) => {
                        return Err(format!("SSH 引擎启动失败：{}", inner.stderr_snapshot()))
                    }
                    Some(GtpSessionEvent::ReadError(e)) => return Err(e),
                    None => {}
                }
            }
        }
        let profile = app_model::EngineProfileDto {
            name: "容错复盘".into(),
            engine_path: c.engine_path.clone(),
            model_path: Some(c.model_path.clone()),
            config_path: Some(c.config_path.clone()),
            working_dir: c.working_dir.clone(),
            backend: app_model::EngineBackend::KataGoAnalysis,
        };
        let mut spec = engine_manager::build_command_spec(&profile).map_err(|e| e.to_string())?;
        let asset = |s: &str| {
            let p = PathBuf::from(s);
            if p.is_absolute() {
                p
            } else {
                Path::new(c.working_dir.as_deref().unwrap_or(".")).join(p)
            }
        };
        let program = if Path::new(&spec.program).is_file() {
            PathBuf::from(&spec.program)
        } else {
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .map(|p| p.join(&spec.program))
                .find(|p| p.is_file())
                .ok_or("找不到 KataGo 可执行文件")?
        };
        let model = asset(&c.model_path).canonicalize().map_err(|e| e.to_string())?;
        let human = asset(&c.human_model_path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let config = asset(&c.config_path).canonicalize().map_err(|e| e.to_string())?;
        let version = std::process::Command::new(&program)
            .arg("version")
            .output()
            .map_err(|e| e.to_string())?;
        if !version.status.success() {
            return Err("KataGo 版本探测失败".into());
        }
        let identity = ModelIdentity {
            engine_version: String::from_utf8_lossy(&version.stdout).into_owned(),
            engine_sha256: file_hash(&program)?,
            model_sha256: file_hash(&model)?,
            human_model_sha256: file_hash(&human)?,
            config_sha256: file_hash(&config)?,
            cache_safe: !std::fs::read_to_string(&config)
                .map_err(|e| e.to_string())?
                .contains("@include"),
        };
        if let Some(i) = spec.args.iter().position(|a| a == "-override-config") {
            spec.args.drain(i..i + 2);
        }
        spec.args.extend(["-human-model".into(),human.to_string_lossy().into_owned(),"-override-config".into(),"reportAnalysisWinratesAs=BLACK,numAnalysisThreads=1,nnMaxBatchSize=16,numSearchThreadsPerAnalysisThread=2".into()]);
        Ok(Self {
            inner: GtpSession::start(&spec).map_err(|e| e.to_string())?,
            identity,
            remote: false,
            closed: false,
        })
    }
    pub fn query(&mut self, q: &Value, cancel: &AnalysisCancelToken) -> Result<Value, String> {
        self.inner
            .send_command(&q.to_string())
            .map_err(|e| e.to_string())?;
        let until = Instant::now() + Duration::from_secs(600);
        loop {
            if cancel.is_cancelled() {
                return Err("已取消".into());
            }
            if Instant::now() > until {
                return Err("局面分析超过 600 秒，已停止任务".into());
            }
            match self.inner.next_event_timeout(Duration::from_millis(100)) {
                Some(GtpSessionEvent::Line(line)) => {
                    let Ok(v) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if v.get("id") != q.get("id") {
                        continue;
                    }
                    if let Some(e) = v.get("error") {
                        return Err(format!("KataGo: {e}"));
                    }
                    if v.get("isDuringSearch") == Some(&Value::Bool(true)) || v.get("rootInfo").is_none() {
                        continue;
                    }
                    return Ok(v);
                }
                Some(GtpSessionEvent::Eof { .. }) => {
                    return Err(format!("引擎连接中断：{}", self.inner.stderr_snapshot()))
                }
                Some(GtpSessionEvent::ReadError(e)) => return Err(e),
                None => {}
            }
        }
    }
    pub fn close(&mut self) -> Result<(), String> {
        if self.closed {
            return Ok(());
        }
        let mut confirmed = !self.remote;
        if self.remote {
            let _ = self.inner.send_command(r#"{"riskControl":"close"}"#);
            let until = Instant::now() + Duration::from_secs(10);
            while Instant::now() < until {
                match self.inner.next_event_timeout(Duration::from_millis(100)) {
                    Some(GtpSessionEvent::Line(line)) => {
                        if serde_json::from_str::<Value>(&line)
                            .ok()
                            .and_then(|v| v.get("riskClosed").and_then(Value::as_bool))
                            == Some(true)
                        {
                            confirmed = true;
                            break;
                        }
                    }
                    Some(GtpSessionEvent::Eof { .. }) | Some(GtpSessionEvent::ReadError(_)) => break,
                    None => {}
                }
            }
        }
        self.inner.close().map_err(|e| e.to_string())?;
        self.closed = true;
        if confirmed {
            Ok(())
        } else {
            Err("未收到远端进程退出确认；保留已完成结果，请核对远端任务后再运行".into())
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
