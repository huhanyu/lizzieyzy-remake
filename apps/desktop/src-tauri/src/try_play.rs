//! Minimal IPC surface for the try-play session.
//!
//! All rules live in `sgf::TryPlaySession`; this module only owns the one active
//! session and maps it to/from DTOs. Exactly one session exists at a time, and it
//! is addressed by the `session_id` handed out by `try_play_begin`, so a request
//! that belongs to a superseded session cannot disturb the current one.
//!
//! The state functions are free functions over the shared slot and return the DTOs
//! directly, so the behaviour is testable without a running Tauri app.

use app_model::{MoveVertex, NodeId, PositionDto, SgfTreeDto};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;

/// The one active try-play session, if any.
#[derive(Default)]
pub struct TryPlayState(Mutex<Option<ActiveTryPlay>>);

struct ActiveTryPlay {
    session_id: Uuid,
    session: sgf::TryPlaySession,
}

/// What the frontend renders after `begin`/`move`.
#[derive(Debug, Clone, Serialize)]
pub struct TryPlayViewDto {
    /// Echoed so the caller can address later `move`/`finish` calls.
    pub session_id: Uuid,
    /// The working document, including the try-play line. The caller's own text stays untouched.
    pub sgf_text: String,
    /// End of the current try-play line (the anchor before the first move).
    pub node_id: NodeId,
    pub position: PositionDto,
    pub tree: Option<SgfTreeDto>,
}

/// The result of committing a try-play line into the caller's document.
#[derive(Debug, Clone, Serialize)]
pub struct TryPlayFinishDto {
    pub sgf_text: String,
    pub node_id: NodeId,
}

impl TryPlayViewDto {
    fn build(session_id: Uuid, session: &sgf::TryPlaySession) -> Result<Self, String> {
        let sgf_text = session.working_sgf().to_string();
        let tree = sgf::parse_sgf(&sgf_text)
            .and_then(|document| sgf::to_sgf_tree_dto(&document))
            .map_err(|err| err.to_string())?;
        Ok(Self {
            session_id,
            sgf_text,
            node_id: session.current_node_id(),
            position: session.position().map_err(|err| err.to_string())?,
            tree,
        })
    }
}

fn lock(state: &TryPlayState) -> Result<std::sync::MutexGuard<'_, Option<ActiveTryPlay>>, String> {
    state
        .0
        .lock()
        .map_err(|_| "try-play state is poisoned".to_string())
}

/// Reject a request whose `session_id` does not name the active session.
fn active_session(guard: &mut Option<ActiveTryPlay>, session_id: Uuid) -> Result<&mut ActiveTryPlay, String> {
    match guard.as_mut() {
        Some(active) if active.session_id == session_id => Ok(active),
        Some(_) => Err("try-play session is not the active session".to_string()),
        None => Err("no try-play session is active".to_string()),
    }
}

/// Enter a try-play line at `node_id` of `sgf_text`.
///
/// Refuses while another session is active rather than overwriting it: silently
/// dropping a live session would discard a line the user may still save.
pub fn begin(state: &TryPlayState, sgf_text: String, node_id: NodeId) -> Result<TryPlayViewDto, String> {
    let mut guard = lock(state)?;
    if guard.is_some() {
        return Err("a try-play session is already active".to_string());
    }
    let session = sgf::TryPlaySession::begin(&sgf_text, node_id).map_err(|err| err.to_string())?;
    let session_id = Uuid::new_v4();
    let view = TryPlayViewDto::build(session_id, &session)?;
    *guard = Some(ActiveTryPlay { session_id, session });
    Ok(view)
}

/// Play one try-play move. The side to play comes from the position, never from the caller.
pub fn play(state: &TryPlayState, session_id: Uuid, vertex: MoveVertex) -> Result<TryPlayViewDto, String> {
    let mut guard = lock(state)?;
    let active = active_session(&mut guard, session_id)?;
    active.session.play(vertex).map_err(|err| err.to_string())?;
    TryPlayViewDto::build(session_id, &active.session)
}

/// Commit or discard the session.
///
/// `save` needs the caller's current `sgf_text`; a stale text fails and the session
/// is kept so the caller can retry with the right document. A successful save and a
/// discard both clear the session, and the discard returns `None`.
pub fn finish(
    state: &TryPlayState,
    session_id: Uuid,
    sgf_text: String,
    save: bool,
) -> Result<Option<TryPlayFinishDto>, String> {
    let mut guard = lock(state)?;
    let active = active_session(&mut guard, session_id)?;

    if !save {
        *guard = None;
        return Ok(None);
    }

    let saved = match active.session.save(&sgf_text) {
        Ok(saved) => saved,
        // Keep the session: the caller can re-send the correct document and save again.
        Err(err) => return Err(err.to_string()),
    };
    *guard = None;
    Ok(Some(TryPlayFinishDto {
        sgf_text: saved.sgf_text,
        node_id: saved.node_id,
    }))
}

#[tauri::command]
pub fn try_play_begin(
    sgf_text: String,
    node_id: NodeId,
    state: State<'_, TryPlayState>,
) -> Result<TryPlayViewDto, String> {
    begin(&state, sgf_text, node_id)
}

#[tauri::command]
pub fn try_play_move(
    session_id: Uuid,
    vertex: MoveVertex,
    state: State<'_, TryPlayState>,
) -> Result<TryPlayViewDto, String> {
    play(&state, session_id, vertex)
}

#[tauri::command]
pub fn try_play_finish(
    session_id: Uuid,
    sgf_text: String,
    save: bool,
    state: State<'_, TryPlayState>,
) -> Result<Option<TryPlayFinishDto>, String> {
    finish(&state, session_id, sgf_text, save)
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_model::PointDto;

    const SOURCE: &str = "(;SZ[5];B[aa]C[first])";

    fn anchor() -> NodeId {
        sgf::to_sgf_tree_dto(&sgf::parse_sgf(SOURCE).unwrap())
            .unwrap()
            .unwrap()
            .nodes
            .iter()
            .find(|node| node.move_number == Some(1))
            .unwrap()
            .id
    }

    fn active_id(state: &TryPlayState) -> Uuid {
        lock(state).unwrap().as_ref().unwrap().session_id
    }

    fn point(x: u8, y: u8) -> MoveVertex {
        MoveVertex::Point(PointDto { x, y })
    }

    #[test]
    fn begin_returns_the_working_view_without_touching_the_source() {
        let state = TryPlayState::default();
        let view = begin(&state, SOURCE.to_string(), anchor()).unwrap();

        assert_eq!(view.sgf_text, SOURCE);
        assert_eq!(view.node_id, anchor());
        assert_eq!(view.position.move_number, 1);
        assert!(view.position.errors.is_empty());
        assert_eq!(view.tree.as_ref().unwrap().nodes.len(), 2);
        assert_eq!(SOURCE, "(;SZ[5];B[aa]C[first])");
    }

    #[test]
    fn begin_refuses_while_a_session_is_active() {
        let state = TryPlayState::default();
        let first = begin(&state, SOURCE.to_string(), anchor()).unwrap();

        let error = begin(&state, SOURCE.to_string(), anchor()).unwrap_err();

        assert!(error.contains("already active"));
        // The first session survived the rejected begin, id included.
        assert_eq!(active_id(&state), first.session_id);
    }

    #[test]
    fn move_on_a_wrong_session_id_cannot_touch_the_current_session() {
        let state = TryPlayState::default();
        let stale = Uuid::new_v4();
        let view = begin(&state, SOURCE.to_string(), anchor()).unwrap();

        let wrong_id = play(&state, stale, point(1, 1)).unwrap_err();
        assert!(wrong_id.contains("not the active session"));

        // The current session is untouched and still usable.
        let after = play(&state, view.session_id, point(1, 1)).unwrap();
        assert_eq!(after.position.move_number, 2);
        assert!(after
            .position
            .stones
            .iter()
            .any(|stone| stone.x == 1 && stone.y == 1));
        assert_eq!(after.sgf_text, view.sgf_text.replace(")", ";W[bb])"));
    }

    #[test]
    fn move_and_finish_reject_a_session_id_when_nothing_is_active() {
        let state = TryPlayState::default();
        let orphan = Uuid::new_v4();

        assert!(play(&state, orphan, point(1, 1))
            .unwrap_err()
            .contains("no try-play session"));
        assert!(finish(&state, orphan, SOURCE.to_string(), true)
            .unwrap_err()
            .contains("no try-play session"));
    }

    #[test]
    fn move_derives_the_colour_from_the_position() {
        let state = TryPlayState::default();
        let view = begin(&state, SOURCE.to_string(), anchor()).unwrap();

        let after = play(&state, view.session_id, point(1, 1)).unwrap();

        // White is to play at the anchor, so White is what gets appended.
        assert!(after.sgf_text.contains(";W[bb]"));
        assert!(after
            .position
            .stones
            .iter()
            .any(|stone| stone.x == 1 && stone.y == 1 && stone.color == app_model::PlayerColor::White));
    }

    #[test]
    fn move_rejects_an_illegal_vertex_and_keeps_the_session() {
        let state = TryPlayState::default();
        let view = begin(&state, SOURCE.to_string(), anchor()).unwrap();

        let error = play(&state, view.session_id, point(0, 0)).unwrap_err();
        assert!(error.contains("illegal SGF move"));

        // The rejected move neither ended the session nor advanced the line.
        assert_eq!(active_id(&state), view.session_id);
        let after = play(&state, view.session_id, point(1, 1)).unwrap();
        assert_ne!(after.node_id, view.node_id);
        assert_eq!(after.position.move_number, 2);
    }

    #[test]
    fn finish_save_with_a_stale_text_fails_and_keeps_the_session() {
        let state = TryPlayState::default();
        let view = begin(&state, SOURCE.to_string(), anchor()).unwrap();
        play(&state, view.session_id, point(1, 1)).unwrap();

        let stale = "(;SZ[5];B[aa]C[edited])";
        let error = finish(&state, view.session_id, stale.to_string(), true).unwrap_err();

        assert!(error.contains("stale"));
        // The session is still there, so the caller can save against the right document.
        assert_eq!(active_id(&state), view.session_id);

        let saved = finish(&state, view.session_id, SOURCE.to_string(), true)
            .unwrap()
            .unwrap();
        assert!(saved.sgf_text.contains(";W[bb]"));
        assert!(saved.sgf_text.contains("C[first]"));
        // The saved node is the appended branch, and it is reachable in the new text.
        let reopened = sgf::replay_sgf_position_at_node(&saved.sgf_text, saved.node_id).unwrap();
        assert_eq!(reopened.move_number, 2);
        assert!(reopened.errors.is_empty());
        assert!(lock(&state).unwrap().is_none());
    }

    #[test]
    fn finish_discard_clears_the_session_and_returns_none() {
        let state = TryPlayState::default();
        let view = begin(&state, SOURCE.to_string(), anchor()).unwrap();
        play(&state, view.session_id, point(1, 1)).unwrap();

        let result = finish(&state, view.session_id, SOURCE.to_string(), false).unwrap();

        assert!(result.is_none());
        assert!(lock(&state).unwrap().is_none());
        // The discarded line never reached the caller's document.
        assert_eq!(SOURCE, "(;SZ[5];B[aa]C[first])");
    }

    #[test]
    fn finish_save_clears_the_session_and_a_new_begin_starts_fresh() {
        let state = TryPlayState::default();
        let view = begin(&state, SOURCE.to_string(), anchor()).unwrap();
        play(&state, view.session_id, point(1, 1)).unwrap();

        let saved = finish(&state, view.session_id, SOURCE.to_string(), true)
            .unwrap()
            .unwrap();
        assert!(lock(&state).unwrap().is_none());

        let reopened = begin(&state, saved.sgf_text, saved.node_id).unwrap();
        assert_ne!(reopened.session_id, view.session_id);
        assert_eq!(reopened.node_id, saved.node_id);
        assert_eq!(reopened.position.move_number, 2);
        assert!(reopened.position.errors.is_empty());
    }

    #[test]
    fn begin_rejects_an_unknown_anchor() {
        let state = TryPlayState::default();

        let error = begin(&state, SOURCE.to_string(), Uuid::new_v4()).unwrap_err();

        assert!(error.contains("not found"));
        assert!(lock(&state).unwrap().is_none());
    }
}
