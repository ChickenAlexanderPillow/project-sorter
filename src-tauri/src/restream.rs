//! Native Restream MCP connection. OAuth secrets stay in the OS credential store.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use std::{fs, path::Path};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use url::Url;
use uuid::Uuid;

const MCP: &str = "https://mcp.restream.io/mcp";
const AUTH: &str = "https://mcp.restream.io/.well-known/oauth-authorization-server";
const REDIRECT: &str = "http://127.0.0.1:43821/oauth/callback";
const REDIRECT_ADDR: &str = "127.0.0.1:43821";
const SERVICE: &str = "Pepper.Restream";

#[derive(Default)]
pub struct Runtime {
    pending: Mutex<Option<Pending>>,
    refresh_lock: tokio::sync::Mutex<()>,
}
struct Pending {
    client_id: String,
    state: String,
    verifier: String,
    listener: TcpListener,
}
fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("OS credential store unavailable: {e}"))
}
fn read(key: &str) -> Option<String> {
    entry(key).ok()?.get_password().ok()
}
fn save(key: &str, value: &str) -> Result<(), String> {
    entry(key)?
        .set_password(value)
        .map_err(|e| format!("Unable to save Restream credentials securely: {e}"))
}
fn delete(key: &str) {
    if let Ok(e) = entry(key) {
        let _ = e.delete_credential();
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    token_type: Option<String>,
}
fn token_bundle() -> Result<Tokens, String> {
    let access = read("access").ok_or_else(|| "Restream is not connected.".to_string())?;
    let refresh = read("refresh");
    let expires = read("expires").and_then(|s| s.parse().ok());
    Ok(Tokens {
        access_token: access,
        refresh_token: refresh,
        expires_in: expires.map(|at: u64| at.saturating_sub(now())),
        token_type: Some("Bearer".into()),
    })
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn save_tokens(t: &Tokens) -> Result<(), String> {
    save("access", &t.access_token)?;
    if let Some(r) = &t.refresh_token {
        save("refresh", r)?;
    }
    if let Some(tt) = &t.token_type {
        let _ = tt;
    }
    if let Some(expires) = t.expires_in {
        save("expires", &now().saturating_add(expires).to_string())?;
    }
    Ok(())
}
async fn access(rt: &Runtime) -> Result<String, String> {
    let bundle = token_bundle()?;
    if read("expires")
        .and_then(|s| s.parse::<u64>().ok())
        .map(|e| e > now() + 90)
        .unwrap_or(false)
    {
        return Ok(bundle.access_token);
    }
    let _guard = rt.refresh_lock.lock().await;
    let bundle = token_bundle()?;
    if read("expires")
        .and_then(|s| s.parse::<u64>().ok())
        .map(|e| e > now() + 90)
        .unwrap_or(false)
    {
        return Ok(bundle.access_token);
    }
    let refresh = bundle
        .refresh_token
        .ok_or_else(|| "Restream requires you to reconnect.".to_string())?;
    let client_id = read("client_id")
        .ok_or_else(|| "Restream OAuth registration is missing. Reconnect Restream.".to_string())?;
    let resp = Client::new()
        .post("https://api.restream.io/oauth/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.as_str()),
            ("client_id", client_id.as_str()),
        ])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Restream is temporarily unavailable: {e}"))?;
    if resp.status().is_client_error() {
        return Err("Restream requires you to reconnect this computer.".into());
    }
    let t: Tokens = resp
        .error_for_status()
        .map_err(|e| format!("Restream token refresh failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid Restream token response: {e}"))?;
    save_tokens(&t)?;
    Ok(t.access_token)
}
#[derive(Deserialize)]
struct Metadata {
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
}
#[tauri::command]
pub async fn restream_start_auth(
    _app: AppHandle,
    rt: tauri::State<'_, Runtime>,
) -> Result<String, String> {
    let listener = TcpListener::bind(REDIRECT_ADDR).map_err(|e| {
        format!("Could not reserve Restream's local OAuth callback ({REDIRECT_ADDR}): {e}")
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Could not prepare Restream's local OAuth callback: {e}"))?;
    let meta: Metadata = Client::new()
        .get(AUTH)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let existing = read("client_id");
    let client_id = if let Some(id) = existing {
        id
    } else {
        let endpoint = meta
            .registration_endpoint
            .ok_or("Restream does not advertise dynamic registration")?;
        let body = json!({"client_name":"Pepper","redirect_uris":[REDIRECT],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","application_type":"native"});
        let response = Client::new()
            .post(endpoint)
            .json(&body)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("Restream client registration failed: {e}"))?;
        let status = response.status();
        let response_body = response
            .text()
            .await
            .map_err(|e| format!("Could not read Restream registration response: {e}"))?;
        if !status.is_success() {
            let detail = serde_json::from_str::<Value>(&response_body)
                .ok()
                .and_then(|v| {
                    v.get("error_description")
                        .or_else(|| v.get("error"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_else(|| response_body.chars().take(400).collect());
            return Err(format!(
                "Restream rejected native client registration ({status}): {detail}"
            ));
        }
        let v: Value = serde_json::from_str(&response_body)
            .map_err(|e| format!("Invalid Restream registration response: {e}"))?;
        let id = v
            .get("client_id")
            .and_then(Value::as_str)
            .ok_or("Registration response did not contain client_id")?
            .to_string();
        save("client_id", &id)?;
        id
    };
    let state = Uuid::new_v4().to_string();
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut u = Url::parse(&meta.authorization_endpoint).map_err(|e| e.to_string())?;
    u.query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", REDIRECT)
        .append_pair("response_type", "code")
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("scope", "studio.default.read studio.write storage.read");
    *rt.pending
        .lock()
        .map_err(|_| "Restream auth state unavailable")? = Some(Pending {
        client_id,
        state,
        verifier,
        listener,
    });
    Ok(u.to_string())
}
#[tauri::command]
pub async fn restream_finish_auth(rt: tauri::State<'_, Runtime>) -> Result<(), String> {
    let pending = rt
        .pending
        .lock()
        .map_err(|_| "Restream auth state unavailable")?
        .take()
        .ok_or("Start Restream sign-in first")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    let raw = loop {
        match pending.listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut bytes = [0u8; 8192];
                let count = stream
                    .read(&mut bytes)
                    .map_err(|e| format!("Could not read Restream OAuth callback: {e}"))?;
                let request = String::from_utf8_lossy(&bytes[..count]);
                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .ok_or("Restream returned a malformed local callback")?;
                let callback = callback_from_request_target(target)?;
                let page="<!doctype html><title>Pepper</title><p>Restream connected. Return to Pepper.</p>";
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",page.len(),page);
                let _ = stream.write_all(response.as_bytes());
                break callback.to_string();
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(format!("Restream OAuth callback listener failed: {e}")),
        }
        if tokio::time::Instant::now() > deadline {
            return Err("Timed out waiting for Restream sign-in callback".into());
        }
        tokio::time::sleep(Duration::from_millis(40)).await
    };
    let u = Url::parse(&raw).map_err(|_| "Invalid Restream callback")?;
    let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
    if q.get("state") != Some(&pending.state) {
        return Err("Restream sign-in state did not match".into());
    }
    if let Some(e) = q.get("error") {
        return Err(format!("Restream sign-in failed: {e}"));
    }
    let code = q
        .get("code")
        .ok_or("Restream did not return an authorization code")?;
    let meta: Metadata = Client::new()
        .get(AUTH)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let response = Client::new()
        .post(meta.token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("client_id", pending.client_id.as_str()),
            ("redirect_uri", REDIRECT),
            ("code_verifier", pending.verifier.as_str()),
        ])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let t: Tokens = response
        .error_for_status()
        .map_err(|e| format!("Restream rejected authorization code: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Invalid Restream token response: {e}"))?;
    save_tokens(&t)
}

fn callback_from_request_target(target: &str) -> Result<Url, String> {
    let url = Url::parse(&format!("http://127.0.0.1:43821{target}"))
        .map_err(|_| "Invalid Restream callback URL")?;
    if url.host_str() != Some("127.0.0.1") || url.path() != Url::parse(REDIRECT).unwrap().path() {
        return Err("Restream callback did not match Pepper's registered redirect URI".into());
    }
    Ok(url)
}
#[tauri::command]
pub fn restream_disconnect(rt: tauri::State<'_, Runtime>) {
    for k in ["access", "refresh", "expires", "client_id"] {
        delete(k)
    }
    if let Ok(mut p) = rt.pending.lock() {
        *p = None
    }
}

#[tauri::command]
pub fn restream_cancel_auth(rt: tauri::State<'_, Runtime>) {
    if let Ok(mut pending) = rt.pending.lock() {
        *pending = None;
    }
}
#[tauri::command]
pub fn restream_connection_status() -> String {
    if read("refresh").is_some() {
        "connected".into()
    } else {
        "disconnected".into()
    }
}

async fn mcp(rt: &Runtime, method: &str, params: Value) -> Result<Value, String> {
    let token = access(rt).await?;
    let client = Client::new();
    let init=client.post(MCP).bearer_auth(&token).header("accept","application/json, text/event-stream").json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"Pepper","version":"0.1.0"}}})).timeout(Duration::from_secs(30)).send().await.map_err(|e|format!("Restream MCP unavailable: {e}"))?;
    let sid = init
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let _ = init
        .error_for_status()
        .map_err(|e| format!("Restream MCP initialization failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let mut initialized = client
        .post(MCP)
        .bearer_auth(&token)
        .header("accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
        .timeout(Duration::from_secs(15));
    if let Some(s) = &sid {
        initialized = initialized.header("mcp-session-id", s);
    }
    let _ = initialized
        .send()
        .await
        .map_err(|e| format!("Restream MCP handshake failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Restream MCP handshake rejected: {e}"))?;
    let payload = if method == "tools/list" {
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":params})
    } else {
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":method,"arguments":params}})
    };
    let mut req = client
        .post(MCP)
        .bearer_auth(token)
        .header("accept", "application/json, text/event-stream")
        .json(&payload)
        .timeout(Duration::from_secs(45));
    if let Some(s) = sid {
        req = req.header("mcp-session-id", s)
    }
    let response = req
        .send()
        .await
        .map_err(|e| format!("Restream MCP request failed: {e}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Restream MCP returned {status}: {}",
            body.chars().take(500).collect::<String>()
        ));
    }
    let data = body
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .last()
        .unwrap_or(&body);
    let v: Value =
        serde_json::from_str(data).map_err(|e| format!("Malformed Restream MCP response: {e}"))?;
    if let Some(e) = v.get("error") {
        return Err(format!("Restream error: {e}"));
    }
    if v.pointer("/result/isError").and_then(Value::as_bool) == Some(true) {
        let detail = v
            .pointer("/result/content")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        return Err(if detail.is_empty() {
            "Restream MCP tool returned an error".into()
        } else {
            format!("Restream MCP tool error: {detail}")
        });
    }
    Ok(v.pointer("/result/structuredContent")
        .cloned()
        .or_else(|| v.pointer("/result").cloned())
        .unwrap_or(v))
}
#[tauri::command]
pub async fn restream_create_studio(
    rt: tauri::State<'_, Runtime>,
    title: String,
) -> Result<Value, String> {
    if title.trim().is_empty() {
        return Err("Enter a session title".into());
    }
    let v = mcp(
        &rt,
        "create_event",
        json!({"eventType":"studio","title":title.trim()}),
    )
    .await?;
    validate_event(v)
}
#[tauri::command]
pub async fn restream_get_studio(
    rt: tauri::State<'_, Runtime>,
    event_id: String,
) -> Result<Value, String> {
    validate_event(mcp(&rt, "get_event", json!({"eventId":event_id})).await?)
}

/// Match all MCP recording entries with this saved session's title.
#[tauri::command]
pub async fn restream_list_event_recordings(
    rt: tauri::State<'_, Runtime>,
    event_id: String,
    session_title: String,
) -> Result<Value, String> {
    Uuid::parse_str(&event_id)
        .map_err(|_| "Restream returned an event ID that is not a UUID".to_string())?;
    let result = mcp(&rt, "list_user_recordings", json!({})).await?;
    let rows = result.get("recordings").and_then(Value::as_array)
        .ok_or_else(|| "Restream returned an unexpected recording list".to_string())?;
    let wanted = session_title.trim();
    let matched = rows.iter().filter(|recording| {
        let title = recording.get("title")
            .or_else(|| recording.pointer("/event/title"))
            .and_then(Value::as_str).unwrap_or_default();
        let recording_event = recording.get("eventId")
            .or_else(|| recording.get("event_id"))
            .or_else(|| recording.pointer("/event/id"))
            .and_then(Value::as_str);
        recording_event == Some(event_id.as_str()) || (!wanted.is_empty() && title.eq_ignore_ascii_case(wanted))
    }).cloned().collect::<Vec<_>>();
    if matched.is_empty() {
        let exact = mcp(&rt, "list_user_recordings", json!({"eventId":event_id})).await?;
        if exact.get("recordings").and_then(Value::as_array).is_some() { return Ok(exact); }
        return Ok(json!({"recordings":[]}));
    }
    Ok(json!({"recordings":matched}))
}

async fn recording_download_url(
    rt: &Runtime,
    event_id: String,
    file_name: String,
) -> Result<String, String> {
    Uuid::parse_str(&event_id)
        .map_err(|_| "Restream returned an event ID that is not a UUID".to_string())?;
    if file_name.trim().is_empty() || file_name.len() > 512 {
        return Err("Invalid Restream recording file name".into());
    }
    let result = mcp(
        &rt,
        "get_recording_download_url",
        json!({"eventId":event_id,"fileName":file_name}),
    )
    .await?;
    let link = result
        .get("downloadUrl")
        .or_else(|| result.get("url"))
        .and_then(Value::as_str)
        .ok_or("Restream did not return a recording download URL")?;
    let parsed = Url::parse(link).map_err(|_| "Restream returned an invalid download URL")?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https" || host.is_empty() || parsed.username() != "" || parsed.password().is_some() {
        return Err("Restream returned an invalid secure recording download URL".into());
    }
    Ok(link.to_owned())
}

/// Download a listed recording to a path selected through Pepper's save dialog.
#[tauri::command]
pub async fn restream_download_recording(
    rt: tauri::State<'_, Runtime>,
    event_id: String,
    file_name: String,
    save_path: String,
) -> Result<(), String> {
    let target = PathBuf::from(save_path);
    if target.file_name().is_none() {
        return Err("Choose a file name for the recording".into());
    }
    let url = recording_download_url(&rt, event_id, file_name).await?;
    let response = Client::new()
        .get(&url)
        .timeout(Duration::from_secs(15 * 60))
        .send()
        .await
        .map_err(|e| format!("Restream recording download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Restream recording download failed: {e}"))?;
    if response.url().scheme() != "https" || response.url().host_str().is_none() || response.url().username() != "" || response.url().password().is_some() {
        return Err("Restream redirected the recording to an invalid or insecure URL".into());
    }
    let temp = target.with_file_name(format!(".{}.{}.partial", target.file_name().unwrap().to_string_lossy(), Uuid::new_v4()));
    let result = async {
        let mut output = tokio::fs::File::create(&temp).await.map_err(|e| format!("Could not create temporary recording file: {e}"))?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Recording download interrupted: {e}"))?;
            output.write_all(&chunk).await.map_err(|e| format!("Could not write recording data: {e}"))?;
        }
        output.flush().await.map_err(|e| format!("Could not finish writing recording: {e}"))?;
        drop(output);
        tokio::fs::copy(&temp, &target).await.map_err(|e| format!("Could not save recording to the selected location: {e}"))?;
        Ok::<(), String>(())
    }.await;
    let _ = tokio::fs::remove_file(&temp).await;
    result
}

#[tauri::command]
pub async fn restream_list_studios(rt: tauri::State<'_, Runtime>) -> Result<Vec<Value>, String> {
    let schema = mcp(&rt, "tools/list", json!({})).await?;
    let tools = schema.get("tools").and_then(Value::as_array);
    let tool = tools.and_then(|rows| {
        rows.iter()
            .find(|row| row.get("name").and_then(Value::as_str) == Some("list_user_events"))
    });
    let tool = match tool {
        Some(tool) => tool,
        None => {
            let names = tools
                .map(|rows| {
                    rows.iter()
                        .filter_map(|r| r.get("name").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_else(|| format!("unexpected response: {}", schema));
            return Err(format!(
                "Restream tools/list did not include list_user_events. Available tools: {names}"
            ));
        }
    };
    let properties = tool
        .pointer("/inputSchema/properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let page_key = ["cursor", "pageToken", "page", "offset"]
        .into_iter()
        .find(|k| properties.contains_key(*k));
    let mut out = Vec::new();
    for status in ["draft", "scheduled"] {
        let mut page = json!({"status":status});
        let mut seen = std::collections::HashSet::new();
        for _ in 0..100 {
            let v = mcp(&rt, "list_user_events", page.clone()).await?;
            let rows = v
                .get("events")
                .or_else(|| v.get("data"))
                .and_then(Value::as_array)
                .ok_or("Unexpected Restream event list response")?;
            for e in rows {
                let kind = e
                    .get("eventType")
                    .or_else(|| e.get("type"))
                    .and_then(Value::as_str);
                if kind == Some("studio") {
                    let mut event = e.clone();
                    if event
                        .pointer("/event/url")
                        .or_else(|| event.get("url"))
                        .and_then(Value::as_str)
                        .is_none()
                    {
                        if let Some(id) = event.get("id").and_then(Value::as_str) {
                            event = mcp(&rt, "get_event", json!({"eventId":id})).await?;
                        }
                    }
                    if validate_event(event.clone()).is_ok() {
                        out.push(event)
                    }
                }
            }
            let next = v
                .pointer("/nextCursor")
                .or_else(|| v.pointer("/pageInfo/nextCursor"))
                .or_else(|| v.pointer("/pagination/nextCursor"))
                .and_then(Value::as_str);
            let (Some(key), Some(next)) = (page_key, next) else {
                break;
            };
            if !seen.insert(next.to_owned()) {
                break;
            }
            page[key] = Value::String(next.to_owned());
        }
    }
    Ok(out)
}
fn validate_event(v: Value) -> Result<Value, String> {
    let u = v
        .pointer("/event/url")
        .or_else(|| v.get("url"))
        .and_then(Value::as_str)
        .ok_or("Restream did not return the Studio URL")?;
    let parsed = Url::parse(u).map_err(|_| "Restream returned an invalid Studio URL")?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https" || (host != "restream.io" && !host.ends_with(".restream.io")) {
        return Err("Restream returned an untrusted Studio URL".into());
    }
    Ok(v)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudioAssociation {
    pub event_id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub status: Option<String>,
}
fn association_path(client: &str) -> Result<std::path::PathBuf, String> {
    let root = Path::new(client);
    if !root.is_dir() {
        return Err("Client folder is unavailable".into());
    }
    Ok(root.join(".pepper-restream.json"))
}
#[tauri::command]
pub fn restream_client_sessions(client_path: String) -> Result<Vec<StudioAssociation>, String> {
    let path = association_path(&client_path)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read(path).map_err(|e| format!("Could not read client Studio sessions: {e}"))?;
    serde_json::from_slice(&data)
        .map_err(|e| format!("Client Studio session metadata is invalid: {e}"))
}
#[tauri::command]
pub fn restream_associate_session(
    client_path: String,
    session: StudioAssociation,
) -> Result<Vec<StudioAssociation>, String> {
    validate_event(json!({"event":{"id":session.event_id,"url":session.url}}))
        .map_err(|e| e.to_string())?;
    update_client_sessions(&client_path, |rows| {
        if let Some(existing) = rows.iter_mut().find(|row| row.event_id == session.event_id) {
            *existing = session;
        } else {
            rows.push(session);
        }
    })
}

#[tauri::command]
pub async fn restream_delete_studio(
    rt: tauri::State<'_, Runtime>,
    client_path: String,
    event_id: String,
) -> Result<Vec<StudioAssociation>, String> {
    // Restrict deletion to sessions explicitly saved for this client.
    let saved = restream_client_sessions(client_path.clone())?;
    if !saved.iter().any(|row| row.event_id == event_id) {
        return Err("This session is no longer associated with the client. Refresh and try again.".into());
    }
    let schema = mcp(&rt, "tools/list", json!({})).await?;
    let tool = schema.get("tools").and_then(Value::as_array)
        .and_then(|tools| tools.iter().find(|tool| tool.get("name").and_then(Value::as_str) == Some("remove_event")))
        .ok_or("Restream does not currently support deleting sessions through this connection.")?;
    if tool.pointer("/inputSchema/properties/eventId").is_none() {
        return Err("Restream's delete-session interface has changed. No session was deleted.".into());
    }
    mcp(&rt, "remove_event", json!({"eventId":event_id})).await?;
    remove_client_session(&client_path, &event_id).map_err(|error| {
        format!("Session deleted from Restream, but the saved client link could not be removed: {error}")
    })
}

fn remove_client_session(client_path: &str, event_id: &str) -> Result<Vec<StudioAssociation>, String> {
    update_client_sessions(client_path, |rows| rows.retain(|row| row.event_id != event_id))
}

struct AssociationLock {
    file: Option<fs::File>,
    path: std::path::PathBuf,
}
impl Drop for AssociationLock {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.path);
    }
}

fn update_client_sessions(
    client_path: &str,
    update: impl FnOnce(&mut Vec<StudioAssociation>),
) -> Result<Vec<StudioAssociation>, String> {
    let path = association_path(client_path)?;
    let lock_path = path.with_extension("restream.lock");
    let started = std::time::Instant::now();
    let lock = loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(file) => break file,
            Err(e)
                if e.kind() == std::io::ErrorKind::AlreadyExists
                    && started.elapsed() < Duration::from_secs(8) =>
            {
                std::thread::sleep(Duration::from_millis(75))
            }
            Err(e) => {
                return Err(format!(
                    "Could not safely update client Studio sessions: {e}"
                ))
            }
        }
    };
    let _guard = AssociationLock { file: Some(lock), path: lock_path };
    let mut rows = if path.exists() {
        serde_json::from_slice::<Vec<StudioAssociation>>(
            &fs::read(&path).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    update(&mut rows);
    let tmp = path.with_extension(format!("restream-{}.tmp", Uuid::new_v4()));
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(&rows).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    replace_file(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not save client Studio sessions: {e}")
    })?;
    Ok(rows)
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}
#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            windows::core::PCWSTR(from.as_ptr()),
            windows::core::PCWSTR(to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_https_restream_studio_urls() {
        assert!(validate_event(
            json!({"event":{"id":"e1","url":"https://studio.restream.io/event/e1"}})
        )
        .is_ok());
        assert!(
            validate_event(json!({"event":{"id":"e1","url":"http://studio.restream.io/e1"}}))
                .is_err()
        );
        assert!(
            validate_event(json!({"event":{"id":"e1","url":"https://example.com/e1"}})).is_err()
        );
        assert!(validate_event(json!({"event":{"id":"e1"}})).is_err());
    }

    #[test]
    fn accepts_only_registered_loopback_callback_path() {
        let callback = callback_from_request_target("/oauth/callback?code=abc&state=xyz").unwrap();
        assert_eq!(callback.host_str(), Some("127.0.0.1"));
        assert!(callback_from_request_target("/wrong?code=abc").is_err());
    }
    #[test]
    fn client_session_associations_are_deduplicated_and_updated() {
        let root = tempfile::tempdir().unwrap();
        let client = root.path().to_string_lossy().to_string();
        let one = StudioAssociation {
            event_id: "event-1".into(),
            title: "First".into(),
            url: "https://studio.restream.io/e1".into(),
            status: Some("draft".into()),
        };
        let two = StudioAssociation {
            title: "Renamed".into(),
            ..one.clone()
        };
        assert_eq!(
            restream_associate_session(client.clone(), one)
                .unwrap()
                .len(),
            1
        );
        let rows = restream_associate_session(client.clone(), two).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Renamed");
        assert_eq!(restream_client_sessions(client).unwrap().len(), 1);
    }
    #[test]
    fn removing_a_session_preserves_other_sessions_and_releases_lock_on_error() {
        let root = tempfile::tempdir().unwrap();
        let client = root.path().to_string_lossy().to_string();
        for id in ["one", "two"] {
            restream_associate_session(client.clone(), StudioAssociation {
                event_id: id.into(), title: id.into(),
                url: format!("https://studio.restream.io/{id}"), status: None,
            }).unwrap();
        }
        let rows = remove_client_session(&client, "one").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].event_id, "two");
        assert_eq!(restream_client_sessions(client.clone()).unwrap()[0].event_id, "two");
        assert_eq!(remove_client_session(&client, "missing").unwrap().len(), 1);
        let path = association_path(&client).unwrap();
        fs::write(&path, b"invalid json").unwrap();
        assert!(remove_client_session(&client, "two").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid json");
        assert!(!path.with_extension("restream.lock").exists());
    }

}
