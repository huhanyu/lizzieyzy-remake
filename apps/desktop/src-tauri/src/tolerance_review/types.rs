use analysis_core::tolerance::{HumanResponse, LossDistribution};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const FORMAT: &str = "lizzieyzy-tolerance-v1";
pub const ALGORITHM: &str = "human-loss-v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHop {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewConfig {
    pub source: String,
    pub engine_path: String,
    pub model_path: String,
    pub human_model_path: String,
    pub config_path: String,
    pub working_dir: Option<String>,
    #[serde(default)]
    pub ssh_route: Vec<SshHop>,
    pub identity_file: Option<String>,
    #[serde(default)]
    pub use_agent_identities: bool,
    pub human_profile: String,
    pub screen_visits: u32,
    pub deep_visits: u32,
    pub min_candidate_visits: u32,
    pub target_coverage: f64,
    pub max_supplemental_moves: u32,
    pub max_deep_positions: usize,
    pub max_alternatives: usize,
    pub future_decisions: usize,
}
impl ReviewConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !["local", "ssh"].contains(&self.source.as_str()) {
            return Err("该来源尚未验证完整 HumanSL 分析能力；请选择本地或 SSH".into());
        }
        for path in [
            &self.engine_path,
            &self.model_path,
            &self.human_model_path,
            &self.config_path,
        ] {
            if path.trim().is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
                return Err("请配置有效的引擎、评估模型、人类模型和配置路径".into());
            }
        }
        let p = &self.human_profile;
        let valid = (1..=20).any(|n| p == &format!("rank_{n}k"))
            || (1..=9).any(|n| p == &format!("rank_{n}d"))
            || (1800..=2023).any(|n| p == &format!("proyear_{n}"));
        if !valid {
            return Err("HumanSL 棋力或职业年份档位无效".into());
        }
        if !(128..=65536).contains(&self.screen_visits)
            || !(512..=131072).contains(&self.deep_visits)
            || self.deep_visits < self.screen_visits
            || !(1..=8192).contains(&self.min_candidate_visits)
            || self.min_candidate_visits > self.screen_visits
            || !self.target_coverage.is_finite()
            || !(0.5..=0.999).contains(&self.target_coverage)
            || self.max_supplemental_moves > 20
            || self.max_deep_positions > 20
            || !(1..=3).contains(&self.max_alternatives)
            || !(1..=3).contains(&self.future_decisions)
        {
            return Err("分析预算或分支范围超出支持范围".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub sgf_text: String,
    pub anchor_node_id: Uuid,
    pub mode: String,
    pub config: ReviewConfig,
    #[serde(default)]
    pub alternatives: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelIdentity {
    pub engine_version: String,
    pub engine_sha256: String,
    pub model_sha256: String,
    pub human_model_sha256: String,
    pub config_sha256: String,
    pub cache_safe: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionInput {
    pub node_id: Uuid,
    pub turn: u32,
    pub player: String,
    pub initial_player: String,
    pub board_size: u8,
    pub komi: f64,
    pub rules: String,
    pub initial_stones: Vec<(String, String)>,
    pub moves: Vec<(String, String)>,
    pub actual_move: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionResult {
    pub input: PositionInput,
    pub stage: String,
    pub response: HumanResponse,
    pub distribution: LossDistribution,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchResult {
    pub root_move: String,
    pub is_actual: bool,
    pub root_score_loss: Option<f64>,
    pub root_win_loss_pp: Option<f64>,
    pub opponent_reply: String,
    pub opponent_probability: f64,
    pub states: Vec<PositionResult>,
    pub line: Vec<(String, String)>,
    pub sgf_text: String,
    pub node_ids: Vec<Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReport {
    pub format: String,
    pub algorithm: String,
    pub job_id: String,
    pub document_hash: String,
    pub request: ReviewRequest,
    pub identity: Option<ModelIdentity>,
    pub status: String,
    pub phase: String,
    pub completed: usize,
    pub total: usize,
    pub query_count: usize,
    pub cache_hits: usize,
    pub positions: Vec<PositionResult>,
    pub branches: Vec<BranchResult>,
    pub error: Option<String>,
    pub cleanup_confirmed: bool,
    pub updated_at: u64,
}
