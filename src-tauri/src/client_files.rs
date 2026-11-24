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

fn category_roots(category: &str) -> Result<Vec<(&'static str, &'static str)>, String> {
    match category {
        "all" => Ok(vec![("Media", "01_MEDIA")]),
        "video" => Ok(vec![
            ("Raw", "01_MEDIA/020_VIDEO_RAW"),
            ("Proxy", "01_MEDIA/010_VIDEO_PROXY"),
        ]),
        "audio" => Ok(vec![
            ("Raw", "01_MEDIA/040_AUDIO_RAW"),
            ("Clean", "01_MEDIA/030_AUDIO_CLEAN"),
            ("Music", "01_MEDIA/060_MUSIC"),
        ]),
        "stills" => Ok(vec![
            ("Stills", "01_MEDIA/050_STILLS"),
            ("Graphics", "01_MEDIA/070_GRAPHICS"),
        ]),
        "stock" => Ok(vec![("Stock", "01_MEDIA/090_STOCK")]),
        "edit" => Ok(vec![("Edit", "02_EDIT")]),
        _ => Err("Choose Video, Audio, Stills or Edit.".into()),
    }
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
fn list_assets(client_path: &Path, category: &str) -> Result<ClientAssets, String> {
    let roots = category_roots(category)?;
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
            label: label.into(),
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
                variant: label.into(),
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

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct ClientEditNoteTask {
    id: String,
    text: String,
    completed: bool,
    #[serde(default)]
    references: Vec<ClientEditNoteReference>,
}

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct ClientEditNoteReference {
    id: String,
    relative_path: String,
    name: String,
    timecode: String,
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
            Ok(legacy.lines().filter_map(|line| {
                let text = line.trim_start().strip_prefix("- ").or_else(|| line.trim_start().strip_prefix("* ")).unwrap_or(line).trim();
                (!text.is_empty()).then(|| ClientEditNoteTask { id: uuid::Uuid::new_v4().to_string(), text: text.to_string(), completed: false, references: Vec::new() })
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

#[tauri::command]
pub async fn client_edit_notes_save(client_path: String, tasks: Vec<ClientEditNoteTask>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_client_edit_notes(Path::new(&client_path), &tasks))
        .await.map_err(|e| e.to_string())?
}

fn validated_project(client_path: &Path, path: &Path) -> Result<PathBuf, String> {
    if !client_path.is_absolute() || !path.is_absolute() || !project_file(path) || !path.is_file() {
        return Err("Choose an available editing project.".into());
    }
    let root = client_path.canonicalize().map_err(|e| e.to_string())?;
    let target = path.canonicalize().map_err(|e| e.to_string())?;
    let allowed=["02_EDIT","01_MEDIA"].into_iter().any(|folder|client_path.join(folder).canonicalize().ok()
        .is_some_and(|folder|folder.starts_with(&root)&&target.starts_with(folder)));
    if !allowed {
        return Err("This project is outside the client's Edit and Media folders.".into());
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
