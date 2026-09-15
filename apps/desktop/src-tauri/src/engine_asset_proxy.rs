//! Read-only macOS HTTPS proxy fallback for official asset traffic.
use reqwest::blocking::ClientBuilder;

pub(super) fn configure(builder: ClientBuilder) -> ClientBuilder {
    if ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]
        .iter()
        .any(|key| std::env::var_os(key).is_some())
    {
        return builder;
    }
    let Some(address) = system_proxy() else {
        return builder;
    };
    // Keep this fallback limited to the same official hosts as the downloader.
    builder.proxy(reqwest::Proxy::custom(move |url| {
        if url.scheme() == "https"
            && matches!(
                url.host_str(),
                Some(
                    "github.com"
                        | "api.github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                        | "media.katagotraining.org"
                )
            )
        {
            Some(address.clone())
        } else {
            None
        }
    }))
}

#[cfg(target_os = "macos")]
fn system_proxy() -> Option<String> {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let mut child = Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let output = child.wait_with_output().ok()?;
                return parse(&String::from_utf8(output.stdout).ok()?);
            }
            Ok(Some(_)) => return None,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}
#[cfg(not(target_os = "macos"))]
fn system_proxy() -> Option<String> {
    None
}

fn parse(text: &str) -> Option<String> {
    let field = |key: &str| -> Option<&str> {
        let mut values = text.lines().filter_map(|line| {
            let (name, value) = line.trim().split_once(':')?;
            (name.trim() == key).then_some(value.trim())
        });
        let value = values.next()?;
        if values.next().is_some() {
            None
        } else {
            Some(value)
        }
    };
    if field("HTTPSEnable")? != "1" {
        return None;
    }
    let host = field("HTTPSProxy")?;
    let port: u16 = field("HTTPSPort")?.parse().ok()?;
    if port == 0 || host.is_empty() || host.len() > 253 {
        return None;
    }
    // Accept hostnames and IP addresses, never URL paths, credentials or whitespace.
    let raw_host = if host.starts_with('[') && host.ends_with(']') {
        &host[1..host.len() - 1]
    } else {
        host
    };
    let ip = raw_host.parse::<std::net::IpAddr>().ok();
    let authority = if let Some(ip) = ip {
        match ip {
            std::net::IpAddr::V6(_) => format!("[{ip}]"),
            _ => ip.to_string(),
        }
    } else {
        if !host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        }) {
            return None;
        }
        host.to_owned()
    };
    Some(format!("http://{authority}:{port}"))
}

#[cfg(test)]
mod tests {
    use super::parse;
    #[test]
    fn enabled_proxy_is_parsed() {
        assert_eq!(
            parse("<dictionary> {\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890\n}"),
            Some("http://127.0.0.1:7890".into())
        );
        assert_eq!(
            parse("HTTPSEnable : 1\nHTTPSProxy : ::1\nHTTPSPort : 7890"),
            Some("http://[::1]:7890".into())
        );
    }
    #[test]
    fn disabled_and_invalid_proxy_are_ignored() {
        for text in [
            "HTTPSEnable : 0\nHTTPSProxy : localhost\nHTTPSPort : 7890",
            "HTTPSEnable : 1\nHTTPSProxy : user:pass@localhost\nHTTPSPort : 7890",
            "HTTPSEnable : 1\nHTTPSProxy : localhost/path\nHTTPSPort : 7890",
            "HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 0",
            "HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 99999",
            "HTTPSEnable : 1\nHTTPSProxy : localhost",
            "HTTPSEnable : 1\nHTTPSEnable : 0\nHTTPSProxy : localhost\nHTTPSPort : 7890",
        ] {
            assert!(parse(text).is_none(), "{text}");
        }
    }
}
