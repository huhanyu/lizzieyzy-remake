//! Human-policy weighted losses. Probability mass is never conditioned on searched moves.
//! Kept separate from parent/child loss and strength-estimation metrics.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanRoot {
    pub current_player: String,
    pub visits: u64,
    pub winrate: f64,
    pub score_lead: Option<f64>,
    pub score_mean: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanMove {
    #[serde(rename = "move")]
    pub vertex: String,
    pub visits: u64,
    pub winrate: f64,
    pub score_lead: Option<f64>,
    pub score_mean: Option<f64>,
    pub order: Option<u32>,
    #[serde(default)]
    pub pv: Vec<String>,
    pub is_symmetry_of: Option<String>,
}
impl HumanMove {
    pub fn score(&self) -> Option<f64> {
        self.score_lead.or(self.score_mean).filter(|v| v.is_finite())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanResponse {
    pub id: String,
    pub turn_number: u32,
    pub root_info: HumanRoot,
    pub move_infos: Vec<HumanMove>,
    // Intentionally required: ordinary engine policy is NOT a fallback.
    pub human_policy: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LossCandidate {
    pub vertex: String,
    pub probability: f64,
    pub visits: u64,
    pub score_loss: Option<f64>,
    pub win_loss_pp: Option<f64>,
    pub score_black: Option<f64>,
    pub winrate_black: Option<f64>,
    pub order: Option<u32>,
    pub pv: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LossDistribution {
    pub reference_score_move: Option<String>,
    pub reference_win_move: Option<String>,
    pub coverage: f64,
    pub unknown: f64,
    pub candidates: Vec<LossCandidate>,
}

pub fn vertex_at(index: usize, size: u8) -> String {
    if index == usize::from(size).pow(2) {
        "pass".into()
    } else {
        format!(
            "{}{}",
            b"ABCDEFGHJKLMNOPQRSTUVWXYZ"[index % size as usize] as char,
            size as usize - index / size as usize
        )
    }
}

pub fn policy_index(vertex: &str, size: u8) -> Option<usize> {
    if vertex == "pass" {
        return Some(usize::from(size).pow(2));
    }
    let x = b"ABCDEFGHJKLMNOPQRSTUVWXYZ"
        .iter()
        .position(|c| Some(c) == vertex.as_bytes().first())?;
    let row = vertex.get(1..)?.parse::<usize>().ok()?;
    (x < size as usize && row > 0 && row <= size as usize)
        .then_some((size as usize).saturating_sub(row) * size as usize + x)
}

pub fn distribution(response: &HumanResponse, size: u8, min_visits: u64) -> Result<LossDistribution, String> {
    if !(2..=25).contains(&size) || min_visits == 0 {
        return Err("棋盘大小或候选访问门槛无效".into());
    }
    let root = &response.root_info;
    let sign = match root.current_player.as_str() {
        "B" => 1.0,
        "W" => -1.0,
        _ => return Err("缺少明确的行棋方".into()),
    };
    if !root.winrate.is_finite()
        || !(0.0..=1.0).contains(&root.winrate)
        || !root.score_lead.or(root.score_mean).is_some_and(f64::is_finite)
    {
        return Err("引擎局面评价无效".into());
    }
    let policy = &response.human_policy;
    if policy.len() != usize::from(size).pow(2) + 1 || policy.iter().any(|p| !p.is_finite() || *p > 1.001) {
        return Err("HumanSL 概率数组无效或棋盘大小不匹配".into());
    }
    let mass: f64 = policy.iter().filter(|p| **p >= 0.0).sum();
    if (mass - 1.0).abs() > 0.01 {
        return Err("HumanSL 合法落点概率总和不是 1".into());
    }
    let mut seen = HashSet::new();
    for m in &response.move_infos {
        let i = policy_index(&m.vertex, size).ok_or("引擎候选坐标无效")?;
        if !seen.insert(i) {
            return Err("引擎返回了重复候选".into());
        }
    }
    let valid = |m: &&HumanMove| {
        m.visits >= min_visits
            && m.is_symmetry_of.is_none()
            && m.score().is_some()
            && m.winrate.is_finite()
            && (0.0..=1.0).contains(&m.winrate)
            && policy[policy_index(&m.vertex, size).unwrap()] >= 0.0
    };
    let trusted: Vec<_> = response.move_infos.iter().filter(valid).collect();
    let own_win = |m: &HumanMove| if sign > 0.0 { m.winrate } else { 1.0 - m.winrate };
    let score_ref = trusted
        .iter()
        .max_by(|a, b| (sign * a.score().unwrap()).total_cmp(&(sign * b.score().unwrap())))
        .copied();
    let win_ref = trusted
        .iter()
        .max_by(|a, b| own_win(a).total_cmp(&own_win(b)))
        .copied();
    let mut coverage = 0.0;
    let mut candidates = Vec::new();
    for (i, p) in policy.iter().enumerate().filter(|(_, p)| **p >= 0.0) {
        let vertex = vertex_at(i, size);
        let found = response.move_infos.iter().find(|m| m.vertex == vertex);
        let good = found.filter(|m| valid(m));
        let probability = p / mass; // only floating-point drift; never searched-mass normalization
        if good.is_some() {
            coverage += probability;
        }
        candidates.push(LossCandidate {
            vertex,
            probability,
            visits: found.map_or(0, |m| m.visits),
            score_loss: good
                .zip(score_ref)
                .map(|(m, r)| (sign * (r.score().unwrap() - m.score().unwrap())).max(0.0)),
            win_loss_pp: good
                .zip(win_ref)
                .map(|(m, r)| (100.0 * (own_win(r) - own_win(m))).max(0.0)),
            score_black: good.and_then(HumanMove::score),
            winrate_black: good.map(|m| m.winrate),
            order: found.and_then(|m| m.order),
            pv: found.map_or_else(Vec::new, |m| m.pv.clone()),
        });
    }
    candidates.sort_by(|a, b| b.probability.total_cmp(&a.probability));
    Ok(LossDistribution {
        reference_score_move: score_ref.map(|m| m.vertex.clone()),
        reference_win_move: win_ref.map(|m| m.vertex.clone()),
        coverage: coverage.min(1.0),
        unknown: (1.0 - coverage).max(0.0),
        candidates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> HumanResponse {
        HumanResponse {
            id: "x".into(),
            turn_number: 0,
            root_info: HumanRoot {
                current_player: "B".into(),
                visits: 300,
                winrate: 0.9,
                score_lead: Some(10.0),
                score_mean: Some(20.0),
            },
            human_policy: vec![0.2, 0.3, 0.1, -1.0, 0.4],
            move_infos: vec![
                HumanMove {
                    vertex: "A2".into(),
                    visits: 200,
                    winrate: 0.9,
                    score_lead: Some(10.0),
                    score_mean: Some(20.0),
                    order: Some(0),
                    pv: vec![],
                    is_symmetry_of: None,
                },
                HumanMove {
                    vertex: "B2".into(),
                    visits: 100,
                    winrate: 0.7,
                    score_lead: Some(7.0),
                    score_mean: Some(25.0),
                    order: Some(1),
                    pv: vec![],
                    is_symmetry_of: None,
                },
                HumanMove {
                    vertex: "A1".into(),
                    visits: 1,
                    winrate: 1.0,
                    score_lead: Some(100.0),
                    score_mean: None,
                    order: Some(2),
                    pv: vec![],
                    is_symmetry_of: None,
                },
            ],
        }
    }
    #[test]
    fn keeps_unsearched_mass_and_prefers_score_lead() {
        let d = distribution(&sample(), 2, 32).unwrap();
        assert!((d.coverage - 0.5).abs() < 1e-9);
        assert!((d.unknown - 0.5).abs() < 1e-9);
        let b = d.candidates.iter().find(|m| m.vertex == "B2").unwrap();
        assert_eq!(b.score_loss, Some(3.0));
        assert!((b.win_loss_pp.unwrap() - 20.0).abs() < 1e-9);
        assert!(d
            .candidates
            .iter()
            .find(|m| m.vertex == "pass")
            .unwrap()
            .score_loss
            .is_none());
    }
    #[test]
    fn white_perspective_is_not_black() {
        let mut r = sample();
        r.root_info.current_player = "W".into();
        let d = distribution(&r, 2, 32).unwrap();
        assert_eq!(d.reference_score_move.as_deref(), Some("B2"));
        assert_eq!(
            d.candidates.iter().find(|m| m.vertex == "A2").unwrap().score_loss,
            Some(3.0)
        );
    }
    #[test]
    fn rejects_bad_policies_and_keeps_symmetry_unknown() {
        let mut r = sample();
        r.human_policy.clear();
        assert!(distribution(&r, 2, 32).is_err());
        let mut r = sample();
        r.move_infos[0].is_symmetry_of = Some("B2".into());
        assert!((distribution(&r, 2, 32).unwrap().coverage - 0.3).abs() < 1e-9);
        let mut r = sample();
        r.move_infos.push(r.move_infos[0].clone());
        assert!(distribution(&r, 2, 32).is_err());
    }
    #[test]
    fn coordinates_include_pass_and_skip_i() {
        assert_eq!(policy_index("J19", 19), Some(8));
        assert_eq!(vertex_at(361, 19), "pass");
        assert_eq!(policy_index("T1", 19), Some(360));
        assert_eq!(policy_index("A0", 19), None);
    }
}
