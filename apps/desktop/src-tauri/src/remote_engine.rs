//! SSH is only a process transport. Analysis semantics remain in the shared GTP owner.
use engine_manager::CommandSpec;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteEngineConfig {
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub engine_path: String,
    pub model_path: String,
    pub config_path: String,
}
fn destination_token(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value.len() <= 255
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn quote(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(|c| c.is_control()) {
        return Err("远程路径不能为空或包含控制字符".into());
    }
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}
pub(super) fn ssh_spec(config: &RemoteEngineConfig) -> Result<CommandSpec, String> {
    if !destination_token(&config.host) || config.port == Some(0) {
        return Err("SSH 主机或端口无效".into());
    }
    let destination = match config.user.as_deref().filter(|u| !u.is_empty()) {
        Some(user) if destination_token(user) && !user.contains(':') => format!("{user}@{}", config.host),
        Some(_) => return Err("SSH 用户名无效".into()),
        None => config.host.clone(),
    };
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
    .into_iter()
    .map(String::from)
    .collect();
    if let Some(port) = config.port {
        args.extend(["-p".into(), port.to_string()]);
    }
    if let Some(identity) = config.identity_file.as_deref().filter(|s| !s.is_empty()) {
        if identity.chars().any(|c| c.is_control()) || !std::path::Path::new(identity).is_file() {
            return Err("SSH 私钥文件不存在".into());
        }
        args.extend(["-i".into(), identity.into()]);
    }
    let remote = format!(
        "exec {} gtp -model {} -config {} -override-config reportAnalysisWinratesAs=BLACK",
        quote(&config.engine_path)?,
        quote(&config.model_path)?,
        quote(&config.config_path)?
    );
    args.extend(["--".into(), destination, remote]);
    Ok(CommandSpec {
        program: if cfg!(windows) { "ssh" } else { "/usr/bin/ssh" }.into(),
        args,
        working_dir: None,
        env: Vec::new(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> RemoteEngineConfig {
        RemoteEngineConfig {
            host: "compute-alias".into(),
            user: None,
            port: None,
            identity_file: None,
            engine_path: "/opt/Kata Go/katago".into(),
            model_path: "/models/model.bin.gz".into(),
            config_path: "/configs/gtp.cfg".into(),
        }
    }
    #[test]
    fn uses_agent_and_known_hosts_without_password_or_shell_injection() {
        let mut c = config();
        c.model_path = "/models/a'$(touch /tmp/never).bin.gz".into();
        let spec = ssh_spec(&c).unwrap();
        assert!(spec.args.contains(&"BatchMode=yes".into()));
        assert!(spec.args.contains(&"StrictHostKeyChecking=yes".into()));
        assert!(spec
            .args
            .last()
            .unwrap()
            .contains("'/models/a'\\''$(touch /tmp/never).bin.gz'"));
        c.host = "-oProxyCommand=bad".into();
        assert!(ssh_spec(&c).is_err());
        c = config();
        c.engine_path = "katago\nquit".into();
        assert!(ssh_spec(&c).is_err());
    }
    #[test]
    fn remote_command_keeps_server_config_without_local_tuning() {
        let spec=ssh_spec(&config()).unwrap();
        let command=spec.args.last().unwrap();
        assert!(command.contains("-config '/configs/gtp.cfg'"));
        for local_key in ["numSearchThreads", "nnMaxBatchSize", "numNNServerThreads", "analysisWideRootNoise", "playoutDoublingAdvantage"] {
            assert!(!command.contains(local_key));
        }
    }
    #[test]
    fn mock_ssh_uses_the_existing_gtp_session() {
        let mut spec = ssh_spec(&config()).unwrap();
        let script = std::env::temp_dir().join(format!("mock-ssh-{}.sh", uuid::Uuid::new_v4()));
        std::fs::write(&script,"#!/bin/sh\n[ \"$1\" = '-T' ] || exit 12\ncase \" $* \" in *BatchMode=yes*) ;; *) exit 13;; esac\nwhile IFS= read -r line; do id=${line%% *}; case \"$line\" in *quit*) exit 0;; esac; printf '= %s\\n\\n' \"$line\"; done\n").unwrap();
        spec.program = "/bin/sh".into();
        spec.args.insert(0, script.to_string_lossy().into_owned());
        let mut session = engine_manager::GtpSession::start(&spec).unwrap();
        session.send_command("1 protocol_version").unwrap();
        assert!(
            matches!(session.next_event_timeout(std::time::Duration::from_secs(2)), Some(engine_manager::GtpSessionEvent::Line(line)) if line.contains("protocol_version"))
        );
        session.close().unwrap();
        let _ = std::fs::remove_file(script);
    }
}
