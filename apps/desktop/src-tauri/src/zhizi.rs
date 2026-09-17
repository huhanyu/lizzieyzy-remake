//! Session-only Zhizi authentication. Never expose either token through IPC.
use serde::Serialize;
#[path = "cloud_keychain.rs"]
mod cloud_keychain;
#[path = "cloud_selection.rs"]
mod cloud_selection;
use cloud_selection::CloudSelection;
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::{Arc, Mutex},
    time::Duration,
};

const BASE: &str = "https://www.zhizigo.com";
const INVALID: &str = "智子云返回的数据无效";
const STALE: &str = "登录状态已改变，请重试";

#[derive(Clone, Default)]
pub struct ZhiziState {
    inner: Arc<Mutex<Session>>,
}
#[derive(Default)]
struct Session {
    generation: u64,
    credentials: Option<AccountCredentials>,
    selection: CloudSelection,
}
struct AccountCredentials {
    account: String,
    token: String,
}
#[derive(Serialize)]
pub struct ZhiziStatus {
    pub logged_in: bool,
    pub account: Option<String>,
    pub remembered: bool,
}
// Deliberately neither Debug nor Serialize: these values must remain backend-only.
pub struct SocketCredentials {
    pub socket_url: String,
    pub token: String,
}

impl ZhiziState {
    fn begin_login(&self) -> u64 {
        let mut session = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        session.generation = session.generation.wrapping_add(1);
        session.credentials = None;
        session.generation
    }
    fn finish_login(&self, generation: u64, account: String, token: String) -> Result<ZhiziStatus, String> {
        let mut session = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if session.generation != generation {
            return Err(STALE.into());
        }
        session.credentials = Some(AccountCredentials { account, token });
        Ok(status_of(&session))
    }
    pub fn status(&self) -> ZhiziStatus {
        status_of(&self.inner.lock().unwrap_or_else(|p| p.into_inner()))
    }
    pub fn logout(&self) {
        self.begin_login();
    }
    pub fn forget_after_logout(&self) -> Result<(), String> {
        let session = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        // A late logout worker must not delete credentials saved by a newer completed login.
        if session.credentials.is_none() { cloud_keychain::forget()?; }
        Ok(())
    }
    fn expire(&self, generation: u64) {
        let mut session = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if session.generation == generation {
            session.generation = session.generation.wrapping_add(1);
            session.credentials = None;
        }
    }
    /// Blocking HTTP; caller must invoke from its blocking worker, never the UI executor.
    /// Allocation is performed only on an explicit cloud-analysis start, never at login.
    pub fn allocate_vip(&self) -> Result<SocketCredentials, String> {
        let (generation, token, args) = {
            let session = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let credentials = session.credentials.as_ref().ok_or("请先登录智子云")?;
            (session.generation, credentials.token.clone(), session.selection.args()?)
        };
        let result = post(
            "/api/cluster/account/fetch-socketio-token",
            json!({"args": args}),
            Some(&token),
        );
        let response = match result {
            Err(ApiError::Unauthorized) => {
                self.expire(generation);
                return Err("智子云登录已过期，请重新登录".into());
            }
            Err(error) => return Err(error.message(false)),
            Ok(response) => response,
        };
        let credentials = parse_socket(&response)?;
        let session = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if session.generation != generation || session.credentials.is_none() {
            return Err(STALE.into());
        }
        Ok(credentials)
    }
}

fn status_of(session: &Session) -> ZhiziStatus {
    ZhiziStatus {
        logged_in: session.credentials.is_some(),
        remembered: false,
        account: session.credentials.as_ref().map(|c| mask_account(&c.account)),
    }
}
fn mask_account(account: &str) -> String {
    // Mask both local part and domain; no full identifier crosses the IPC boundary.
    let first = account.chars().next().unwrap_or('*');
    if account.contains('@') {
        format!("{first}***@***")
    } else {
        format!("{first}***")
    }
}
fn login_body(account: &str, password: &str) -> Value {
    if account.contains('@') {
        json!({"email":account, "password":password})
    } else {
        json!({"phone":account, "password":password})
    }
}
fn parse_token(response: &Value) -> Result<String, String> {
    response
        .get("token")
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty() && !t.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| INVALID.into())
}
fn parse_socket(response: &Value) -> Result<SocketCredentials, String> {
    let token = parse_token(response)?;
    let socket_url = response
        .get("socketIOURL")
        .and_then(Value::as_str)
        .ok_or(INVALID)?;
    let url = reqwest::Url::parse(socket_url).map_err(|_| INVALID)?;
    let host = url.host_str().ok_or(INVALID)?;
    if !matches!(url.scheme(), "https" | "wss")
        || !(host == "zhizigo.com" || host.ends_with(".zhizigo.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return Err("智子云连接地址未通过官方域名校验".into());
    }
    Ok(SocketCredentials {
        socket_url: socket_url.to_owned(),
        token,
    })
}
enum ApiError {
    Unauthorized,
    Status(u16),
    Network,
    Invalid,
}
impl ApiError {
    fn message(self, login: bool) -> String {
        match self {
            Self::Unauthorized if login => "账号或密码错误".into(),
            Self::Unauthorized => "智子云登录已过期，请重新登录".into(),
            Self::Status(403) => "智子云拒绝访问，请检查 VIP 资格".into(),
            Self::Status(429) => "智子云请求过于频繁，请稍后重试".into(),
            Self::Status(_) => "智子云服务暂不可用，请稍后重试".into(),
            Self::Network => "无法连接智子云，请检查网络后重试".into(),
            Self::Invalid => INVALID.into(),
        }
    }
}
fn post(path: &str, body: Value, token: Option<&str>) -> Result<Value, ApiError> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ApiError::Network)?;
    let mut request = client
        .post(format!("{BASE}{path}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(serde_json::to_string(&body).map_err(|_| ApiError::Invalid)?);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().map_err(|_| ApiError::Network)?;
    let code = response.status().as_u16();
    if code == 401 {
        return Err(ApiError::Unauthorized);
    }
    if !(200..300).contains(&code) {
        return Err(ApiError::Status(code));
    }
    // Limit the response size, and never forward response bodies or reqwest errors.
    let mut bytes = Vec::new();
    response
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| ApiError::Network)?;
    if bytes.len() > 65_536 {
        return Err(ApiError::Invalid);
    }
    serde_json::from_slice(&bytes).map_err(|_| ApiError::Invalid)
}

#[tauri::command]
pub async fn zhizi_login(
    account: String,
    password: String,
    remember: Option<bool>,
    state: tauri::State<'_, ZhiziState>,
) -> Result<ZhiziStatus, String> {
    let account = account.trim().to_owned();
    if account.is_empty()
        || account.len() > 320
        || password.is_empty()
        || password.len() > 4096
        || account.chars().any(char::is_control)
    {
        return Err("请输入有效的邮箱或手机号及密码".into());
    }
    let state = state.inner().clone();
    let generation = state.begin_login();
    tauri::async_runtime::spawn_blocking(move || {
        let response = post(
            "/api/cluster/account/login",
            login_body(&account, &password),
            None,
        )
        .map_err(|e| e.message(true))?;
        let token = parse_token(&response)?;
        // Hold the generation lock during persistence so logout/new login cannot save an old account.
        {
            let session = state.inner.lock().unwrap_or_else(|p| p.into_inner());
            if session.generation != generation { return Err(STALE.into()); }
            if remember.unwrap_or(false) {
                cloud_keychain::save(&account, &token)?;
            } else { cloud_keychain::forget()?; }
        }
        let mut status = state.finish_login(generation, account, token)?;
        status.remembered = remember.unwrap_or(false);
        Ok(status)
    })
    .await
    .map_err(|_| "智子云登录任务失败，请重试".to_owned())?
}
#[tauri::command]
pub fn zhizi_status(state: tauri::State<'_, ZhiziState>) -> ZhiziStatus {
    state.status()
}
#[tauri::command]
pub fn zhizi_catalog() -> serde_json::Value { cloud_selection::catalog() }

#[tauri::command]
pub fn zhizi_get_selection(state: tauri::State<'_, ZhiziState>) -> CloudSelection {
    state.inner.lock().unwrap_or_else(|p| p.into_inner()).selection.clone()
}

#[tauri::command]
pub fn zhizi_set_selection(selection: CloudSelection, state: tauri::State<'_, ZhiziState>) -> Result<(), String> {
    selection.args()?;
    let mut session = state.inner.lock().unwrap_or_else(|p| p.into_inner());
    session.generation = session.generation.wrapping_add(1);
    session.selection = selection;
    Ok(())
}

#[tauri::command]
pub async fn zhizi_restore_login(state: tauri::State<'_, ZhiziState>) -> Result<ZhiziStatus, String> {
    let state = state.inner().clone();
    let generation = state.begin_login();
    tauri::async_runtime::spawn_blocking(move || {
        let Some((account, token)) = cloud_keychain::load()? else { return Ok(state.status()); };
        let mut status = state.finish_login(generation, account, token)?;
        status.remembered = true;
        Ok(status)
    }).await.map_err(|_| "无法读取钥匙串".to_owned())?
}


#[tauri::command]
pub async fn zhizi_forget_login() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(cloud_keychain::forget).await.map_err(|_| "无法删除钥匙串凭据".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_and_parse() {
        assert_eq!(
            login_body("a@b.com", "secret"),
            json!({"email":"a@b.com", "password":"secret"})
        );
        assert_eq!(login_body("123", "secret")["phone"], "123");
        assert!(parse_token(&json!({"token":"ok"})).is_ok());
        for value in [
            json!({}),
            json!({"token":123}),
            json!({"token":""}),
            json!({"token":"\n"}),
        ] {
            assert!(parse_token(&value).is_err());
        }
        assert!(ApiError::Unauthorized.message(true).contains("密码"));
        assert!(ApiError::Unauthorized.message(false).contains("过期"));
    }
    #[test]
    fn socket_credentials_reject_untrusted_destinations() {
        for url in ["https://zhizigo.com", "wss://worker.zhizigo.com/socket.io/"] {
            assert!(parse_socket(&json!({"token":"temporary", "socketIOURL":url})).is_ok());
        }
        for url in [
            "https://zhizigo.com.evil.com",
            "https://evilzhizigo.com",
            "http://worker.zhizigo.com",
            "https://user@zhizigo.com",
            "https://zhizigo.com:444",
            "https://127.0.0.1",
            "file:///tmp/foo",
        ] {
            assert!(parse_socket(&json!({"token":"temporary", "socketIOURL":url})).is_err());
        }
    }
    #[test]
    fn logout_and_new_login_reject_late_completion() {
        let state = ZhiziState::default();
        let old = state.begin_login();
        state.logout();
        assert!(state
            .finish_login(old, "old@example.com".into(), "old-token".into())
            .is_err());
        let current = state.begin_login();
        assert!(state
            .finish_login(current, "new@example.com".into(), "new-token".into())
            .is_ok());
        state.expire(old);
        assert!(state.status().logged_in);
        state.expire(current);
        assert!(!state.status().logged_in);
        assert!(state.status().account.is_none());
    }
    #[test]
    fn status_does_not_serialize_secrets() {
        let state = ZhiziState::default();
        let generation = state.begin_login();
        let status = state
            .finish_login(generation, "private@example.com".into(), "private-token".into())
            .unwrap();
        let output = serde_json::to_string(&status).unwrap();
        assert!(!output.contains("private"));
        assert!(!output.contains("token"));
        assert!(status.logged_in);
    }
}
