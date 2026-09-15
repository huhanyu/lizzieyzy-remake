use app_model::{
    AnalysisFrameDto, AnalysisJobId, CandidateMoveDto, GameDto, MoveDto, MoveVertex, PlayerColor, PointDto,
    StoneDto,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub type KataMove = (String, String);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisQuery {
    pub id: String,
    pub moves: Vec<KataMove>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub initial_stones: Vec<KataMove>,
    pub rules: String,
    pub komi: f32,
    pub board_x_size: u8,
    pub board_y_size: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analyze_turns: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_visits: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_ownership: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_policy: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct AnalysisQueryOptions {
    pub id: String,
    pub rules: String,
    pub turn: u32,
    pub max_visits: Option<u32>,
    pub include_ownership: Option<bool>,
    pub include_policy: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct AnalysisBatchQueryOptions {
    pub id: String,
    pub rules: String,
    pub analyze_turns: Option<Vec<u32>>,
    pub max_visits: Option<u32>,
    pub include_ownership: Option<bool>,
    pub include_policy: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResponse {
    pub id: String,
    #[serde(default)]
    pub turn_number: u32,
    #[serde(default)]
    pub root_info: Option<RootInfo>,
    #[serde(default)]
    pub move_infos: Vec<MoveInfo>,
    #[serde(default)]
    pub ownership: Option<Vec<f32>>,
    #[serde(default)]
    pub policy: Option<Vec<f32>>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "RootInfoWire")]
pub struct RootInfo {
    #[serde(default)]
    pub visits: u32,
    #[serde(default)]
    pub winrate: f32,
    #[serde(default)]
    pub score_mean: f32,
    #[serde(default)]
    pub score_stdev: Option<f32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootInfoWire {
    #[serde(default)]
    visits: u32,
    #[serde(default)]
    winrate: f32,
    score_mean: Option<f32>,
    score_lead: Option<f32>,
    score_stdev: Option<f32>,
}
impl From<RootInfoWire> for RootInfo {
    fn from(value: RootInfoWire) -> Self {
        Self {
            visits: value.visits,
            winrate: value.winrate,
            score_mean: value.score_mean.or(value.score_lead).unwrap_or(0.0),
            score_stdev: value.score_stdev,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveInfo {
    #[serde(rename = "move")]
    pub move_: Option<String>,
    #[serde(default)]
    pub visits: u32,
    #[serde(default)]
    pub winrate: f32,
    #[serde(default)]
    pub score_mean: f32,
    #[serde(default)]
    pub prior: Option<f32>,
    #[serde(default)]
    pub pv: Vec<String>,
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("json parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("KataGo returned error: {0}")]
    Engine(String),
    #[error("move vertex ({x}, {y}) is outside board size {board_size}")]
    InvalidVertex { x: u8, y: u8, board_size: u8 },
}

impl AnalysisQuery {
    pub fn to_jsonl(&self) -> Result<String, ProtocolError> {
        Ok(format!("{}\n", serde_json::to_string(self)?))
    }
}

pub fn parse_response_line(line: &str) -> Result<AnalysisResponse, ProtocolError> {
    let response: AnalysisResponse = serde_json::from_str(line)?;
    if let Some(error) = &response.error {
        return Err(ProtocolError::Engine(error.clone()));
    }
    Ok(response)
}

pub fn analysis_query_from_game(
    game: &GameDto,
    options: AnalysisQueryOptions,
) -> Result<AnalysisQuery, ProtocolError> {
    let board_size = game.summary.board_size;
    let turn = options.turn.min(game.moves.len() as u32);
    let moves = game
        .moves
        .iter()
        .take(turn as usize)
        .map(|move_| move_dto_to_kata_move(move_, board_size))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(AnalysisQuery {
        id: options.id,
        moves,
        initial_stones: setup_stones_to_kata_moves(&game.summary.initial_stones, board_size)?,
        rules: options.rules,
        komi: game.summary.komi,
        board_x_size: board_size,
        board_y_size: board_size,
        analyze_turns: Some(vec![turn]),
        max_visits: options.max_visits,
        include_ownership: options.include_ownership,
        include_policy: options.include_policy,
    })
}

pub fn analysis_batch_query_from_game(
    game: &GameDto,
    options: AnalysisBatchQueryOptions,
) -> Result<AnalysisQuery, ProtocolError> {
    let board_size = game.summary.board_size;
    let move_count = game.moves.len() as u32;
    let moves = game
        .moves
        .iter()
        .map(|move_| move_dto_to_kata_move(move_, board_size))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(AnalysisQuery {
        id: options.id,
        moves,
        initial_stones: setup_stones_to_kata_moves(&game.summary.initial_stones, board_size)?,
        rules: options.rules,
        komi: game.summary.komi,
        board_x_size: board_size,
        board_y_size: board_size,
        analyze_turns: Some(normalize_analysis_turns(options.analyze_turns, move_count)),
        max_visits: options.max_visits,
        include_ownership: options.include_ownership,
        include_policy: options.include_policy,
    })
}

/// Convert the DTO's 0-based setup stones into KataGo `initialStones` entries.
///
/// KataGo expects `[color, vertex]` pairs using the same GTP-style coordinates as regular moves, so
/// reuse [`point_to_kata_coordinate`] to stay in the same coordinate system as `MoveDto.vertex`.
fn setup_stones_to_kata_moves(stones: &[StoneDto], board_size: u8) -> Result<Vec<KataMove>, ProtocolError> {
    stones
        .iter()
        .map(|stone| {
            let point = PointDto {
                x: stone.x,
                y: stone.y,
            };
            Ok((
                player_color_to_kata(stone.color).to_string(),
                point_to_kata_coordinate(&point, board_size)?,
            ))
        })
        .collect()
}

fn normalize_analysis_turns(turns: Option<Vec<u32>>, move_count: u32) -> Vec<u32> {
    let mut turns = turns.unwrap_or_else(|| (0..=move_count).collect());
    for turn in &mut turns {
        *turn = (*turn).min(move_count);
    }
    turns.sort_unstable();
    turns.dedup();
    turns
}

pub fn move_dto_to_kata_move(move_: &MoveDto, board_size: u8) -> Result<KataMove, ProtocolError> {
    Ok((
        player_color_to_kata(move_.color).to_string(),
        move_vertex_to_kata_coordinate(&move_.vertex, board_size)?,
    ))
}

pub fn player_color_to_kata(color: PlayerColor) -> &'static str {
    match color {
        PlayerColor::Black => "B",
        PlayerColor::White => "W",
    }
}

pub fn move_vertex_to_kata_coordinate(vertex: &MoveVertex, board_size: u8) -> Result<String, ProtocolError> {
    match vertex {
        MoveVertex::Pass => Ok("pass".to_string()),
        MoveVertex::Point(point) => point_to_kata_coordinate(point, board_size),
    }
}

pub fn point_to_kata_coordinate(point: &PointDto, board_size: u8) -> Result<String, ProtocolError> {
    if point.x >= board_size || point.y >= board_size {
        return Err(ProtocolError::InvalidVertex {
            x: point.x,
            y: point.y,
            board_size,
        });
    }
    let col = if point.x >= 8 {
        (b'A' + point.x + 1) as char
    } else {
        (b'A' + point.x) as char
    };
    let row = board_size - point.y;
    Ok(format!("{col}{row}"))
}

pub fn normalize_responses_for_turns(
    job_id: AnalysisJobId,
    responses: Vec<AnalysisResponse>,
    board_size: u8,
    turns: &[u32],
) -> Vec<AnalysisFrameDto> {
    let mut turns = turns.to_vec();
    turns.sort_unstable();
    turns.dedup();

    let mut frames = responses
        .into_iter()
        .filter(|response| turns.binary_search(&response.turn_number).is_ok())
        .map(|response| normalize_response(job_id, response, board_size))
        .collect::<Vec<_>>();
    frames.sort_by_key(|frame| frame.turn);
    frames
}

pub fn normalize_response(
    job_id: AnalysisJobId,
    response: AnalysisResponse,
    board_size: u8,
) -> AnalysisFrameDto {
    let root = response.root_info.unwrap_or(RootInfo {
        visits: 0,
        winrate: 0.5,
        score_mean: 0.0,
        score_stdev: None,
    });
    AnalysisFrameDto {
        job_id,
        game_id: None,
        node_id: None,
        turn: response.turn_number,
        visits: root.visits,
        winrate_black: root.winrate,
        score_mean_black: root.score_mean,
        score_stdev: root.score_stdev,
        candidates: response
            .move_infos
            .into_iter()
            .map(|info| CandidateMoveDto {
                vertex: info
                    .move_
                    .as_deref()
                    .map(|m| gtp_vertex_to_dto(m, board_size))
                    .unwrap_or(MoveVertex::Pass),
                visits: info.visits,
                winrate_black: info.winrate,
                score_mean_black: info.score_mean,
                policy_prior: info.prior,
                pv: info.pv.iter().map(|m| gtp_vertex_to_dto(m, board_size)).collect(),
            })
            .collect(),
        ownership: response.ownership,
        policy: response.policy,
    }
}

pub fn gtp_vertex_to_dto(vertex: &str, board_size: u8) -> MoveVertex {
    if vertex.eq_ignore_ascii_case("pass") || vertex.is_empty() {
        return MoveVertex::Pass;
    }
    let mut chars = vertex.chars();
    let Some(col) = chars.next() else {
        return MoveVertex::Pass;
    };
    let row: String = chars.collect();
    let Ok(row_num) = row.parse::<u8>() else {
        return MoveVertex::Pass;
    };
    let col_upper = col.to_ascii_uppercase();
    let skipped_i = if col_upper > 'I' { 1 } else { 0 };
    let x = (col_upper as u8).saturating_sub(b'A').saturating_sub(skipped_i);
    let y = board_size.saturating_sub(row_num);
    if x >= board_size || y >= board_size {
        MoveVertex::Pass
    } else {
        MoveVertex::Point(PointDto { x, y })
    }
}

/// One parsed `kata-analyze` output line.
///
/// **Perspective**: every value in this struct is reported by KataGo in whatever
/// perspective the `reportAnalysisWinratesAs` config key selected (verified on
/// KataGo v1.16.4 with `gtp.cfg`, where that key is commented out and the engine
/// falls back to `SIDETOMOVE`). This type deliberately does **not** assume which
/// perspective that is — the caller states it explicitly via the `perspective`
/// argument of [`kata_analyze_line_to_frame`], which converts to the
/// black-perspective DTO.
#[derive(Debug, Clone, PartialEq)]
pub struct KataAnalyzeLine {
    /// All `info` blocks on the line, sorted ascending by `order`.
    pub candidates: Vec<KataAnalyzeCandidate>,
    /// Root statistics. Present whenever there is at least one `info` block: taken
    /// from an explicit `rootInfo` section when the line has one (the engine was
    /// launched with `rootInfo true`), otherwise falling back to the first
    /// (best-move) `info` block. Inspect [`KataAnalyzeRoot::source`] to tell the
    /// two apart — they are not the same quantity.
    pub root: Option<KataAnalyzeRoot>,
    /// Board ownership array (only when `ownership true` was requested).
    /// Row-major, index `y * board_size + x`; engine perspective (see the type docs).
    pub ownership: Option<Vec<f32>>,
}

/// A single `info` block inside a `kata-analyze` line.
///
/// **Units**: `winrate` and `prior` are raw decimals in `0..1` — do **not**
/// multiply by 100. (`lz-analyze` uses 10000-scaled integers; `kata-analyze` does
/// not.) `score_mean`/`score_stdev` are point counts, unscaled.
#[derive(Debug, Clone, PartialEq)]
pub struct KataAnalyzeCandidate {
    pub vertex: MoveVertex,
    pub visits: u32,
    /// Raw KataGo decimal in `0..1`, engine perspective (see the type docs), **not scaled**.
    pub winrate: f32,
    /// `scoreMean` (identical to `scoreLead`), engine perspective (see the type docs), unscaled.
    pub score_mean: f32,
    pub score_stdev: Option<f32>,
    /// Raw `prior` decimal in `0..1`.
    pub prior: Option<f32>,
    pub order: u32,
    pub pv: Vec<MoveVertex>,
}

/// Where the root statistics in a [`KataAnalyzeLine`] came from.
///
/// `rootInfo` is **request-gated**: `kata-analyze` emits it only when launched with
/// `rootInfo true`. Without that flag the line carries no root statistics at all,
/// and the parser falls back to the best move's `info` block — which is a
/// **different quantity** (the best move's visits/winrate fluctuate, while the root
/// averages smoothly across all visits). Consumers must therefore not assume the
/// two are interchangeable: compare against `analysis` JSONL, log, or refuse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootSource {
    /// Real root statistics parsed from a `rootInfo` section (the engine was
    /// launched with `rootInfo true`).
    RootInfo,
    /// Fallback: the first (best-move, `order 0`) `info` block was used because the
    /// line had no `rootInfo` section. Values are the best move's, not the root's.
    FirstInfoBlock,
}

/// Root statistics of a `kata-analyze` line.
///
/// Check [`KataAnalyzeRoot::source`] before treating these as true root statistics:
/// when it is [`RootSource::FirstInfoBlock`] the numbers actually describe the best
/// move.
#[derive(Debug, Clone, PartialEq)]
pub struct KataAnalyzeRoot {
    /// Where this struct's values came from.
    pub source: RootSource,
    /// The engine's best move, taken from the first `info` block.
    ///
    /// A `rootInfo` section carries no move, so this is the best move in both
    /// source cases; it is only meaningful as "the move these statistics belong to"
    /// when `source` is [`RootSource::FirstInfoBlock`].
    pub vertex: MoveVertex,
    pub visits: u32,
    /// Raw decimal in `0..1`, engine perspective (see the type docs), **not scaled**.
    pub winrate: f32,
    pub score_mean: f32,
    pub score_stdev: Option<f32>,
}

/// Keys that may appear inside an `info` block. Used to terminate the
/// variable-length `pv` / `movesOwnership` value lists. Unknown keys are skipped
/// safely rather than rejected, because KataGo adds fields over time
/// (`utility`, `utilityLcb`, `scoreSelfplay`, `isSymmetryOf`, ...).
const KNOWN_INFO_KEYS: &[&str] = &[
    "move",
    "visits",
    "edgeVisits",
    "utility",
    "winrate",
    "scoreMean",
    "scoreStdev",
    "scoreLead",
    "scoreSelfplay",
    "prior",
    "lcb",
    "utilityLcb",
    "weight",
    "order",
    "isSymmetryOf",
    "noResultValue",
    "pv",
    "pvVisits",
    "pvEdgeVisits",
    "movesOwnership",
    "movesOwnershipStdev",
];

fn is_known_info_key(token: &str) -> bool {
    KNOWN_INFO_KEYS.contains(&token)
}

#[derive(Default)]
struct RawInfoBlock<'a> {
    move_: Option<&'a str>,
    visits: Option<u32>,
    winrate: Option<f32>,
    score_mean: Option<f32>,
    score_lead: Option<f32>,
    score_stdev: Option<f32>,
    prior: Option<f32>,
    order: Option<u32>,
    pv: Vec<&'a str>,
}

/// Parse a single `info` block (the tokens after the `info` keyword).
///
/// Never panics: malformed numbers fall back to `None` and unknown keys are
/// skipped. This runs once per `interval` (default 100 ms) on engine output, so
/// robustness beats strictness.
fn parse_info_block<'a>(tokens: &[&'a str]) -> RawInfoBlock<'a> {
    let mut block = RawInfoBlock::default();
    let mut i = 0;
    while i < tokens.len() {
        let key = tokens[i];
        match key {
            // Variable-length value lists: collect until the next known key.
            "pv" => {
                i += 1;
                while i < tokens.len() && !is_known_info_key(tokens[i]) {
                    block.pv.push(tokens[i]);
                    i += 1;
                }
            }
            // We never request these; consume their floats so they cannot be
            // mistaken for a top-level `ownership` array or for `pv` moves.
            "movesOwnership" | "movesOwnershipStdev" => {
                i += 1;
                while i < tokens.len() && !is_known_info_key(tokens[i]) {
                    i += 1;
                }
            }
            "move" => {
                block.move_ = tokens.get(i + 1).copied();
                i += 2;
            }
            "visits" => {
                block.visits = tokens.get(i + 1).and_then(|value| value.parse().ok());
                i += 2;
            }
            "winrate" => {
                block.winrate = tokens.get(i + 1).and_then(|value| value.parse().ok());
                i += 2;
            }
            "scoreMean" => {
                block.score_mean = tokens.get(i + 1).and_then(|value| value.parse().ok());
                i += 2;
            }
            "scoreLead" => {
                block.score_lead = tokens.get(i + 1).and_then(|value| value.parse().ok());
                i += 2;
            }
            "scoreStdev" => {
                block.score_stdev = tokens.get(i + 1).and_then(|value| value.parse().ok());
                i += 2;
            }
            "prior" => {
                block.prior = tokens.get(i + 1).and_then(|value| value.parse().ok());
                i += 2;
            }
            "order" => {
                block.order = tokens.get(i + 1).and_then(|value| value.parse().ok());
                i += 2;
            }
            // Unknown or irrelevant key: skip it and, when the next token is a
            // value rather than another key, skip that too.
            _ => {
                let has_value = tokens.get(i + 1).is_some_and(|next| !is_known_info_key(next));
                i += if has_value { 2 } else { 1 };
            }
        }
    }
    block
}

/// Parse the floats following a top-level `ownership` keyword.
///
/// Stops at the first non-float token (e.g. a trailing `ownershipStdev`), and
/// drops the array entirely when its length is not `board_size * board_size`:
/// a half-read array would misalign the heatmap on the board.
fn parse_ownership_values(tokens: &[&str], board_size: u8) -> Option<Vec<f32>> {
    let mut values = Vec::new();
    for token in tokens {
        match token.parse::<f32>() {
            Ok(value) => values.push(value),
            Err(_) => break,
        }
    }
    let expected = (board_size as usize) * (board_size as usize);
    if values.len() == expected {
        Some(values)
    } else {
        None
    }
}

/// Parse one `kata-analyze` output line.
///
/// Returns `None` when the line is not analysis output (GTP `=`/`?` responses,
/// blank lines, a bare `info` keyword), so callers can ignore it.
///
/// The trailing `ownership` array is stripped **before** splitting on ` info `;
/// otherwise its floats would be parsed as the last block's `pv` moves. Note the
/// substring search is on the standalone token `ownership`, which does not match
/// the `movesOwnership` key that lives inside an `info` block.
pub fn parse_kata_analyze_line(line: &str, board_size: u8) -> Option<KataAnalyzeLine> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.first() != Some(&"info") {
        return None;
    }

    // Locate the top-level `ownership` section (never `movesOwnership`).
    let ownership_start = tokens.iter().rposition(|token| *token == "ownership");
    let body_end = ownership_start.unwrap_or(tokens.len());
    let ownership =
        ownership_start.and_then(|start| parse_ownership_values(&tokens[start + 1..], board_size));

    // Walk the body: repeated `info` blocks, then an optional `rootInfo` section.
    let body = &tokens[..body_end];
    let mut blocks: Vec<RawInfoBlock> = Vec::new();
    let mut root_info_tokens: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < body.len() {
        if body[i] == "info" {
            let start = i + 1;
            let mut end = start;
            while end < body.len() && body[end] != "info" && body[end] != "rootInfo" {
                end += 1;
            }
            // A bare `info` keyword with no fields is not analysis output.
            if end > start {
                blocks.push(parse_info_block(&body[start..end]));
            }
            i = end;
        } else if body[i] == "rootInfo" {
            root_info_tokens = body[i + 1..].to_vec();
            break;
        } else {
            i += 1;
        }
    }

    let mut candidates: Vec<KataAnalyzeCandidate> = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| KataAnalyzeCandidate {
            vertex: block
                .move_
                .map(|move_| gtp_vertex_to_dto(move_, board_size))
                .unwrap_or(MoveVertex::Pass),
            visits: block.visits.unwrap_or(0),
            winrate: block.winrate.unwrap_or(0.0),
            score_mean: block.score_mean.or(block.score_lead).unwrap_or(0.0),
            score_stdev: block.score_stdev,
            prior: block.prior,
            order: block.order.unwrap_or(index as u32),
            pv: block
                .pv
                .iter()
                .map(|move_| gtp_vertex_to_dto(move_, board_size))
                .collect(),
        })
        .collect();

    if candidates.is_empty() {
        return None;
    }

    candidates.sort_by_key(|candidate| candidate.order);

    // Root statistics live in a `rootInfo` section that `kata-analyze` emits only
    // when launched with `rootInfo true`. When it is absent, fall back to the first
    // (best-move) `info` block but mark the result as such: the two are different
    // quantities and consumers must be able to tell them apart.
    let first = &blocks[0];
    let mut root = KataAnalyzeRoot {
        source: RootSource::FirstInfoBlock,
        vertex: first
            .move_
            .map(|move_| gtp_vertex_to_dto(move_, board_size))
            .unwrap_or(MoveVertex::Pass),
        visits: first.visits.unwrap_or(0),
        winrate: first.winrate.unwrap_or(0.0),
        score_mean: first.score_mean.or(first.score_lead).unwrap_or(0.0),
        score_stdev: first.score_stdev,
    };
    if !root_info_tokens.is_empty() {
        apply_root_info_overrides(&mut root, &root_info_tokens);
        root.source = RootSource::RootInfo;
    }

    Some(KataAnalyzeLine {
        candidates,
        root: Some(root),
        ownership,
    })
}

fn apply_root_info_overrides(root: &mut KataAnalyzeRoot, tokens: &[&str]) {
    let mut i = 0;
    while i < tokens.len() {
        match tokens[i] {
            "visits" => {
                if let Some(value) = tokens.get(i + 1).and_then(|token| token.parse().ok()) {
                    root.visits = value;
                }
                i += 2;
            }
            "winrate" => {
                if let Some(value) = tokens.get(i + 1).and_then(|token| token.parse().ok()) {
                    root.winrate = value;
                }
                i += 2;
            }
            "scoreMean" | "scoreLead" => {
                if let Some(value) = tokens.get(i + 1).and_then(|token| token.parse().ok()) {
                    root.score_mean = value;
                }
                i += 2;
            }
            "scoreStdev" => {
                root.score_stdev = tokens.get(i + 1).and_then(|token| token.parse().ok());
                i += 2;
            }
            _ => {
                let has_value = tokens.get(i + 1).is_some_and(|next| next.parse::<f32>().is_ok());
                i += if has_value { 2 } else { 1 };
            }
        }
    }
}

/// Convert a parsed streaming line into a black-perspective [`AnalysisFrameDto`].
///
/// `perspective` is the **explicit, auditable contract** for the perspective the
/// engine actually used for this output — not an assumption baked into the
/// parser. `kata-analyze` reports `winrate`, `scoreMean`/`scoreLead` **and
/// `ownership`** from the perspective selected by the `reportAnalysisWinratesAs`
/// config key, while this repository's `*_black` fields are fixed to black.
///
/// That key is optional and its effective value is not observable from the
/// protocol, so the caller must state which perspective applies:
///
/// - `PlayerColor::Black` — engine reported black perspective (e.g. the live
///   session launches the engine with `reportAnalysisWinratesAs=BLACK`); values
///   are kept as-is.
/// - `PlayerColor::White` — engine reported white perspective (e.g. the config
///   key is absent or commented out and white is to move); `winrate -> 1 - winrate`
///   and `score -> -score` are applied to winrate, score **and ownership**.
///
/// Flipping only some of these fields is a direction error. Keeping the
/// perspective explicit means removing an engine-side override is a visible
/// argument change here rather than a silent corruption of every white-to-move
/// frame.
///
/// `score_stdev` and `policy_prior` are not perspective-dependent and are kept
/// as-is. `policy` is `None`: the streaming path has no full-board policy array.
///
/// **Root fallback**: frame-level values come from `line.root` whenever it is
/// present, which includes the [`RootSource::FirstInfoBlock`] fallback used when the
/// line had no `rootInfo` section (i.e. the engine was not launched with
/// `rootInfo true`). Check `line.root.as_ref().map(|root| root.source)` before
/// conversion if the caller needs to distinguish true root statistics from
/// best-move statistics; this function deliberately does not hide the difference.
pub fn kata_analyze_line_to_frame(
    job_id: AnalysisJobId,
    line: &KataAnalyzeLine,
    turn: u32,
    perspective: PlayerColor,
) -> AnalysisFrameDto {
    let flip = perspective == PlayerColor::White;
    let adjust_winrate = |winrate: f32| if flip { 1.0 - winrate } else { winrate };
    let adjust_score = |score: f32| if flip { -score } else { score };

    let (visits, winrate, score_mean, score_stdev) = match &line.root {
        Some(root) => (root.visits, root.winrate, root.score_mean, root.score_stdev),
        None => match line.candidates.first() {
            Some(candidate) => (
                candidate.visits,
                candidate.winrate,
                candidate.score_mean,
                candidate.score_stdev,
            ),
            // Neutral defaults, matching `normalize_response`.
            None => (0, 0.5, 0.0, None),
        },
    };

    // Some cloud proxies omit rootInfo. A single move's visits are not the
    // position's search count; sum the reported children as a lower bound.
    let visits = if line.root.as_ref().is_some_and(|root| root.source == RootSource::RootInfo) {
        visits
    } else {
        line.candidates.iter().fold(0u32, |sum, candidate| sum.saturating_add(candidate.visits))
    };

    AnalysisFrameDto {
        job_id,
        game_id: None,
        node_id: None,
        turn,
        visits,
        winrate_black: adjust_winrate(winrate),
        score_mean_black: adjust_score(score_mean),
        score_stdev,
        candidates: line
            .candidates
            .iter()
            .map(|candidate| CandidateMoveDto {
                vertex: candidate.vertex.clone(),
                visits: candidate.visits,
                winrate_black: adjust_winrate(candidate.winrate),
                score_mean_black: adjust_score(candidate.score_mean),
                policy_prior: candidate.prior,
                pv: candidate.pv.clone(),
            })
            .collect(),
        ownership: line
            .ownership
            .as_ref()
            .map(|values| values.iter().map(|value| adjust_score(*value)).collect()),
        policy: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use app_model::{GameId, GameSummaryDto};

    fn move_at(color: PlayerColor, x: u8, y: u8, move_number: u32) -> MoveDto {
        MoveDto {
            color,
            vertex: MoveVertex::Point(PointDto { x, y }),
            move_number,
        }
    }

    fn pass(color: PlayerColor, move_number: u32) -> MoveDto {
        MoveDto {
            color,
            vertex: MoveVertex::Pass,
            move_number,
        }
    }

    fn game(moves: Vec<MoveDto>) -> GameDto {
        GameDto {
            summary: GameSummaryDto {
                id: GameId::nil(),
                board_size: 19,
                komi: 7.5,
                black_name: None,
                white_name: None,
                result: None,
                move_count: moves.len(),
                initial_stones: vec![],
                to_play: PlayerColor::Black,
                rules: None,
            },
            moves,
        }
    }

    fn options(turn: u32) -> AnalysisQueryOptions {
        AnalysisQueryOptions {
            id: "query-1".to_string(),
            rules: "chinese".to_string(),
            turn,
            max_visits: Some(128),
            include_ownership: Some(true),
            include_policy: Some(false),
        }
    }

    fn batch_options(analyze_turns: Option<Vec<u32>>) -> AnalysisBatchQueryOptions {
        AnalysisBatchQueryOptions {
            id: "batch-1".to_string(),
            rules: "chinese".to_string(),
            analyze_turns,
            max_visits: Some(256),
            include_ownership: Some(false),
            include_policy: Some(true),
        }
    }

    fn response(turn_number: u32, visits: u32) -> AnalysisResponse {
        AnalysisResponse {
            id: "batch-1".to_string(),
            turn_number,
            root_info: Some(RootInfo {
                visits,
                winrate: 0.5,
                score_mean: 0.0,
                score_stdev: None,
            }),
            move_infos: Vec::new(),
            ownership: None,
            policy: None,
            error: None,
            warning: None,
        }
    }

    #[test]
    fn parse_response_line_returns_engine_error_field() {
        let error = parse_response_line(r#"{"id":"query-1","error":"bad query"}"#).unwrap_err();

        match error {
            ProtocolError::Engine(message) => assert_eq!(message, "bad query"),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn parse_response_line_accepts_success_response_without_error_field() {
        let response = parse_response_line(
            r#"{"id":"query-1","turnNumber":2,"rootInfo":{"visits":64,"winrate":0.52,"scoreMean":1.5}}"#,
        )
        .unwrap();

        assert_eq!(response.id, "query-1");
        assert_eq!(response.turn_number, 2);
        assert_eq!(response.root_info.unwrap().visits, 64);
    }

    #[test]
    fn converts_pass_to_katago_pass() {
        let move_ = pass(PlayerColor::Black, 1);
        let kata_move = move_dto_to_kata_move(&move_, 19).unwrap();

        assert_eq!(kata_move, ("B".to_string(), "pass".to_string()));
    }

    #[test]
    fn skips_i_column_in_katago_coordinates() {
        let coordinate = point_to_kata_coordinate(&PointDto { x: 8, y: 9 }, 19).unwrap();

        assert_eq!(coordinate, "J10");
    }

    #[test]
    fn converts_19_line_board_edges() {
        let top_left = point_to_kata_coordinate(&PointDto { x: 0, y: 0 }, 19).unwrap();
        let bottom_right = point_to_kata_coordinate(&PointDto { x: 18, y: 18 }, 19).unwrap();

        assert_eq!(top_left, "A19");
        assert_eq!(bottom_right, "T1");
    }

    #[test]
    fn analysis_query_includes_setup_stones() {
        let mut game = game(vec![move_at(PlayerColor::White, 4, 4, 1)]);
        game.summary.board_size = 9;
        game.summary.initial_stones = vec![
            StoneDto {
                x: 2,
                y: 2,
                color: PlayerColor::Black,
            },
            StoneDto {
                x: 6,
                y: 6,
                color: PlayerColor::Black,
            },
            StoneDto {
                x: 2,
                y: 6,
                color: PlayerColor::Black,
            },
        ];

        let query = analysis_query_from_game(&game, options(1)).unwrap();

        assert_eq!(
            query.initial_stones,
            vec![
                ("B".to_string(), "C7".to_string()),
                ("B".to_string(), "G3".to_string()),
                ("B".to_string(), "C3".to_string()),
            ]
        );

        let batch = analysis_batch_query_from_game(&game, batch_options(None)).unwrap();

        assert_eq!(batch.initial_stones, query.initial_stones);
    }

    #[test]
    fn analysis_query_omits_setup_stones_for_empty_board() {
        let game = game(vec![move_at(PlayerColor::Black, 3, 15, 1)]);

        let query = analysis_query_from_game(&game, options(1)).unwrap();

        assert!(query.initial_stones.is_empty());
        // Empty setup stones stay off the wire so ordinary games keep their previous query shape.
        let jsonl = query.to_jsonl().unwrap();
        assert!(!jsonl.contains("initialStones"));
    }

    #[test]
    fn analysis_query_rejects_setup_stone_outside_board() {
        let mut game = game(Vec::new());
        game.summary.board_size = 9;
        game.summary.initial_stones = vec![StoneDto {
            x: 9,
            y: 0,
            color: PlayerColor::Black,
        }];

        let error = analysis_query_from_game(&game, options(0)).unwrap_err();

        assert!(matches!(
            error,
            ProtocolError::InvalidVertex {
                x: 9,
                y: 0,
                board_size: 9
            }
        ));
    }

    #[test]
    fn query_for_turn_truncates_moves_and_sets_analyze_turn() {
        let game = game(vec![
            move_at(PlayerColor::Black, 3, 15, 1),
            move_at(PlayerColor::White, 15, 3, 2),
            pass(PlayerColor::Black, 3),
        ]);

        let query = analysis_query_from_game(&game, options(2)).unwrap();

        assert_eq!(
            query.moves,
            vec![
                ("B".to_string(), "D4".to_string()),
                ("W".to_string(), "Q16".to_string())
            ]
        );
        assert_eq!(query.analyze_turns, Some(vec![2]));
        assert_eq!(query.max_visits, Some(128));
        assert_eq!(query.include_ownership, Some(true));
        assert_eq!(query.include_policy, Some(false));
    }

    #[test]
    fn batch_query_defaults_to_every_turn_and_full_main_line() {
        let game = game(vec![
            move_at(PlayerColor::Black, 3, 15, 1),
            move_at(PlayerColor::White, 15, 3, 2),
            pass(PlayerColor::Black, 3),
        ]);

        let query = analysis_batch_query_from_game(&game, batch_options(None)).unwrap();

        assert_eq!(
            query.moves,
            vec![
                ("B".to_string(), "D4".to_string()),
                ("W".to_string(), "Q16".to_string()),
                ("B".to_string(), "pass".to_string())
            ]
        );
        assert_eq!(query.analyze_turns, Some(vec![0, 1, 2, 3]));
        assert_eq!(query.max_visits, Some(256));
        assert_eq!(query.include_ownership, Some(false));
        assert_eq!(query.include_policy, Some(true));
    }

    #[test]
    fn batch_query_normalizes_custom_turns() {
        let game = game(vec![
            move_at(PlayerColor::Black, 3, 15, 1),
            move_at(PlayerColor::White, 15, 3, 2),
            pass(PlayerColor::Black, 3),
        ]);

        let query = analysis_batch_query_from_game(&game, batch_options(Some(vec![3, 1, 99, 1, 0]))).unwrap();

        assert_eq!(query.analyze_turns, Some(vec![0, 1, 3]));
    }

    #[test]
    fn normalizes_responses_for_requested_turns_sorted_by_turn() {
        let job_id = AnalysisJobId::nil();
        let frames = normalize_responses_for_turns(
            job_id,
            vec![response(3, 30), response(1, 10), response(2, 20)],
            19,
            &[3, 1, 3],
        );

        assert_eq!(
            frames.iter().map(|frame| frame.turn).collect::<Vec<_>>(),
            vec![1, 3]
        );
        assert_eq!(
            frames.iter().map(|frame| frame.visits).collect::<Vec<_>>(),
            vec![10, 30]
        );
    }

    #[test]
    fn normalizes_responses_filters_unrequested_turns_without_collapsing_duplicate_responses() {
        let job_id = AnalysisJobId::nil();
        let frames = normalize_responses_for_turns(
            job_id,
            vec![response(1, 10), response(2, 20), response(1, 11)],
            19,
            &[1, 1],
        );

        assert_eq!(
            frames.iter().map(|frame| frame.turn).collect::<Vec<_>>(),
            vec![1, 1]
        );
        assert_eq!(
            frames.iter().map(|frame| frame.visits).collect::<Vec<_>>(),
            vec![10, 11]
        );
    }

    #[test]
    fn normalizes_response_ownership_and_policy_arrays() {
        let job_id = AnalysisJobId::nil();
        let response = parse_response_line(
            r#"{"id":"query-1","turnNumber":2,"rootInfo":{"visits":64,"winrate":0.52,"scoreMean":1.5},"ownership":[0.1,-0.2,0.3],"policy":[0.01,0.02,0.03]}"#,
        )
        .unwrap();

        let frame = normalize_response(job_id, response, 19);

        assert_eq!(frame.ownership, Some(vec![0.1, -0.2, 0.3]));
        assert_eq!(frame.policy, Some(vec![0.01, 0.02, 0.03]));
    }

    // ---- kata-analyze streaming parser (plan 005) ----

    fn approx(actual: f32, expected: f32) -> bool {
        (actual - expected).abs() < 1e-5
    }

    /// A real `kata-analyze interval 20 ownership true` line captured from the
    /// bundled KataGo v1.16.4 (9x9, Metal). Trimmed to the first two `info`
    /// blocks plus the full trailing 81-float `ownership` array.
    const REAL_LINE_WITH_OWNERSHIP: &str = "info move F7 visits 512 edgeVisits 513 utility -0.886032 winrate 0.065605 scoreMean -1.08388 scoreStdev 4.98739 scoreLead -1.08388 scoreSelfplay -1.67525 prior 0.0956863 lcb 0.0579522 utilityLcb -0.90746 weight 769.328 order 0 pv F7 C4 F3 F2 F4 F8 E8 G7 E7 G2 B5 G5 H4 H5 info move D7 visits 512 edgeVisits 513 utility -0.886032 winrate 0.065605 scoreMean -1.08388 scoreStdev 4.98739 scoreLead -1.08388 scoreSelfplay -1.67525 prior 0.0956863 lcb 0.0579522 utilityLcb -0.90746 weight 769.328 isSymmetryOf F7 order 1 pv D7 G4 D3 D2 D4 D8 E8 C7 E7 C2 H5 C5 B4 B5 ownership 0.323368 0.332785 0.341685 0.353567 0.287671 0.196604 0.0285549 -0.0229616 -0.049842 0.309147 0.325217 0.351113 0.366548 0.41661 0.0211489 0.0210635 -0.0476197 -0.062539 0.287902 0.315276 0.352525 0.38935 0.513294 0.262633 -0.0851994 -0.108716 -0.0667401 0.26118 0.343913 0.370037 0.366607 0.381509 0.253574 0.0366966 -0.00485405 -0.0360641 0.216289 0.209113 0.330652 0.468088 0.93549 0.206917 0.208191 0.0506969 0.0724863 0.0908725 0.154204 -0.0313288 0.124936 0.201955 0.347002 0.140049 0.191823 0.0902578 -0.0226244 -0.0987591 -0.109858 0.251842 -0.735209 0.130237 -0.0765328 -0.0291642 -0.00280849 -0.114412 -0.140279 -0.290158 -0.584148 -0.590882 -0.58192 -0.447318 -0.152797 -0.10807 -0.191277 -0.286609 -0.366678 -0.452353 -0.517891 -0.520824 -0.410564 -0.327577 -0.209652";

    fn line_with(
        candidates: Vec<KataAnalyzeCandidate>,
        root: Option<KataAnalyzeRoot>,
        ownership: Option<Vec<f32>>,
    ) -> KataAnalyzeLine {
        KataAnalyzeLine {
            candidates,
            root,
            ownership,
        }
    }

    #[test]
    fn parses_single_info_block() {
        let parsed = parse_kata_analyze_line(
            "info move E4 visits 487 winrate 0.480018 scoreMean -0.611848 scoreStdev 24.7058 scoreLead -0.611848 prior 0.221121 lcb 0.477221 order 0 pv E4 E3 F3",
            19,
        )
        .unwrap();

        assert_eq!(parsed.candidates.len(), 1);
        let candidate = &parsed.candidates[0];
        assert_eq!(candidate.visits, 487);
        assert!(approx(candidate.winrate, 0.480018));
        assert!(approx(candidate.score_mean, -0.611848));
        assert!(candidate.score_stdev.is_some_and(|value| approx(value, 24.7058)));
        assert!(candidate.prior.is_some_and(|value| approx(value, 0.221121)));
        assert_eq!(candidate.order, 0);
        assert_eq!(candidate.pv.len(), 3);
        // `gtp_vertex_to_dto` skips the letter I and counts rows from the bottom:
        // column E -> x = 4, row 4 -> y = 19 - 4 = 15.
        assert_eq!(candidate.pv[0], MoveVertex::Point(PointDto { x: 4, y: 15 }));
    }

    #[test]
    fn parses_multiple_info_blocks_on_one_line() {
        let parsed = parse_kata_analyze_line(
            "info move E4 visits 487 winrate 0.480018 order 0 pv E4 E3 info move P16 visits 470 winrate 0.470018 order 1 pv P16 P17 info move E16 visits 143 winrate 0.410018 order 2 pv E16 P4 P3",
            19,
        )
        .unwrap();

        assert_eq!(parsed.candidates.len(), 3);
        assert_eq!(
            parsed.candidates.iter().map(|c| c.order).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(
            parsed.candidates.iter().map(|c| c.visits).collect::<Vec<_>>(),
            vec![487, 470, 143]
        );
    }

    #[test]
    fn parses_root_info_and_ownership() {
        let parsed = parse_kata_analyze_line(
            "info move E4 visits 487 winrate 0.480018 order 0 pv E4 rootInfo visits 1101 winrate 0.5005 scoreMean 1.25 ownership 0.1 0.2 0.3 0.4",
            2,
        )
        .unwrap();

        let root = parsed.root.unwrap();
        assert_eq!(root.source, RootSource::RootInfo);
        assert_eq!(root.visits, 1101);
        assert!(approx(root.winrate, 0.5005));
        assert!(approx(root.score_mean, 1.25));
        assert_eq!(parsed.ownership, Some(vec![0.1, 0.2, 0.3, 0.4]));
        assert_eq!(parsed.candidates.len(), 1);
    }

    #[test]
    fn root_source_distinguishes_root_info_from_best_move_fallback() {
        // Real measured line pair from KataGo v1.16.4 (9x9), identical except for the
        // `rootInfo true` request. Without it the line carries no root statistics at
        // all, so the parser falls back to the best move (order 0) — a *different*
        // quantity (visits 426 vs root 1454), not merely a rounding difference.
        let without_root_info = parse_kata_analyze_line(
            "info move F7 visits 426 winrate 0.066791 scoreMean -1.1 order 0 pv F7 C4 ownership 0.1 0.2 0.3 0.4",
            2,
        )
        .unwrap();
        let with_root_info = parse_kata_analyze_line(
            "info move F7 visits 426 winrate 0.066791 scoreMean -1.1 order 0 pv F7 C4 rootInfo visits 1454 winrate 0.066791 scoreMean -1.1 ownership 0.1 0.2 0.3 0.4",
            2,
        )
        .unwrap();

        let fallback = without_root_info.root.unwrap();
        assert_eq!(fallback.source, RootSource::FirstInfoBlock);
        assert_eq!(fallback.visits, 426);

        let real = with_root_info.root.unwrap();
        assert_eq!(real.source, RootSource::RootInfo);
        assert_eq!(real.visits, 1454);

        // The two sources must not be conflated: 426 is the best move's visits, not
        // the root's, and the same best-move block is present in both lines.
        assert_ne!(fallback.visits, real.visits);
        assert_eq!(without_root_info.candidates[0].visits, 426);
        assert_eq!(with_root_info.candidates[0].visits, 426);
    }

    #[test]
    fn missing_root_counts_all_reported_candidates() {
        let parsed = parse_kata_analyze_line(
            "info move D4 visits 200 winrate 0.5 order 0 pv D4 info move Q16 visits 300 winrate 0.5 order 1 pv Q16", 19).unwrap();
        let frame = kata_analyze_line_to_frame(AnalysisJobId::nil(), &parsed, 0, PlayerColor::Black);
        assert_eq!(frame.visits, 500);
        let with_root = parse_kata_analyze_line(
            "info move D4 visits 200 winrate 0.5 order 0 pv D4 rootInfo visits 900 winrate 0.5 scoreMean 0", 19).unwrap();
        assert_eq!(kata_analyze_line_to_frame(AnalysisJobId::nil(), &with_root, 0, PlayerColor::Black).visits, 900);
    }

    #[test]
    fn frame_values_follow_root_source_without_hiding_it() {
        // A frame built from a no-rootInfo line uses best-move values, and the caller
        // can still detect that via the parsed line's root source.
        let parsed = parse_kata_analyze_line(
            "info move F7 visits 426 winrate 0.2 scoreMean -1.1 order 0 pv F7 C4",
            9,
        )
        .unwrap();

        assert_eq!(parsed.root.as_ref().unwrap().source, RootSource::FirstInfoBlock);
        let frame = kata_analyze_line_to_frame(AnalysisJobId::nil(), &parsed, 0, PlayerColor::Black);
        assert_eq!(frame.visits, 426);
        assert!(approx(frame.winrate_black, 0.2));
    }

    #[test]
    fn ownership_is_stripped_before_pv_parsing() {
        let parsed = parse_kata_analyze_line(
            "info move E4 visits 10 order 0 pv E4 E3 ownership 0.5 0.5 0.5 0.5",
            2,
        )
        .unwrap();

        // If ownership were split first, its 4 floats would leak into `pv`.
        assert_eq!(parsed.candidates[0].pv.len(), 2);
        assert_eq!(parsed.ownership.unwrap().len(), 4);
    }

    #[test]
    fn ownership_with_wrong_length_is_dropped() {
        let parsed =
            parse_kata_analyze_line("info move E4 visits 10 order 0 pv E4 ownership 0.5 0.5 0.5", 2).unwrap();

        assert_eq!(parsed.ownership, None);
    }

    #[test]
    fn non_info_lines_return_none() {
        for line in ["= ", "", "?", "info", "= boardsize"] {
            assert!(
                parse_kata_analyze_line(line, 19).is_none(),
                "expected None for {line:?}"
            );
        }
    }

    #[test]
    fn trailing_carriage_return_is_tolerated() {
        // stdout lines may arrive CRLF-terminated; `\r` must not glue onto the last
        // token and silently truncate the trailing ownership array.
        let parsed = parse_kata_analyze_line(
            "info move E4 visits 10 order 0 pv E4 E3 ownership 0.5 0.5 0.5 0.5\r\n",
            2,
        )
        .unwrap();

        assert_eq!(parsed.candidates[0].pv.len(), 2);
        assert_eq!(parsed.ownership, Some(vec![0.5, 0.5, 0.5, 0.5]));
    }

    #[test]
    fn unknown_keys_do_not_panic() {
        let parsed = parse_kata_analyze_line(
            "info move E4 visits 487 utility -0.0408357 utilityLcb -0.0486664 scoreSelfplay -0.515178 winrate 0.480018 order 0 pv E4",
            19,
        )
        .unwrap();

        assert_eq!(parsed.candidates.len(), 1);
        assert_eq!(parsed.candidates[0].visits, 487);
        assert!(approx(parsed.candidates[0].winrate, 0.480018));
    }

    #[test]
    fn malformed_numbers_fall_back_without_panic() {
        let parsed =
            parse_kata_analyze_line("info move E4 visits abc winrate xyz order 0 pv E4", 19).unwrap();

        assert_eq!(parsed.candidates.len(), 1);
        assert_eq!(parsed.candidates[0].visits, 0);
        assert!(approx(parsed.candidates[0].winrate, 0.0));
    }

    #[test]
    fn winrate_is_not_scaled() {
        let parsed =
            parse_kata_analyze_line("info move E4 visits 10 winrate 0.480018 order 0 pv E4", 19).unwrap();

        // 0.480018, not 48.0018: kata-analyze reports 0..1 decimals.
        assert!(approx(parsed.candidates[0].winrate, 0.480018));
        assert!(parsed.candidates[0].winrate < 1.0);
    }

    #[test]
    fn parses_real_engine_line_with_ownership() {
        let parsed = parse_kata_analyze_line(REAL_LINE_WITH_OWNERSHIP, 9).unwrap();

        assert_eq!(parsed.candidates.len(), 2);
        assert_eq!(parsed.candidates[0].visits, 512);
        assert_eq!(parsed.candidates[0].order, 0);
        assert_eq!(parsed.candidates[0].pv.len(), 14);
        // `isSymmetryOf F7` sits between `weight` and `order` in the real line and
        // must be skipped without corrupting the block.
        assert_eq!(parsed.candidates[1].order, 1);
        assert_eq!(parsed.candidates[1].pv.len(), 14);
        let ownership = parsed.ownership.unwrap();
        assert_eq!(ownership.len(), 81);
        assert!(approx(ownership[0], 0.323368));
        // No `rootInfo` requested in this line, so root falls back to the first block.
        assert_eq!(parsed.root.unwrap().visits, 512);
    }

    #[test]
    fn kata_analyze_line_to_frame_prefers_root_stats() {
        let line = line_with(
            vec![KataAnalyzeCandidate {
                vertex: MoveVertex::Pass,
                visits: 100,
                winrate: 0.25,
                score_mean: 1.0,
                score_stdev: None,
                prior: None,
                order: 0,
                pv: Vec::new(),
            }],
            Some(KataAnalyzeRoot {
                source: RootSource::RootInfo,
                vertex: MoveVertex::Pass,
                visits: 900,
                winrate: 0.75,
                score_mean: 5.0,
                score_stdev: Some(2.0),
            }),
            None,
        );

        let frame = kata_analyze_line_to_frame(AnalysisJobId::nil(), &line, 7, PlayerColor::Black);

        assert_eq!(frame.turn, 7);
        assert_eq!(frame.visits, 900);
        assert!(approx(frame.winrate_black, 0.75));
        assert!(approx(frame.score_mean_black, 5.0));
        assert!(frame.score_stdev.is_some_and(|value| approx(value, 2.0)));
    }

    #[test]
    fn kata_analyze_line_to_frame_falls_back_to_best_candidate() {
        let line = line_with(
            vec![KataAnalyzeCandidate {
                vertex: MoveVertex::Pass,
                visits: 100,
                winrate: 0.25,
                score_mean: 1.0,
                score_stdev: None,
                prior: None,
                order: 0,
                pv: Vec::new(),
            }],
            None,
            None,
        );

        let frame = kata_analyze_line_to_frame(AnalysisJobId::nil(), &line, 3, PlayerColor::Black);

        assert_eq!(frame.visits, 100);
        assert!(approx(frame.winrate_black, 0.25));
        assert!(approx(frame.score_mean_black, 1.0));
    }

    #[test]
    fn white_perspective_values_are_converted_to_black_perspective() {
        // Real measurement: the same position reports winrate 0.988298 when the
        // engine reports black perspective and 0.012669 when it reports white
        // perspective (side-to-move with white to move).
        let line = line_with(
            vec![KataAnalyzeCandidate {
                vertex: MoveVertex::Pass,
                visits: 500,
                winrate: 0.012669,
                score_mean: 0.169398,
                score_stdev: Some(3.0),
                prior: Some(0.2),
                order: 0,
                pv: Vec::new(),
            }],
            Some(KataAnalyzeRoot {
                source: RootSource::RootInfo,
                vertex: MoveVertex::Pass,
                visits: 800,
                winrate: 0.012669,
                score_mean: 0.169398,
                score_stdev: Some(3.0),
            }),
            None,
        );

        let frame = kata_analyze_line_to_frame(AnalysisJobId::nil(), &line, 1, PlayerColor::White);

        assert!(approx(frame.winrate_black, 1.0 - 0.012669));
        assert!(approx(frame.score_mean_black, -0.169398));
        assert!(approx(frame.candidates[0].winrate_black, 1.0 - 0.012669));
        assert!(approx(frame.candidates[0].score_mean_black, -0.169398));
        // Perspective-independent fields stay untouched.
        assert!(frame.score_stdev.is_some_and(|value| approx(value, 3.0)));
        assert!(frame.candidates[0]
            .policy_prior
            .is_some_and(|value| approx(value, 0.2)));
    }

    #[test]
    fn black_perspective_values_are_kept_unchanged() {
        let line = line_with(
            vec![KataAnalyzeCandidate {
                vertex: MoveVertex::Pass,
                visits: 500,
                winrate: 0.988298,
                score_mean: 0.0850384,
                score_stdev: None,
                prior: None,
                order: 0,
                pv: Vec::new(),
            }],
            Some(KataAnalyzeRoot {
                source: RootSource::RootInfo,
                vertex: MoveVertex::Pass,
                visits: 800,
                winrate: 0.988298,
                score_mean: 0.0850384,
                score_stdev: None,
            }),
            None,
        );

        let frame = kata_analyze_line_to_frame(AnalysisJobId::nil(), &line, 0, PlayerColor::Black);

        assert!(approx(frame.winrate_black, 0.988298));
        assert!(approx(frame.score_mean_black, 0.0850384));
        assert!(approx(frame.candidates[0].winrate_black, 0.988298));
        assert!(approx(frame.candidates[0].score_mean_black, 0.0850384));
    }

    #[test]
    fn perspective_is_the_only_input_that_decides_the_flip() {
        // The same parsed line converted with Black vs White must differ exactly by
        // the perspective flip; nothing else may influence the result. This is the
        // contract that makes removing an engine-side override a visible change.
        let line = line_with(
            vec![KataAnalyzeCandidate {
                vertex: MoveVertex::Pass,
                visits: 42,
                winrate: 0.25,
                score_mean: 3.5,
                score_stdev: None,
                prior: None,
                order: 0,
                pv: Vec::new(),
            }],
            Some(KataAnalyzeRoot {
                source: RootSource::RootInfo,
                vertex: MoveVertex::Pass,
                visits: 42,
                winrate: 0.25,
                score_mean: 3.5,
                score_stdev: None,
            }),
            Some(vec![0.5, -0.5]),
        );

        let black = kata_analyze_line_to_frame(AnalysisJobId::nil(), &line, 0, PlayerColor::Black);
        let white = kata_analyze_line_to_frame(AnalysisJobId::nil(), &line, 0, PlayerColor::White);

        assert!(approx(black.winrate_black, 0.25));
        assert!(approx(white.winrate_black, 0.75));
        assert!(approx(black.score_mean_black, 3.5));
        assert!(approx(white.score_mean_black, -3.5));
        assert_eq!(black.ownership, Some(vec![0.5, -0.5]));
        assert_eq!(white.ownership, Some(vec![-0.5, 0.5]));
    }

    #[test]
    fn score_lead_and_score_mean_flip_together() {
        // Real measurement: default config reports scoreLead +0.196254, forced
        // black reports -0.0902159 for the same position. Both fields share the
        // engine perspective, so both must flip when it is white.
        let parsed = parse_kata_analyze_line(
            "info move D4 visits 300 winrate 0.391752 scoreMean 0.196254 scoreLead 0.196254 order 0 pv D4",
            19,
        )
        .unwrap();

        let frame = kata_analyze_line_to_frame(AnalysisJobId::nil(), &parsed, 0, PlayerColor::White);

        assert!(approx(frame.winrate_black, 1.0 - 0.391752));
        assert!(approx(frame.score_mean_black, -0.196254));
        assert!(approx(frame.candidates[0].score_mean_black, -0.196254));
    }

    #[test]
    fn ownership_is_converted_to_black_perspective() {
        // Real measurement: for a white-perspective position the same point reports
        // ownership -0.9459 by default (side-to-move) and +0.9494 with
        // reportAnalysisWinratesAs = BLACK.
        let line = KataAnalyzeLine {
            candidates: vec![KataAnalyzeCandidate {
                vertex: MoveVertex::Pass,
                visits: 1,
                winrate: 0.5,
                score_mean: 0.0,
                score_stdev: None,
                prior: None,
                order: 0,
                pv: Vec::new(),
            }],
            root: None,
            ownership: Some(vec![0.5, -0.25, 0.0, 1.0]),
        };

        let frame = kata_analyze_line_to_frame(AnalysisJobId::nil(), &line, 0, PlayerColor::White);

        assert_eq!(frame.ownership, Some(vec![-0.5, 0.25, 0.0, -1.0]));
    }

    #[test]
    fn frame_has_no_policy_and_no_game_or_node_ids() {
        let parsed = parse_kata_analyze_line("info move E4 visits 10 order 0 pv E4", 19).unwrap();

        let frame = kata_analyze_line_to_frame(AnalysisJobId::nil(), &parsed, 0, PlayerColor::Black);

        assert_eq!(frame.policy, None);
        assert_eq!(frame.game_id, None);
        assert_eq!(frame.node_id, None);
    }
}

#[cfg(test)]
mod root_score_compatibility_tests {
    use super::RootInfo;
    #[test]
    fn reads_modern_root_lead_and_preserves_legacy_mean() {
        for (json, expected) in [
            (r#"{"scoreLead":-0.95}"#, -0.95),
            (r#"{"scoreMean":2.5}"#, 2.5),
            (r#"{"scoreMean":2.5,"scoreLead":3.0}"#, 2.5),
        ] {
            let root: RootInfo = serde_json::from_str(json).unwrap();
            assert_eq!(root.score_mean, expected);
        }
    }
}
