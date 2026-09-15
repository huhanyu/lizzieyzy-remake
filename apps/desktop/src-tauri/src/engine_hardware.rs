//! Best-effort hardware discovery; absence of a tool is not evidence that a GPU is absent.
use serde::Serialize;
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HardwareInfo {
    os: &'static str,
    arch: &'static str,
    threads: usize,
    gpus: Vec<String>,
    suggested_backend: &'static str,
}
fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut output = String::new();
        let _ = stdout.by_ref().take(65536).read_to_string(&mut output);
        output
    });
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    reader.join().ok().filter(|v| !v.is_empty())
}
pub(super) fn detect() -> HardwareInfo {
    let mut gpus = Vec::new();
    if cfg!(target_os = "macos") {
        if let Some(text) = command_output("/usr/sbin/system_profiler", &["SPDisplaysDataType", "-json"]) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                for gpu in value["SPDisplaysDataType"].as_array().into_iter().flatten() {
                    if let Some(name) = gpu["sppci_model"].as_str().or_else(|| gpu["_name"].as_str()) {
                        gpus.push(name.to_owned());
                    }
                }
            }
        }
    } else if let Some(text) = command_output("nvidia-smi", &["--query-gpu=name", "--format=csv,noheader"]) {
        gpus.extend(text.lines().take(16).map(str::to_owned));
    }
    HardwareInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        threads: std::thread::available_parallelism().map_or(1, |n| n.get()),
        gpus,
        suggested_backend: if cfg!(target_os = "macos") {
            "导入兼容 macOS 的 KataGo，或使用已安装的系统引擎"
        } else {
            "按实际 GPU 驱动选择 CUDA / TensorRT / OpenCL；无 GPU 可选 Eigen"
        },
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_tool_is_unknown_not_a_false_gpu() {
        assert!(command_output("/nonexistent/lizzie-hardware-probe", &[]).is_none());
    }
}
