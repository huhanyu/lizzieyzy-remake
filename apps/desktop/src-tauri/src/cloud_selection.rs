//! Official-app display names supplied by the user; legacy Java presets retained.
//! These are not a live inventory or a guarantee of account entitlement.
use serde::{Deserialize, Serialize};
const MODELS: &[&str] = &["11b768t", "10b384t", "10b512t", "20b", "18bnbt", "28bnbt", "fdx"];
#[derive(Clone, Deserialize, Serialize)]
pub struct CloudSelection { pub plan: String, pub backend: String, pub model: String }
impl Default for CloudSelection {
    fn default() -> Self { Self { plan: "vip-share".into(), backend: "katago-TENSORRT".into(), model: "28bnbt".into() } }
}
impl CloudSelection {
    pub fn args(&self) -> Result<String, String> {
        if !["vip-share", "1x", "3x", "6x", "12x", "24x"].contains(&self.plan.as_str())
            || !["katago-TENSORRT", "katago-CUDA"].contains(&self.backend.as_str())
            || !MODELS.contains(&self.model.as_str()) {
            return Err("请选择受支持的 KataGo 套餐和模型".into());
        }
        if self.backend == "katago-CUDA" && self.plan != "1x" { return Err("CUDA 预设仅支持 1x 套餐".into()); }
        Ok(format!("--platform all --engine-type go --gpu-type {} --kata-name {} --kata-weight {}", self.plan, self.backend, self.model))
    }
}
pub fn catalog() -> serde_json::Value {
    serde_json::json!({"source":"官方应用截图预设（新模型接口待实测），保留旧版模型", "plans":["vip-share","1x","3x","6x","12x","24x"],"backends":["katago-TENSORRT","katago-CUDA"],"models":MODELS})
}
#[cfg(test)] mod tests { use super::*;
    #[test] fn official_app_models_are_forwarded_exactly() {
        for model in ["10b384t", "10b512t", "20b", "11b768t"] {
            let mut selection = CloudSelection::default();
            selection.model = model.into();
            assert!(selection.args().unwrap().ends_with(&format!("--kata-weight {}", model)));
        }
    }
    #[test] fn rejects_unlisted_and_injected_options() {
        let mut s=CloudSelection::default(); assert!(s.args().unwrap().contains("vip-share"));
        s.model="28bnbt --other".into(); assert!(s.args().is_err());
        s.model="28bnbt".into(); s.backend="leela".into(); assert!(s.args().is_err());
        s.backend="katago-CUDA".into(); assert!(s.args().is_err());
        s.plan="1x".into(); assert!(s.args().is_ok());
    }
}
