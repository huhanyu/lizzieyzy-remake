//! Pinned official model metadata shared with the browser preview.
//! Installation uses the existing verified asset pipeline, never a second downloader.
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelCatalogEntry {
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_version: Option<String>,
    pub compatibility: String,
}

#[tauri::command]
pub(crate) fn engine_model_catalog() -> Result<Vec<ModelCatalogEntry>, String> {
    let entries: Vec<ModelCatalogEntry> =
        serde_json::from_str(include_str!("../../src/domain/modelCatalog.json"))
            .map_err(|_| "模型目录格式无效")?;
    let mut ids = std::collections::HashSet::new();
    for entry in &entries {
        if !ids.insert(&entry.id)
            || !["balanced", "light", "deep", "quick", "human"].contains(&entry.purpose.as_str())
            || entry.bytes == 0
            || entry.description.trim().is_empty()
            || entry.compatibility.trim().is_empty()
        {
            return Err("模型目录内容无效".into());
        }
        super::engine_assets::validate_request(&super::engine_assets::AssetInstallRequest {
            id: "00000000-0000-4000-8000-000000000001".into(),
            name: entry.name.clone(),
            url: entry.url.clone(),
            sha256: entry.sha256.clone(),
            kind: "model".into(),
        })?;
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_catalog_is_installable_and_covers_each_purpose() {
        let entries = engine_model_catalog().unwrap();
        for purpose in ["balanced", "light", "deep", "quick", "human"] {
            assert_eq!(entries.iter().filter(|e| e.purpose == purpose).count(), 1);
        }
        let light = entries.iter().find(|e| e.purpose == "light").unwrap();
        let quick = entries.iter().find(|e| e.purpose == "quick").unwrap();
        assert_eq!(light.sha256, quick.sha256);
        assert_eq!(light.url, quick.url);
        assert_eq!(light.minimum_version.as_deref(), Some("1.17.0"));
    }

    #[test]
    fn extra_models_allowlist_is_narrow() {
        let human = engine_model_catalog()
            .unwrap()
            .into_iter()
            .find(|e| e.purpose == "human")
            .unwrap();
        let mut request = super::super::engine_assets::AssetInstallRequest {
            id: "00000000-0000-4000-8000-000000000001".into(),
            name: human.name,
            url: human.url,
            sha256: human.sha256,
            kind: "model".into(),
        };
        for bad in [
            "https://media.katagotraining.org/uploaded/networks/models_extra/other.bin.gz",
            "https://media.katagotraining.org.evil.test/uploaded/networks/models_extra/b18c384nbt-humanv0.bin.gz",
            "https://media.katagotraining.org/uploaded/networks/models_extra/b18c384nbt-humanv0.bin.gz?redirect=1",
        ] {
            request.url = bad.into();
            assert!(super::super::engine_assets::validate_request(&request).is_err());
        }
    }
}
