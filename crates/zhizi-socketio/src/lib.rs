//! Engine.IO v4 / Socket.IO GTP transport with URI-selected namespaces.
//! `connect` waits for ready: invoke it on an engine worker, never a UI thread.
//! No reconnection, redirects or polling fallback.
use serde_json::{json, Value};
use std::{
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{stream::MaybeTlsStream, Message, WebSocket};
use url::Url;
const LIMIT: usize = 1024 * 1024;
const IO_TICK: Duration = Duration::from_millis(100);
// Shared with the waiting caller: a partial frame may keep the network worker
// inside read(), so the caller's hard timeout must not depend on worker progress.
const STAGE_DNS: u8 = 0;
const STAGE_TCP: u8 = 1;
const STAGE_TLS: u8 = 2;
const STAGE_ENGINE_OPEN: u8 = 3;
const STAGE_SOCKET_CONNECT: u8 = 4;
const STAGE_READY: u8 = 5;
const STAGE_ACTIVE: u8 = 6;
fn startup_timeout(stage: &AtomicU8) -> String {
    match stage.load(Ordering::Acquire) {
        STAGE_DNS => "Cloud DNS lookup timeout",
        STAGE_TCP => "Cloud TCP connection timeout",
        STAGE_TLS => "Cloud TLS or WebSocket handshake timeout",
        STAGE_ENGINE_OPEN => "Cloud Engine.IO open timeout",
        STAGE_SOCKET_CONNECT => "Cloud Socket.IO connect timeout",
        _ => "Cloud engine ready timeout",
    }
    .into()
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZhiziEvent {
    Line(String),
    Eof,
    ReadError(String),
}
fn enqueue_command(sender: &SyncSender<String>, mut command: String, stop: &AtomicBool, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if stop.load(Ordering::Acquire) { return Err("Cloud session closed".into()); }
        match sender.try_send(command) {
            Ok(()) => return Ok(()),
            Err(mpsc::TrySendError::Disconnected(_)) => return Err("Cloud command channel disconnected".into()),
            Err(mpsc::TrySendError::Full(pending)) => command = pending,
        }
        if started.elapsed() >= timeout { return Err("Cloud command queue drain timeout".into()); }
        thread::sleep(Duration::from_millis(2));
    }
}

pub struct ZhiziSession {
    commands: SyncSender<String>,
    events: Receiver<ZhiziEvent>,
    failure: Receiver<String>,
    stop: Arc<AtomicBool>,
    eof: bool,
    worker: Option<thread::JoinHandle<()>>,
}
impl ZhiziSession {
    pub fn connect(socket_url: &str, token: &str) -> Result<Self, String> {
        let url = endpoint(socket_url, token, false)?;
        Self::start(url, Duration::from_secs(60))
    }
    fn start(url: Endpoint, timeout: Duration) -> Result<Self, String> {
        let (commands, rx) = mpsc::sync_channel(64);
        let (tx, events) = mpsc::sync_channel(1024);
        let (failure_tx, failure) = mpsc::sync_channel(1);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let cancelled = stop.clone();
        let stage = Arc::new(AtomicU8::new(STAGE_DNS));
        let worker_stage = stage.clone();
        let worker = thread::Builder::new()
            .name("zhizi-socketio".into())
            .spawn(move || {
                let result = run(url, rx, &tx, &ready_tx, &cancelled, &worker_stage, timeout);
                if let Err(error) = result {
                    let _ = ready_tx.try_send(Err(error.clone()));
                    let _ = failure_tx.try_send(error);
                }
                let _ = ready_tx.try_send(Err("Cloud session closed before ready".into()));
            })
            .map_err(|_| "Cannot start cloud transport worker".to_string())?;
        match ready_rx.recv_timeout(timeout) {
            Ok(Ok(())) => Ok(Self {
                commands,
                events,
                failure,
                stop,
                eof: false,
                worker: Some(worker),
            }),
            Ok(Err(e)) => {
                stop.store(true, Ordering::Release);
                Err(e)
            }
            Err(_) => {
                stop.store(true, Ordering::Release);
                Err(startup_timeout(&stage))
            }
        }
    }
    /// Queues one command with bounded backpressure while the network worker drains.
    pub fn send_command(&mut self, command: &str) -> Result<(), String> {
        if self.stop.load(Ordering::Acquire) || self.eof {
            return Err("Cloud session closed".into());
        }
        let command = command.trim_end_matches(['\r', '\n']);
        if command.is_empty() || command.len() > 65536 || command.contains(['\n', '\r', '\0']) {
            return Err("Invalid GTP command".into());
        }
        enqueue_command(&self.commands, format!("{command}\n"), &self.stop, Duration::from_secs(5))
    }
    pub fn next_event_timeout(&mut self, timeout: Duration) -> Option<ZhiziEvent> {
        if self.eof {
            return None;
        }
        match self.events.recv_timeout(timeout) {
            Ok(e) => {
                if matches!(e, ZhiziEvent::Eof) {
                    self.eof = true;
                }
                Some(e)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if let Ok(error) = self.failure.try_recv() {
                    Some(ZhiziEvent::ReadError(error))
                } else {
                    self.eof = true;
                    Some(ZhiziEvent::Eof)
                }
            }
            Err(_) => None,
        }
    }
    /// Sends quit/disconnect and joins the worker. Call on an engine worker, not the UI.
    pub fn shutdown(&mut self) -> Result<(), String> {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| "Cloud transport worker panicked")?;
        }
        Ok(())
    }
}
impl Drop for ZhiziSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
struct Endpoint {
    url: Url,
    namespace: String,
}
impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Endpoint([redacted])")
    }
}
fn socket_packet(kind: &str, namespace: &str, payload: &str) -> String {
    if namespace == "/" {
        format!("4{kind}{payload}")
    } else {
        format!("4{kind}{namespace},{payload}")
    }
}
// Strip only the namespace, leaving existing packet/event parsing independent of
// endpoint selection. Binary attachments for another namespace must still drain.
fn incoming_packet(text: &str, namespace: &str) -> Result<(Option<String>, usize), String> {
    if !text.starts_with('4') {
        return Ok((Some(text.into()), 0));
    }
    let prefix_len = if text.starts_with("45") {
        text.find('-')
            .map(|n| n + 1)
            .ok_or("Invalid binary event header")?
    } else {
        2
    };
    let rest = text.get(prefix_len..).ok_or("Invalid Socket.IO packet")?;
    let (packet_namespace, payload) = if rest.starts_with('/') {
        rest.split_once(',').ok_or("Invalid Socket.IO namespace packet")?
    } else {
        ("/", rest)
    };
    if packet_namespace != namespace {
        let count = if text.starts_with("45") {
            text[2..prefix_len - 1]
                .parse::<usize>()
                .map_err(|_| "Invalid attachment count")?
        } else {
            0
        };
        if count > 64 {
            return Err("Invalid attachment count".into());
        }
        return Ok((None, count));
    }
    Ok((Some(format!("{}{payload}", &text[..prefix_len])), 0))
}
fn endpoint(input: &str, token: &str, local: bool) -> Result<Endpoint, String> {
    let mut u = Url::parse(input).map_err(|_| "Invalid cloud endpoint")?;
    let host = u.host_str().unwrap_or("");
    let trusted = host == "zhizigo.com" || host.ends_with(".zhizigo.com");
    let loopback = local && host == "127.0.0.1" && u.scheme() == "ws";
    if (!trusted || !matches!(u.scheme(), "https" | "wss")) && !loopback {
        return Err("Untrusted cloud endpoint".into());
    }
    if (!loopback && u.port_or_known_default() != Some(443))
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || u.query().is_some()
        || token.is_empty()
    {
        return Err("Invalid cloud endpoint or token".into());
    }
    // Java URI.getPath() decodes the path; it selects a namespace, independently
    // of the fixed Engine.IO HTTP request path.
    let namespace = percent_encoding::percent_decode_str(u.path())
        .decode_utf8()
        .map_err(|_| "Invalid cloud namespace")?
        .into_owned();
    let namespace = if namespace.is_empty() {
        "/".to_string()
    } else {
        namespace
    };
    if namespace.contains(',') || namespace.chars().any(char::is_control) {
        return Err("Invalid cloud namespace".into());
    }
    if u.scheme() == "https" {
        u.set_scheme("wss").map_err(|_| "Invalid endpoint scheme")?;
    }
    u.set_path("/socket.io.v4/");
    u.query_pairs_mut()
        .append_pair("EIO", "4")
        .append_pair("transport", "websocket")
        .append_pair("zz-socketio-token", token);
    Ok(Endpoint { url: u, namespace })
}
type Socket = WebSocket<MaybeTlsStream<TcpStream>>;
fn send(ws: &mut Socket, text: String) -> Result<(), String> {
    ws.send(Message::Text(text.into()))
        .map_err(|_| "Cloud socket write failed".into())
}
fn run(
    endpoint: Endpoint,
    commands: Receiver<String>,
    events: &SyncSender<ZhiziEvent>,
    ready: &SyncSender<Result<(), String>>,
    stop: &AtomicBool,
    stage: &AtomicU8,
    timeout: Duration,
) -> Result<(), String> {
    let Endpoint { url, namespace } = endpoint;
    let started = Instant::now();
    let addresses = (
        url.host_str().ok_or("Invalid endpoint")?,
        url.port_or_known_default().ok_or("Invalid port")?,
    )
        .to_socket_addrs()
        .map_err(|_| "Cloud DNS lookup failed")?;
    stage.store(STAGE_TCP, Ordering::Release);
    let mut tcp = None;
    for address in addresses.take(8) {
        if stop.load(Ordering::Acquire) || started.elapsed() >= timeout {
            return Err("Cloud connection cancelled or timed out".into());
        }
        if let Ok(s) = TcpStream::connect_timeout(
            &address,
            Duration::from_secs(5).min(timeout.saturating_sub(started.elapsed())),
        ) {
            tcp = Some(s);
            break;
        }
    }
    let tcp = tcp.ok_or("Cloud TCP connection failed")?;
    tcp.set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| "Socket configuration failed")?;
    tcp.set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "Socket configuration failed")?;
    stage.store(STAGE_TLS, Ordering::Release);
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(LIMIT))
        .max_frame_size(Some(LIMIT));
    // client_tls performs one handshake on the supplied socket; it never follows redirects.
    let (mut ws, _) = tungstenite::client_tls_with_config(url.as_str(), tcp, Some(config), None)
        .map_err(|_| "Cloud TLS or WebSocket handshake failed")?;
    match ws.get_mut() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(IO_TICK)),
        MaybeTlsStream::NativeTls(s) => s.get_mut().set_read_timeout(Some(IO_TICK)),
        _ => return Err("Unsupported TLS backend".into()),
    }
    .map_err(|_| "Socket configuration failed")?;
    stage.store(STAGE_ENGINE_OPEN, Ordering::Release);
    let mut opened = false;
    let mut connected = false;
    let mut active = false;
    let mut heartbeat = Duration::from_secs(45);
    let mut last_ping = Instant::now();
    let mut pending = String::new();
    let mut binary_event: Option<String> = None;
    let mut binary_remaining = 0usize;
    let mut quit = false;
    let outcome = (|| -> Result<(), String> {
        loop {
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            if !active && started.elapsed() >= timeout {
                return Err(startup_timeout(stage));
            }
            if opened && last_ping.elapsed() > heartbeat {
                return Err("Cloud heartbeat timeout".into());
            }
            if active {
                for _ in 0..16 {
                    match commands.try_recv() {
                        Ok(command) => {
                            quit |= command.trim() == "quit";
                            send(
                                &mut ws,
                                socket_packet("2", &namespace, &json!(["stdin", command]).to_string()),
                            )?;
                        }
                        Err(_) => break,
                    }
                }
            }
            let message = match ws.read() {
                Ok(m) => m,
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return Ok(())
                }
                Err(_) => return Err("Cloud socket read failed".into()),
            };
            match message {
                Message::Close(_) => {
                    let _ = ws.flush();
                    return Ok(());
                }
                Message::Ping(_) | Message::Pong(_) => {
                    ws.flush().map_err(|_| "Cloud socket flush failed")?;
                }
                Message::Text(text) => {
                    let (text, ignored_binary) = incoming_packet(&text, &namespace)?;
                    if ignored_binary > 0 {
                        if binary_event.is_some() {
                            return Err("Unexpected binary event".into());
                        }
                        binary_event = Some("__ignored".into());
                        binary_remaining = ignored_binary;
                    }
                    let Some(text) = text else { continue };
                    if let Some(payload) = text.strip_prefix('0') {
                        if opened {
                            return Err("Duplicate Engine.IO handshake".into());
                        }
                        let v: Value =
                            serde_json::from_str(payload).map_err(|_| "Invalid Engine.IO handshake")?;
                        let interval = v["pingInterval"].as_u64().ok_or("Missing heartbeat interval")?;
                        let ping_timeout = v["pingTimeout"].as_u64().ok_or("Missing heartbeat timeout")?;
                        if v["sid"].as_str().unwrap_or("").is_empty() || interval == 0 || ping_timeout == 0 {
                            return Err("Invalid Engine.IO handshake".into());
                        }
                        heartbeat = Duration::from_millis(interval.saturating_add(ping_timeout).min(300_000));
                        last_ping = Instant::now();
                        opened = true;
                        send(&mut ws, socket_packet("0", &namespace, ""))?;
                        stage.store(STAGE_SOCKET_CONNECT, Ordering::Release);
                    } else if let Some(data) = text.strip_prefix('2') {
                        if !opened {
                            return Err("Ping before handshake".into());
                        }
                        last_ping = Instant::now();
                        send(&mut ws, format!("3{data}"))?;
                    } else if text.starts_with("40") && opened {
                        connected = true;
                        stage.store(STAGE_READY, Ordering::Release);
                    } else if text == "1" || text.starts_with("41") {
                        return Ok(());
                    } else if text.starts_with("44") {
                        return Err("Cloud Socket.IO connection rejected".into());
                    } else if let Some(data) = text.strip_prefix("42") {
                        if !connected {
                            return Err("Event before Socket.IO connection".into());
                        }
                        let v: Value = serde_json::from_str(data).map_err(|_| "Invalid Socket.IO event")?;
                        match v[0].as_str() {
                            Some("ready") => {
                                if !active {
                                    active = true;
                                    stage.store(STAGE_ACTIVE, Ordering::Release);
                                    let _ = ready.try_send(Ok(()));
                                }
                            }
                            Some("stdout") if active => {
                                let chunk = v[1].as_str().ok_or("Unsupported stdout payload")?;
                                emit_lines(&mut pending, chunk, events)?;
                            }
                            // Diagnostics must never be passed to the GTP parser, or echoed with secrets.
                            Some("stderr") => {}
                            _ => {}
                        }
                    } else if let Some(data) = text.strip_prefix("451-") {
                        if !connected || binary_event.is_some() {
                            return Err("Unexpected binary event".into());
                        }
                        let v: Value = serde_json::from_str(data).map_err(|_| "Invalid binary event")?;
                        if v[1]["_placeholder"] != true || v[1]["num"] != 0 {
                            return Err("Invalid binary attachment".into());
                        }
                        binary_event = Some(v[0].as_str().ok_or("Invalid binary event name")?.into());
                        binary_remaining = 1;
                    } else if text.starts_with("45") {
                        return Err("Unsupported binary event attachment count".into());
                    }
                }
                Message::Binary(bytes) => {
                    let event = binary_event.as_deref().ok_or("Unexpected binary attachment")?;
                    if event == "__ignored" {
                        binary_remaining -= 1;
                        if binary_remaining == 0 {
                            binary_event = None;
                        }
                        continue;
                    }
                    let event = binary_event.take().ok_or("Unexpected binary attachment")?;
                    binary_remaining = 0;
                    if event == "stdout" && active {
                        emit_lines(&mut pending, &String::from_utf8_lossy(&bytes), events)?;
                    }
                }
                _ => {}
            }
        }
    })();
    // Even a ready timeout can leave a billed engine allocated: quit whenever the
    // Socket.IO namespace was established, then close the transport on every exit.
    if connected && !quit {
        let _ = send(
            &mut ws,
            socket_packet("2", &namespace, &json!(["stdin", "quit\n"]).to_string()),
        );
    }
    if connected {
        let _ = send(&mut ws, socket_packet("1", &namespace, ""));
    }
    let _ = ws.close(None);
    let _ = ws.flush();
    outcome
}

fn emit_lines(pending: &mut String, chunk: &str, events: &SyncSender<ZhiziEvent>) -> Result<(), String> {
    if pending.len() + chunk.len() > LIMIT {
        return Err("Cloud output line too long".into());
    }
    pending.push_str(chunk);
    while let Some(pos) = pending.find('\n') {
        let line = pending[..pos].trim_end_matches('\r').to_string();
        pending.drain(..=pos);
        events
            .try_send(ZhiziEvent::Line(line))
            .map_err(|_| "Cloud output queue overflow")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    #[test]
    fn long_position_waits_for_queue_and_preserves_order() {
        let (tx, rx) = mpsc::sync_channel(64);
        let worker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            (0..365).map(|_| rx.recv().unwrap()).collect::<Vec<_>>()
        });
        let stop = AtomicBool::new(false);
        for i in 0..365 { enqueue_command(&tx, i.to_string(), &stop, Duration::from_secs(1)).unwrap(); }
        assert_eq!(worker.join().unwrap(), (0..365).map(|i| i.to_string()).collect::<Vec<_>>());
    }
    #[test]
    fn blocked_command_queue_has_bounded_wait() {
        let (tx, _rx) = mpsc::sync_channel(1);
        tx.send("first".into()).unwrap();
        let stop = AtomicBool::new(false);
        assert_eq!(enqueue_command(&tx, "next".into(), &stop, Duration::from_millis(5)).unwrap_err(), "Cloud command queue drain timeout");
        stop.store(true, Ordering::Release);
        assert_eq!(enqueue_command(&tx, "next".into(), &stop, Duration::from_secs(1)).unwrap_err(), "Cloud session closed");
    }
    fn mock(ready: bool) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut ws = tungstenite::accept_hdr(
                tcp,
                |request: &tungstenite::handshake::server::Request,
                 response: tungstenite::handshake::server::Response| {
                    assert_eq!(request.uri().path(), "/socket.io.v4/");
                    let parsed = Url::parse(&format!("ws://localhost{}", request.uri())).unwrap();
                    let pairs: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
                    assert_eq!(pairs["EIO"], "4");
                    assert_eq!(pairs["transport"], "websocket");
                    assert_eq!(pairs["zz-socketio-token"], "mock +&token");
                    Ok(response)
                },
            )
            .unwrap();
            ws.send(Message::Text(r#"0{"sid":"mock","upgrades":[],"pingInterval":1000,"pingTimeout":1000,"maxPayload":1000000}"#.into())).unwrap();
            assert_eq!(ws.read().unwrap().into_text().unwrap(), "40");
            ws.send(Message::Text(r#"40{"sid":"socket"}"#.into())).unwrap();
            if !ready {
                let msg = ws.read().unwrap().into_text().unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(msg.strip_prefix("42").unwrap()).unwrap(),
                    json!(["stdin", "quit\n"])
                );
                assert_eq!(ws.read().unwrap().into_text().unwrap(), "41");
                assert!(matches!(ws.read().unwrap(), Message::Close(_)));
                let _ = ws.flush();
                return;
            }
            ws.send(Message::Text(r#"42["ready"]"#.into())).unwrap();
            ws.send(Message::Text("2".into())).unwrap();
            let mut pong = false;
            let mut command = false;
            while !pong || !command {
                let msg = ws.read().unwrap().into_text().unwrap();
                if msg == "3" {
                    pong = true;
                } else {
                    let v: Value = serde_json::from_str(msg.strip_prefix("42").unwrap()).unwrap();
                    assert_eq!(v, json!(["stdin", "name\n"]));
                    command = true;
                }
            }
            ws.send(Message::Text(r#"42["stderr","diagnostic\n"]"#.into()))
                .unwrap();
            ws.send(Message::Text(r#"42["stdout","= Kata"]"#.into())).unwrap();
            ws.send(Message::Text(r#"42["stdout","Go\r\n\ninfo move D4\n"]"#.into()))
                .unwrap();
            ws.send(Message::Text(
                r#"451-["stdout",{"_placeholder":true,"num":0}]"#.into(),
            ))
            .unwrap();
            ws.send(Message::Binary(b"binary output\n".to_vec().into()))
                .unwrap();
            let msg = ws.read().unwrap().into_text().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(msg.strip_prefix("42").unwrap()).unwrap(),
                json!(["stdin", "quit\n"])
            );
            assert_eq!(ws.read().unwrap().into_text().unwrap(), "41");
            assert!(matches!(ws.read().unwrap(), Message::Close(_)));
            let _ = ws.flush();
        });
        (format!("ws://{address}"), worker)
    }
    #[test]
    fn websocket_gtp_roundtrip_heartbeat_and_shutdown() {
        let (url, worker) = mock(true);
        let mut session = ZhiziSession::start(
            endpoint(&url, "mock +&token", true).unwrap(),
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(session.next_event_timeout(Duration::from_millis(10)), None);
        session.send_command("name").unwrap();
        for expected in ["= KataGo", "", "info move D4", "binary output"] {
            assert_eq!(
                session.next_event_timeout(Duration::from_secs(2)),
                Some(ZhiziEvent::Line(expected.into()))
            );
        }
        session.shutdown().unwrap();
        assert!(
            session.worker.is_none(),
            "shutdown must join and remove the worker"
        );
        session.shutdown().unwrap();
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(2)),
            Some(ZhiziEvent::Eof)
        );
        assert!(session.send_command("name").is_err());
        worker.join().unwrap();
    }
    #[test]
    fn ready_timeout_on_connected_mock() {
        let (url, worker) = mock(false);
        let result = ZhiziSession::start(
            endpoint(&url, "mock +&token", true).unwrap(),
            Duration::from_millis(200),
        );
        assert!(matches!(result,Err(e) if e == "Cloud engine ready timeout"));
        worker.join().unwrap();
    }
    fn terminal_mock(mode: &'static str) -> (ZhiziSession, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut ws = tungstenite::accept(tcp).unwrap();
            ws.send(Message::Text(
                r#"0{"sid":"mock","upgrades":[],"pingInterval":50,"pingTimeout":50,"maxPayload":1000000}"#
                    .into(),
            ))
            .unwrap();
            assert_eq!(ws.read().unwrap().into_text().unwrap(), "40");
            ws.send(Message::Text(r#"40{"sid":"socket"}"#.into())).unwrap();
            ws.send(Message::Text(r#"42["ready"]"#.into())).unwrap();
            if mode == "close" {
                ws.close(None).unwrap();
                let _ = ws.read();
                return;
            }
            if mode == "overflow" {
                ws.send(Message::Text(
                    format!("42{}", json!(["stdout", "x\n".repeat(1100)])).into(),
                ))
                .unwrap();
            }
            let msg = ws.read().unwrap().into_text().unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(msg.strip_prefix("42").unwrap()).unwrap(),
                json!(["stdin", "quit\n"])
            );
            assert_eq!(ws.read().unwrap().into_text().unwrap(), "41");
            assert!(matches!(ws.read().unwrap(), Message::Close(_)));
            let _ = ws.flush();
        });
        let session = ZhiziSession::start(
            endpoint(&format!("ws://{address}"), "mock", true).unwrap(),
            Duration::from_secs(2),
        )
        .unwrap();
        (session, worker)
    }
    #[test]
    fn missing_server_ping_terminates_session() {
        let (mut session, worker) = terminal_mock("timeout");
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(2)),
            Some(ZhiziEvent::ReadError("Cloud heartbeat timeout".into()))
        );
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(2)),
            Some(ZhiziEvent::Eof)
        );
        session.shutdown().unwrap();
        worker.join().unwrap();
    }
    #[test]
    fn server_close_is_eof_without_reconnection() {
        let (mut session, worker) = terminal_mock("close");
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(2)),
            Some(ZhiziEvent::Eof)
        );
        session.shutdown().unwrap();
        worker.join().unwrap();
    }
    #[test]
    fn overflow_is_reported_after_bounded_output_queue() {
        let (mut session, worker) = terminal_mock("overflow");
        // Let the worker fill the queue without a consumer, then check the terminal
        // error survives even though there was no room to enqueue an error event.
        worker.join().unwrap();
        for _ in 0..1024 {
            assert_eq!(
                session.next_event_timeout(Duration::from_secs(1)),
                Some(ZhiziEvent::Line("x".into()))
            );
        }
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(1)),
            Some(ZhiziEvent::ReadError("Cloud output queue overflow".into()))
        );
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(1)),
            Some(ZhiziEvent::Eof)
        );
        session.shutdown().unwrap();
    }
    fn handshake_timeout_mock(send_open: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut ws = tungstenite::accept(tcp).unwrap();
            if send_open {
                ws.send(Message::Text(r#"0{"sid":"mock","upgrades":[],"pingInterval":1000,"pingTimeout":1000,"maxPayload":1000000}"#.into())).unwrap();
                assert_eq!(ws.read().unwrap().into_text().unwrap(), "40");
            }
            // Deliberately withhold the next handshake message from a real socket.
            assert!(matches!(ws.read().unwrap(), Message::Close(_)));
            let _ = ws.flush();
        });
        let result = ZhiziSession::start(
            endpoint(&format!("ws://{address}"), "private-test-token", true).unwrap(),
            Duration::from_millis(250),
        );
        let error = match result {
            Err(e) => e,
            Ok(_) => panic!("missing handshake must time out"),
        };
        worker.join().unwrap();
        assert!(!error.contains("private-test-token"));
        error
    }
    #[test]
    fn engine_open_timeout_reports_actual_stage() {
        assert_eq!(handshake_timeout_mock(false), "Cloud Engine.IO open timeout");
    }
    #[test]
    fn namespace_connect_timeout_reports_actual_stage() {
        assert_eq!(handshake_timeout_mock(true), "Cloud Socket.IO connect timeout");
    }
    #[test]
    fn custom_namespace_roundtrip_ignores_other_namespaces_and_binary_attachments() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut ws = tungstenite::accept(tcp).unwrap();
            ws.send(Message::Text(
                r#"0{"sid":"mock","upgrades":[],"pingInterval":1000,"pingTimeout":1000}"#.into(),
            ))
            .unwrap();
            assert_eq!(ws.read().unwrap().into_text().unwrap(), "40/worker,");
            // None of these unrelated namespace packets may connect, ready, fail,
            // disconnect, or feed output into the requested worker namespace.
            for msg in [
                r#"40/other,{"sid":"other"}"#,
                r#"42/other,["ready"]"#,
                r#"44/other,{"message":"ignored"}"#,
                "41/other,",
                r#"42["stdout","wrong default\n"]"#,
                r#"452-/other,["stdout",{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}]"#,
            ] {
                ws.send(Message::Text(msg.into())).unwrap();
            }
            ws.send(Message::Binary(b"ignored1".to_vec().into())).unwrap();
            ws.send(Message::Binary(b"ignored2".to_vec().into())).unwrap();
            ws.send(Message::Text(r#"40/worker,{"sid":"correct"}"#.into()))
                .unwrap();
            ws.send(Message::Text(r#"42/worker,["ready"]"#.into())).unwrap();
            ws.send(Message::Text("2".into())).unwrap();
            let mut command = false;
            let mut pong = false;
            while !command || !pong {
                let text = ws.read().unwrap().into_text().unwrap();
                if text == "3" {
                    pong = true;
                } else {
                    assert_eq!(text, r#"42/worker,["stdin","name\n"]"#);
                    command = true;
                }
            }
            ws.send(Message::Text(r#"42/worker,["stdout","= Kata"]"#.into()))
                .unwrap();
            ws.send(Message::Text(r#"42/worker,["stdout","Go\n\n"]"#.into()))
                .unwrap();
            ws.send(Message::Text(
                r#"451-/other,["stdout",{"_placeholder":true,"num":0}]"#.into(),
            ))
            .unwrap();
            ws.send(Message::Binary(b"ignored3".to_vec().into())).unwrap();
            ws.send(Message::Text(
                r#"451-/worker,["stdout",{"_placeholder":true,"num":0}]"#.into(),
            ))
            .unwrap();
            ws.send(Message::Binary(b"binary target\n".to_vec().into()))
                .unwrap();
            assert_eq!(
                ws.read().unwrap().into_text().unwrap(),
                r#"42/worker,["stdin","quit\n"]"#
            );
            assert_eq!(ws.read().unwrap().into_text().unwrap(), "41/worker,");
            assert!(matches!(ws.read().unwrap(), Message::Close(_)));
            let _ = ws.flush();
        });
        let mut session = ZhiziSession::start(
            endpoint(&format!("ws://{address}/%77orker"), "mock", true).unwrap(),
            Duration::from_secs(2),
        )
        .unwrap();
        session.send_command("name").unwrap();
        for line in ["= KataGo", "", "binary target"] {
            assert_eq!(
                session.next_event_timeout(Duration::from_secs(2)),
                Some(ZhiziEvent::Line(line.into()))
            );
        }
        session.shutdown().unwrap();
        assert_eq!(
            session.next_event_timeout(Duration::from_secs(1)),
            Some(ZhiziEvent::Eof)
        );
        worker.join().unwrap();
    }
    #[test]
    fn uri_namespace_is_decoded_and_transport_path_is_independent() {
        let endpoint = endpoint("https://worker.zhizigo.com/%77orker", "private-test-token", false).unwrap();
        assert_eq!(endpoint.namespace, "/worker");
        assert_eq!(endpoint.url.path(), "/socket.io.v4/");
        assert!(super::endpoint("https://worker.zhizigo.com/a%2Cb", "token", false).is_err());
    }
    #[test]
    fn refuses_untrusted_endpoints_without_network() {
        for url in [
            "http://zhizigo.com",
            "wss://zhizigo.com:8443",
            "wss://zhizigo.com.evil.test",
            "wss://evilzhizigo.com",
            "wss://user:password@zhizigo.com",
            "wss://zhizigo.com?secret=value",
            "ws://127.0.0.1:12",
        ] {
            assert!(ZhiziSession::connect(url, "secret").is_err());
        }
        assert!(endpoint("https://worker.zhizigo.com", "secret", false).is_ok());
    }
}
