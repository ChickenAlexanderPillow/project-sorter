use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::stream;
use keyring::Entry;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, atomic::{AtomicBool, Ordering}, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(not(target_os = "windows"))]
use tauri_plugin_opener::OpenerExt;
#[cfg(target_os = "windows")]
use std::{os::windows::process::CommandExt, process::Command};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use url::Url;
use uuid::Uuid;

const API: &str = "https://api.frame.io/v4";
const IMS: &str = "https://ims-na1.adobelogin.com/ims";
pub const REDIRECT_URI: &str = "adobe+4694cbd42914a67015f420c3d5241c8540f26611://adobeid/5bfe79c1be7d40af8ed450499e30c2c7";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const CLAIM_STALE_AFTER: Duration = Duration::from_secs(180);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SharedRecord {
    pub schema_version: u32,
    pub state: String,
    pub source_size: u64,
    pub source_modified_nanos: u128,
    pub destination_account_id: String,
    pub destination_project_id: String,
    pub destination_folder_id: String,
    #[serde(default)]
    pub production_project_name: String,
    #[serde(default)]
    pub client_key: String,
    #[serde(default)]
    pub remote_name: String,
    pub file_id: Option<String>,
    #[serde(default)]
    pub version_stack_id: Option<String>,
    pub share_id: Option<String>,
    pub share_url: Option<String>,
    pub updated_at: String,
    pub last_error: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    approval_path: String,
    state: String,
    uploaded: u64,
    total: u64,
    message: Option<String>,
    share_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FrameIoOption {
    pub id: String,
    pub name: String,
    pub workspace_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameIoStorage {
    pub used_bytes: u64,
    pub limit_bytes: u64,
}

struct PendingAuth {
    client_id: String,
    state: String,
    verifier: String,
}

#[derive(Default)]
pub struct Runtime {
    pending_auth: Mutex<Option<PendingAuth>>,
    auth_callback: Arc<Mutex<Option<String>>>,
    auth_cancel: Arc<AtomicBool>,
    auth_active: Arc<AtomicBool>,
}

impl Runtime {
    pub fn accept_auth_callback(&self, raw_url: &str) -> bool {
        let Ok(url) = Url::parse(raw_url) else { return false; };
        let Ok(expected) = Url::parse(REDIRECT_URI) else { return false; };
        if url.scheme() != expected.scheme() || url.host_str() != expected.host_str() || url.path() != expected.path() {
            return false;
        }
        let Ok(mut callback) = self.auth_callback.lock() else { return false; };
        *callback = Some(raw_url.to_string());
        true
    }
}

struct AuthActiveReset(Arc<AtomicBool>);
impl Drop for AuthActiveReset {
    fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); }
}

#[derive(Serialize, Deserialize)]
struct OAuthTokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

fn token_entry(client_id: &str, suffix: &str) -> Result<Entry, String> {
    Entry::new("Pepper.FrameIO", &format!("{client_id}:{suffix}"))
        .map_err(|error| format!("Unable to access the OS credential store: {error}"))
}

fn save_tokens(client_id: &str, tokens: &OAuthTokens) -> Result<(), String> {
    token_entry(client_id, "access")?.set_password(&tokens.access_token)
        .map_err(|error| format!("Unable to save the Adobe token securely: {error}"))?;
    if let Some(expires_in) = tokens.expires_in {
        let expires_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().saturating_add(expires_in);
        token_entry(client_id, "expires")?.set_password(&expires_at.to_string())
            .map_err(|error| format!("Unable to save Adobe token expiry securely: {error}"))?;
    }
    if let Some(refresh) = &tokens.refresh_token {
        token_entry(client_id, "refresh")?.set_password(refresh)
            .map_err(|error| format!("Unable to save the Adobe refresh token securely: {error}"))?;
    }
    Ok(())
}

async fn access_token(client_id: &str) -> Result<String, String> {
    let access = token_entry(client_id, "access")?.get_password().ok();
    let expiry = token_entry(client_id, "expires")?.get_password().ok().and_then(|value| value.parse::<u64>().ok());
    if let (Some(access), Some(expiry)) = (access, expiry) {
        if SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().saturating_add(90) < expiry {
            return Ok(access);
        }
    }
    let refresh = token_entry(client_id, "refresh")?.get_password().ok()
        .ok_or_else(|| "Connect your Adobe account to Frame.io first.".to_string())?;
    let client = Client::new();
    let response = client.post(format!("{IMS}/token/v3"))
        .query(&[("client_id", client_id)])
        .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh.as_str())])
        .send().await.map_err(|error| format!("Adobe token refresh failed: {error}"))?;
    if !response.status().is_success() {
        return Err("Adobe sign-in expired. Connect your Adobe account again.".into());
    }
    let tokens: OAuthTokens = response.json().await.map_err(|error| format!("Invalid Adobe token response: {error}"))?;
    save_tokens(client_id, &tokens)?;
    Ok(tokens.access_token)
}

#[tauri::command]
pub fn frameio_start_auth(
    client_id: String,
    scopes: String,
    runtime: tauri::State<'_, Runtime>,
) -> Result<String, String> {
    if client_id.trim().is_empty() || scopes.trim().is_empty() {
        return Err("Enter the OAuth Client ID and scopes from the Adobe Developer Console.".into());
    }
    runtime.auth_active.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "Adobe sign-in is already in progress. Finish it in your browser or cancel it in Pepper.".to_string())?;
    let mut pending = match runtime.pending_auth.lock() {
        Ok(pending) => pending,
        Err(_) => { runtime.auth_active.store(false, Ordering::SeqCst); return Err("Authentication state is unavailable".into()); }
    };
    runtime.auth_cancel.store(false, Ordering::SeqCst);
    if let Ok(mut callback) = runtime.auth_callback.lock() { *callback = None; }
    let state = Uuid::new_v4().to_string();
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = Url::parse(&format!("{IMS}/authorize/v2")).map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id.trim())
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", scopes.trim())
        .append_pair("response_type", "code")
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    *pending = Some(PendingAuth { client_id, state, verifier });
    Ok(url.to_string())
}

#[tauri::command]
pub async fn frameio_finish_auth(app: AppHandle, runtime: tauri::State<'_, Runtime>) -> Result<String, String> {
    let _active_reset = AuthActiveReset(runtime.auth_active.clone());
    let pending = runtime.pending_auth.lock().map_err(|_| "Authentication state is unavailable".to_string())?
        .take().ok_or_else(|| "Start Adobe sign-in first.".to_string())?;
    let callback_slot = runtime.auth_callback.clone();
    let deadline = std::time::Instant::now() + Duration::from_secs(180);
    let callback_url = loop {
        if runtime.auth_cancel.load(Ordering::SeqCst) { return Err("Adobe sign-in cancelled.".into()); }
        let callback = callback_slot.lock().map_err(|_| "Authentication state is unavailable".to_string())?.take();
        if let Some(callback) = callback { break callback; }
        if std::time::Instant::now() >= deadline { return Err("Adobe sign-in timed out before Pepper received Adobe's callback.".into()); }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let code = parse_auth_callback(&callback_url, &pending.state)?;
    let (client_id, verifier) = (pending.client_id, pending.verifier);
    let response = Client::new().post(format!("{IMS}/token/v3"))
        .query(&[("client_id", client_id.as_str())])
        .form(&[("code", code.as_str()), ("grant_type", "authorization_code"), ("code_verifier", verifier.as_str()), ("redirect_uri", REDIRECT_URI)])
        .send().await.map_err(|error| format!("Adobe token exchange failed: {error}"))?;
    if !response.status().is_success() { return Err("Adobe rejected the authorization code. Check the registered redirect URI and OAuth scopes.".into()); }
    let tokens: OAuthTokens = response.json().await.map_err(|error| format!("Invalid Adobe token response: {error}"))?;
    save_tokens(&client_id, &tokens)?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(client_id)
}

#[tauri::command]
pub fn frameio_cancel_auth(runtime: tauri::State<'_, Runtime>) {
    runtime.auth_cancel.store(true, Ordering::SeqCst);
    if let Ok(mut callback) = runtime.auth_callback.lock() { *callback = None; }
    if let Ok(mut pending) = runtime.pending_auth.lock() {
        if pending.take().is_some() {
            runtime.auth_active.store(false, Ordering::SeqCst);
        }
    }
}

fn parse_auth_callback(raw_url: &str, expected_state: &str) -> Result<String, String> {
    let callback = Url::parse(raw_url).map_err(|_| "Adobe returned an invalid callback URL.".to_string())?;
    let expected = Url::parse(REDIRECT_URI).map_err(|_| "Pepper's Adobe callback URI is invalid.".to_string())?;
    if callback.scheme() != expected.scheme() || callback.host_str() != expected.host_str() || callback.path() != expected.path() {
        return Err("Adobe returned the wrong callback URI. Check the Native App redirect URI in Adobe Developer Console.".into());
    }
    let query: HashMap<String, String> = callback.query_pairs().into_owned().collect();
    if let Some(error) = query.get("error") {
        let description = query.get("error_description").cloned().unwrap_or_default();
        return Err(format!("Adobe sign-in failed: {error} {description}").trim().to_string());
    }
    if query.get("state").map(String::as_str) != Some(expected_state) {
        return Err("Adobe sign-in state did not match.".into());
    }
    query.get("code").cloned().ok_or_else(|| "Adobe did not return an authorization code.".into())
}

#[tauri::command]
pub fn frameio_open_external_url(_app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Pepper received an invalid browser URL.".to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    let allowed_host = host == "ims-na1.adobelogin.com"
        || host == "frame.io"
        || host.ends_with(".frame.io")
        || host == "f.io";
    if parsed.scheme() != "https" || !allowed_host {
        return Err("Pepper can only open Adobe sign-in and Frame.io links.".into());
    }

    #[cfg(target_os = "windows")]
    {
        let mut candidates = Vec::new();
        for variable in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(variable) {
                candidates.push(PathBuf::from(root).join("Google/Chrome/Application/chrome.exe"));
            }
        }
        if let Some(chrome) = candidates.into_iter().find(|path| path.is_file()) {
            return Command::new(&chrome).arg(&url).creation_flags(CREATE_NO_WINDOW).spawn()
                .map(|_| ())
                .map_err(|error| format!("Could not launch Chrome: {error}"));
        }
        return Err("Could not find Chrome. Install Chrome, then try Adobe sign-in again.".into());
    }

    #[cfg(not(target_os = "windows"))]
    _app.opener().open_url(url, None::<&str>).map_err(|error| format!("Could not open the browser: {error}"))
}

#[derive(Deserialize)]
struct UploadUrl { url: String, size: u64 }

fn sidecar_path(video: &Path) -> PathBuf {
    let name = video.file_name().unwrap_or_default().to_string_lossy();
    video.with_file_name(format!("{name}.frameio.json"))
}

fn atomic_record(path: &Path, record: &SharedRecord) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "Approval folder is missing.".to_string())?;
    let bytes = serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|error| format!("Unable to stage shared upload status: {error}"))?;
    temp.write_all(&bytes).and_then(|_| temp.as_file().sync_all()).map_err(|error| error.to_string())?;
    temp.persist(path).map_err(|error| format!("Unable to publish shared upload status: {}", error.error))?;
    Ok(())
}

fn fingerprint(path: &Path) -> Result<(u64, u128), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("Cannot read approval copy: {error}"))?;
    let modified = metadata.modified().map_err(|error| error.to_string())?.duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos();
    Ok((metadata.len(), modified))
}

struct Claim { path: PathBuf, owner: String, stop: std::sync::mpsc::Sender<()>, heartbeat: Option<std::thread::JoinHandle<()>> }
impl Claim {
    fn acquire(video: &Path) -> Result<Self, String> {
        let busy_message = "Another Pepper computer is working on this approval copy.";
        let legacy_path = sidecar_path(video).with_extension("frameio.lock");
        match Self::acquire_path(legacy_path.clone(), busy_message) {
            Err(error) if error.starts_with("INVALID_CLAIM_PATH:") => {
                // Keep the legacy name as the primary lock so existing Pepper
                // instances still coordinate. Use a short stable name only
                // when Windows rejects the legacy path with ERROR_BAD_PATHNAME.
                if legacy_path.exists() {
                    return Err(busy_message.into());
                }
                let compact_path = compact_claim_path(video);
                Self::acquire_path(compact_path.clone(), busy_message).map_err(|fallback_error| {
                    if fallback_error == busy_message {
                        fallback_error
                    } else {
                        format!("Unable to claim approval copy. Legacy lock path '{}' was rejected; compact lock path '{}' also failed: {fallback_error}", legacy_path.display(), compact_path.display())
                    }
                })
            }
            result => result,
        }
    }

    fn acquire_path(path: PathBuf, busy_message: &str) -> Result<Self, String> {
        let owner = Uuid::new_v4().to_string();
        for _ in 0..2 {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    writeln!(file, "{owner}").map_err(|error| error.to_string())?;
                    file.sync_all().map_err(|error| error.to_string())?;
                    let (stop, thread_stop) = std::sync::mpsc::channel();
                    let thread_path = path.clone();
                    let thread_owner = owner.clone();
                    let heartbeat = std::thread::spawn(move || loop {
                        match thread_stop.recv_timeout(Duration::from_secs(30)) {
                            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                if let Ok(mut current) = OpenOptions::new().write(true).truncate(true).open(&thread_path) {
                                    let _ = writeln!(current, "{thread_owner}");
                                    let _ = current.sync_all();
                                }
                            }
                        }
                    });
                    return Ok(Self { path, owner, stop, heartbeat: Some(heartbeat) });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&path).and_then(|metadata| metadata.modified()).ok()
                        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                        .is_some_and(|age| age > CLAIM_STALE_AFTER);
                    if !stale { return Err(busy_message.into()); }
                    let stale_path = path.with_extension(format!("stale-{}.lock", Uuid::new_v4()));
                    if fs::rename(&path, stale_path).is_err() { return Err("The upload claim changed while recovering it. Refresh and try again.".into()); }
                }
                Err(error) if error.raw_os_error() == Some(161) => {
                    return Err(format!("INVALID_CLAIM_PATH:{}:{error}", path.display()));
                }
                Err(error) => return Err(format!("Unable to create shared upload lock '{}': {error}", path.display())),
            }
        }
        Err("Unable to acquire the shared upload claim.".into())
    }
}

fn compact_claim_path(video: &Path) -> PathBuf {
    let file_name = video.file_name().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
    let digest = Sha256::digest(file_name.as_bytes());
    let mut suffix = String::with_capacity(24);
    for byte in digest.iter().take(12) {
        use std::fmt::Write as _;
        let _ = write!(suffix, "{byte:02x}");
    }
    video.with_file_name(format!(".pepper-frameio-{suffix}.lock"))
}
impl Drop for Claim {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.heartbeat.take() { let _ = thread.join(); }
        if fs::read_to_string(&self.path).ok().is_some_and(|owner| owner.trim() == self.owner) { let _ = fs::remove_file(&self.path); }
    }
}

async fn api_json(client: &Client, token: &str, method: reqwest::Method, url: &str, body: Option<Value>) -> Result<Value, String> {
    let mut request = client.request(method, url).bearer_auth(token);
    if let Some(body) = body { request = request.json(&body); }
    let response = request.send().await.map_err(|error| format!("Frame.io request failed: {error}"))?;
    let status = response.status();
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    if status == StatusCode::UNAUTHORIZED { return Err("Frame.io sign-in expired. Reconnect Adobe in Pepper.".into()); }
    if status == StatusCode::TOO_MANY_REQUESTS { return Err("Frame.io rate limit reached. Wait briefly, then retry.".into()); }
    if !status.is_success() {
        let detail = value.pointer("/errors/0/detail").and_then(Value::as_str).unwrap_or("Frame.io rejected the request.");
        return Err(format!("Frame.io error ({}): {detail}", status.as_u16()));
    }
    Ok(value)
}

fn asset_is_still_ingesting(error: &str) -> bool {
    let rejected = [400, 409, 422].iter().any(|status| error.starts_with(&format!("Frame.io error ({status}):")));
    let detail = error.to_ascii_lowercase();
    rejected && ["still uploading", "still processing", "not yet uploaded", "not ready", "being processed"]
        .iter().any(|reason| detail.contains(reason))
}

async fn api_json_after_upload(client: &Client, token: &str, method: reqwest::Method, url: &str, body: Option<Value>) -> Result<Value, String> {
    // Usually the asset can be linked immediately. Retry only explicit server
    // rejections while its uploaded parts are being assembled. An uncertain
    // network result must not repeat a POST that may already have succeeded.
    let mut delays = [250, 750, 1500].into_iter();
    loop {
        match api_json(client, token, method.clone(), url, body.clone()).await {
            Err(error) if asset_is_still_ingesting(&error) => {
                let Some(delay) = delays.next() else { return Err(error); };
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            result => return result,
        }
    }
}

async fn list_api_data(client: &Client, token: &str, url: String) -> Result<Vec<Value>, String> {
    let mut next = Some(url);
    let mut items = Vec::new();
    while let Some(url) = next.take() {
        let page = api_json(client, token, reqwest::Method::GET, &url, None).await?;
        if let Some(data) = page.get("data").and_then(Value::as_array) {
            items.extend(data.iter().cloned());
        }
        if let Some(link) = page.pointer("/links/next").and_then(Value::as_str) {
            next = Some(if link.starts_with("https://api.frame.io/") { link.to_string() } else { format!("https://api.frame.io{link}") });
        }
    }
    Ok(items)
}

fn option_from(value: &Value, workspace_name: Option<String>) -> Option<FrameIoOption> {
    let id = value.get("id").and_then(Value::as_str)?.to_string();
    let name = value.get("name").and_then(Value::as_str)
        .or_else(|| value.get("display_name").and_then(Value::as_str))
        .unwrap_or(&id).to_string();
    Some(FrameIoOption { id, name, workspace_name })
}

#[tauri::command]
pub async fn frameio_list_accounts(client_id: String) -> Result<Vec<FrameIoOption>, String> {
    let token = access_token(&client_id).await?;
    let client = Client::new();
    let accounts = list_api_data(&client, &token, format!("{API}/accounts?page_size=100")).await?;
    Ok(accounts.iter().filter_map(|item| option_from(item, None)).collect())
}

#[tauri::command]
pub async fn frameio_get_storage(client_id: String, account_id: String) -> Result<FrameIoStorage, String> {
    let token = access_token(&client_id).await?;
    let client = Client::new();
    // Frame.io V4 exposes account storage fields on GET /accounts; the
    // legacy-style GET /accounts/{account_id} route does not exist in V4.
    let accounts = list_api_data(&client, &token, format!("{API}/accounts?page_size=100")).await?;
    let account = accounts.iter().find(|account| {
        account.get("id").and_then(Value::as_str) == Some(account_id.as_str())
    }).ok_or_else(|| "Frame.io did not return this account for the signed-in user.".to_string())?;
    let used_bytes = account.get("storage_usage").and_then(Value::as_u64)
        .ok_or_else(|| "Frame.io did not return storage usage for this account.".to_string())?;
    let limit_bytes = account.get("storage_limit").and_then(Value::as_u64)
        .ok_or_else(|| "Frame.io did not return a storage limit for this account.".to_string())?;
    Ok(FrameIoStorage { used_bytes, limit_bytes })
}

#[tauri::command]
pub async fn frameio_list_projects(client_id: String, account_id: String) -> Result<Vec<FrameIoOption>, String> {
    let token = access_token(&client_id).await?;
    let client = Client::new();
    let workspaces = list_api_data(&client, &token, format!("{API}/accounts/{account_id}/workspaces?page_size=100")).await?;
    let workspace_names = workspaces.iter().filter_map(|workspace| {
        let id = workspace.get("id").and_then(Value::as_str)?;
        let name = workspace.get("name").and_then(Value::as_str)
            .or_else(|| workspace.get("display_name").and_then(Value::as_str))?;
        Some((id.to_string(), name.to_string()))
    }).collect::<HashMap<_, _>>();
    // The account-level endpoint includes all projects the user can access,
    // including projects shared directly without workspace-level access.
    let account_projects = list_api_data(&client, &token,
        format!("{API}/accounts/{account_id}/projects?page_size=100")).await?;
    let mut projects = account_projects.iter().filter_map(|item| {
        let workspace_name = item.get("workspace_id").and_then(Value::as_str)
            .and_then(|id| workspace_names.get(id).cloned());
        option_from(item, workspace_name)
    }).collect::<Vec<_>>();
    projects.sort_by(|a, b| a.workspace_name.cmp(&b.workspace_name).then_with(|| a.name.cmp(&b.name)));
    Ok(projects)
}

async fn list_folder_children(client: &Client, token: &str, account_id: &str, folder_id: &str) -> Result<Vec<Value>, String> {
    let mut next = Some(format!("{API}/accounts/{account_id}/folders/{folder_id}/children?page_size=100"));
    let mut children = Vec::new();
    while let Some(url) = next.take() {
        let page = api_json(client, token, reqwest::Method::GET, &url, None).await?;
        if let Some(items) = page.get("data").and_then(Value::as_array) {
            children.extend(items.iter().cloned());
        }
        if let Some(link) = page.pointer("/links/next").and_then(Value::as_str) {
            next = Some(if link.starts_with("https://api.frame.io/") { link.to_string() } else { format!("https://api.frame.io{link}") });
        }
    }
    Ok(children)
}

async fn ensure_project_folder(client: &Client, token: &str, account_id: &str, project_id: &str, name: &str) -> Result<String, String> {
    let project_url = format!("{API}/accounts/{account_id}/projects/{project_id}");
    let project = api_json(client, token, reqwest::Method::GET, &project_url, None).await?;
    let root_folder_id = project.pointer("/data/root_folder_id").and_then(Value::as_str)
        .ok_or_else(|| "Frame.io project did not return its root folder ID.".to_string())?;
    let children = list_folder_children(client, token, account_id, root_folder_id).await?;
    let matches: Vec<_> = children.iter().filter(|item| {
        item.get("type").and_then(Value::as_str) == Some("folder")
            && item.get("name").and_then(Value::as_str).is_some_and(|value| value.eq_ignore_ascii_case(name))
    }).collect();
    if matches.len() > 1 {
        return Err(format!("More than one Frame.io root folder is named '{name}'. Rename duplicates before uploading."));
    }
    if let Some(id) = matches.first().and_then(|item| item.get("id")).and_then(Value::as_str) {
        return Ok(id.to_string());
    }
    let create_url = format!("{API}/accounts/{account_id}/folders/{root_folder_id}/folders");
    let created = api_json(client, token, reqwest::Method::POST, &create_url, Some(json!({"data":{"name":name}}))).await?;
    created.pointer("/data/id").and_then(Value::as_str).map(str::to_string)
        .ok_or_else(|| "Frame.io did not return the new production folder ID.".to_string())
}

fn latest_client_record(approval_dir: &Path, client_key: &str, account_id: &str, project_id: &str, folder_id: &str) -> Option<SharedRecord> {
    let entries = fs::read_dir(approval_dir).ok()?;
    let mut records = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name() else { continue; };
        let name = file_name.to_string_lossy();
        let Some(video_name) = name.strip_suffix(".frameio.json") else { continue; };
        let video_path = approval_dir.join(video_name);
        let Ok(bytes) = fs::read(&path) else { continue; };
        let Ok(record) = serde_json::from_slice::<SharedRecord>(&bytes) else { continue; };
        if record.schema_version < 2
            || !record.client_key.eq_ignore_ascii_case(client_key)
            || record.destination_account_id != account_id
            || record.destination_project_id != project_id
            || record.destination_folder_id != folder_id
            || record.state != "ready"
            || record.share_id.is_none()
            || record.share_url.is_none()
            || record.file_id.is_none()
        { continue; }
        if fingerprint(&video_path).ok() != Some((record.source_size, record.source_modified_nanos)) { continue; }
        records.push(record);
    }
    records.into_iter().max_by(|left, right| left.updated_at.cmp(&right.updated_at))
}

fn normalized_client_key(value: &str) -> Result<String, String> {
    let key = value.trim().to_ascii_uppercase().replace(' ', "_");
    if key.is_empty() || !key.chars().all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-') {
        return Err("Pepper client name contains characters that cannot be used for a Frame.io filename.".into());
    }
    Ok(key)
}

fn share_payload(client_key: &str, asset_id: &str) -> Value {
    json!({"data":{"type":"asset","name":format!("Review - {client_key}"),"access":"public","asset_ids":[asset_id],"commenting_enabled":true,"downloading_enabled":true,"show_all_asset_versions":true}})
}

async fn create_share_link(
    client: &Client,
    token: &str,
    account_id: &str,
    project_id: &str,
    client_key: &str,
    asset_id: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let share_url = format!("{API}/accounts/{account_id}/projects/{project_id}/shares");
    let share = api_json_after_upload(client, token, reqwest::Method::POST, &share_url, Some(share_payload(client_key, asset_id))).await?;
    Ok((
        share.pointer("/data/id").and_then(Value::as_str).map(str::to_string),
        share.pointer("/data/short_url").and_then(Value::as_str).map(str::to_string),
    ))
}

#[tauri::command]
pub async fn frameio_upload(
    window: tauri::Window,
    approval_path: String,
    client_id: String,
    account_id: String,
    project_id: String,
    production_project_name: String,
    production_project_path: String,
    client_key: String,
) -> Result<SharedRecord, String> {
    let path = PathBuf::from(&approval_path).canonicalize().map_err(|error| format!("Approval copy is unavailable: {error}"))?;
    if path.parent().and_then(Path::file_name).is_none_or(|name| !name.to_string_lossy().eq_ignore_ascii_case("APPROVAL")) {
        return Err("Only watermarked videos directly inside 03_EXPORTS/APPROVAL can be uploaded.".into());
    }
    if !path.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default().to_ascii_uppercase().contains("_APPROVAL") {
        return Err("This file is not a watermarked approval copy.".into());
    }
    ensure_latest_approval(&path)?;
    let project_name = production_project_name.trim();
    if project_name.is_empty() || project_name.contains(['/', '\\']) {
        return Err("Select a valid Pepper production project before uploading.".into());
    }
    let client_key = normalized_client_key(&client_key)?;
    let production_root = PathBuf::from(&production_project_path).canonicalize()
        .map_err(|error| format!("Pepper production project path is unavailable: {error}"))?;
    if !production_root.is_dir() { return Err("Pepper production project path is not a folder.".into()); }
    let _claim = Claim::acquire(&path)?;
    let project_lock_path = production_root.join(".frameio-workflow.lock");
    let _project_claim = Claim::acquire_path(
        project_lock_path.clone(),
        "Another Pepper computer is updating this production project's Frame.io folder or version stack. Try again shortly.",
    ).map_err(|error| {
        if error.starts_with("INVALID_CLAIM_PATH:") {
            format!("Unable to create Frame.io workflow lock '{}': Windows rejected the path ({error}).", project_lock_path.display())
        } else {
            error
        }
    })?;
    let (source_size, source_modified_nanos) = fingerprint(&path)?;
    let record_path = sidecar_path(&path);
    let mut retry_share = None;
    if let Ok(bytes) = fs::read(&record_path) {
        if let Ok(existing) = serde_json::from_slice::<SharedRecord>(&bytes) {
            if existing.source_size == source_size && existing.source_modified_nanos == source_modified_nanos {
                // A ready sidecar belongs to the destination used by that
                // upload. Do not treat it as complete when the user has
                // explicitly selected a different Frame.io account/project
                // on this computer; allow this explicit action to upload to
                // the newly selected destination.
                if existing.state == "ready"
                    && existing.share_url.is_some()
                    && existing.destination_account_id == account_id
                    && existing.destination_project_id == project_id
                { return Ok(existing); }
                if matches!(existing.state.as_str(), "creating_share" | "share_needs_reconciliation")
                    && existing.file_id.is_some()
                    && existing.destination_account_id == account_id
                    && existing.destination_project_id == project_id
                {
                    retry_share = Some(existing);
                } else if existing.state == "ready" && existing.share_url.is_some() {
                    // A prior successful delivery to another destination is
                    // not an in-flight job and must not block a new explicit
                    // delivery. The sidecar is replaced with the new record
                    // after the new upload is established.
                } else {
                    return Err(format!("This approval copy already has a Frame.io job in state '{}'. Pepper will not create another remote video automatically; reconcile the existing Frame.io item first.", existing.state));
                }
            }
        }
    }
    let approval_dir = path.parent().ok_or_else(|| "Approval folder is missing.".to_string())?;
    if let Ok(entries) = fs::read_dir(approval_dir) {
        for entry in entries.flatten() {
            let sidecar = entry.path();
            if sidecar == record_path { continue; }
            let Ok(name) = sidecar.file_name().map(|name| name.to_string_lossy().to_string()).ok_or(()) else { continue; };
            let Some(video_name) = name.strip_suffix(".frameio.json") else { continue; };
            let Ok(bytes) = fs::read(&sidecar) else { continue; };
            let Ok(previous) = serde_json::from_slice::<SharedRecord>(&bytes) else { continue; };
            let fingerprint_matches = fingerprint(&approval_dir.join(video_name)).ok()
                == Some((previous.source_size, previous.source_modified_nanos));
            if previous.schema_version >= 2
                && previous.client_key.eq_ignore_ascii_case(&client_key)
                && previous.destination_account_id == account_id
                && previous.destination_project_id == project_id
                && previous.state != "ready"
                && fingerprint_matches
            {
                return Err(format!("An earlier Frame.io upload for {client_key} is in state '{}'. Reconcile that job before sending another version.", previous.state));
            }
        }
    }
    let updated = || chrono::Utc::now().to_rfc3339();
    let token = access_token(&client_id).await?;
    let client = Client::builder().timeout(Duration::from_secs(120)).build().map_err(|error| error.to_string())?;
    if let Some(mut record) = retry_share {
        let asset_id = record.version_stack_id.as_deref().or(record.file_id.as_deref())
            .ok_or_else(|| "The uploaded Frame.io file ID is missing; the job needs manual reconciliation.".to_string())?;
        record.state = "creating_share".into();
        record.updated_at = updated();
        record.last_error = None;
        atomic_record(&record_path, &record)?;
        let _ = window.emit("frameio-upload-progress", Progress { approval_path: approval_path.clone(), state: record.state.clone(), uploaded: source_size, total: source_size, message: None, share_url: None });
        match create_share_link(&client, &token, &account_id, &project_id, &client_key, asset_id).await {
            Ok((share_id, share_url)) => {
                record.share_id = share_id;
                record.share_url = share_url;
            }
            Err(error) => {
                record.state = "share_needs_reconciliation".into();
                record.last_error = Some(error.clone());
                record.updated_at = updated();
                let _ = atomic_record(&record_path, &record);
                let _ = window.emit("frameio-upload-progress", Progress { approval_path, state: record.state.clone(), uploaded: source_size, total: source_size, message: Some(error.clone()), share_url: None });
                return Err(format!("FRAMEIO_VIDEO_UPLOADED_SHARE_FAILED: {error}"));
            }
        }
        if record.share_url.is_some() {
            record.state = "ready".into();
            record.updated_at = updated();
            record.last_error = None;
            atomic_record(&record_path, &record)?;
            let _ = window.emit("frameio-upload-progress", Progress { approval_path, state: record.state.clone(), uploaded: source_size, total: source_size, message: None, share_url: record.share_url.clone() });
            return Ok(record);
        }
        record.state = "share_needs_reconciliation".into();
        record.last_error = Some("Frame.io created the share but did not return its URL.".into());
        record.updated_at = updated();
        atomic_record(&record_path, &record)?;
        return Err("FRAMEIO_VIDEO_UPLOADED_SHARE_FAILED: Frame.io did not return a share URL. The video is uploaded; retry share link creation.".into());
    }
    let folder_id = ensure_project_folder(&client, &token, &account_id, &project_id, project_name).await?;
    let prior = latest_client_record(approval_dir, &client_key, &account_id, &project_id, &folder_id);
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("mp4");
    let remote_name = format!("{client_key}.{ext}");
    let children = list_folder_children(&client, &token, &account_id, &folder_id).await?;

    let mut existing_stack_id = prior.as_ref().and_then(|record| record.version_stack_id.clone());
    let mut existing_file_id = if existing_stack_id.is_none() { prior.as_ref().and_then(|record| record.file_id.clone()) } else { None };
    let mut matching_remote = children.iter().filter(|item| {
        item.get("name").and_then(Value::as_str).is_some_and(|name| name.eq_ignore_ascii_case(&remote_name))
            && matches!(item.get("type").and_then(Value::as_str), Some("file" | "version_stack"))
    });
    let matched = matching_remote.next();
    if matching_remote.next().is_some() {
        return Err(format!("More than one Frame.io asset is named '{remote_name}' in '{project_name}'. Resolve the duplicate before uploading."));
    }
    if existing_stack_id.is_none() && existing_file_id.is_none() {
        if let Some(item) = matched {
            match item.get("type").and_then(Value::as_str) {
                Some("version_stack") => existing_stack_id = item.get("id").and_then(Value::as_str).map(str::to_string),
                Some("file") => existing_file_id = item.get("id").and_then(Value::as_str).map(str::to_string),
                _ => {}
            }
        }
    }
    let mut record = SharedRecord {
        schema_version: 2, state: "creating_remote_file".into(), source_size, source_modified_nanos,
        destination_account_id: account_id.clone(), destination_project_id: project_id.clone(), destination_folder_id: folder_id.clone(),
        production_project_name: project_name.to_string(), client_key: client_key.clone(), remote_name: remote_name.clone(),
        file_id: None, version_stack_id: existing_stack_id.clone(),
        share_id: prior.as_ref().and_then(|record| record.share_id.clone()),
        share_url: prior.as_ref().and_then(|record| record.share_url.clone()),
        updated_at: updated(), last_error: None,
    };
    atomic_record(&record_path, &record)?;
    let create_url = format!("{API}/accounts/{account_id}/folders/{folder_id}/files/local_upload");
    let created = match api_json(&client, &token, reqwest::Method::POST, &create_url, Some(json!({"data":{"name":remote_name,"file_size":source_size}}))).await {
        Ok(value) => value,
        Err(error) => {
            record.state = "needs_reconciliation".into(); record.last_error = Some(error.clone()); record.updated_at = updated();
            let _ = atomic_record(&record_path, &record);
            let _ = window.emit("frameio-upload-progress", Progress { approval_path, state: record.state.clone(), uploaded: 0, total: source_size, message: Some(error.clone()), share_url: None });
            return Err(error);
        }
    };
    let data = created.get("data").ok_or_else(|| "Frame.io did not return the new file.".to_string())?;
    let file_id = data.get("id").and_then(Value::as_str).ok_or_else(|| "Frame.io response did not include a file ID.".to_string())?.to_string();
    let media_type = data.get("media_type").and_then(Value::as_str).unwrap_or("application/octet-stream").to_string();
    let urls: Vec<UploadUrl> = serde_json::from_value(data.get("upload_urls").cloned().unwrap_or(Value::Null)).map_err(|error| format!("Frame.io upload URL response was invalid: {error}"))?;
    record.file_id = Some(file_id.clone()); record.state = "uploading".into(); record.updated_at = updated(); atomic_record(&record_path, &record)?;
    let _ = window.emit("frameio-upload-progress", Progress { approval_path: approval_path.clone(), state: record.state.clone(), uploaded: 0, total: source_size, message: None, share_url: None });
    let mut offset = 0u64;
    let mut sent = 0u64;
    for upload in urls {
        let mut source = tokio::fs::File::open(&path).await.map_err(|error| format!("Cannot open approval video: {error}"))?;
        source.seek(std::io::SeekFrom::Start(offset)).await.map_err(|error| error.to_string())?;
        let remaining = upload.size;
        let app = window.app_handle().clone();
        let progress_path = approval_path.clone();
        let body_stream = stream::try_unfold((source, remaining, sent, source_size, app, progress_path), |(mut file, mut remaining, sent, total, app, path)| async move {
            if remaining == 0 { return Ok(None); }
            let mut buffer = vec![0u8; remaining.min(1024 * 1024) as usize];
            let read = file.read(&mut buffer).await?;
            if read == 0 { return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "Approval video ended before the declared file size.")); }
            buffer.truncate(read);
            remaining -= read as u64;
            let uploaded = sent + read as u64;
            let _ = app.emit("frameio-upload-progress", Progress { approval_path: path.clone(), state: "uploading".into(), uploaded, total, message: None, share_url: None });
            Ok(Some((bytes::Bytes::from(buffer), (file, remaining, uploaded, total, app, path))))
        });
        let response = client.put(&upload.url).header("x-amz-acl", "private").header(reqwest::header::CONTENT_TYPE, &media_type)
            .header(reqwest::header::CONTENT_LENGTH, upload.size).body(reqwest::Body::wrap_stream(body_stream)).send().await
            .map_err(|error| format!("Frame.io part upload failed: {error}"))?;
        if !response.status().is_success() { return Err(format!("Frame.io part upload failed with HTTP {}. The shared record can be reconciled before retrying.", response.status().as_u16())); }
        // A new file handle is opened for every part, so video data stays streamed.
        sent += upload.size; offset += upload.size;
    }
    if sent == 0 { return Err("Frame.io returned no upload parts for this video.".into()); }
    if sent != source_size { return Err("Frame.io upload parts did not cover the full source file.".into()); }
    if fingerprint(&path)? != (source_size, source_modified_nanos) { return Err("The approval video changed while uploading; the remote upload needs reconciliation.".into()); }
    // All upload parts have been accepted. Shares and version stacks refer to
    // the file resource; waiting for video renditions delays the review link.
    record.state = "finalizing_review".into(); record.updated_at = updated(); atomic_record(&record_path, &record)?;
    let _ = window.emit("frameio-upload-progress", Progress { approval_path: approval_path.clone(), state: record.state.clone(), uploaded: source_size, total: source_size, message: None, share_url: None });
    if let Some(stack_id) = existing_stack_id {
        let move_url = format!("{API}/accounts/{account_id}/files/{file_id}/move");
        api_json_after_upload(&client, &token, reqwest::Method::PATCH, &move_url, Some(json!({"data":{"parent_id":stack_id}}))).await?;
        record.version_stack_id = Some(stack_id);
    } else if let Some(previous_file_id) = existing_file_id {
        record.state = "creating_version_stack".into(); record.updated_at = updated(); atomic_record(&record_path, &record)?;
        let _ = window.emit("frameio-upload-progress", Progress { approval_path: approval_path.clone(), state: record.state.clone(), uploaded: source_size, total: source_size, message: None, share_url: None });
        let stack_url = format!("{API}/accounts/{account_id}/folders/{folder_id}/version_stacks");
        let stack = api_json_after_upload(&client, &token, reqwest::Method::POST, &stack_url, Some(json!({"data":{"file_ids":[previous_file_id,file_id]}}))).await?;
        let stack_id = stack.pointer("/data/id").and_then(Value::as_str).map(str::to_string)
            .ok_or_else(|| "Frame.io did not return the version stack ID.".to_string())?;
        record.version_stack_id = Some(stack_id.clone());
        record.state = "updating_share".into(); record.updated_at = updated(); atomic_record(&record_path, &record)?;
        let _ = window.emit("frameio-upload-progress", Progress { approval_path: approval_path.clone(), state: record.state.clone(), uploaded: source_size, total: source_size, message: None, share_url: None });
        if let (Some(share_id), Some(old_share_url)) = (record.share_id.clone(), record.share_url.clone()) {
            let add_url = format!("{API}/accounts/{account_id}/shares/{share_id}/assets");
            api_json(&client, &token, reqwest::Method::POST, &add_url, Some(json!({"data":{"asset_id":stack_id}}))).await?;
            let remove_url = format!("{API}/accounts/{account_id}/shares/{share_id}/assets/{previous_file_id}");
            api_json(&client, &token, reqwest::Method::DELETE, &remove_url, None).await?;
            record.share_url = Some(old_share_url);
        }
    }
    if record.share_id.is_none() {
        record.state = "creating_share".into(); record.updated_at = updated(); atomic_record(&record_path, &record)?;
        let _ = window.emit("frameio-upload-progress", Progress { approval_path: approval_path.clone(), state: record.state.clone(), uploaded: source_size, total: source_size, message: None, share_url: None });
        let asset_id = record.version_stack_id.as_deref().unwrap_or(&file_id);
        match create_share_link(&client, &token, &account_id, &project_id, &client_key, asset_id).await {
            Ok((share_id, share_url)) => {
                record.share_id = share_id;
                record.share_url = share_url;
            }
            Err(error) => {
                record.state = "share_needs_reconciliation".into();
                record.last_error = Some(error.clone());
                record.updated_at = updated();
                let _ = atomic_record(&record_path, &record);
                let _ = window.emit("frameio-upload-progress", Progress { approval_path, state: record.state.clone(), uploaded: source_size, total: source_size, message: Some(error.clone()), share_url: None });
                return Err(format!("FRAMEIO_VIDEO_UPLOADED_SHARE_FAILED: {error}"));
            }
        }
    }
    if record.share_url.is_none() {
        let error = "Frame.io returned a share without a URL.".to_string();
        record.state = "share_needs_reconciliation".into();
        record.last_error = Some(error.clone());
        record.updated_at = updated();
        atomic_record(&record_path, &record)?;
        let _ = window.emit("frameio-upload-progress", Progress { approval_path, state: record.state.clone(), uploaded: source_size, total: source_size, message: Some(error.clone()), share_url: None });
        return Err(format!("FRAMEIO_VIDEO_UPLOADED_SHARE_FAILED: {error}"));
    }
    record.state = if record.share_url.is_some() { "ready" } else { "share_needs_reconciliation" }.into();
    record.updated_at = updated(); record.last_error = None; atomic_record(&record_path, &record)?;
    let _ = window.emit("frameio-upload-progress", Progress { approval_path, state: record.state.clone(), uploaded: source_size, total: source_size, message: None, share_url: record.share_url.clone() });
    Ok(record)
}

fn ensure_latest_approval(selected: &Path) -> Result<(), String> {
    let approval_dir = selected.parent().ok_or_else(|| "Approval folder is missing.".to_string())?;
    let selected_stem = selected.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default();
    let marker = selected_stem.to_ascii_uppercase().find("_APPROVAL")
        .ok_or_else(|| "This file is not a watermarked approval copy.".to_string())?;
    let selected_source_stem = &selected_stem[..marker];
    let (_, selected_version) = super::versioned_stem(selected_source_stem)?;
    let selected_version = selected_version.unwrap_or(1);
    let mut latest_version = 0;
    for entry in fs::read_dir(approval_dir).map_err(|error| format!("Unable to read approval folder: {error}"))? {
        let entry = entry.map_err(|error| error.to_string())?;
        let candidate = entry.path();
        if !candidate.is_file() || !candidate.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| super::VIDEO_EXTENSIONS.iter().any(|allowed| ext.eq_ignore_ascii_case(allowed))) {
            continue;
        }
        let stem = candidate.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default();
        let Some(marker) = stem.to_ascii_uppercase().find("_APPROVAL") else { continue; };
        let (_, version) = super::versioned_stem(&stem[..marker])?;
        latest_version = latest_version.max(version.unwrap_or(1));
    }
    if selected_version != latest_version {
        return Err(format!("Only the latest approval version can be published. This is V{selected_version}; the latest in APPROVAL is V{latest_version}. Refresh the project and send the latest version."));
    }
    Ok(())
}

#[cfg(test)]
mod auth_tests {
    use super::*;

    fn mock_api(responses: Vec<(u16, &'static str)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, BufReader, Read};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/shares", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let handle = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut socket, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(std::time::Instant::now() < deadline, "Expected request did not arrive");
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("Mock API accept failed: {error}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                let mut content_length = 0;
                loop {
                    let mut header = String::new();
                    assert!(reader.read_line(&mut header).unwrap() > 0);
                    if header == "\r\n" { break; }
                    if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                        content_length = value.trim().parse::<usize>().unwrap();
                    }
                }
                reader.read_exact(&mut vec![0; content_length]).unwrap();
                requests.push(request.trim().to_string());
                write!(socket, "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (url, handle)
    }

    fn post_upload_request(url: &str) -> Result<Value, String> {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let client = Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
            api_json_after_upload(&client, "test-token", reqwest::Method::POST, url, Some(share_payload("CLIENT", "file-123"))).await
        })
    }

    #[test]
    fn post_upload_link_is_returned_without_processing_polls() {
        let (url, server) = mock_api(vec![(201, r#"{"data":{"short_url":"https://f.io/test"}}"#)]);
        let result = post_upload_request(&url).unwrap();
        assert_eq!(result.pointer("/data/short_url").and_then(Value::as_str), Some("https://f.io/test"));
        assert_eq!(server.join().unwrap(), vec!["POST /shares HTTP/1.1"]);
    }

    #[test]
    fn post_upload_link_retries_a_definitively_rejected_ingesting_asset() {
        let (url, server) = mock_api(vec![
            (422, r#"{"errors":[{"detail":"Asset is still uploading"}]}"#),
            (201, r#"{"data":{"short_url":"https://f.io/test"}}"#),
        ]);
        assert!(post_upload_request(&url).is_ok());
        assert_eq!(server.join().unwrap().len(), 2);
    }

    #[test]
    fn post_upload_link_does_not_repeat_an_uncertain_server_failure() {
        let (url, server) = mock_api(vec![(500, r#"{"errors":[{"detail":"Asset is still processing"}]}"#)]);
        assert!(post_upload_request(&url).unwrap_err().starts_with("Frame.io error (500):"));
        assert_eq!(server.join().unwrap().len(), 1);
        assert!(!asset_is_still_ingesting("Frame.io request failed: connection closed while still uploading"));
        assert!(!asset_is_still_ingesting("Frame.io error (422): Invalid asset ID"));
    }

    #[test]
    fn share_payload_uses_plan_supported_download_setting() {
        let payload = share_payload("CLIENT_A", "asset-123");
        assert_eq!(payload.pointer("/data/downloading_enabled").and_then(Value::as_bool), Some(true));
        assert_eq!(payload.pointer("/data/asset_ids/0").and_then(Value::as_str), Some("asset-123"));
    }

    #[test]
    fn only_latest_approval_version_is_publishable() {
        let directory = tempfile::tempdir().unwrap();
        let older = directory.path().join("Client_V2_APPROVAL.mp4");
        let latest = directory.path().join("Client_V3_APPROVAL.mp4");
        fs::write(&older, b"older").unwrap();
        fs::write(&latest, b"latest").unwrap();

        assert!(ensure_latest_approval(&latest).is_ok());
        assert!(ensure_latest_approval(&older).unwrap_err().contains("Only the latest approval version"));
    }

    #[test]
    fn unversioned_approval_is_latest_when_it_is_the_only_copy() {
        let directory = tempfile::tempdir().unwrap();
        let approval = directory.path().join("Client_APPROVAL.mp4");
        fs::write(&approval, b"approval").unwrap();

        assert!(ensure_latest_approval(&approval).is_ok());
    }

    #[test]
    fn parses_registered_native_app_callback() {
        let callback = format!("{REDIRECT_URI}?code=sample-code&state=expected-state");
        assert_eq!(parse_auth_callback(&callback, "expected-state").unwrap(), "sample-code");
    }

    #[test]
    fn accepts_only_the_registered_native_app_deep_link() {
        let runtime = Runtime::default();
        let callback = format!("{REDIRECT_URI}?code=sample-code&state=expected-state");
        assert!(runtime.accept_auth_callback(&callback));
        assert_eq!(runtime.auth_callback.lock().unwrap().as_deref(), Some(callback.as_str()));
        assert!(!runtime.accept_auth_callback("adobe+wrong://adobeid/not-this-client?code=fake&state=fake"));
    }

    #[test]
    fn rejects_callback_with_wrong_state() {
        let callback = format!("{REDIRECT_URI}?code=sample-code&state=other-state");
        assert!(parse_auth_callback(&callback, "expected-state").unwrap_err().contains("state did not match"));
    }

    #[test]
    fn surfaces_adobe_callback_errors() {
        let callback = format!("{REDIRECT_URI}?error=access_denied&error_description=User+denied&state=expected-state");
        assert!(parse_auth_callback(&callback, "expected-state").unwrap_err().contains("access_denied User denied"));
    }
}

