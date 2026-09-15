use super::{zhizi, AnalysisJobKind, AnalysisJobRegistry};
#[path = "live_controls.rs"]
mod controls;
#[path = "remote_engine.rs"]
mod remote;
#[path = "gtp_console.rs"]
mod console;
pub(super) use remote::RemoteEngineConfig;
use crate::live_transport::{GtpCommands, LiveTransport};
use controls::{acknowledged_command, pause_on_limit, send_control};
use app_model::{AnalysisFrameDto, EngineBackend, EngineProfileDto};
pub(super) use controls::{LiveEngineParameters, LiveSearchOptions};
use engine_manager::{build_command_spec, AnalysisCancelToken};
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

/// Default `kata-analyze` interval in centiseconds, matching the Java mainline default (10 cs = 100 ms).
pub(super) const DEFAULT_LIVE_REVIEW_INTERVAL_CENTISEC: u32 = 10;
/// Fallback board size for a `set_position` call that does not restate it.
pub(super) const DEFAULT_LIVE_REVIEW_BOARD_SIZE: u8 = 19;

/// How long the owner thread blocks waiting for one engine event before looping to pick up commands.
pub(super) const LIVE_REVIEW_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// A command for the live-review owner thread.
///
/// Everything needed to reproduce one SGF position on the engine, faithfully.
///
/// The flat `moves` list the first revision carried could only express a run of alternating
/// moves, which loses three things the SGF actually carries:
///
/// * **setup stones** (`AB`/`AW`) - life-and-death problems and handicap games have no move
///   history at all, so replaying "moves" cannot produce them;
/// * **rules** (`RU`) - scoring and ko differ by ruleset, so the engine's evaluation must be told;
/// * **the analysed branch** - a position reached through a variation is a different move sequence
///   from the mainline, and mixing them analyses the wrong board.
///
/// `setup` and `moves` are both flattened `[COLOR, VERTEX, ...]` pairs in GTP coordinates.
#[derive(Debug, Clone, Default)]
pub(super) struct LiveReviewPositionRequest {
    pub(super) board_size: u8,
    /// `AB`/`AW` stones, sent with `set_position`. Empty means "no setup" (a normal game).
    pub(super) setup: Vec<String>,
    /// The branch's moves **after** the setup, sent with `play`.
    pub(super) moves: Vec<String>,
    /// KataGo rules name (e.g. `japanese`), sent with `kata-set-rules`.
    pub(super) rules: Option<String>,
    /// SGF `HA` value. A handicap game of 2+ stones must be installed with the standard GTP
    /// `set_free_handicap`, not `set_position`: only the former tells the engine the stones are a
    /// handicap, which is what `whiteHandicapBonus` (and therefore Chinese-rules scoring) depends
    /// on. See GTP_Extensions.md on `set_position` ("It is NOT recommended to use this command to
    /// place the starting stones for handicap games").
    pub(super) handicap: Option<u32>,
    pub(super) komi: Option<f32>,
    /// Side to move, used only to make the engine's turn match the SGF's `PL`.
    pub(super) player: Option<String>,
}

/// The [`engine_manager::GtpSession`] is owned by that thread — not by the Tauri state — because
/// `send_command` needs `&mut` while the forwarding loop needs `&` on the same session. A channel
/// keeps ownership in one place without wrapping the session in `Arc<Mutex<..>>`, which would
/// change lock semantics and could deadlock the stream.
///
/// Pause retains the exclusive session for a review scheduler; Shutdown releases it.
pub(super) enum LiveReviewCommand {
    /// Send a fresh position and (re)start `kata-analyze` for it.
    SetPosition {
        generation: u64,
        target_turn: u32,
        request: LiveReviewPositionRequest,
        interval_centisec: u32,
        options: LiveSearchOptions,
    },
    Pause {
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    Configure {
        parameters: LiveEngineParameters,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
    Console { generation: u64, command: String, reply: std::sync::mpsc::Sender<Result<String, String>> },
    /// Tear the session down (engine process included).
    Shutdown,
}

/// Shared, authoritative view of "which request is current", written by the command handlers
/// and read by the owner thread immediately before emitting a frame.
///
/// It is deliberately *not* owned by the owner thread: the handler must invalidate in-flight
/// lines the instant a new request is issued, even if the owner thread has not yet dequeued the
/// corresponding command. That synchronous hand-off is what closes the staleness race.
#[derive(Default)]
pub(super) struct LiveReviewGuardState {
    pub(super) generation: u64,
    pub(super) target_turn: Option<u32>,
    pub(super) player: Option<app_model::PlayerColor>,
    /// True only once the owner thread has seen the `=` acknowledgement for this generation's own
    /// `kata-analyze`. See [`accepts_live_info_line`] for why the generation alone is not enough.
    pub(super) stream_ready: bool,
}

pub(super) type SharedLiveReviewGuard = std::sync::Arc<Mutex<LiveReviewGuardState>>;

/// Tauri-side handle to the live-review session.
///
/// This holds the *command sender* and the bookkeeping the handlers need; the
/// [`engine_manager::GtpSession`] itself lives on the owner thread (see [`LiveReviewCommand`]).
pub(super) struct LiveReviewSession {
    pub(super) commands: Option<std::sync::mpsc::Sender<LiveReviewCommand>>,
    pub(super) forwarder: Option<std::thread::JoinHandle<()>>,
    pub(super) job_id: Option<String>,
    pub(super) cloud: bool,
    pub(super) server_config: bool,
    /// Monotonic generation. Bumped on every new analysis request (start/set_position/stop);
    /// any `info` line tagged with an older generation is stale and must be dropped.
    pub(super) generation: u64,
    /// The move currently being analysed. `None` means "nothing should be rendered".
    pub(super) target_turn: Option<u32>,
    pub(super) board_size: u8,
    /// Session-wide `kata-analyze` interval default, set at start and used by `set_position`
    /// when that call passes `0`.
    pub(super) interval_centisec: u32,
    /// Handlers publish here *synchronously* when they accept a new request, so in-flight lines
    /// are invalidated before the owner thread even dequeues the matching command.
    pub(super) guard: SharedLiveReviewGuard,
}

impl Default for LiveReviewSession {
    fn default() -> Self {
        Self {
            commands: None,
            forwarder: None,
            job_id: None,
            cloud: false,
            server_config: false,
            generation: 0,
            target_turn: None,
            board_size: 19,
            interval_centisec: DEFAULT_LIVE_REVIEW_INTERVAL_CENTISEC,
            guard: SharedLiveReviewGuard::default(),
        }
    }
}

impl LiveReviewSession {
    /// Detach the live session, leaving the state empty and stopping the analysis.
    ///
    /// `commands`/`forwarder`/`job_id` are handed to the caller, which owns the tear-down order:
    /// detach under the lock, then signal, join and release the registry entry with the lock free.
    /// `board_size` and `interval_centisec` stay on the state on purpose — they are the last known
    /// session settings, and the `set_position` fallback reads them for a request that does not
    /// restate the board size.
    pub(super) fn take_session(&mut self) -> Option<LiveReviewSession> {
        if !self.has_session() {
            return None;
        }
        // The engine-facing handles move to the returned value; the caller owns the tear-down order.
        // The last known `board_size`/`interval_centisec` are handed over too, because the superseded
        // session's teardown may still be observed by a `set_position` that reads them.
        let taken = LiveReviewSession {
            commands: self.commands.take(),
            forwarder: self.forwarder.take(),
            job_id: self.job_id.take(),
            cloud: self.cloud,
            server_config: self.server_config,
            generation: self.generation,
            target_turn: self.target_turn,
            board_size: self.board_size,
            interval_centisec: self.interval_centisec,
            guard: std::sync::Arc::clone(&self.guard),
        };
        // The state keeps its settings but drops every handle, so it no longer owns a session: a
        // `set_position` arriving now fails with "not running" instead of racing a dying owner.
        self.job_id = None;
        self.target_turn = None;
        Some(taken)
    }

    /// True while a live engine session is owned by this state.
    pub(super) fn has_session(&self) -> bool {
        self.commands.is_some() || self.forwarder.is_some() || self.job_id.is_some()
    }

    /// Publish a new authoritative request: bump the generation and record what is being analysed.
    ///
    /// This is the synchronous half of the staleness guard. `player` is stored for the payload's
    /// `to_play` metadata and the cloud engine's side-to-play output perspective.
    pub(super) fn publish_request(
        &mut self,
        target_turn: Option<u32>,
        player: Option<app_model::PlayerColor>,
    ) -> u64 {
        let generation = next_live_review_generation(self.generation);
        self.generation = generation;
        self.target_turn = target_turn;
        if let Ok(mut guard) = self.guard.lock() {
            guard.generation = generation;
            guard.target_turn = target_turn;
            guard.player = player;
            // Close the stream for the new generation until its own `kata-analyze` has been
            // acknowledged, so pipelined output from the previous request cannot be tagged with
            // this generation.
            guard.stream_ready = false;
        }
        generation
    }
}

/// The staleness guard — the single-layer equivalent of the Java mainline's six guards.
///
/// A live `info` line is accepted only when its generation is still the current one *and* it
/// belongs to the turn still being analysed. Anything else is output from a superseded request
/// and must be discarded, otherwise a frame from move A would be rendered on the board showing
/// move B (correct board, wrong candidate dots and heatmap).
///
/// `line_generation` / `line_target_turn` are snapshotted when the engine line is read;
/// `current_generation` / `current_target_turn` are re-read at emission time, so a request that
/// arrived in between invalidates the line.
///
/// `stream_ready` is the GTP response-boundary gate, and it is what makes the guard falsifiable
/// rather than merely plausible. Clearing the command queue once is *not* enough: the engine's
/// stdout is a pipe with batch buffering (measured: eight handshake replies arrive with identical
/// timestamps), so `info` lines produced for request A can still sit unread and be picked up
/// *after* the owner thread has already handled request B. Those lines would then be labelled with
/// B's generation and target turn and pass every other check in this predicate — the frame is
/// stale but its tag is not.
///
/// `stream_ready` is cleared by the handler the moment a new request is published (same lock as
/// the generation) and set again only when the owner thread observes the `=` acknowledgement of
/// that request's own `kata-analyze`, which is sent with a unique GTP command id. Lines that were
/// still in flight from the previous request therefore cannot be accepted, because no boundary for
/// the new request has been seen yet.
pub(super) fn accepts_live_info_line(
    current_generation: u64,
    line_generation: u64,
    current_target_turn: Option<u32>,
    line_target_turn: Option<u32>,
    stream_ready: bool,
) -> bool {
    stream_ready
        && line_generation == current_generation
        && current_target_turn.is_some()
        && line_target_turn == current_target_turn
}

/// Bump the live-review generation monotonically (saturating so it can never wrap to 0).
pub(super) fn next_live_review_generation(current: u64) -> u64 {
    current.saturating_add(1)
}

/// Normalize the requested interval: `0` means "use the default" (10 cs, the Java default).
pub(super) fn normalize_live_review_interval(interval_centisec: u32) -> u32 {
    if interval_centisec == 0 {
        DEFAULT_LIVE_REVIEW_INTERVAL_CENTISEC
    } else {
        interval_centisec
    }
}

/// Build the `kata-analyze` command for `player` at `interval_centisec`, **without** a command id.
///
/// The id is added by the single `send` helper in [`apply_live_review_position`]; prefixing here as
/// well would emit `4 4 kata-analyze ...` and the engine would reject the whole command.
///
/// `ownership true` is mandatory: the engine does not emit ownership by default, so without it the
/// heatmap is permanently empty. `rootInfo true` is equally mandatory: without it the engine emits
/// no `rootInfo` section and the frame silently degrades to the best move's statistics, which
/// fluctuate and disagree with the batch path.
pub(super) fn live_review_kata_analyze_command(player: Option<&str>, interval_centisec: u32) -> String {
    match player {
        Some(player) => {
            format!("kata-analyze {player} {interval_centisec} ownership true rootInfo true")
        }
        None => format!("kata-analyze {interval_centisec} ownership true rootInfo true"),
    }
}

/// Parse a GTP colour token into the DTO's colour. Unknown/absent input yields `None`.
pub(super) fn live_review_player_color(player: Option<&str>) -> Option<app_model::PlayerColor> {
    match player.map(str::trim) {
        Some(token) if token.eq_ignore_ascii_case("b") || token.eq_ignore_ascii_case("black") => {
            Some(app_model::PlayerColor::Black)
        }
        Some(token) if token.eq_ignore_ascii_case("w") || token.eq_ignore_ascii_case("white") => {
            Some(app_model::PlayerColor::White)
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct LiveReviewFramePayload {
    pub(super) job_id: String,
    pub(super) generation: u64,
    pub(super) turn: u32,
    /// Side to move in this frame's position. **Metadata only** — the values inside
    /// [`frame`](Self::frame) are already black-perspective, so the frontend must not convert
    /// again from this field.
    pub(super) to_play: app_model::PlayerColor,
    /// **Already converted to black perspective** by `kata_analyze_line_to_frame`
    /// (plan 005 Step 3b), matching the batch path (`katago_analyze_game`). The frontend renders
    /// `winrate_black`/`score_mean_black` directly and must not flip them again.
    pub(super) frame: AnalysisFrameDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct LiveReviewEndedPayload {
    pub(super) job_id: String,
    pub(super) generation: u64,
    pub(super) reason: String,
}

pub(super) fn guard_snapshot(
    guard: &Mutex<LiveReviewGuardState>,
) -> (u64, Option<u32>, Option<app_model::PlayerColor>, bool) {
    match guard.lock() {
        Ok(state) => (
            state.generation,
            state.target_turn,
            state.player,
            state.stream_ready,
        ),
        Err(_) => (0, None, None, false),
    }
}

/// Open the stream for `generation` once its `kata-analyze` has been acknowledged.
///
/// An acknowledgement without a matching id is ignored: it may belong to an older request, and
/// accepting it would re-open the stream before this generation's own boundary has been seen.
pub(super) fn publish_stream_ready(guard: &Mutex<LiveReviewGuardState>, generation: u64) {
    if let Ok(mut state) = guard.lock() {
        if state.generation == generation {
            state.stream_ready = true;
        }
    }
}

/// A GTP acknowledgement line (`=3 ok`, `?3 illegal move`), classified by status.
///
/// KataGo echoes the command id introduced by GTP, which is what makes a request's response
/// boundary observable instead of inferred. The status is kept separate from the id because an
/// error must **not** open the stream: `?id` answers a command that failed, so treating it as the
/// boundary would let a position whose `play`/`boardsize` was rejected still emit normal frames
/// for the wrong board.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct GtpAck {
    pub(super) id: Option<u64>,
    pub(super) is_error: bool,
}

pub(super) fn parse_gtp_ack(line: &str) -> Option<GtpAck> {
    let (rest, is_error) = if let Some(rest) = line.strip_prefix('=') {
        (rest, false)
    } else {
        (line.strip_prefix('?')?, true)
    };
    let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    Some(GtpAck {
        id: digits.parse().ok(),
        is_error,
    })
}

/// The GTP command ids a single live-review request occupies.
///
/// Every preparation command (`boardsize`, `komi`, `clear_board`, `play`) shares this range with
/// the final `kata-analyze`, so an error on *any* of them is attributable to this request. Checking
/// only [`analyze`] would silently ignore `?id` for the earlier, lower ids - the failure that
/// matters most, because a rejected `play` leaves the engine analysing a different board.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LiveReviewCommandIds {
    pub(super) first: u64,
    /// The id of this request's `kata-analyze`; its acknowledgement is the response boundary.
    pub(super) analyze: u64,
}

impl LiveReviewCommandIds {
    pub(super) fn contains(self, id: u64) -> bool {
        id >= self.first && id <= self.analyze
    }

    /// True when `id` is the boundary acknowledgement that opens the stream.
    pub(super) fn is_boundary(self, id: u64) -> bool {
        id == self.analyze
    }
}

/// Apply a position to the session and (re)start `kata-analyze` on it.
///
/// Order matters: [`clear_board`] first, then every move, then `kata-analyze`. `komi` is only
/// sent when the caller supplies one, so an absent value falls back to the engine default
/// instead of silently overwriting it with a wrong number.
///
/// Every command carries a GTP command id, and the ids are strictly increasing within the session.
/// That gives the owner thread an observable response boundary: the acknowledgement for
/// `generation` proves that every earlier command has completed, so an `info` line seen after it
/// cannot be pipelined output from a superseded request. The final id is returned so the caller
/// knows which acknowledgement to wait for.
pub(super) fn apply_live_review_position(
    session: &mut impl GtpCommands,
    request: &LiveReviewPositionRequest,
    interval_centisec: u32,
    next_command_id: &mut u64,
) -> Result<LiveReviewCommandIds, String> {
    apply_live_review_position_with_options(
        session,
        request,
        interval_centisec,
        next_command_id,
        &LiveSearchOptions::default(),
    )
}

fn apply_live_review_position_with_options(
    session: &mut impl GtpCommands,
    request: &LiveReviewPositionRequest,
    interval_centisec: u32,
    next_command_id: &mut u64,
    options: &LiveSearchOptions,
) -> Result<LiveReviewCommandIds, String> {
    options.validate(request.board_size, request.player.as_deref())?;
    /// Send one id-prefixed command, consuming the next command id.
    pub(super) fn send(
        session: &mut impl GtpCommands,
        next_command_id: &mut u64,
        command: String,
    ) -> Result<(), String> {
        let id = *next_command_id;
        *next_command_id = next_command_id.saturating_add(1);
        session
            .send_command(&format!("{id} {command}"))
            .map_err(|err| err.to_string())
    }

    let first_id = *next_command_id;
    send(
        session,
        next_command_id,
        format!("boardsize {}", request.board_size),
    )?;
    if let Some(komi) = request.komi {
        send(session, next_command_id, format!("komi {komi}"))?;
    }
    if let Some(rules) = request.rules.as_deref() {
        // Rules affect scoring and ko, so they must be set before the position is analysed.
        send(session, next_command_id, format!("kata-set-rules {rules}"))?;
    }

    // Handicap games (HA >= 2) must use the standard GTP handicap command so the engine knows the
    // stones are handicap stones; `set_position` would look like a normal position to the rules
    // code and break the `whiteHandicapBonus`. Below HA=2 there is no bonus, so `set_position`
    // (or `clear_board`) is correct and avoids inventing a handicap that the SGF did not declare.
    let handicap_stones = live_review_handicap_stones(request)?;

    if !handicap_stones.is_empty() {
        // KataGo keeps the board when boardsize is unchanged. Handicap placement requires an
        // empty board, including when revisiting another node of the same handicap game.
        send(session, next_command_id, "clear_board".to_string())?;
        send(
            session,
            next_command_id,
            format!("set_free_handicap {}", handicap_stones.join(" ")),
        )?;
    } else if request.setup.is_empty() {
        // A normal game: clear the board, then replay the branch's moves so ko/superko history is
        // real. `clear_board` is equivalent to `set_position` with no arguments.
        send(session, next_command_id, "clear_board".to_string())?;
    } else {
        // A setup position (`AB`/`AW`): `set_position` installs exactly those stones and is
        // documented as *having no move history*, which is what a layout problem means. It also
        // avoids the neural net being biased by an invented move order, which playing the stones as
        // alternating moves would cause.
        let pairs = setup_pairs_to_set_position(&request.setup)?;
        send(session, next_command_id, format!("set_position {pairs}"))?;
    }

    // Moves that follow the setup (some SGFs combine `AB`/`AW` with real moves).
    for pair in request.moves.chunks(2) {
        let (color, vertex) = live_review_move_pair(pair, &request.moves)?;
        send(session, next_command_id, format!("play {color} {vertex}"))?;
    }

    let analyze_id = *next_command_id;
    send(
        session,
        next_command_id,
        format!(
            "{}{}",
            live_review_kata_analyze_command(request.player.as_deref(), interval_centisec),
            options.suffix(request.player.as_deref())
        ),
    )?;
    Ok(LiveReviewCommandIds {
        first: first_id,
        analyze: analyze_id,
    })
}

/// Split one `[COLOR, VERTEX]` pair, rejecting a malformed list instead of sending a bad command.
pub(super) fn live_review_move_pair<'a>(
    pair: &'a [String],
    all: &[String],
) -> Result<(&'a str, &'a str), String> {
    let color = pair
        .first()
        .ok_or_else(|| format!("live review move list is not colour/vertex pairs: {all:?}"))?;
    let vertex = pair
        .get(1)
        .ok_or_else(|| format!("live review move list is not colour/vertex pairs: {all:?}"))?;
    Ok((color.as_str(), vertex.as_str()))
}

/// Validate and extract handicap stones, refusing anything that would silently change the position.
///
/// `set_free_handicap` only accepts Black stones, so a setup that is not uniformly Black cannot be
/// forwarded as-is. Silently dropping the White stones (or an odd trailing pair) would make the
/// engine analyse a *different* board than the SGF describes while still emitting normal frames,
/// which is the worst failure mode here: it looks like it works. So this returns an error instead,
/// and the caller surfaces it through the `live-review-ended` event.
pub(super) fn live_review_handicap_stones(
    request: &LiveReviewPositionRequest,
) -> Result<Vec<String>, String> {
    if request.handicap.unwrap_or(0) < 2 {
        return Ok(Vec::new());
    }
    if request.setup.len() % 2 != 0 {
        return Err(format!(
            "handicap position has an incomplete colour/vertex pair: {:?}",
            request.setup
        ));
    }
    let mut stones = Vec::with_capacity(request.setup.len() / 2);
    for pair in request.setup.chunks(2) {
        let color = pair.first().map(String::as_str).unwrap_or_default();
        let vertex = pair.get(1).map(String::as_str).unwrap_or_default();
        if !color.eq_ignore_ascii_case("b") && !color.eq_ignore_ascii_case("black") {
            return Err(format!(
                "handicap stones must all be Black, found {color:?} in {:?}",
                request.setup
            ));
        }
        if vertex.trim().is_empty() {
            return Err(format!(
                "handicap stones contain an empty vertex: {:?}",
                request.setup
            ));
        }
        stones.push(vertex.to_string());
    }
    let declared = request.handicap.unwrap_or(0) as usize;
    if stones.len() != declared {
        return Err(format!(
            "handicap says {declared} stones but the setup has {}: {:?}",
            stones.len(),
            request.setup
        ));
    }
    Ok(stones)
}

/// Render setup stones as the argument list of the GTP `set_position` command.
///
/// Rejects an odd-length list and empty vertices, so a malformed request fails loudly here rather
/// than reaching the engine as a command that silently places nothing.
pub(super) fn setup_pairs_to_set_position(setup: &[String]) -> Result<String, String> {
    if setup.len() % 2 != 0 {
        return Err(format!(
            "live review setup stones are not colour/vertex pairs: {setup:?}"
        ));
    }
    let mut rendered = Vec::with_capacity(setup.len());
    for value in setup {
        if value.trim().is_empty() {
            return Err(format!(
                "live review setup stones contain an empty value: {setup:?}"
            ));
        }
        rendered.push(value.as_str());
    }
    Ok(rendered.join(" "))
}

pub(super) fn emit_live_review_ended(app_handle: &AppHandle, job_id: &str, generation: u64, reason: &str) {
    let _ = app_handle.emit(
        "katago://live-review-ended",
        LiveReviewEndedPayload {
            job_id: job_id.to_string(),
            generation,
            reason: reason.to_string(),
        },
    );
}

/// Own the engine session for the lifetime of a live-review job: apply commands, drain the
/// `info` stream, and forward only frames that pass the staleness guard.
///
/// The session is owned here (not shared behind a mutex) so `send_command`'s `&mut` and the
/// event loop's `&` never contend. Commands arrive over a channel, so the Tauri handlers only
/// need a `Sender` and never touch the engine directly.
#[tauri::command]
pub(super) async fn katago_console_query(app_handle: AppHandle, command: String) -> Result<String, String> {
    let command = console::validate(&command)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<Mutex<LiveReviewSession>>();
        let (reply, receiver) = std::sync::mpsc::channel();
        {
            let mut live = state.lock().map_err(|_| "实时会话不可用")?;
            let sender = live.commands.clone().ok_or("请先连接引擎")?;
            let generation=live.publish_request(None, None);
            sender.send(LiveReviewCommand::Console { generation, command, reply }).map_err(|_| "实时会话已结束")?;
        }
        receiver.recv_timeout(Duration::from_secs(12)).map_err(|_| "控制台查询未确认")?
    }).await.map_err(|_| "控制台任务失败".to_owned())?
}

#[tauri::command]
pub(super) async fn katago_live_review_pause(app_handle: AppHandle) -> Result<u64, String> {
    send_control(app_handle, None).await
}
#[tauri::command]
pub(super) async fn katago_live_review_configure(
    app_handle: AppHandle,
    parameters: LiveEngineParameters,
) -> Result<u64, String> {
    send_control(app_handle, Some(parameters)).await
}
pub(super) fn run_live_review_owner(
    app_handle: AppHandle,
    job_id: String,
    mut session: LiveTransport,
    commands: std::sync::mpsc::Receiver<LiveReviewCommand>,
    guard: SharedLiveReviewGuard,
    cancel_token: AnalysisCancelToken,
    board_size: u8,
) {
    let mut line_generation = guard_snapshot(&guard).0;
    let mut line_target_turn: Option<u32> = None;
    let mut board_size = board_size;
    // The command id whose acknowledgement opens the stream for `line_generation`. `None` while no
    // request is outstanding (before the first `set_position`, and after `stop`).
    let mut pending_ids: Option<LiveReviewCommandIds> = None;
    // Session-wide monotonic GTP command id; ids are unique so an acknowledgement can never be
    // confused with an older request's boundary.
    let mut next_command_id: u64 = 1;
    let mut active_options = LiveSearchOptions::default();
    let mut started_at: Option<std::time::Instant> = None;

    loop {
        // 1) Apply every pending command. Each one re-tags the lines this thread produces, so
        //    output from a superseded position can never be attributed to the new one.
        loop {
            match commands.try_recv() {
                Ok(LiveReviewCommand::SetPosition {
                    generation,
                    target_turn,
                    request,
                    interval_centisec,
                    options,
                }) => {
                    started_at = None;
                    active_options = options;
                    board_size = request.board_size;
                    line_generation = generation;
                    line_target_turn = Some(target_turn);
                    if let Err(message) = apply_live_review_position_with_options(
                        &mut session,
                        &request,
                        interval_centisec,
                        &mut next_command_id,
                        &active_options,
                    )
                    .map(|ids| pending_ids = Some(ids))
                    {
                        emit_live_review_ended(&app_handle, &job_id, generation, &message);
                        let _ = session.close();
                        return;
                    }
                }
                Ok(LiveReviewCommand::Pause { reply }) => {
                    pending_ids = None;
                    started_at = None;
                    line_target_turn = None;
                    let result = acknowledged_command(&mut session, &mut next_command_id, "stop");
                    let failed = result.is_err();
                    let _ = reply.send(result);
                    if failed {
                        let _ = session.close();
                        emit_live_review_ended(
                            &app_handle,
                            &job_id,
                            guard_snapshot(&guard).0,
                            "暂停未确认，连接已关闭",
                        );
                        return;
                    }
                }
                Ok(LiveReviewCommand::Configure { parameters, reply }) => {
                    pending_ids = None;
                    started_at = None;
                    line_target_turn = None;
                    if let Err(error) = acknowledged_command(&mut session, &mut next_command_id, "stop") {
                        let _ = reply.send(Err(error));
                        let _ = session.close();
                        emit_live_review_ended(
                            &app_handle,
                            &job_id,
                            guard_snapshot(&guard).0,
                            "暂停未确认，连接已关闭",
                        );
                        return;
                    }
                    let result = parameters.commands(session.is_cloud()).and_then(|commands| {
                        for command in commands {
                            acknowledged_command(&mut session, &mut next_command_id, &command)?;
                        }
                        Ok(())
                    });
                    let _ = reply.send(result);
                }
                Ok(LiveReviewCommand::Console { generation, command, reply }) => {
                    pending_ids = None;
                    started_at = None;
                    line_target_turn = None;
                    if let Err(error) = acknowledged_command(&mut session, &mut next_command_id, "stop") {
                        let _ = reply.send(Err(error));
                        let _ = session.close();
                        emit_live_review_ended(&app_handle, &job_id, guard_snapshot(&guard).0, "控制台暂停未确认，连接已关闭");
                        return;
                    }
                    controls::emit_paused(&app_handle, &job_id, generation, "console");
                    let _ = reply.send(console::query(&mut session, &mut next_command_id, &command));
                }
                Ok(LiveReviewCommand::Shutdown) => {
                    let _ = session.close();
                    return;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    let _ = session.close();
                    return;
                }
            }
        }

        if started_at.is_some_and(|start| active_options.reached(0, start.elapsed().as_secs_f64())) {
            if !pause_on_limit(&app_handle, &job_id, line_generation, &guard, &mut session, &mut next_command_id) { return; }
            started_at = None;
            line_target_turn = None;
        }

        if cancel_token.is_cancelled() {
            let _ = session.send_bare_newline();
            emit_live_review_ended(&app_handle, &job_id, line_generation, "cancelled");
            let _ = session.close();
            return;
        }

        // 2) Forward at most one event, then loop back so commands stay responsive.
        match session.next_event_timeout(LIVE_REVIEW_POLL_INTERVAL) {
            Some(engine_manager::GtpSessionEvent::Line(line)) => {
                // 2a) A GTP acknowledgement carrying this request's command id is its response
                //     boundary: everything the engine had queued from earlier requests has already
                //     been drained, so from here on the stream belongs to `line_generation`.
                if let Some(ack) = parse_gtp_ack(&line) {
                    let ack_id = ack.id;
                    let in_range = match (pending_ids, ack_id) {
                        (Some(ids), Some(id)) => ids.contains(id),
                        _ => false,
                    };
                    if in_range && ack.is_error {
                        // Any command in this request failed: `boardsize`/`komi`/`clear_board`/`play`
                        // (all with lower ids than the `kata-analyze`) or the analysis command
                        // itself. The stream must stay closed, because the position that would be
                        // analysed is not the one requested - a frame emitted now would be silently
                        // wrong rather than obviously broken. Report the engine's own words.
                        let reason = if session.is_cloud() {
                            "智子云拒绝棋局或分析命令".to_owned()
                        } else {
                            format!("engine rejected {}", line.trim())
                        };
                        let _ = session.close();
                        emit_live_review_ended(&app_handle, &job_id, line_generation, &reason);
                        return;
                    }
                    let open = match (pending_ids, ack_id) {
                        (Some(ids), Some(id)) => !ack.is_error && ids.is_boundary(id),
                        _ => false,
                    };
                    if open {
                        pending_ids = None;
                        publish_stream_ready(&guard, line_generation);
                        started_at = Some(std::time::Instant::now());
                    }
                    continue;
                }
                let Some(parsed) = katago_protocol::parse_kata_analyze_line(&line, board_size) else {
                    continue;
                };
                let (current_generation, current_target_turn, current_player, current_stream_ready) =
                    guard_snapshot(&guard);
                if !accepts_live_info_line(
                    current_generation,
                    line_generation,
                    current_target_turn,
                    line_target_turn,
                    current_stream_ready,
                ) {
                    // Stale output from a superseded request: drop it without emitting.
                    continue;
                }
                let turn = line_target_turn.unwrap_or(0);
                // Local launch pins BLACK. Zhizi follows Java's side-to-play contract;
                // current_player is generation-bound, never sampled from the mutable UI.
                let frame = katago_protocol::kata_analyze_line_to_frame(
                    Uuid::nil(),
                    &parsed,
                    turn,
                    session.perspective(current_player),
                );
                let visits = frame.visits;
                let _ = app_handle.emit(
                    "katago://live-review-frame",
                    LiveReviewFramePayload {
                        job_id: job_id.clone(),
                        generation: current_generation,
                        turn,
                        to_play: current_player.unwrap_or(app_model::PlayerColor::Black),
                        frame,
                    },
                );
                if started_at
                    .is_some_and(|start| active_options.reached(visits, start.elapsed().as_secs_f64()))
                {
                    if !pause_on_limit(
                        &app_handle,
                        &job_id,
                        line_generation,
                        &guard,
                        &mut session,
                        &mut next_command_id,
                    ) {
                        return;
                    }
                    started_at = None;
                    line_target_turn = None;
                }
            }
            Some(engine_manager::GtpSessionEvent::Eof { .. }) => {
                emit_live_review_ended(&app_handle, &job_id, line_generation, "engine exited");
                let _ = session.close();
                return;
            }
            Some(engine_manager::GtpSessionEvent::ReadError(message)) => {
                emit_live_review_ended(&app_handle, &job_id, line_generation, &message);
                let _ = session.close();
                return;
            }
            None => {}
        }
    }
}

#[tauri::command]
pub(super) fn katago_start_live_review(
    app_handle: AppHandle,
    state: State<'_, Mutex<LiveReviewSession>>,
    registry: State<'_, AnalysisJobRegistry>,
    profile: EngineProfileDto,
    board_size: u8,
    turn: u32,
    interval_centisec: u32,
) -> Result<String, String> {
    start_live_review_session(
        &app_handle,
        &state,
        &registry,
        profile,
        board_size,
        turn,
        interval_centisec,
    )
}

#[tauri::command]
pub(super) async fn ssh_start_live_review(app_handle: AppHandle, config: RemoteEngineConfig, board_size: u8, turn: u32, interval_centisec: u32) -> Result<String, String> {
    let spec = remote::ssh_spec(&config)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<Mutex<LiveReviewSession>>();
        let registry = app_handle.state::<AnalysisJobRegistry>();
        start_live_transport(&app_handle, &state, &registry, board_size, turn, interval_centisec, false,
            move || engine_manager::GtpSession::start(&spec).map(LiveTransport::Remote).map_err(|_| "SSH 引擎启动失败；请确认系统 SSH 密钥、known_hosts 和远程路径".into()))
    }).await.map_err(|_| "SSH 连接任务失败".to_owned())?
}

pub(super) fn start_live_review_session(
    app_handle: &AppHandle,
    state: &Mutex<LiveReviewSession>,
    registry: &AnalysisJobRegistry,
    profile: EngineProfileDto,
    board_size: u8,
    turn: u32,
    interval_centisec: u32,
) -> Result<String, String> {
    if profile.backend != EngineBackend::KataGoGtp {
        return Err("live review requires the KataGo GTP backend".into());
    }
    let spec = build_command_spec(&profile).map_err(|err| err.to_string())?;
    start_live_transport(
        app_handle,
        state,
        registry,
        board_size,
        turn,
        interval_centisec,
        false,
        move || {
            engine_manager::GtpSession::start(&spec)
                .map(LiveTransport::Local)
                .map_err(|e| e.to_string())
        },
    )
}

fn start_live_transport(
    app_handle: &AppHandle,
    state: &Mutex<LiveReviewSession>,
    registry: &AnalysisJobRegistry,
    board_size: u8,
    turn: u32,
    interval_centisec: u32,
    cloud: bool,
    connect: impl FnOnce() -> Result<LiveTransport, String>,
) -> Result<String, String> {
    if !(2..=25).contains(&board_size) {
        return Err("棋盘大小必须介于 2 和 25".into());
    }
    let interval_centisec = normalize_live_review_interval(interval_centisec);
    let job_id = Uuid::new_v4().to_string();

    // Serialize the whole hand-off. A batch job cannot be displaced (it is someone else's work), but
    // an existing live session *is* displaced — that is what "jump to another move" does — and the
    // old session must be fully gone before the new slot is claimed. See `start_batch_analysis` for
    // why the lifecycle lock, not the registry lock, is what makes this atomic.
    let _lifecycle = registry
        .lifecycle
        .lock()
        .map_err(|_| "analysis job lifecycle is unavailable".to_string())?;

    ensure_live_slot_available(registry)?;

    // Stop and join the superseded live session before claiming the slot. The join is what makes the
    // slot genuinely free: the owner releases its own entry on the way out.
    tear_down_live_review(state, registry);

    // Claim before the engine process exists, so a failure below cannot leave an unclaimed engine.
    let slot = registry.try_insert_exclusive(AnalysisJobKind::Live, job_id.clone())?;

    // Every failure from here to the end of this block must give the slot back: the engine either
    // never started or is being closed, and leaving the slot taken would block every later start
    // until the process exits.
    let mut session = match connect() {
        Ok(session) => session,
        Err(err) => {
            registry.remove_if_owner(&job_id, &slot);
            return Err(err.to_string());
        }
    };
    let server_config = !matches!(&session, LiveTransport::Local(_));
    // The engine does not know the board size until told, and nothing else sends it.
    if let Err(err) = session.send_command(&format!("boardsize {board_size}")) {
        let _ = session.close();
        registry.remove_if_owner(&job_id, &slot);
        return Err(err.to_string());
    }

    let (commands, command_rx) = std::sync::mpsc::channel();
    let guard_state = SharedLiveReviewGuard::default();

    let owner_handle = {
        let app_handle = app_handle.clone();
        let owner_job_id = job_id.clone();
        let guard = std::sync::Arc::clone(&guard_state);
        let registry_handle = app_handle.clone();
        let owner_slot = slot.clone();
        let owner_cancel_token = slot.cancel_token.clone();
        std::thread::spawn(move || {
            run_live_review_owner(
                app_handle,
                owner_job_id.clone(),
                session,
                command_rx,
                guard,
                owner_cancel_token,
                board_size,
            );
            // The session is over (normal end, error, or cancellation): give the slot back, but
            // only if it is still ours — a superseded session must never evict its successor.
            if let Some(registry) = registry_handle.try_state::<AnalysisJobRegistry>() {
                let _ = registry.remove_if_owner(&owner_job_id, &owner_slot);
            }
        })
    };

    // The engine is up, so the slot must now be owned by the state that will tear it down. A
    // poisoned state lock here would otherwise strand a running engine with no handle to stop it.
    match state.lock() {
        Ok(mut live) => {
            live.cloud = cloud;
            live.server_config = server_config;
            live.commands = Some(commands);
            live.forwarder = Some(owner_handle);
            live.job_id = Some(job_id.clone());
            live.board_size = board_size;
            live.interval_centisec = interval_centisec;
            live.guard = guard_state;
            // Publish after the sender exists so the first request is authoritative.
            live.publish_request(Some(turn), None);
            Ok(job_id)
        }
        Err(_) => {
            // The state is unusable: stop the just-started engine and give the slot back.
            let _ = commands.send(LiveReviewCommand::Shutdown);
            join_live_review_owner(Some(owner_handle));
            registry.remove_if_owner(&job_id, &slot);
            Err("live review state is unavailable".to_string())
        }
    }
}

/// Signal the owner thread to stop and wait for it to return.
///
/// The join is not optional: it is what makes "the session is gone" true rather than likely. Until
/// it returns, the old engine process may still be alive and writing to the same session state.
pub(super) fn join_live_review_owner(forwarder: Option<std::thread::JoinHandle<()>>) {
    if let Some(forwarder) = forwarder {
        let _ = forwarder.join();
    }
}

/// Tear down any running live session: detach it from the state, stop its owner thread, join it,
/// and release its registry entry.
///
/// The three steps are ordered so no step can deadlock against another:
///
/// 1. **under the state lock** — detach the session (a [`LiveReviewSession`] value carrying the
///    command sender, the owner handle and the job id). The state is now empty, so a concurrent
///    `set_position` fails cleanly with "session is not running" instead of racing a dying owner;
/// 2. **with the lock released** — send `Shutdown` and join the owner. Joining under the state lock
///    would deadlock whenever the owner is blocked on it;
/// 3. **after the join** — drop the registry entry. Dropping it earlier (or on cancel) would open
///    the exclusive slot while the engine process is still exiting.
///
/// The caller must hold [`AnalysisJobRegistry::lifecycle`]: the tear-down is only correct as part of
/// the serialized "displace the old job, then register the new one" sequence. Callers that are the
/// *entry point* ([`stop_live_review`], process exit) take the lock themselves.
pub(super) fn tear_down_live_review(state: &Mutex<LiveReviewSession>, registry: &AnalysisJobRegistry) {
    let torn_down = match state.lock() {
        Ok(mut live) => live.take_session(),
        Err(_) => None,
    };
    let Some(torn_down) = torn_down else {
        return;
    };
    finish_live_review_teardown(
        torn_down.commands,
        torn_down.forwarder,
        torn_down.job_id,
        registry,
    );
}

/// Steps 2 and 3 of [`tear_down_live_review`], shared with the batch-start path: stop the owner,
/// join it, then release the registry entry.
pub(super) fn finish_live_review_teardown(
    commands: Option<std::sync::mpsc::Sender<LiveReviewCommand>>,
    forwarder: Option<std::thread::JoinHandle<()>>,
    job_id: Option<String>,
    registry: &AnalysisJobRegistry,
) {
    if let Some(commands) = commands {
        let _ = commands.send(LiveReviewCommand::Shutdown);
    }
    join_live_review_owner(forwarder);
    // The job id is the registry key, so leaving it behind would leak a cancel token for a session
    // that no longer exists (and would make a later `remove` a no-op on a dead entry).
    if let Some(job_id) = job_id {
        registry.remove(&job_id);
    }
}

/// Tear the live session down and drop its registry entry, using the app handle to reach the
/// registry on paths where no `State` guard is available (notably process exit).
pub(super) fn tear_down_live_review_with_app(app: &AppHandle) {
    let state = app.state::<Mutex<LiveReviewSession>>();
    let registry = app.state::<AnalysisJobRegistry>();
    // Same serialization as `stop_live_review`: a process-exit tear-down must not interleave with a
    // start that is midway through displacing a session.
    let _lifecycle = registry.lifecycle.lock();
    tear_down_live_review(&state, &registry);
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(super) fn katago_live_review_set_position(
    state: State<'_, Mutex<LiveReviewSession>>,
    moves: Vec<String>,
    turn: u32,
    interval_centisec: u32,
    player: Option<String>,
    komi: Option<f32>,
    board_size: Option<u8>,
    setup: Option<Vec<String>>,
    rules: Option<String>,
    handicap: Option<u32>,
    options: Option<LiveSearchOptions>,
) -> Result<u64, String> {
    let request = LiveReviewPositionRequest {
        board_size: match board_size {
            Some(size) => size,
            None => state
                .lock()
                .map(|live| live.board_size)
                .unwrap_or(DEFAULT_LIVE_REVIEW_BOARD_SIZE),
        },
        setup: setup.unwrap_or_default(),
        handicap,
        moves,
        rules,
        komi,
        player,
    };
    set_live_review_position_with_options(
        &state,
        request,
        turn,
        interval_centisec,
        options.unwrap_or_default(),
    )
}

pub(super) fn set_live_review_position(
    state: &Mutex<LiveReviewSession>,
    request: LiveReviewPositionRequest,
    turn: u32,
    interval_centisec: u32,
) -> Result<u64, String> {
    set_live_review_position_with_options(
        state,
        request,
        turn,
        interval_centisec,
        LiveSearchOptions::default(),
    )
}

fn set_live_review_position_with_options(
    state: &Mutex<LiveReviewSession>,
    request: LiveReviewPositionRequest,
    turn: u32,
    interval_centisec: u32,
    options: LiveSearchOptions,
) -> Result<u64, String> {
    options.validate(request.board_size, request.player.as_deref())?;
    let interval_centisec = normalize_live_review_interval(interval_centisec);
    let generation = {
        let mut live = state
            .lock()
            .map_err(|_| "live review state is unavailable".to_string())?;
        if live.cloud && live_review_player_color(request.player.as_deref()).is_none() {
            return Err("智子云分析必须指定当前执棋方 B 或 W".into());
        }
        let Some(sender) = live.commands.clone() else {
            return Err("live review session is not running".to_string());
        };
        // An interval of 0 means "keep the session default", which `start_live_review` already
        // normalized to a real value.
        let interval_centisec = if interval_centisec == 0 {
            live.interval_centisec
        } else {
            interval_centisec
        };
        // Bumping the generation invalidates every in-flight line from the previous position
        // immediately, before the owner thread even sees this command.
        let player = live_review_player_color(request.player.as_deref());
        let generation = live.publish_request(Some(turn), player);
        // Enqueue under the same lock as publication, preserving generation order against pause/configure.
        sender.send(LiveReviewCommand::SetPosition {
            generation,
            target_turn: turn,
            request,
            interval_centisec,
            options,
        })
        .map_err(|_| "live review session has ended".to_string())?;
        generation
    };
    Ok(generation)
}

#[tauri::command]
pub(super) async fn katago_live_review_stop(app_handle: AppHandle) -> Result<(), String> {
    // Lifecycle handoff may be waiting for a cloud ready timeout or worker shutdown.
    // Keep that wait off the UI executor, as with cloud startup and logout.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<Mutex<LiveReviewSession>>();
        let registry = app_handle.state::<AnalysisJobRegistry>();
        stop_live_review(&state, &registry)
    })
    .await
    .map_err(|_| "停止分析任务失败".to_owned())?
}

/// Stop the live session for real: close the engine and release the registry slot.
///
/// The previous version only paused the analysis (a `Stop` command). The engine process, its
/// registry entry and the exclusive slot all stayed alive, so a later batch start saw a live job
/// that the UI considered stopped. Stopping now tears the session down, which is what the
/// "stopped" state must mean for the mutual exclusion to be honest.
pub(super) fn stop_live_review(
    state: &Mutex<LiveReviewSession>,
    registry: &AnalysisJobRegistry,
) -> Result<(), String> {
    let _lifecycle = registry
        .lifecycle
        .lock()
        .map_err(|_| "analysis job lifecycle is unavailable".to_string())?;
    tear_down_live_review(state, registry);
    Ok(())
}

/// Cloud allocation occurs only after the exclusive lifecycle slot is secured.
#[tauri::command]
pub(super) async fn zhizi_start_live_review(
    app_handle: AppHandle,
    board_size: u8,
    turn: u32,
    interval_centisec: u32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<Mutex<LiveReviewSession>>();
        let registry = app_handle.state::<AnalysisJobRegistry>();
        let auth = app_handle.state::<zhizi::ZhiziState>();
        if !auth.status().logged_in {
            return Err("请先登录智子云".into());
        }
        start_live_transport(
            &app_handle,
            &state,
            &registry,
            board_size,
            turn,
            interval_centisec,
            true,
            || {
                let credentials = auth.allocate_vip()?;
                zhizi_socketio::ZhiziSession::connect(&credentials.socket_url, &credentials.token)
                    .map(LiveTransport::Cloud)
                    .map_err(|reason| format!("智子云连接失败：{reason}"))
            },
        )
    })
    .await
    .map_err(|_| "智子云启动任务失败".to_owned())?
}

#[tauri::command]
pub(super) async fn zhizi_logout(app_handle: AppHandle) -> Result<(), String> {
    // Immediately invalidate any in-flight authentication/HTTP allocation.
    app_handle.state::<zhizi::ZhiziState>().logout();
    tauri::async_runtime::spawn_blocking(move || {
        app_handle.state::<zhizi::ZhiziState>().forget_after_logout()?;
        let registry = app_handle.state::<AnalysisJobRegistry>();
        let _lifecycle = registry
            .lifecycle
            .lock()
            .map_err(|_| "分析状态不可用".to_owned())?;
        let state = app_handle.state::<Mutex<LiveReviewSession>>();
        let cloud = state.lock().map_err(|_| "分析状态不可用".to_owned())?.cloud;
        if cloud {
            tear_down_live_review(&state, &registry);
        }
        Ok(())
    })
    .await
    .map_err(|_| "智子云退出任务失败".to_owned())?
}

fn ensure_live_slot_available(registry: &AnalysisJobRegistry) -> Result<(), String> {
    match registry.kind_of_first() {
        None | Some(AnalysisJobKind::Live) => {}
        Some(AnalysisJobKind::Batch) => {
            return Err(format!(
                "cannot start {} while a {} job is running",
                AnalysisJobKind::Live.label(),
                AnalysisJobKind::Batch.label()
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod cloud_tests {
    use super::*;
    #[test]
    fn logged_out_allocation_fails_before_network() {
        let auth = zhizi::ZhiziState::default();
        assert!(matches!(auth.allocate_vip(), Err(message) if message == "请先登录智子云"));
    }
    #[test]
    fn batch_ownership_refuses_cloud_before_allocation() {
        let registry = AnalysisJobRegistry::default();
        let slot = registry
            .try_insert_exclusive(AnalysisJobKind::Batch, "batch".into())
            .unwrap();
        assert!(ensure_live_slot_available(&registry).is_err());
        assert!(registry.remove_if_owner("batch", &slot));
        assert!(ensure_live_slot_available(&registry).is_ok());
    }
}

