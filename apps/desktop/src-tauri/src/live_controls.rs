//! Validated search controls shared by interactive analysis and review scheduling.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiveSearchOptions {
    pub restriction: Option<MoveRestriction>,
    pub max_visits: Option<u32>,
    pub max_seconds: Option<f64>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RestrictionMode {
    Allow,
    Avoid,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct MoveRestriction {
    pub mode: RestrictionMode,
    pub vertices: Vec<String>,
}
impl LiveSearchOptions {
    pub fn validate(&self, board_size: u8, player: Option<&str>) -> Result<(), String> {
        if self.max_visits == Some(0) {
            return Err("计算量限额必须大于 0".into());
        }
        if self
            .max_seconds
            .is_some_and(|v| !v.is_finite() || v <= 0.0 || v > 86400.0)
        {
            return Err("时间限额必须在 0 至 86400 秒之间".into());
        }
        if let Some(r) = &self.restriction {
            if !matches!(player, Some("B" | "W" | "b" | "w")) {
                return Err("限定选点必须指定执棋方".into());
            }
            if r.vertices.is_empty() || r.vertices.len() > (board_size as usize).pow(2) + 1 {
                return Err("请选择至少一个有效选点".into());
            }
            for vertex in &r.vertices {
                if !valid_vertex(vertex, board_size) {
                    return Err(format!("无效选点：{vertex}"));
                }
            }
        }
        Ok(())
    }
    pub fn suffix(&self, player: Option<&str>) -> String {
        self.restriction
            .as_ref()
            .map(|r| {
                format!(
                    " {} {} {} 1",
                    match r.mode {
                        RestrictionMode::Allow => "allow",
                        RestrictionMode::Avoid => "avoid",
                    },
                    player.unwrap_or("B").to_ascii_uppercase(),
                    r.vertices
                        .iter()
                        .map(|v| v.to_ascii_uppercase())
                        .collect::<Vec<_>>()
                        .join(",")
                )
            })
            .unwrap_or_default()
    }
    pub fn reached(&self, visits: u32, seconds: f64) -> bool {
        self.max_visits.is_some_and(|v| visits >= v) || self.max_seconds.is_some_and(|s| seconds >= s)
    }
}
fn valid_vertex(vertex: &str, size: u8) -> bool {
    if vertex.eq_ignore_ascii_case("pass") {
        return true;
    }
    let bytes = vertex.as_bytes();
    if !(2..=3).contains(&bytes.len()) || !bytes[1..].iter().all(u8::is_ascii_digit) {
        return false;
    }
    let column = b"ABCDEFGHJKLMNOPQRSTUVWXYZ"
        .iter()
        .position(|c| *c == bytes[0].to_ascii_uppercase());
    column.is_some_and(|c| c < size as usize) && vertex[1..].parse::<u8>().is_ok_and(|r| r > 0 && r <= size)
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiveEngineParameters {
    pub num_search_threads: Option<u32>,
    pub analysis_wide_root_noise: Option<f64>,
    pub playout_doubling_advantage: Option<f64>,
}
impl LiveEngineParameters {
    pub fn commands(&self, cloud: bool) -> Result<Vec<String>, String> {
        if cloud && self.num_search_threads.is_some() {
            return Err("云共享算力不支持修改服务器线程数".into());
        }
        if self.num_search_threads.is_some_and(|v| !(1..=256).contains(&v)) {
            return Err("线程数必须为 1 至 256".into());
        }
        if self
            .analysis_wide_root_noise
            .is_some_and(|v| !v.is_finite() || !(0.0..=5.0).contains(&v))
        {
            return Err("搜索广度必须为 0 至 5".into());
        }
        if self
            .playout_doubling_advantage
            .is_some_and(|v| !v.is_finite() || !(-3.0..=3.0).contains(&v))
        {
            return Err("激进度必须为 -3 至 3".into());
        }
        let mut commands = Vec::new();
        if let Some(v) = self.num_search_threads {
            commands.push(format!("kata-set-param numSearchThreads {v}"));
        }
        if let Some(v) = self.analysis_wide_root_noise {
            commands.push(format!("kata-set-param analysisWideRootNoise {v}"));
        }
        if let Some(v) = self.playout_doubling_advantage {
            commands.push(format!("kata-set-param playoutDoublingAdvantage {v}"));
        }
        if commands.is_empty() {
            return Err("请输入至少一项引擎参数".into());
        }
        Ok(commands)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restrictions_reject_injection_and_outside_board() {
        for vertex in ["D4\nquit", "I4", "T20", "A0", "é4"] {
            let options = LiveSearchOptions {
                restriction: Some(MoveRestriction {
                    mode: RestrictionMode::Allow,
                    vertices: vec![vertex.into()],
                }),
                ..Default::default()
            };
            assert!(options.validate(19, Some("B")).is_err());
        }
        let options = LiveSearchOptions {
            restriction: Some(MoveRestriction {
                mode: RestrictionMode::Avoid,
                vertices: vec!["D4".into(), "pass".into()],
            }),
            ..Default::default()
        };
        assert!(options.validate(19, Some("W")).is_ok());
        assert_eq!(options.suffix(Some("W")), " avoid W D4,PASS 1");
    }
    #[test]
    fn limits_are_combined_and_parameters_validate_before_send() {
        let options = LiveSearchOptions {
            max_visits: Some(100),
            max_seconds: Some(2.0),
            ..Default::default()
        };
        assert!(!options.reached(99, 1.9));
        assert!(options.reached(100, 1.9));
        assert!(options.reached(1, 2.0));
        assert!(LiveEngineParameters {
            num_search_threads: Some(4),
            ..Default::default()
        }
        .commands(true)
        .is_err());
        assert!(LiveEngineParameters {
            analysis_wide_root_noise: Some(f64::NAN),
            ..Default::default()
        }
        .commands(false)
        .is_err());
    }
}

// The owner remains the only reader of GTP events while control acknowledgements are pending.
use super::{
    emit_live_review_ended, parse_gtp_ack, LiveReviewCommand, LiveReviewSession, SharedLiveReviewGuard,
    LIVE_REVIEW_POLL_INTERVAL,
};
use crate::live_transport::{GtpCommands, GtpEvents, LiveTransport};
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
pub(super) fn acknowledged_command(
    session: &mut impl GtpEvents,
    next_id: &mut u64,
    command: &str,
) -> Result<(), String> {
    let id = *next_id;
    *next_id = next_id.saturating_add(1);
    session.send_command(&format!("{id} {command}"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match session.next_event_timeout(LIVE_REVIEW_POLL_INTERVAL) {
            Some(engine_manager::GtpSessionEvent::Line(line)) => {
                if let Some(ack) = parse_gtp_ack(&line).filter(|ack| ack.id == Some(id)) {
                    return if ack.is_error {
                        Err("引擎拒绝设置：当前引擎或云服务不支持此参数；此前参数可能已应用，请检查后重新应用".into())
                    } else {
                        Ok(())
                    };
                }
            }
            Some(
                engine_manager::GtpSessionEvent::Eof { .. } | engine_manager::GtpSessionEvent::ReadError(_),
            ) => return Err("引擎连接已结束".into()),
            None => {}
        }
    }
    Err("等待引擎确认超时，设置尚未确认".into())
}

#[derive(Clone, Serialize)]
struct LiveReviewPausedPayload {
    job_id: String,
    generation: u64,
    reason: &'static str,
}
pub(super) fn emit_paused(app: &AppHandle, job_id: &str, generation: u64, reason: &'static str) {
    let _ = app.emit("katago://live-review-paused", LiveReviewPausedPayload { job_id: job_id.into(), generation, reason });
}
pub(super) fn pause_on_limit(
    app: &AppHandle,
    job_id: &str,
    generation: u64,
    guard: &SharedLiveReviewGuard,
    session: &mut LiveTransport,
    next_id: &mut u64,
) -> bool {
    if let Ok(mut state) = guard.lock() {
        if state.generation != generation {
            return true;
        }
        state.stream_ready = false;
    }
    match acknowledged_command(session, next_id, "stop") {
        Ok(()) => {
            let _ = app.emit(
                "katago://live-review-paused",
                LiveReviewPausedPayload {
                    job_id: job_id.into(),
                    generation,
                    reason: "limit",
                },
            );
        }
        Err(error) => {
            let _ = session.close();
            emit_live_review_ended(app, job_id, generation, &error);
            return false;
        }
    }
    true
}

pub(super) async fn send_control(
    app_handle: AppHandle,
    parameters: Option<LiveEngineParameters>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<Mutex<LiveReviewSession>>();
        let (reply, receiver) = std::sync::mpsc::channel();
        let generation = {
            let mut live = state.lock().map_err(|_| "实时分析状态不可用")?;
            if let Some(p) = &parameters {
                if live.server_config { return Err("远程引擎沿用服务端配置，不下发本地调优参数".into()); }
                p.commands(live.cloud)?;
            }
            let sender = live.commands.clone().ok_or("实时引擎未连接")?;
            let generation = live.publish_request(None, None);
            let command = match parameters {
                Some(parameters) => LiveReviewCommand::Configure { parameters, reply },
                None => LiveReviewCommand::Pause { reply },
            };
            sender.send(command).map_err(|_| "实时引擎已结束")?;
            generation
        };
        receiver
            .recv_timeout(Duration::from_secs(25))
            .map_err(|_| "引擎控制请求未确认")??;
        Ok(generation)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod control_ack_tests {
    use super::*;
    struct FakeTransport {
        events: std::collections::VecDeque<engine_manager::GtpSessionEvent>,
        sent: Vec<String>,
    }
    impl GtpCommands for FakeTransport {
        fn send_command(&mut self, command: &str) -> Result<(), String> {
            self.sent.push(command.into());
            Ok(())
        }
    }
    impl GtpEvents for FakeTransport {
        fn next_event_timeout(&mut self, _: Duration) -> Option<engine_manager::GtpSessionEvent> {
            self.events.pop_front()
        }
    }
    fn fake(lines: &[&str]) -> FakeTransport {
        FakeTransport {
            events: lines
                .iter()
                .map(|s| engine_manager::GtpSessionEvent::Line(s.to_string()))
                .collect(),
            sent: Vec::new(),
        }
    }
    #[test]
    fn pause_requires_matching_ack_and_ignores_stale_frames() {
        let mut session = fake(&["info move D4 visits 20", "=3", "=4"]);
        let mut id = 4;
        assert!(acknowledged_command(&mut session, &mut id, "stop").is_ok());
        assert_eq!(session.sent, ["4 stop"]);
        assert_eq!(id, 5);
    }
    #[test]
    fn position_command_carries_root_only_restriction() {
        let mut session = fake(&[]);
        let request = super::super::LiveReviewPositionRequest {
            board_size: 19,
            player: Some("W".into()),
            ..Default::default()
        };
        let options = LiveSearchOptions {
            restriction: Some(MoveRestriction {
                mode: RestrictionMode::Allow,
                vertices: vec!["D4".into(), "Q16".into()],
            }),
            ..Default::default()
        };
        super::super::apply_live_review_position_with_options(&mut session, &request, 10, &mut 1, &options)
            .unwrap();
        assert!(session
            .sent
            .last()
            .unwrap()
            .ends_with("kata-analyze W 10 ownership true rootInfo true allow W D4,Q16 1"));
        let before = session.sent.len();
        let invalid = LiveSearchOptions {
            max_visits: Some(0),
            ..Default::default()
        };
        assert!(super::super::apply_live_review_position_with_options(
            &mut session,
            &request,
            10,
            &mut 1,
            &invalid
        )
        .is_err());
        assert_eq!(
            session.sent.len(),
            before,
            "invalid options must not mutate the engine"
        );
    }
    #[test]
    fn concurrent_position_requests_are_enqueued_in_generation_order() {
        let (sender, receiver) = std::sync::mpsc::channel();
        let state = Mutex::new(LiveReviewSession { commands: Some(sender), ..Default::default() });
        std::thread::scope(|scope| {
            for turn in 0..16 {
                let state = &state;
                scope.spawn(move || {
                    let request = super::super::LiveReviewPositionRequest { board_size: 19, player: Some("B".into()), ..Default::default() };
                    super::super::set_live_review_position(state, request, turn, 10).unwrap();
                });
            }
        });
        let actual: Vec<u64> = receiver.try_iter().map(|command| match command {
            LiveReviewCommand::SetPosition { generation, .. } => generation,
            _ => panic!("unexpected command"),
        }).collect();
        assert_eq!(actual, (1..=16).collect::<Vec<_>>());
    }
    #[test]
    fn configure_rejection_is_not_success() {
        let mut session = fake(&["=1", "?4 unsupported parameter"]);
        let error =
            acknowledged_command(&mut session, &mut 4, "kata-set-param numSearchThreads 2").unwrap_err();
        assert!(error.contains("此前参数可能已应用"));
    }
}
