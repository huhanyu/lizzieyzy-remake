//! Store only the reusable account token, never the password. No shell commands or files.
const SERVICE: &str = "org.lizzieyzy.next.zhizi";
const ACCOUNT: &str = "remembered-login";
#[cfg(target_os = "macos")]
pub fn save(account: &str, token: &str) -> Result<(), String> {
    let bytes = serde_json::to_vec(&(account, token)).map_err(|_| "凭据编码失败")?;
    security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, &bytes).map_err(|_| "无法保存到系统钥匙串".into())
}
#[cfg(target_os = "macos")]
pub fn load() -> Result<Option<(String,String)>, String> {
    match security_framework::passwords::get_generic_password(SERVICE, ACCOUNT) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| "钥匙串凭据无效".into()),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(_) => Err("无法读取系统钥匙串".into()),
    }
}
#[cfg(target_os = "macos")]
pub fn forget() -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT) {
        Ok(()) => Ok(()), Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("无法删除系统钥匙串凭据".into()),
    }
}
#[cfg(not(target_os = "macos"))]
pub fn save(_: &str, _: &str) -> Result<(), String> { Err("此平台尚未启用安全凭据存储".into()) }
#[cfg(not(target_os = "macos"))]
pub fn load() -> Result<Option<(String,String)>, String> { Ok(None) }
#[cfg(not(target_os = "macos"))]
pub fn forget() -> Result<(), String> { Ok(()) }
