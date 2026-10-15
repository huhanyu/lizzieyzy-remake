use super::{
    position::{advance, Document},
    transport::hash_bytes,
    types::*,
};
use analysis_core::tolerance::{distribution, HumanResponse, LossCandidate};
use engine_manager::AnalysisCancelToken;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub trait QueryEngine {
    fn ask(&mut self, q: &Value, cancel: &AnalysisCancelToken) -> Result<Value, String>;
}
impl QueryEngine for super::transport::Session {
    fn ask(&mut self, q: &Value, cancel: &AnalysisCancelToken) -> Result<Value, String> {
        self.query(q, cancel)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEvent {
    pub job_id: String,
    pub document_hash: String,
    pub status: String,
    pub phase: String,
    pub completed: usize,
    pub total: usize,
    pub query_count: usize,
    pub cache_hits: usize,
    pub cleanup_confirmed: bool,
    pub error: Option<String>,
    pub position: Option<PositionResult>,
    pub branch: Option<BranchResult>,
}
pub fn event(
    r: &ReviewReport,
    position: Option<PositionResult>,
    branch: Option<BranchResult>,
) -> ReviewEvent {
    ReviewEvent {
        job_id: r.job_id.clone(),
        document_hash: r.document_hash.clone(),
        status: r.status.clone(),
        phase: r.phase.clone(),
        completed: r.completed,
        total: r.total,
        query_count: r.query_count,
        cache_hits: r.cache_hits,
        cleanup_confirmed: r.cleanup_confirmed,
        error: r.error.clone(),
        position,
        branch,
    }
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn atomic_json(path: &Path, v: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, serde_json::to_vec(v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}
pub fn save_report(dir: &Path, r: &ReviewReport) -> Result<(), String> {
    atomic_json(&dir.join("reports").join(format!("{}.json", r.job_id)), r)?;
    atomic_json(&dir.join(format!("latest-{}.json", r.document_hash)), &r.job_id)
}
pub fn new_report(id: String, request: ReviewRequest) -> ReviewReport {
    ReviewReport {
        format: FORMAT.into(),
        algorithm: ALGORITHM.into(),
        job_id: id,
        document_hash: hash_bytes(request.sgf_text.as_bytes()),
        request,
        identity: None,
        status: "starting".into(),
        phase: "验证模型与能力".into(),
        completed: 0,
        total: 0,
        query_count: 0,
        cache_hits: 0,
        positions: vec![],
        branches: vec![],
        error: None,
        cleanup_confirmed: false,
        updated_at: now(),
    }
}
pub fn make_query(p: &PositionInput, c: &ReviewConfig, visits: u32, allowed: Option<&str>) -> Value {
    let mut q = json!({"moves":p.moves,"initialStones":p.initial_stones,"initialPlayer":p.initial_player,
        "rules":p.rules,"komi":p.komi,"boardXSize":p.board_size,"boardYSize":p.board_size,
        "maxVisits":visits,"includePolicy":true,"overrideSettings":{"humanSLProfile":c.human_profile,
            "ignorePreRootHistory":false,"reportAnalysisWinratesAs":"BLACK","humanSLRootExploreProbWeightless":0.5,
            "humanSLCpuctPermanent":2.0,"rootNumSymmetriesToSample":8,"maxTime":540.0}});
    if let Some(a) = allowed {
        q["allowMoves"] = json!([{"player":p.player,"moves":[a],"untilDepth":1}]);
        q["overrideSettings"]["humanSLRootExploreProbWeightless"] = json!(0);
    }
    q
}

pub struct Runner<'a> {
    pub engine: &'a mut dyn QueryEngine,
    pub cancel: &'a AnalysisCancelToken,
    pub dir: PathBuf,
    pub report: &'a mut ReviewReport,
    pub emit: &'a mut dyn FnMut(ReviewEvent),
}
impl Runner<'_> {
    fn checkpoint(
        &mut self,
        position: Option<PositionResult>,
        branch: Option<BranchResult>,
    ) -> Result<(), String> {
        self.report.updated_at = now();
        save_report(&self.dir, self.report)?;
        (self.emit)(event(self.report, position, branch));
        Ok(())
    }
    fn raw(
        &mut self,
        p: &PositionInput,
        visits: u32,
        allowed: Option<&str>,
    ) -> Result<HumanResponse, String> {
        if self.cancel.is_cancelled() {
            return Err("已取消".into());
        }
        let mut q = make_query(p, &self.report.request.config, visits, allowed);
        let fingerprint = json!({"algorithm":ALGORITHM,"identity":self.report.identity,"query":q});
        let key = hash_bytes(fingerprint.to_string().as_bytes());
        let path = self.dir.join("queries").join(format!("{key}.json"));
        let safe = self.report.identity.as_ref().is_some_and(|i| i.cache_safe);
        if safe {
            if let Ok(bytes) = std::fs::read(&path) {
                if let Ok(r) = serde_json::from_slice::<HumanResponse>(&bytes) {
                    if self.validate_response(&r, p).is_ok() {
                        self.report.cache_hits += 1;
                        return Ok(r);
                    }
                }
            }
        }
        q["id"] = json!(format!("{}-{}", self.report.job_id, self.report.query_count));
        let raw = self.engine.ask(&q, self.cancel)?;
        let r: HumanResponse =
            serde_json::from_value(raw.clone()).map_err(|e| format!("引擎未提供完整 HumanSL 响应：{e}"))?;
        if raw.get("id") != q.get("id") {
            return Err("响应不属于当前查询".into());
        }
        self.validate_response(&r, p)?;
        self.report.query_count += 1;
        // Retain query/response provenance independently of display checkpoints.
        atomic_json(
            &self
                .dir
                .join("evidence")
                .join(&self.report.job_id)
                .join(format!("{}.json", self.report.query_count)),
            &json!({"query":q,"response":raw}),
        )?;
        if safe {
            atomic_json(&path, &r)?;
        }
        (self.emit)(event(self.report, None, None));
        Ok(r)
    }
    fn validate_response(&self, r: &HumanResponse, p: &PositionInput) -> Result<(), String> {
        if r.turn_number != p.moves.len() as u32 || r.root_info.current_player != p.player {
            return Err("引擎回复的手数或行棋方与请求不符".into());
        }
        distribution(
            r,
            p.board_size,
            u64::from(self.report.request.config.min_candidate_visits),
        )?;
        Ok(())
    }
    fn analyze(
        &mut self,
        p: &PositionInput,
        visits: u32,
        enrich: bool,
        stage: &str,
    ) -> Result<PositionResult, String> {
        let mut r = self.raw(p, visits, None)?;
        let min = u64::from(self.report.request.config.min_candidate_visits);
        let d = distribution(&r, p.board_size, min)?;
        if enrich || stage == "training-screen" {
            let c = self.report.request.config.clone();
            let mut todo = vec![];
            let mut anticipated = d.coverage;
            if let Some(a) = &p.actual_move {
                if c.max_supplemental_moves > 0
                    && d.candidates
                        .iter()
                        .any(|m| &m.vertex == a && m.score_loss.is_none())
                {
                    todo.push(a.clone());
                    anticipated += d
                        .candidates
                        .iter()
                        .find(|m| &m.vertex == a)
                        .map_or(0.0, |m| m.probability);
                }
            }
            for m in d.candidates.iter().filter(|_| enrich) {
                if anticipated >= c.target_coverage || todo.len() >= c.max_supplemental_moves as usize {
                    break;
                }
                if m.probability > 0.0 && m.score_loss.is_none() && !todo.contains(&m.vertex) {
                    anticipated += m.probability;
                    todo.push(m.vertex.clone());
                }
            }
            for a in todo {
                let extra = self.raw(p, c.deep_visits.min(2048).max(c.min_candidate_visits), Some(&a))?;
                let mut m = extra
                    .move_infos
                    .into_iter()
                    .find(|m| m.vertex == a)
                    .ok_or("定点搜索没有返回指定候选")?;
                m.order = None; // supplemental query order=0 must not become the continuation policy
                r.move_infos.retain(|m| m.vertex != a);
                r.move_infos.push(m);
            }
        }
        Ok(PositionResult {
            input: p.clone(),
            stage: stage.into(),
            distribution: distribution(&r, p.board_size, min)?,
            response: r,
        })
    }
    fn store(&mut self, p: PositionResult) -> Result<(), String> {
        if let Some(i) = self
            .report
            .positions
            .iter()
            .position(|x| x.input.node_id == p.input.node_id)
        {
            self.report.positions[i] = p.clone()
        } else {
            self.report.positions.push(p.clone())
        }
        self.report.completed += 1;
        self.checkpoint(Some(p), None)
    }
    pub fn run(&mut self) -> Result<(), String> {
        let request = self.report.request.clone();
        request.config.validate()?;
        let doc = Document::parse(&request.sgf_text)?;
        let anchor = doc.input(request.anchor_node_id)?;
        let c = &request.config;
        self.report.status = "running".into();
        if request.mode == "scan" || request.mode == "training" {
            let mut inputs = doc.mainline()?;
            if request.mode == "training" {
                inputs.retain(|p| {
                    p.moves.len() >= (60 * usize::from(p.board_size).pow(2)).div_ceil(361)
                        && p.actual_move.is_some()
                });
            }
            self.report.total = inputs.len();
            self.report.phase = if request.mode == "training" {
                "中后盘粗扫"
            } else {
                "全盘粗扫"
            }
            .into();
            self.checkpoint(None, None)?;
            for p in inputs {
                let stage = if request.mode == "training" {
                    "training-screen"
                } else {
                    "screen"
                };
                let result = self.analyze(&p, c.screen_visits, false, stage)?;
                self.store(result)?;
            }
            // Candidate-value loss and low safe mass identify *inspection targets*, not causation.
            let mut priority = self
                .report
                .positions
                .iter()
                .filter(|p| p.input.actual_move.is_some())
                .map(|p| {
                    let actual = p
                        .distribution
                        .candidates
                        .iter()
                        .find(|m| Some(&m.vertex) == p.input.actual_move.as_ref());
                    let safety: f64 = p
                        .distribution
                        .candidates
                        .iter()
                        .filter(|m| m.win_loss_pp.is_some_and(|w| w <= 5.0))
                        .map(|m| m.probability)
                        .sum();
                    let loss = actual.and_then(|m| m.win_loss_pp).unwrap_or(0.0);
                    let score = actual.and_then(|m| m.score_loss).unwrap_or(0.0);
                    let weight = if request.mode == "training" {
                        loss.max(score * 3.0) + (1.0 - safety - p.distribution.unknown).max(0.0) * 20.0
                    } else {
                        loss + (1.0 - safety) * 20.0
                    };
                    (weight, p.input.clone())
                })
                .collect::<Vec<_>>();
            priority.sort_by(|a, b| b.0.total_cmp(&a.0));
            priority.truncate(c.max_deep_positions);
            self.report.total += priority.len();
            self.report.phase = "重点补搜与加深".into();
            self.checkpoint(None, None)?;
            for (_, p) in priority {
                let result = self.analyze(&p, c.deep_visits, true, "deep")?;
                self.store(result)?;
            }
        } else {
            self.report.total = 1;
            self.report.phase = "当前局面加深".into();
            self.checkpoint(None, None)?;
            let root = self.analyze(&anchor, c.deep_visits, true, "deep")?;
            self.store(root.clone())?;
            if request.mode == "compare" {
                self.compare(&doc, root)?;
            } else if request.mode != "position" {
                return Err("未知分析模式".into());
            }
        }
        Ok(())
    }
    fn compare(&mut self, doc: &Document, root: PositionResult) -> Result<(), String> {
        let request = self.report.request.clone();
        let c = request.config;
        let candidates = &root.distribution.candidates;
        let mut choices = vec![];
        if let Some(a) = &root.input.actual_move {
            choices.push(a.clone());
        }
        for a in &request.alternatives {
            if !candidates.iter().any(|m| &m.vertex == a) {
                return Err(format!("比较走法 {a} 不合法"));
            }
            if !choices.contains(a) {
                choices.push(a.clone());
            }
        }
        if request.alternatives.is_empty() {
            let mut near: Vec<_> = candidates
                .iter()
                .filter(|m| m.score_loss.is_some_and(|x| x <= 1.0) && m.win_loss_pp.is_some_and(|x| x <= 5.0))
                .collect();
            near.sort_by(|a, b| {
                a.order
                    .unwrap_or(u32::MAX)
                    .cmp(&b.order.unwrap_or(u32::MAX))
                    .then_with(|| b.probability.total_cmp(&a.probability))
            });
            for m in near {
                if choices.len() > c.max_alternatives {
                    break;
                }
                if !choices.contains(&m.vertex) {
                    choices.push(m.vertex.clone());
                }
            }
        }
        if choices.is_empty() {
            choices.push(best(&root)?);
        }
        if choices.len() > c.max_alternatives + 1 {
            return Err("比较走法超过预算，请减少候选".into());
        }
        self.report.phase = "比较后续容错".into();
        self.report.total += choices.len() * 2 * c.future_decisions;
        self.checkpoint(None, None)?;
        for a in choices {
            let mut text = doc.text.clone();
            let mut p = root.input.clone();
            let mut node_ids = vec![p.node_id];
            node_ids.push(advance(&mut text, &mut p, &a)?);
            let opponent = self.analyze(&p, c.deep_visits, true, "opponent")?;
            let replies = reasonable_replies(&opponent)?;
            for reply in replies {
                let mut state = p.clone();
                let mut sgf = text.clone();
                let mut ids = node_ids.clone();
                ids.push(advance(&mut sgf, &mut state, &reply.vertex)?);
                let loss = candidates.iter().find(|m| m.vertex == a);
                let mut branch = BranchResult {
                    root_move: a.clone(),
                    is_actual: Some(&a) == root.input.actual_move.as_ref(),
                    root_score_loss: loss.and_then(|m| m.score_loss),
                    root_win_loss_pp: loss.and_then(|m| m.win_loss_pp),
                    opponent_reply: reply.vertex.clone(),
                    opponent_probability: reply.probability,
                    states: vec![],
                    line: vec![],
                    sgf_text: String::new(),
                    node_ids: vec![],
                };
                for step in 0..c.future_decisions {
                    let own = self.analyze(&state, c.deep_visits, true, "branch")?;
                    let continuation = best(&own)?;
                    annotate(&mut sgf, &own, &self.report.request.config)?;
                    branch.states.push(own);
                    ids.push(advance(&mut sgf, &mut state, &continuation)?);
                    self.report.completed += 1;
                    branch.line = state.moves[root.input.moves.len()..].to_vec();
                    branch.sgf_text = sgf.clone();
                    branch.node_ids = ids.clone();
                    if let Some(i) = self
                        .report
                        .branches
                        .iter()
                        .position(|b| b.root_move == a && b.opponent_reply == reply.vertex)
                    {
                        self.report.branches[i] = branch.clone();
                    } else {
                        self.report.branches.push(branch.clone());
                    }
                    self.checkpoint(None, Some(branch.clone()))?;
                    if step + 1 < c.future_decisions {
                        let opp = self.analyze(&state, c.deep_visits, false, "continuation")?;
                        ids.push(advance(&mut sgf, &mut state, &best(&opp)?)?);
                    }
                }
            }
        }
        self.report.total = self.report.completed;
        Ok(())
    }
}
pub fn best(p: &PositionResult) -> Result<String, String> {
    p.response
        .move_infos
        .iter()
        .filter(|m| m.order.is_some())
        .min_by_key(|m| m.order.unwrap())
        .map(|m| m.vertex.clone())
        .ok_or_else(|| "引擎没有首选走法".into())
}
pub fn reasonable_replies(p: &PositionResult) -> Result<Vec<LossCandidate>, String> {
    let preferred = best(p)?;
    let mut reasonable: Vec<_> = p
        .distribution
        .candidates
        .iter()
        .filter(|m| m.score_loss.is_some_and(|l| l <= 1.5))
        .cloned()
        .collect();
    reasonable.sort_by(|a, b| {
        (b.vertex == preferred)
            .cmp(&(a.vertex == preferred))
            .then_with(|| b.probability.total_cmp(&a.probability))
    });
    let mut seen = HashSet::new();
    reasonable.retain(|m| seen.insert(m.vertex.clone()));
    reasonable.truncate(2);
    if reasonable.is_empty() {
        return Err("没有充分搜索的合理对手应手，请提高计算预算".into());
    }
    Ok(reasonable)
}

fn annotate(text: &mut String, p: &PositionResult, c: &ReviewConfig) -> Result<(), String> {
    let doc = Document::parse(text)?;
    let previous = doc
        .tree
        .nodes
        .iter()
        .find(|n| n.id == p.input.node_id)
        .and_then(|n| n.comment.as_deref())
        .unwrap_or("");
    let score: f64 = p
        .distribution
        .candidates
        .iter()
        .filter(|m| m.score_loss.is_some_and(|v| v <= 1.0))
        .map(|m| m.probability)
        .sum();
    let win: f64 = p
        .distribution
        .candidates
        .iter()
        .filter(|m| m.win_loss_pp.is_some_and(|v| v <= 5.0))
        .map(|m| m.probability)
        .sum();
    let note=format!("{previous}\n[容错复盘 / HumanSL {}] 代表性引擎变化；行棋方 {}；目损失≤1 的概率 {:.1}%；胜率损失≤5pp 的概率 {:.1}%；未知 {:.1}%。人类风格代理，非整局失败概率。",c.human_profile,p.input.player,100.0*score,100.0*win,100.0*p.distribution.unknown);
    *text = sgf::update_sgf_node_comment(text, p.input.node_id, Some(&note)).map_err(|e| e.to_string())?;
    Ok(())
}
