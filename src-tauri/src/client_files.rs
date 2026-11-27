//! Focused client assets, deliberately excluding arbitrary folder navigation.
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
pub struct ClientAsset {
    name: String,
    path: String,
    relative_path: String,
    kind: String,
    variant: String,
    size: u64,
    modified_ms: Option<u64>,
    created_ms: Option<u64>,
}
#[derive(Serialize)]
pub struct AssetFolder {
    label: String,
    path: String,
    available: bool,
}
#[derive(Serialize)]
pub struct ClientAssets {
    files: Vec<ClientAsset>,
    folders: Vec<AssetFolder>,
    truncated: bool,
}

fn category_roots(client_path: &Path, category: &str) -> Result<Vec<(String, String)>, String> {
    let folders: Vec<(&str, &str, &str)> = match category {
        "all" => vec![("Media", "media", "01_MEDIA")],
        "video" => vec![("Raw", "video_raw", "01_MEDIA/020_VIDEO_RAW"), ("Proxy", "video_proxy", "01_MEDIA/010_VIDEO_PROXY")],
        "audio" => vec![("Raw", "audio_raw", "01_MEDIA/040_AUDIO_RAW"), ("Clean", "audio_clean", "01_MEDIA/030_AUDIO_CLEAN"), ("Music", "music", "01_MEDIA/060_MUSIC")],
        "stills" => vec![("Stills", "stills", "01_MEDIA/050_STILLS"), ("Graphics", "graphics", "01_MEDIA/070_GRAPHICS")],
        "stock" => vec![("Stock", "stock", "01_MEDIA/090_STOCK")],
        "edit" => vec![("Edit", "edit", "02_EDIT")],
        _ => return Err("Choose Video, Audio, Stills or Edit.".into()),
    };
    folders.into_iter().map(|(label, purpose, legacy)| {
        let path = crate::workspace::destination_for_client(client_path, purpose)?.unwrap_or_else(|| legacy.to_string());
        Ok((label.to_string(), path))
    }).collect()
}
fn project_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("prproj" | "aep" | "aepx" | "drp" | "sesx" | "blend")
    )
}
fn excluded_folder(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with('.')
        || name.contains("auto-save")
        || name.contains("autosave")
        || name.contains("audio previews")
        || name.contains("video previews")
        || matches!(
            name.as_str(),
            "media cache" | "media cache files" | "peak files"
        )
}
/// Drag category folders themselves so editors retain their bin structure.
pub(crate) fn category_drag_paths(client_path: &Path, category: &str) -> Result<Vec<String>, String> {
    if !matches!(category, "video" | "audio" | "all") {
        return Err("Choose Video, Audio or All to drag folders.".into());
    }
    let mut paths = Vec::new();
    for (_, relative) in category_roots(client_path, category)? {
        let folder = client_path.join(relative);
        if !folder.is_dir() { continue; }
        if category == "all" {
            for entry in std::fs::read_dir(&folder).map_err(|e| format!("Could not read {}: {e}", folder.display()))? {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_type().map_err(|e| e.to_string())?.is_dir()
                    && !excluded_folder(&entry.file_name().to_string_lossy()) {
                    paths.push(entry.path().to_string_lossy().into_owned());
                }
            }
        } else {
            paths.push(folder.to_string_lossy().into_owned());
        }
    }
    paths.sort();
    paths.dedup();
    if paths.is_empty() { return Err("No media folders are available to drag.".into()); }
    Ok(paths)
}
fn list_assets(client_path: &Path, category: &str) -> Result<ClientAssets, String> {
    let roots = category_roots(client_path, category)?;
    if !client_path.is_absolute() || !client_path.is_dir() {
        return Err("This client's folder is unavailable.".into());
    }
    let canonical_client = client_path
        .canonicalize()
        .map_err(|e| format!("Could not open this client: {e}"))?;
    let mut files = Vec::new();
    let mut folders = Vec::new();
    let mut truncated = false;
    for (label, relative) in roots {
        let folder = client_path.join(relative);
        let available = folder.is_dir();
        folders.push(AssetFolder {
            label: label.clone().into(),
            path: folder.to_string_lossy().into_owned(),
            available,
        });
        if !available {
            continue;
        }
        if !folder
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(&canonical_client)
        {
            return Err("A media folder points outside this client.".into());
        }
        for entry in walkdir::WalkDir::new(&folder)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0
                    || !entry.file_type().is_dir()
                    || !excluded_folder(&entry.file_name().to_string_lossy())
            })
        {
            let entry = entry.map_err(|e| format!("Could not read {}: {e}", folder.display()))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            // All retains supporting files as well as every media/project kind.
            let kind = if category == "all" {
                if project_file(path) { "project" } else { crate::media_browser::media_kind(path).unwrap_or("other") }
            } else if category == "edit" {
                if !project_file(path) {
                    continue;
                }
                "project"
            } else {
                let Some(kind) = crate::media_browser::media_kind(path) else {
                    continue;
                };
                if !matches!(
                    (category, kind),
                    ("video", "video") | ("audio", "audio") | ("stills", "image")
                        | ("stock", "video") | ("stock", "audio") | ("stock", "image")
                ) {
                    continue;
                }
                kind
            };
            let metadata = entry
                .metadata()
                .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
            files.push(ClientAsset {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                relative_path: path
                    .strip_prefix(if category=="all" {client_path} else {&folder})
                    .unwrap_or(path)
                    .to_string_lossy()
                    .into_owned(),
                kind: kind.into(),
                variant: label.clone().into(),
                size: metadata.len(),
                modified_ms: metadata
                    .modified()
                    .ok()
                    .and_then(|date| date.duration_since(UNIX_EPOCH).ok())
                    .and_then(|date| u64::try_from(date.as_millis()).ok()),
                created_ms: metadata.created().ok()
                    .and_then(|date|date.duration_since(UNIX_EPOCH).ok())
                    .and_then(|date|u64::try_from(date.as_millis()).ok()),
            });
            if files.len() > 2000 {
                files.pop();
                truncated = true;
                break;
            }
        }
        if truncated {
            break;
        }
    }
    files.sort_by(|a, b| {
        let recent = if category == "edit" {
            b.modified_ms.cmp(&a.modified_ms)
        } else {
            std::cmp::Ordering::Equal
        };
        recent
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(ClientAssets {
        files,
        folders,
        truncated,
    })
}

#[derive(Serialize)]
pub struct ClientRecording {
    path: String,
    recording_metadata: Option<crate::ingest::RecordingMetadata>,
}
#[tauri::command]
pub async fn client_files_recordings(project_root: String, client_path: String) -> Result<Vec<ClientRecording>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root=PathBuf::from(project_root);
        let client=PathBuf::from(client_path);
        if !client.canonicalize().map_err(|e|e.to_string())?.starts_with(root.canonicalize().map_err(|e|e.to_string())?) {
            return Err("This client is outside the project.".into());
        }
        let listing=list_assets(&client,"all")?;
        let paths:Vec<_>=listing.files.into_iter().filter(|file|matches!(file.kind.as_str(),"audio"|"video")).map(|file|PathBuf::from(file.path)).collect();
        Ok(crate::ingest::client_recording_metadata(&root,&paths).into_iter().map(|(path,recording_metadata)|ClientRecording{path,recording_metadata}).collect())
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn client_files_list(
    client_path: String,
    category: String,
) -> Result<ClientAssets, String> {
    tauri::async_runtime::spawn_blocking(move || list_assets(Path::new(&client_path), &category))
        .await
        .map_err(|e| e.to_string())?
}

const EDIT_NOTES_FILE: &str = ".pepper-edit-notes.json";

#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct ClientEditNoteTask {
    id: String,
    text: String,
    completed: bool,
    #[serde(default)]
    references: Vec<ClientEditNoteReference>,
}

#[derive(Clone, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct ClientEditNoteReference {
    id: String,
    relative_path: String,
    name: String,
    timecode: String,
    #[serde(default)]
    end_timecode: String,
    #[serde(default)]
    text: String,
}

#[cfg(not(windows))]
fn replace_edit_notes(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn replace_edit_notes(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe { MoveFileExW(windows::core::PCWSTR(from.as_ptr()), windows::core::PCWSTR(to.as_ptr()), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) }
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
fn mark_edit_notes_hidden(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" { fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32; }
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { SetFileAttributesW(path.as_ptr(), 0x2) } == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else { Ok(()) }
}

#[cfg(not(windows))]
fn mark_edit_notes_hidden(_path: &Path) -> Result<(), String> { Ok(()) }

fn client_edit_notes(client_path: &Path) -> Result<Vec<ClientEditNoteTask>, String> {
    if !client_path.is_absolute() || !client_path.is_dir() {
        return Err("This client's folder is unavailable.".into());
    }
    let root = client_path.canonicalize().map_err(|e| e.to_string())?;
    let path = root.join(EDIT_NOTES_FILE);
    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("The editing notes file must not be a symbolic link.".into());
    }
    match std::fs::read(&path) {
        Ok(bytes) => {
            let data: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|_| "The editing notes file could not be read.".to_string())?;
            if let Some(tasks) = data.get("tasks") {
                return serde_json::from_value(tasks.clone()).map_err(|_| "The editing notes file could not be read.".to_string());
            }
            let legacy = data.get("text").and_then(|v| v.as_str()).unwrap_or("");
            Ok(legacy.lines().enumerate().filter_map(|(index, line)| {
                let text = line.trim_start().strip_prefix("- ").or_else(|| line.trim_start().strip_prefix("* ")).unwrap_or(line).trim();
                (!text.is_empty()).then(|| ClientEditNoteTask { id: format!("legacy-{index}-{}", { use sha2::{Digest, Sha256}; format!("{:x}", Sha256::digest(text.as_bytes())) }), text: text.to_string(), completed: false, references: Vec::new() })
            }).collect())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("Could not read editing notes: {error}")),
    }
}

fn save_client_edit_notes(client_path: &Path, tasks: &[ClientEditNoteTask]) -> Result<(), String> {
    if !client_path.is_absolute() || !client_path.is_dir() {
        return Err("This client's folder is unavailable.".into());
    }
    let root = client_path.canonicalize().map_err(|e| e.to_string())?;
    let path = root.join(EDIT_NOTES_FILE);
    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("The editing notes file must not be a symbolic link.".into());
    }
    let tasks: Vec<_> = tasks.iter().filter(|task| !task.text.trim().is_empty() || !task.references.is_empty()).cloned().collect();
    if tasks.is_empty() {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Could not clear editing notes: {error}")),
        }
    }
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({"version": 1, "tasks": tasks}))
        .map_err(|e| e.to_string())?;
    let temp = root.join(format!(".pepper-edit-notes-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, bytes).map_err(|e| format!("Could not save editing notes: {e}"))?;
    if let Err(error) = mark_edit_notes_hidden(&temp) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Could not hide editing notes: {error}"));
    }
    if let Err(error) = replace_edit_notes(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Could not save editing notes: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn client_edit_notes_load(client_path: String) -> Result<Vec<ClientEditNoteTask>, String> {
    tauri::async_runtime::spawn_blocking(move || client_edit_notes(Path::new(&client_path)))
        .await.map_err(|e| e.to_string())?
}

// Apply only fields changed against the caller's base, under a shared-file lock.
// Conflicting edits to one field preserve both tasks instead of losing text.
fn merge_note_value(base: &serde_json::Value, local: &serde_json::Value, remote: &serde_json::Value) -> (serde_json::Value, bool) {
    if local == base { return (remote.clone(), false); }
    if remote == base || local == remote { return (local.clone(), false); }
    if let (Some(base), Some(local), Some(remote)) = (base.as_object(), local.as_object(), remote.as_object()) {
        let mut result = remote.clone();
        let mut conflict = false;
        for (key, value) in local {
            let (merged, collided) = merge_note_value(base.get(key).unwrap_or(&serde_json::Value::Null), value, remote.get(key).unwrap_or(&serde_json::Value::Null));
            result.insert(key.clone(), merged);
            conflict |= collided;
        }
        return (result.into(), conflict);
    }
    if let (Some(base), Some(local), Some(remote)) = (base.as_array(), local.as_array(), remote.as_array()) {
        return merge_note_list(base, local, remote);
    }
    (local.clone(), true)
}

fn merge_note_list(base: &[serde_json::Value], local: &[serde_json::Value], remote: &[serde_json::Value]) -> (serde_json::Value, bool) {
    let mut result = remote.to_vec();
    let mut conflict = false;
    for before in base {
        if !local.iter().any(|item| item["id"] == before["id"]) {
            result.retain(|item| item["id"] != before["id"] || item != before);
        }
    }
    for item in local {
        let before = base.iter().find(|old| old["id"] == item["id"]);
        if before == Some(item) { continue; }
        if let Some(index) = result.iter().position(|saved| saved["id"] == item["id"]) {
            let (merged, collided) = merge_note_value(before.unwrap_or(&serde_json::Value::Null), item, &result[index]);
            result[index] = merged;
            conflict |= collided;
        } else {
            result.push(item.clone());
        }
    }
    // Only a deliberate reorder may change the order of existing shared rows.
    let old_order: Vec<_> = base.iter().filter(|b| local.iter().any(|l| l["id"] == b["id"])).map(|v| &v["id"]).collect();
    let new_order: Vec<_> = local.iter().filter(|l| base.iter().any(|b| b["id"] == l["id"])).map(|v| &v["id"]).collect();
    if old_order != new_order {
        result.sort_by_key(|v| local.iter().position(|l| l["id"] == v["id"]).unwrap_or(usize::MAX));
    }
    (result.into(), conflict)
}

fn merge_edit_notes(base: &[ClientEditNoteTask], local: &[ClientEditNoteTask], remote: &[ClientEditNoteTask]) -> Vec<ClientEditNoteTask> {
    let mut result = remote.to_vec();
    for before in base {
        if !local.iter().any(|task| task.id == before.id) {
            result.retain(|task| task.id != before.id || task != before);
        }
    }
    for task in local {
        let before = base.iter().find(|old| old.id == task.id);
        if before == Some(task) { continue; }
        if let Some(index) = result.iter().position(|saved| saved.id == task.id) {
            let (merged, conflict) = merge_note_value(&serde_json::to_value(before).unwrap(), &serde_json::to_value(task).unwrap(), &serde_json::to_value(&result[index]).unwrap());
            if conflict {
                let mut copy = result[index].clone();
                copy.id = uuid::Uuid::new_v4().to_string();
                result[index] = task.clone();
                result.push(copy);
            } else {
                result[index] = serde_json::from_value(merged).unwrap();
            }
        } else {
            result.push(task.clone());
        }
    }
    let old_order: Vec<_> = base.iter().filter(|b| local.iter().any(|l| l.id == b.id)).map(|v| &v.id).collect();
    let new_order: Vec<_> = local.iter().filter(|l| base.iter().any(|b| b.id == l.id)).map(|v| &v.id).collect();
    if old_order != new_order { result.sort_by_key(|v| local.iter().position(|l| l.id == v.id).unwrap_or(usize::MAX)); }
    result
}

fn sync_edit_notes(client: &Path, tasks: &[ClientEditNoteTask], base: Option<&[ClientEditNoteTask]>) -> Result<Vec<ClientEditNoteTask>, String> {
    if !client.is_absolute() || !client.is_dir() { return Err("This client's folder is unavailable.".into()); }
    let lock_path = client.canonicalize().map_err(|e| e.to_string())?.join(".pepper-edit-notes.lock");
    if std::fs::symlink_metadata(&lock_path).is_ok_and(|m| m.file_type().is_symlink()) { return Err("The notes lock must not be a symbolic link.".into()); }
    let lock = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&lock_path).map_err(|e| format!("Could not open notes lock: {e}"))?;
    // OS locks are released on process exit and work across SMB clients. Keep
    // the lock file in place so every writer locks the same file identity.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(error) => return Err(format!("Notes are busy or unavailable; retrying: {error}")),
        }
    }
    mark_edit_notes_hidden(&lock_path).map_err(|e| format!("Could not hide notes lock: {e}"))?;
    let remote = client_edit_notes(client)?;
    let merged = match base { Some(base) => merge_edit_notes(base, tasks, &remote), None => tasks.to_vec() };
    save_client_edit_notes(client, &merged)?;
    Ok(merged)
}

#[tauri::command]
pub async fn client_edit_notes_save(client_path: String, tasks: Vec<ClientEditNoteTask>, base_tasks: Option<Vec<ClientEditNoteTask>>) -> Result<Vec<ClientEditNoteTask>, String> {
    tauri::async_runtime::spawn_blocking(move || sync_edit_notes(Path::new(&client_path), &tasks, base_tasks.as_deref()))
        .await.map_err(|e| e.to_string())?
}

/// Share the same client asset boundaries between browsing, opening and dragging.
pub(crate) fn asset_roots(client_path: &Path) -> Result<Vec<PathBuf>, String> {
    let client = client_path.canonicalize().map_err(|error| format!("Client folder unavailable: {error}"))?;
    let mut relative = vec!["01_MEDIA".to_string(), "02_EDIT".to_string()];
    for (purpose, legacy) in [
        ("media", "01_MEDIA"), ("edit", "02_EDIT"),
        ("video_proxy", "01_MEDIA/010_VIDEO_PROXY"), ("video_raw", "01_MEDIA/020_VIDEO_RAW"),
        ("audio_clean", "01_MEDIA/030_AUDIO_CLEAN"), ("audio_raw", "01_MEDIA/040_AUDIO_RAW"),
        ("stills", "01_MEDIA/050_STILLS"), ("music", "01_MEDIA/060_MUSIC"),
        ("graphics", "01_MEDIA/070_GRAPHICS"), ("misc", "01_MEDIA/080_MISCELLANEOUS"), ("stock", "01_MEDIA/090_STOCK"),
    ] {
        relative.push(crate::workspace::destination_for_client(client_path, purpose)?.unwrap_or_else(|| legacy.into()));
    }
    let mut roots: Vec<_> = relative.into_iter().filter_map(|path| client_path.join(path).canonicalize().ok())
        .filter(|path| path.is_dir() && path.starts_with(&client)).collect();
    roots.sort(); roots.dedup();
    Ok(roots)
}

fn validated_project(client_path: &Path, path: &Path) -> Result<PathBuf, String> {
    if !client_path.is_absolute() || !path.is_absolute() || !project_file(path) || !path.is_file() {
        return Err("Choose an available editing project.".into());
    }
    let target = path.canonicalize().map_err(|e| e.to_string())?;
    let allowed = asset_roots(client_path)?.iter().any(|folder| target.starts_with(folder));
    if !allowed {
        return Err("Choose a project inside this client's configured media or Edit folders.".into());
    }
    // Use the original absolute spelling for Windows file associations rather
    // than passing ShellExecute a verbatim (\\?\) canonical path.
    Ok(path.to_path_buf())
}
#[tauri::command]
pub async fn client_files_open_project(
    app: tauri::AppHandle,
    client_path: String,
    path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = validated_project(Path::new(&client_path), Path::new(&path))?;
        app.opener()
            .open_path(target.to_string_lossy().into_owned(), None::<String>)
            .map_err(|e| format!("Could not open the editing project: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn note(id: &str, text: &str) -> ClientEditNoteTask {
        ClientEditNoteTask { id: id.into(), text: text.into(), completed: false, references: vec![] }
    }

    #[test]
    fn notes_merge_stale_writers_and_preserve_conflicting_text() {
        let base = vec![note("one", "Original")];
        let a = vec![note("one", "Alice"), note("two", "New task")];
        let mut b = base.clone();
        b[0].completed = true;
        let merged = merge_edit_notes(&base, &b, &a);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].text, "Alice");
        assert!(merged[0].completed);
        let collision = merge_edit_notes(&base, &[note("one", "Bob")], &a);
        assert_eq!(collision.len(), 3);
        assert_eq!(collision[0].id, "one");
        assert_eq!(collision[0].text, "Bob");
        assert!(collision.iter().any(|t| t.text == "Alice" && t.id != "one"));
        // Deleting a stale task cannot remove somebody else's changed text.
        assert_eq!(merge_edit_notes(&base, &[], &a), a);
    }

    #[test]
    fn notes_lock_serializes_independent_writers_without_losing_additions() {
        let temp = tempfile::tempdir().unwrap();
        let client = temp.path().to_path_buf();
        let handles: Vec<_> = (0..8).map(|index| {
            let client = client.clone();
            std::thread::spawn(move || sync_edit_notes(&client, &[note(&index.to_string(), "Added concurrently")], Some(&[])).unwrap())
        }).collect();
        for handle in handles { handle.join().unwrap(); }
        assert_eq!(client_edit_notes(&client).unwrap().len(), 8);
        assert!(client.join(".pepper-edit-notes.lock").exists());
    }

    #[test]
    fn notes_storage_handles_legacy_ids_and_clear_then_readd() {
        let temp = tempfile::tempdir().unwrap();
        let client = temp.path();
        fs::write(client.join(EDIT_NOTES_FILE), br#"{"text":"- First\n- Second"}"#).unwrap();
        let base = client_edit_notes(client).unwrap();
        assert_eq!(base, client_edit_notes(client).unwrap());
        assert!(sync_edit_notes(client, &[], Some(&base)).unwrap().is_empty());
        assert!(!client.join(EDIT_NOTES_FILE).exists());
        let tasks = vec![note("one", "Restored")];
        assert_eq!(sync_edit_notes(client, &tasks, Some(&[])).unwrap(), tasks);
        assert_eq!(client_edit_notes(client).unwrap(), tasks);
    }

    #[test]
    fn notes_merge_independent_marker_edits() {
        let mut original = note("one", "Task");
        original.references.push(ClientEditNoteReference { id: "ref".into(), relative_path: "clip.mp4".into(), name: "clip".into(), timecode: "00:10".into(), end_timecode: String::new(), text: "Marker".into() });
        let mut local = original.clone();
        local.references[0].timecode = "00:20".into();
        let mut remote = original.clone();
        remote.references[0].text = "Teammate's marker".into();
        let merged = merge_edit_notes(&[original], &[local], &[remote]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].references[0].timecode, "00:20");
        assert_eq!(merged[0].references[0].text, "Teammate's marker");
    }
    #[test]
    fn notes_range_roundtrip_and_merge_preserves_endpoints() {
        let legacy = serde_json::json!({"id":"ref","relative_path":"clip.mp4","name":"clip","timecode":"00:00:10.000","text":"Cut"});
        let reference: ClientEditNoteReference = serde_json::from_value(legacy).unwrap();
        assert!(reference.end_timecode.is_empty());
        let mut base = note("one", "Task");
        base.references.push(reference);
        let mut local = base.clone();
        local.references[0].end_timecode = "00:00:12.345".into();
        let mut remote = base.clone();
        remote.references[0].text = "Shared note".into();
        let merged = merge_edit_notes(&[base], &[local], &[remote]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].references[0].end_timecode, "00:00:12.345");
        assert_eq!(merged[0].references[0].text, "Shared note");
        let temp = tempfile::tempdir().unwrap();
        let saved = sync_edit_notes(temp.path(), &merged, Some(&[])).unwrap();
        assert_eq!(client_edit_notes(temp.path()).unwrap(), saved);
    }
    #[test]
    fn categories_show_only_working_assets_and_keep_variant_identity() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in [
            "01_MEDIA/020_VIDEO_RAW/Camera A",
            "01_MEDIA/010_VIDEO_PROXY",
            "01_MEDIA/040_AUDIO_RAW",
            "02_EDIT/Adobe Premiere Pro Auto-Save",
            "03_EXPORTS/APPROVAL",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in [
            "01_MEDIA/020_VIDEO_RAW/Camera A/TAKE.MP4",
            "01_MEDIA/010_VIDEO_PROXY/TAKE.mp4",
            "01_MEDIA/020_VIDEO_RAW/Camera A/TAKE.xml",
            "01_MEDIA/040_AUDIO_RAW/REC.wav",
            "02_EDIT/Main.prproj",
            "02_EDIT/Adobe Premiere Pro Auto-Save/Main backup.prproj",
            "02_EDIT/start.exe",
            "03_EXPORTS/APPROVAL/approval.mp4",
        ] {
            fs::write(root.join(file), b"fixture").unwrap();
        }
        let video = list_assets(root, "video").unwrap();
        assert_eq!(video.files.len(), 2);
        assert!(video
            .files
            .iter()
            .any(|f| f.variant == "Raw" && f.relative_path.contains("Camera A")));
        assert!(video.files.iter().any(|f| f.variant == "Proxy"));
        assert_eq!(list_assets(root, "audio").unwrap().files[0].name, "REC.wav");
        let edit = list_assets(root, "edit").unwrap();
        assert_eq!(edit.files.len(), 1);
        assert_eq!(edit.files[0].name, "Main.prproj");
        assert!(list_assets(root, "../../").is_err());
        assert!(list_assets(&root.join("missing"), "video").is_err());
        let empty = list_assets(root, "stills").unwrap();
        assert!(empty.files.is_empty());
        assert!(empty.folders.iter().all(|f| !f.available));
        let all=list_assets(root,"all").unwrap();
        assert_eq!(all.files.len(),4);
        assert!(all.files.iter().all(|f|f.relative_path.starts_with("01_MEDIA")));
        assert!(!all.files.iter().any(|f|f.name=="Main.prproj"||f.name=="start.exe"));
        assert!(all.files.iter().any(|f|f.kind=="audio"));
        assert!(all.files.iter().any(|f|f.kind=="video"));
        assert!(all.files.iter().any(|f|f.kind=="other"&&f.name=="TAKE.xml"));
        assert!(!all.files.iter().any(|f|f.relative_path.contains("Auto-Save")||f.relative_path.contains("03_EXPORTS")));
    }
    #[test]
    fn opening_is_limited_to_edit_projects_in_this_client() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("client");
        fs::create_dir_all(root.join("02_EDIT")).unwrap();
        let project = root.join("02_EDIT/Main.prproj");
        fs::write(&project, b"project").unwrap();
        assert!(validated_project(&root, &project).is_ok());
        let media_project=root.join("01_MEDIA/080_MISCELLANEOUS/Scene.blend");
        fs::create_dir_all(media_project.parent().unwrap()).unwrap();fs::write(&media_project,b"project").unwrap();
        assert!(validated_project(&root,&media_project).is_ok());
        let outside = temp.path().join("Other.prproj");
        fs::write(&outside, b"other").unwrap();
        assert!(validated_project(&root, &outside).is_err());
        let executable = root.join("02_EDIT/start.exe");
        fs::write(&executable, b"exe").unwrap();
        assert!(validated_project(&root, &executable).is_err());
    }
    #[test]
    fn configured_edit_and_media_projects_can_be_opened() {
        let temp = tempfile::tempdir().unwrap();
        let client = temp.path().join("client");
        fs::create_dir_all(&client).unwrap();
        fs::write(client.join(".pepper-client.json"), br#"{"folder_destinations":{"edit":"Editing/Premiere","media":"Footage","video_raw":"Originals","misc":"Supporting"}}"#).unwrap();
        for relative in ["Editing/Premiere/Interview.prproj", "Footage/Scene.blend", "Originals/Imported.aep", "Supporting/Animation.aep"] {
            let path = client.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"project").unwrap();
            assert_eq!(validated_project(&client, &path).unwrap(), path);
        }
        let outside = client.join("03_EXPORTS/Not an editing source.prproj");
        fs::create_dir_all(outside.parent().unwrap()).unwrap();
        fs::write(&outside, b"export").unwrap();
        assert!(validated_project(&client, &outside).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn a_junction_cannot_escape_the_client() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("client");
        let outside = temp.path().join("outside");
        fs::create_dir_all(root.join("01_MEDIA")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("outside.mp4"), b"media").unwrap();
        // Directory junctions do not require the privileges of symbolic links.
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("01_MEDIA").join("020_VIDEO_RAW"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(list_assets(&root, "video").is_err());
    }
}
