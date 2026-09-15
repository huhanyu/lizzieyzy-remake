use app_model::{ProviderFetchRequest, ProviderFetchResult, ProviderError};
use provider_core::transport_failed;
/// Keep legacy blocking HTTP/retry work off the desktop event loop.
#[tauri::command]
pub async fn fetch_online_kifu(request: ProviderFetchRequest) -> Result<ProviderFetchResult, ProviderError> {
    tauri::async_runtime::spawn_blocking(move || super::provider_fetch_fox(request))
        .await.map_err(|_| transport_failed("棋谱查询任务中断"))?
}
