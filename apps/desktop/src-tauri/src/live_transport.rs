//! Common GTP interface; the transport determines the engine's output perspective.
use app_model::PlayerColor;
use engine_manager::{GtpSession, GtpSessionEvent};
use std::time::Duration;

pub(super) trait GtpCommands {
    fn send_command(&mut self, command: &str) -> Result<(), String>;
}
pub(super) trait GtpEvents: GtpCommands {
    fn next_event_timeout(&mut self, timeout: Duration) -> Option<GtpSessionEvent>;
}
impl GtpEvents for LiveTransport {
    fn next_event_timeout(&mut self, timeout: Duration) -> Option<GtpSessionEvent> {
        LiveTransport::next_event_timeout(self, timeout)
    }
}
impl GtpCommands for GtpSession {
    fn send_command(&mut self, command: &str) -> Result<(), String> {
        GtpSession::send_command(self, command).map_err(|e| e.to_string())
    }
}
pub(super) enum LiveTransport {
    Local(GtpSession),
    Remote(GtpSession),
    Cloud(zhizi_socketio::ZhiziSession),
}
impl GtpCommands for LiveTransport {
    fn send_command(&mut self, command: &str) -> Result<(), String> {
        match self {
            Self::Local(s) | Self::Remote(s) => GtpCommands::send_command(s, command),
            Self::Cloud(s) => s.send_command(command).map_err(|error| format!("智子云发送命令失败：{error}")),
        }
    }
}
impl LiveTransport {
    pub(super) fn is_cloud(&self) -> bool {
        matches!(self, Self::Cloud(_))
    }
    pub(super) fn perspective(&self, player: Option<PlayerColor>) -> PlayerColor {
        output_perspective(self.is_cloud(), player)
    }
    pub(super) fn close(&mut self) -> Result<(), String> {
        match self {
            Self::Local(s) | Self::Remote(s) => s.close().map(|_| ()).map_err(|e| e.to_string()),
            Self::Cloud(s) => s.shutdown().map_err(|_| "智子云连接关闭失败".into()),
        }
    }
    pub(super) fn send_bare_newline(&mut self) -> Result<(), String> {
        match self {
            Self::Local(s) | Self::Remote(s) => s.send_bare_newline().map_err(|e| e.to_string()),
            Self::Cloud(s) => s.send_command("stop").map_err(|_| "智子云停止失败".into()),
        }
    }
    pub(super) fn next_event_timeout(&mut self, timeout: Duration) -> Option<GtpSessionEvent> {
        match self {
            Self::Local(s) | Self::Remote(s) => s.next_event_timeout(timeout),
            Self::Cloud(s) => s.next_event_timeout(timeout).map(|event| match event {
                zhizi_socketio::ZhiziEvent::Line(line) => GtpSessionEvent::Line(line),
                zhizi_socketio::ZhiziEvent::Eof => GtpSessionEvent::ReadError("智子云连接已结束".into()),
                zhizi_socketio::ZhiziEvent::ReadError(_) => {
                    GtpSessionEvent::ReadError("智子云连接中断，请重新启动分析".into())
                }
            }),
        }
    }
}
fn output_perspective(cloud: bool, player: Option<PlayerColor>) -> PlayerColor {
    if cloud {
        player.unwrap_or(PlayerColor::Black)
    } else {
        PlayerColor::Black
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cloud_uses_job_player_local_stays_black() {
        assert_eq!(
            output_perspective(true, Some(PlayerColor::White)),
            PlayerColor::White
        );
        assert_eq!(
            output_perspective(true, Some(PlayerColor::Black)),
            PlayerColor::Black
        );
        assert_eq!(
            output_perspective(false, Some(PlayerColor::White)),
            PlayerColor::Black
        );
        let parsed = katago_protocol::parse_kata_analyze_line(
            "info move D4 visits 10 winrate 0.7 scoreLead 3 order 0 pv D4",
            19,
        )
        .unwrap();
        let white = katago_protocol::kata_analyze_line_to_frame(
            uuid::Uuid::nil(),
            &parsed,
            1,
            output_perspective(true, Some(PlayerColor::White)),
        );
        let black = katago_protocol::kata_analyze_line_to_frame(
            uuid::Uuid::nil(),
            &parsed,
            0,
            output_perspective(true, Some(PlayerColor::Black)),
        );
        assert!((white.winrate_black - 0.3).abs() < 0.0001);
        assert!((black.winrate_black - 0.7).abs() < 0.0001);
    }
}
