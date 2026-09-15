//! Deliberately read-only: board mutations, search starts and lifecycle commands have typed APIs.
use super::parse_gtp_ack;
use crate::live_transport::GtpEvents;
use std::time::{Duration, Instant};
pub(super) fn validate(command: &str) -> Result<String, String> {
    if command.len() > 128 || command.chars().any(|c| c.is_control()) {
        return Err("控制台仅接受单行只读命令".into());
    }
    let parts: Vec<&str> = command.split_whitespace().collect();
    let valid = match parts.as_slice() {
        ["protocol_version" | "name" | "version" | "list_commands" | "kata-list-params" | "kata-get-rules"
        | "get_komi" | "showboard" | "kata-get-models" | "kata-get-params"] => true,
        ["known_command" | "kata-get-param", arg] => arg
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        _ => false,
    };
    if !valid {
        return Err("仅允许查询命令。落子、规则、参数修改和停止请使用对应界面，避免棋局状态不同步".into());
    }
    Ok(parts.join(" "))
}
pub(super) fn query(
    session: &mut impl GtpEvents,
    next_id: &mut u64,
    command: &str,
) -> Result<String, String> {
    let command = validate(command)?;
    let id = *next_id;
    *next_id = next_id.saturating_add(1);
    session.send_command(&format!("{id} {command}"))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut started = false;
    let mut rejected = false;
    let mut output = String::new();
    while Instant::now() < deadline {
        match session.next_event_timeout(Duration::from_millis(20)) {
            Some(engine_manager::GtpSessionEvent::Line(line)) => {
                if !started {
                    if let Some(ack) = parse_gtp_ack(&line).filter(|a| a.id == Some(id)) {
                        started = true;
                        rejected = ack.is_error;
                    } else {
                        continue;
                    }
                } else if line.is_empty() {
                    return if rejected {
                        Err(format!("引擎拒绝查询：{output}"))
                    } else {
                        Ok(output)
                    };
                }
                if output.len() + line.len() + 1 > 16_384 {
                    return Err("控制台响应超过 16 KB，已停止收集".into());
                }
                output.push_str(&line);
                output.push('\n');
            }
            Some(
                engine_manager::GtpSessionEvent::Eof { .. } | engine_manager::GtpSessionEvent::ReadError(_),
            ) => return Err("引擎连接已结束".into()),
            None => {}
        }
    }
    Err("控制台查询超时，分析保持暂停".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_readonly_single_commands_are_allowed() {
        for cmd in [
            "play B D4",
            "quit",
            "clear_board",
            "kata-set-param maxVisits 4",
            "version\nquit",
            "printsgf /tmp/file",
            "1 name",
        ] {
            assert!(validate(cmd).is_err(), "{cmd}");
        }
        for cmd in [
            "name",
            "kata-get-param numSearchThreads",
            "known_command kata-analyze",
            "showboard",
        ] {
            assert!(validate(cmd).is_ok());
        }
    }
}

#[cfg(test)]
mod response_tests {
    use super::*;
    struct Fake {
        lines: std::collections::VecDeque<String>,
    }
    impl crate::live_transport::GtpCommands for Fake {
        fn send_command(&mut self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }
    impl GtpEvents for Fake {
        fn next_event_timeout(&mut self, _: Duration) -> Option<engine_manager::GtpSessionEvent> {
            self.lines.pop_front().map(engine_manager::GtpSessionEvent::Line)
        }
    }
    #[test]
    fn multiline_response_waits_for_matching_ack_and_blank_terminator() {
        let mut fake = Fake {
            lines: ["info old", "=2 stale", "=3", "board line", ""]
                .into_iter()
                .map(String::from)
                .collect(),
        };
        assert_eq!(query(&mut fake, &mut 3, "showboard").unwrap(), "=3\nboard line\n");
    }
    #[test]
    fn response_collection_is_bounded() {
        let mut fake = Fake {
            lines: vec!["=3".into(), "x".repeat(17000), "".into()].into(),
        };
        assert!(query(&mut fake, &mut 3, "showboard")
            .unwrap_err()
            .contains("16 KB"));
    }
}

#[cfg(test)]
mod real_engine_test {
    use super::*;
    #[test]
    #[ignore = "Requires explicitly supplied private KataGo test process paths"]
    fn real_katago_console_stop_query_resume() {
        let env = |name| std::env::var(name).expect("set private test engine paths");
        let spec = engine_manager::CommandSpec {
            program: env("LIZZIE_TEST_ENGINE"),
            args: vec![
                "gtp".into(),
                "-model".into(),
                env("LIZZIE_TEST_MODEL"),
                "-config".into(),
                env("LIZZIE_TEST_CONFIG"),
            ],
            working_dir: None,
            env: vec![],
        };
        let mut session =
            crate::live_transport::LiveTransport::Local(engine_manager::GtpSession::start(&spec).unwrap());
        let mut id = 1;
        let ack = super::super::controls::acknowledged_command;
        ack(&mut session, &mut id, "boardsize 9").unwrap();
        ack(
            &mut session,
            &mut id,
            "kata-analyze B 10 ownership true rootInfo true",
        )
        .unwrap();
        fn frame(session: &mut crate::live_transport::LiveTransport) -> bool {
            let until = Instant::now() + Duration::from_secs(5);
            while Instant::now() < until {
                if matches!(session.next_event_timeout(Duration::from_millis(30)),Some(engine_manager::GtpSessionEvent::Line(line))if line.starts_with("info "))
                {
                    return true;
                }
            }
            false
        }
        assert!(frame(&mut session));
        ack(&mut session, &mut id, "stop").unwrap();
        let name = query(&mut session, &mut id, "name").unwrap();
        assert!(name.contains("KataGo"));
        let board = query(&mut session, &mut id, "showboard").unwrap();
        assert!(board.lines().count() > 9);
        ack(
            &mut session,
            &mut id,
            "kata-analyze W 10 ownership true rootInfo true",
        )
        .unwrap();
        assert!(frame(&mut session));
        session.close().unwrap();
        eprintln!("real private KataGo: stream -> acknowledged stop -> name/showboard multiline query -> same-process resume -> close passed");
    }
}
