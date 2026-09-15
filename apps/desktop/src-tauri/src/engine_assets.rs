//! Application-owned, immutable asset installations. Never modifies user engine directories.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
#[path = "engine_asset_io.rs"]
mod asset_io;
use asset_io::{cancelled, client, copy_verified, download_verified, extract_engine};
const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
#[derive(Default)]
pub(crate) struct AssetDownloads(Mutex<HashMap<String, Arc<AtomicBool>>>);
struct ImportLease<'a> {
    state: &'a AssetDownloads,
    id: String,
}
impl Drop for ImportLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.0.lock() {
            active.remove(&self.id);
        }
    }
}
#[tauri::command]
pub(crate) async fn engine_asset_cleanup(app: AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AssetDownloads>();
        let active = state.0.lock().map_err(|_| "下载状态不可用")?;
        let mut count = 0;
        for entry in fs::read_dir(root(&app)?).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_prefix(".staging-") else {
                continue;
            };
            if valid_id(id).is_ok()
                && !active.contains_key(id)
                && entry.file_type().map_err(|e| e.to_string())?.is_dir()
            {
                fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
                count += 1;
            }
        }
        Ok(count)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetInstallRequest {
    pub id: String,
    pub name: String,
    pub url: String,
    pub sha256: String,
    pub kind: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledAsset {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub sha256: String,
    pub source: String,
    pub path: String,
    pub bytes: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    received: u64,
    total: Option<u64>,
    phase: &'static str,
}
#[path = "engine_hardware.rs"]
mod hardware;
#[tauri::command]
pub(crate) async fn engine_hardware() -> Result<hardware::HardwareInfo, String> {
    tauri::async_runtime::spawn_blocking(hardware::detect)
        .await
        .map_err(|e| e.to_string())
}
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("managed-engines");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("受管资源目录不能是符号链接".into());
    }
    path.canonicalize().map_err(|e| e.to_string())
}
fn valid_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "资源 ID 无效".into())
}
pub(crate) fn validate_request(request: &AssetInstallRequest) -> Result<(), String> {
    valid_id(&request.id)?;
    if request.name.trim().is_empty()
        || request.name.len() > 200
        || !["engine", "model"].contains(&request.kind.as_str())
    {
        return Err("资源名称或类型无效".into());
    }
    if request.sha256.len() != 64 || !request.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("请输入发布方提供的 64 位 SHA-256 校验值".into());
    }
    let url = reqwest::Url::parse(&request.url).map_err(|_| "下载地址无效")?;
    let official = (url.host_str() == Some("github.com")
        && url.path().starts_with("/lightvector/KataGo/releases/download/"))
        || (url.host_str() == Some("media.katagotraining.org")
            && (url.path().starts_with("/uploaded/networks/models/")
                || url.path() == "/uploaded/networks/models_extra/b18c384nbt-humanv0.bin.gz"));
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !official
    {
        return Err("仅支持 KataGo 官方发布页及官方模型下载地址".into());
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn engine_release_catalog() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let response=client()?.get("https://api.github.com/repos/lightvector/KataGo/releases/latest").send().map_err(|_|"无法读取 KataGo 官方发布目录")?.error_for_status().map_err(|_|"官方发布目录暂不可用")?;
        let mut body=String::new(); response.take(2_000_000).read_to_string(&mut body).map_err(|e|e.to_string())?;
        let value:serde_json::Value=serde_json::from_str(&body).map_err(|e|e.to_string())?;
        let assets:Vec<_>=value["assets"].as_array().into_iter().flatten().filter(|a| a["name"].as_str().is_some_and(|n|n.ends_with(".zip"))).map(|a|serde_json::json!({"name":a["name"],"url":a["browser_download_url"],"bytes":a["size"],"sha256":a["digest"].as_str().and_then(|v|v.strip_prefix("sha256:"))})).collect();
        Ok(serde_json::json!({"version":value["tag_name"],"url":value["html_url"],"assets":assets,"modelsUrl":"https://katagotraining.org/networks/"}))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub(crate) fn engine_assets_list(app: AppHandle) -> Result<Vec<InstalledAsset>, String> {
    let mut result = Vec::new();
    for entry in fs::read_dir(root(&app)?).map_err(|e| e.to_string())?.flatten() {
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let Ok(text) = fs::read_to_string(entry.path().join("manifest.json")) else {
            continue;
        };
        if let Ok(asset) = serde_json::from_str::<InstalledAsset>(&text) {
            result.push(asset);
        }
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}
#[tauri::command]
pub(crate) fn engine_asset_cancel(state: State<'_, AssetDownloads>, id: String) -> Result<(), String> {
    let downloads = state.0.lock().map_err(|_| "下载状态不可用")?;
    downloads
        .get(&id)
        .ok_or("下载已结束")?
        .store(true, Ordering::Relaxed);
    Ok(())
}
#[tauri::command]
pub(crate) async fn engine_asset_remove(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_asset(&app, &id))
        .await
        .map_err(|e| e.to_string())?
}
fn remove_asset(app: &AppHandle, id: &str) -> Result<(), String> {
    let registry = app.state::<crate::AnalysisJobRegistry>();
    let _lifecycle = registry.lifecycle.lock().map_err(|_| "引擎生命周期状态不可用")?;
    if !registry.jobs.lock().map_err(|_| "引擎任务状态不可用")?.is_empty() {
        return Err("请先结束引擎连接，再清理资源，避免删除运行中的模型或引擎".into());
    }

    valid_id(&id)?;
    if app
        .state::<AssetDownloads>()
        .0
        .lock()
        .map_err(|_| "下载状态不可用")?
        .contains_key(id)
    {
        return Err("请先取消正在进行的下载".into());
    }
    let path = root(&app)?.join(id);
    let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || !path.join("manifest.json").is_file() {
        return Err("只能删除应用受管安装资源".into());
    }
    let profiles = crate::load_engine_profiles_settings(app.clone())?;
    for record in profiles.profiles {
        for configured in [
            Some(record.profile.engine_path.as_str()),
            record.profile.model_path.as_deref(),
            record.profile.config_path.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            let configured = PathBuf::from(configured);
            if configured.starts_with(&path) || configured.canonicalize().is_ok_and(|p| p.starts_with(&path))
            {
                return Err(format!(
                    "配置“{}”仍引用此资源，请先更换配置路径",
                    record.profile.name
                ));
            }
        }
    }
    fs::remove_dir_all(path).map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) async fn engine_asset_install(
    app: AppHandle,
    request: AssetInstallRequest,
) -> Result<InstalledAsset, String> {
    validate_request(&request)?;
    let token = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<AssetDownloads>();
        let mut active = state.0.lock().map_err(|_| "下载状态不可用")?;
        if active.len() >= 2 || active.contains_key(&request.id) {
            return Err("已有下载正在进行，请等待或取消".into());
        }
        active.insert(request.id.clone(), token.clone());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = install(&app, &request, &token);
        if let Ok(mut active) = app.state::<AssetDownloads>().0.lock() {
            active.remove(&request.id);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
fn install(
    app: &AppHandle,
    request: &AssetInstallRequest,
    token: &AtomicBool,
) -> Result<InstalledAsset, String> {
    let root = root(app)?;
    let target = root.join(&request.id);
    if target.exists() {
        return Err("该资源已存在，请使用新的安装 ID 更新".into());
    }
    let staging = root.join(format!(".staging-{}", request.id));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        let download = staging.join("download");
        let mut last = Instant::now() - Duration::from_secs(1);
        let bytes = download_verified(
            &request.url,
            &download,
            &request.sha256,
            token,
            |received, total| {
                if last.elapsed() > Duration::from_millis(250) {
                    last = Instant::now();
                    let _ = app.emit(
                        "engine://asset-progress",
                        DownloadProgress {
                            id: request.id.clone(),
                            received,
                            total,
                            phase: "downloading",
                        },
                    );
                }
            },
        )?;
        cancelled(token)?;
        let relative = if request.kind == "engine" {
            extract_engine(&download, &staging, token)?
        } else {
            fs::rename(&download, staging.join("model.bin.gz")).map_err(|e| e.to_string())?;
            PathBuf::from("model.bin.gz")
        };
        if download.exists() {
            fs::remove_file(&download).map_err(|e| e.to_string())?;
        }
        let asset = InstalledAsset {
            id: request.id.clone(),
            name: request.name.clone(),
            kind: request.kind.clone(),
            sha256: request.sha256.to_lowercase(),
            source: request.url.clone(),
            path: target.join(relative).to_string_lossy().into_owned(),
            bytes,
        };
        fs::write(
            staging.join("manifest.json"),
            serde_json::to_vec_pretty(&asset).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        cancelled(token)?;
        fs::rename(&staging, &target).map_err(|e| e.to_string())?;
        let _ = app.emit(
            "engine://asset-progress",
            DownloadProgress {
                id: request.id.clone(),
                received: bytes,
                total: Some(bytes),
                phase: "installed",
            },
        );
        Ok(asset)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checksum_and_cancel_are_verified_before_install() {
        let path = std::env::temp_dir().join(format!("asset-test-{}", uuid::Uuid::new_v4()));
        let data = b"small fixture";
        let digest = format!("{:x}", Sha256::digest(data));
        let cancel = AtomicBool::new(false);
        assert_eq!(
            copy_verified(&data[..], &path, &digest, &cancel, |_| {}).unwrap(),
            data.len() as u64
        );
        assert!(copy_verified(&data[..], &path, &"0".repeat(64), &cancel, |_| {}).is_err());
        cancel.store(true, Ordering::Relaxed);
        assert!(copy_verified(&data[..], &path, &digest, &cancel, |_| {}).is_err());
        let _ = fs::remove_file(path);
    }
    #[test]
    fn source_and_id_cannot_escape_managed_storage() {
        let mut r = AssetInstallRequest {
            id: uuid::Uuid::new_v4().to_string(),
            name: "test".into(),
            kind: "engine".into(),
            sha256: "a".repeat(64),
            url: "https://github.com/lightvector/KataGo/releases/download/v1/test.zip".into(),
        };
        assert!(validate_request(&r).is_ok());
        r.url = "https://github.com/evil/KataGo/releases/download/v1/test.zip".into();
        assert!(validate_request(&r).is_err());
        r.id = "../outside".into();
        assert!(validate_request(&r).is_err());
    }
}

#[tauri::command]
pub(crate) async fn engine_asset_import(
    app: AppHandle,
    source: String,
    kind: String,
) -> Result<InstalledAsset, String> {
    if !["engine", "model"].contains(&kind.as_str()) {
        return Err("资源类型无效".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(source);
        let metadata = fs::metadata(&source).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_BYTES {
            return Err("请选择不超过 4 GB 的文件".into());
        }
        let name = source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("文件名无效")?
            .to_owned();
        let mut input = File::open(&source).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = input.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            digest.update(&buf[..n]);
        }
        let sha = format!("{:x}", digest.finalize());
        let id = uuid::Uuid::new_v4().to_string();
        let state = app.state::<AssetDownloads>();
        {
            let mut active = state.0.lock().map_err(|_| "下载状态不可用")?;
            if active.len() >= 2 {
                return Err("已有资源操作进行中".into());
            }
            active.insert(id.clone(), Arc::new(AtomicBool::new(false)));
        }
        let _lease = ImportLease {
            state: &state,
            id: id.clone(),
        };
        let root = root(&app)?;
        let staging = root.join(format!(".staging-{id}"));
        let target = root.join(&id);
        fs::create_dir(&staging).map_err(|e| e.to_string())?;
        let result = (|| {
            let filename = if kind == "model" {
                "model.bin.gz"
            } else if cfg!(windows) {
                "katago.exe"
            } else {
                "katago"
            };
            let bytes = copy_verified(
                File::open(&source).map_err(|e| e.to_string())?,
                &staging.join(filename),
                &sha,
                &AtomicBool::new(false),
                |_| {},
            )?;
            #[cfg(unix)]
            if kind == "engine" {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(staging.join(filename), fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
            let asset = InstalledAsset {
                id,
                name,
                kind,
                sha256: sha,
                source: "local import".into(),
                path: target.join(filename).to_string_lossy().into_owned(),
                bytes,
            };
            fs::write(
                staging.join("manifest.json"),
                serde_json::to_vec_pretty(&asset).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            fs::rename(&staging, &target).map_err(|e| e.to_string())?;
            Ok(asset)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(staging);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod fixture_tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn real_small_http_fixture_download_checks_digest() {
        let data = b"fixture bytes";
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let _ = stream.read(&mut request).unwrap();
                write!(stream,"HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes 0-{}/{}\r\nConnection: close\r\n\r\n",data.len(),data.len()-1,data.len()).unwrap();
                stream.write_all(data).unwrap();
            }
        });
        let path = std::env::temp_dir().join(format!("http-fixture-{}", uuid::Uuid::new_v4()));
        let token = AtomicBool::new(false);
        let url = format!("http://{address}/fixture");
        assert_eq!(
            download_verified(
                &url,
                &path,
                &format!("{:x}", Sha256::digest(data)),
                &token,
                |_, _| {}
            )
            .unwrap(),
            data.len() as u64
        );
        assert!(download_verified(&url, &path, &"0".repeat(64), &token, |_, _| {}).is_err());
        server.join().unwrap();
        let _ = fs::remove_file(path);
    }
    #[test]
    fn zip_install_finds_engine_and_rejects_traversal() {
        let root = std::env::temp_dir().join(format!("zip-fixture-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let archive = root.join("fixture.zip");
        for (name, good) in [("katago", true), ("../escape", false)] {
            let mut zip = zip::ZipWriter::new(File::create(&archive).unwrap());
            zip.start_file(name, zip::write::FileOptions::default()).unwrap();
            zip.write_all(b"fake engine").unwrap();
            zip.finish().unwrap();
            let result = extract_engine(&archive, &root, &AtomicBool::new(false));
            assert_eq!(result.is_ok(), good);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
