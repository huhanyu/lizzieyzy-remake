//! Streaming download verification and bounded archive extraction, independent of Tauri state.
use super::MAX_BYTES;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
#[path = "engine_asset_proxy.rs"]
mod proxy;

pub(super) fn client() -> Result<reqwest::blocking::Client, String> {
    proxy::configure(reqwest::blocking::Client::builder())
        .user_agent("LizzieYzy-Next/0.1")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            let trusted = matches!(
                url.host_str(),
                Some(
                    "github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                        | "media.katagotraining.org"
                        | "api.github.com"
                )
            );
            if attempt.previous().len() < 8 && url.scheme() == "https" && trusted {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}
pub(super) fn cancelled(token: &AtomicBool) -> Result<(), String> {
    if token.load(Ordering::Relaxed) {
        Err("下载已取消，可重新开始".into())
    } else {
        Ok(())
    }
}
pub(super) fn copy_verified(
    mut input: impl Read,
    output: &Path,
    expected: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<u64, String> {
    let mut file = File::create(output).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buf = [0u8; 65536];
    loop {
        cancelled(cancel)?;
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        if bytes > MAX_BYTES {
            return Err("资源超过 4 GB 上限".into());
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        hash.update(&buf[..n]);
        progress(bytes);
    }
    file.sync_all().map_err(|e| e.to_string())?;
    if format!("{:x}", hash.finalize()) != expected.to_lowercase() {
        return Err("SHA-256 校验失败，未安装任何资源".into());
    }
    Ok(bytes)
}
// Bounded range requests keep a stalled connection cancellable within 15 seconds,
// without an overall timeout that would prevent large model downloads on slower links.
pub(super) fn download_verified(
    url: &str,
    output: &Path,
    expected: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<u64, String> {
    const CHUNK: u64 = 4 * 1024 * 1024;
    let client = client()?;
    let mut file = File::create(output).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut offset = 0u64;
    loop {
        cancelled(cancel)?;
        let mut response = client
            .get(url)
            .header(
                reqwest::header::RANGE,
                format!("bytes={offset}-{}", offset + CHUNK - 1),
            )
            .timeout(Duration::from_secs(15))
            .send()
            .map_err(|_| "下载连接超时或失败，可重新开始")?
            .error_for_status()
            .map_err(|_| "官方服务器拒绝下载请求")?;
        let (expected_chunk, total) = if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            let range = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .ok_or("服务器未返回分段范围")?;
            let values: Vec<u64> = range
                .strip_prefix("bytes ")
                .ok_or("下载范围无效")?
                .split(['-', '/'])
                .map(str::parse)
                .collect::<Result<_, _>>()
                .map_err(|_| "下载范围无效")?;
            if values.len() != 3
                || values[0] != offset
                || values[1] < offset
                || values[1] - offset + 1 > CHUNK
                || values[2] > MAX_BYTES
                || values[1] >= values[2]
            {
                return Err("服务器下载范围不匹配".into());
            }
            (values[1] - offset + 1, values[2])
        } else if offset == 0 && response.content_length().is_some_and(|n| n <= CHUNK) {
            let total = response.content_length().unwrap();
            (total, total)
        } else {
            return Err("服务器不支持可靠的分段下载，请使用本地导入".into());
        };
        let mut received = 0u64;
        let mut buf = [0u8; 65536];
        loop {
            cancelled(cancel)?;
            let n = response.read(&mut buf).map_err(|_| "下载中断，可重新开始")?;
            if n == 0 {
                break;
            }
            received += n as u64;
            if received > expected_chunk {
                return Err("下载长度超出声明范围".into());
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            hash.update(&buf[..n]);
            progress(offset + received, Some(total));
        }
        if received != expected_chunk {
            return Err("下载不完整，可重新开始".into());
        }
        offset += received;
        if offset == total {
            break;
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    cancelled(cancel)?;
    if format!("{:x}", hash.finalize()) != expected.to_lowercase() {
        return Err("SHA-256 校验失败，未安装任何资源".into());
    }
    Ok(offset)
}
pub(super) fn extract_engine(
    archive: &Path,
    directory: &Path,
    cancel: &AtomicBool,
) -> Result<PathBuf, String> {
    let mut zip =
        zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if zip.len() > 10000 {
        return Err("压缩包文件过多".into());
    }
    let mut expanded = 0u64;
    let mut engine = None;
    for i in 0..zip.len() {
        cancelled(cancel)?;
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let relative = entry.enclosed_name().ok_or("压缩包含非法路径")?.to_owned();
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err("压缩包不能包含符号链接".into());
        }
        expanded = expanded.checked_add(entry.size()).ok_or("压缩包大小溢出")?;
        if expanded > MAX_BYTES {
            return Err("解压资源超过 4 GB".into());
        }
        let target = directory.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        fs::create_dir_all(target.parent().ok_or("资源路径无效")?).map_err(|e| e.to_string())?;
        let mut output = File::create(&target).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 65536];
        loop {
            cancelled(cancel)?;
            let n = entry.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            output.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        }
        if matches!(
            target.file_name().and_then(|s| s.to_str()),
            Some("katago" | "katago.exe")
        ) {
            engine = Some(relative);
        }
    }
    let engine = engine.ok_or("压缩包中未找到 KataGo 引擎")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory.join(&engine), fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    Ok(engine)
}
