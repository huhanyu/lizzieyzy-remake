use super::types::PositionInput;
use app_model::{PlayerColor, SgfTreeDto};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub struct Document {
    pub text: String,
    pub tree: SgfTreeDto,
    pub game: app_model::GameDto,
}
impl Document {
    pub fn parse(text: &str) -> Result<Self, String> {
        if text.len() > 10_000_000 {
            return Err("棋谱超过 10 MB".into());
        }
        let parsed = sgf::parse_sgf(text).map_err(|e| e.to_string())?;
        let tree = sgf::to_sgf_tree_dto(&parsed)
            .map_err(|e| e.to_string())?
            .ok_or("缺少棋谱树")?;
        let game = sgf::to_game_dto(parsed);
        if !(2..=25).contains(&game.summary.board_size) {
            return Err("仅支持 2–25 路棋盘".into());
        }
        if tree.nodes.len() > 5000 {
            return Err("棋谱节点过多".into());
        }
        Ok(Self {
            text: text.into(),
            tree,
            game,
        })
    }
    pub fn input(&self, node_id: Uuid) -> Result<PositionInput, String> {
        let nodes: HashMap<_, _> = self.tree.nodes.iter().map(|n| (n.id, n)).collect();
        let mut path = vec![];
        let mut id = node_id;
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(id) {
                return Err("棋谱节点循环".into());
            }
            let node = nodes.get(&id).ok_or("找不到分析节点")?;
            path.push(*node);
            match node.parent_id {
                Some(parent) => id = parent,
                None => break,
            }
        }
        path.reverse();
        if path.first().map(|n| n.id) != Some(self.tree.root_id) {
            return Err("分支未连接根节点".into());
        }
        if path.iter().skip(1).any(|n| {
            n.properties
                .iter()
                .any(|p| ["AB", "AW", "AE", "PL"].contains(&p.key.as_str()))
        }) {
            return Err("中途摆子或指定行棋方的棋谱请另存为起始局面后分析".into());
        }
        let pos = sgf::replay_sgf_position_at_node(&self.text, node_id).map_err(|e| e.to_string())?;
        if !pos.errors.is_empty() {
            return Err(pos.errors.join("；"));
        }
        let root =
            sgf::replay_sgf_position_at_node(&self.text, self.tree.root_id).map_err(|e| e.to_string())?;
        let size = self.game.summary.board_size;
        let mut moves = vec![];
        for node in path {
            if let (Some(c), Some(v)) = (node.color, node.vertex.as_ref()) {
                moves.push((
                    color(c),
                    katago_protocol::move_vertex_to_kata_coordinate(v, size).map_err(|e| e.to_string())?,
                ));
            }
        }
        let mut next = nodes
            .get(&node_id)
            .and_then(|n| n.child_ids.first())
            .and_then(|id| nodes.get(id))
            .copied();
        let mut actual = None;
        while let Some(n) = next {
            if let (Some(c), Some(v)) = (n.color, n.vertex.as_ref()) {
                if c == pos.to_play {
                    actual = Some(
                        katago_protocol::move_vertex_to_kata_coordinate(v, size)
                            .map_err(|e| e.to_string())?,
                    )
                }
                break;
            }
            next = n.child_ids.first().and_then(|id| nodes.get(id)).copied();
        }
        let initial_stones = self
            .game
            .summary
            .initial_stones
            .iter()
            .map(|s| {
                katago_protocol::point_to_kata_coordinate(&app_model::PointDto { x: s.x, y: s.y }, size)
                    .map(|v| (color(s.color), v))
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(PositionInput {
            node_id,
            turn: moves.len() as u32,
            player: color(pos.to_play),
            initial_player: color(root.to_play),
            board_size: size,
            komi: f64::from(self.game.summary.komi),
            rules: sgf::katago_rules_for_sgf_ru(self.game.summary.rules.as_deref()).into(),
            initial_stones,
            moves,
            actual_move: actual,
        })
    }
    pub fn mainline(&self) -> Result<Vec<PositionInput>, String> {
        let mut inputs = vec![];
        for n in &self.tree.nodes {
            if n.is_mainline && (n.id == self.tree.root_id || n.vertex.is_some()) {
                inputs.push(self.input(n.id)?);
            }
        }
        inputs.sort_by_key(|p| p.turn);
        if inputs.len() > 1501 {
            return Err("全盘扫描最多 1500 手".into());
        }
        Ok(inputs)
    }
}
pub fn color(c: PlayerColor) -> String {
    if c == PlayerColor::Black { "B" } else { "W" }.into()
}
pub fn opposite(c: &str) -> String {
    if c == "B" { "W" } else { "B" }.into()
}

/// The SGF rules engine checks every generated move before a query or exported variation exists.
pub fn advance(text: &mut String, input: &mut PositionInput, vertex: &str) -> Result<Uuid, String> {
    if analysis_core::tolerance::policy_index(vertex, input.board_size).is_none() {
        return Err("变化坐标无效".into());
    }
    let c = if input.player == "B" {
        PlayerColor::Black
    } else {
        PlayerColor::White
    };
    let result = sgf::append_sgf_move(
        text,
        input.node_id,
        c,
        katago_protocol::gtp_vertex_to_dto(vertex, input.board_size),
    )
    .map_err(|e| e.to_string())?;
    let pos =
        sgf::replay_sgf_position_at_node(&result.sgf_text, result.new_node_id).map_err(|e| e.to_string())?;
    if !pos.errors.is_empty() {
        return Err(pos.errors.join("；"));
    }
    *text = result.sgf_text;
    input.node_id = result.new_node_id;
    input.moves.push((input.player.clone(), vertex.into()));
    input.player = opposite(&input.player);
    input.turn += 1;
    input.actual_move = None;
    Ok(result.new_node_id)
}
