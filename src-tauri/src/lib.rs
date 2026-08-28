use libc::EXDEV;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ClientInfo {
    name: String,
    path: String,
    status: String,
    missing: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SortEntry {
    timestamp: String,
    username: String,
    mode: String,
    client: String,
    operation: String,
    source_path: String,
    dest_path: String,
    result: String,
    error_message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SortResult {
    processed: usize,
    failed: usize,
    skipped: usize,
    entries: Vec<SortEntry>,
    log_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct UndoEntry {
    source_path: String,
    dest_path: String,
    operation: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct UndoResult {
    processed: usize,
    failed: usize,
    entries: Vec<UndoEntryResult>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct UndoEntryResult {
    source_path: String,
    dest_path: String,
    result: String,
    error_message: String,
}

#[derive(Debug, Serialize, Clone)]
struct SortProgress {
    processed: usize,
    total: usize,
    current: String,
    result: String,
}

struct WatchState {
    watcher: Option<RecommendedWatcher>,
    stop_tx: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

const REQUIRED_DIRS: [&str; 4] = ["01_MEDIA", "02_EDIT", "03_EXPORTS", "04_FINAL"];
const WINDOWS_NOT_SAME_DEVICE: i32 = 17;
const CLIENT_TEMPLATE_PROJECT_SOURCE: &str =
    r#"Z:\The Huddle\Templates\Copied_Huddle Master Template 2026_4K_2\Huddle Master Template 2026_4K_2.prproj"#;
const CLIENT_SCENE_SWITCHING_TEMPLATE_SOURCE: &str =
    r#"Z:\The Huddle\Templates\Copied_Huddle Master Template Scenes Switching 2026 4K_1\Huddle Master Template Scenes Switching 2026 4K_1.prproj"#;
const CLIENT_TYPES: [&str; 5] = ["EXHIBITOR", "HUDDLE", "PRODUCT", "MARIYAMEETS", "SOCIAL"];
const TEMPLATE_DIRS: [&str; 11] = [
    "01_MEDIA",
    "01_MEDIA/010_VIDEO_PROXY",
    "01_MEDIA/020_VIDEO_RAW",
    "01_MEDIA/030_AUDIO_CLEAN",
    "01_MEDIA/040_AUDIO_RAW",
    "01_MEDIA/050_STILLS",
    "01_MEDIA/060_MUSIC",
    "02_EDIT",
    "03_EXPORTS",
    "03_EXPORTS/APPROVAL",
    "04_FINAL",
];

fn destination_for_mode(mode: &str) -> Option<&'static str> {
    match mode {
        "VIDEO PROXY" => Some("01_MEDIA/010_VIDEO_PROXY"),
        "VIDEO RAW" => Some("01_MEDIA/020_VIDEO_RAW"),
        "AUDIO CLEAN" => Some("01_MEDIA/030_AUDIO_CLEAN"),
        "AUDIO RAW" => Some("01_MEDIA/040_AUDIO_RAW"),
        "STILLS" => Some("01_MEDIA/050_STILLS"),
        "EXPORTS" => Some("03_EXPORTS"),
        "APPROVAL EXPORTS" => Some("03_EXPORTS/APPROVAL"),
        _ => None,
    }
}

fn is_allowed_for_mode(mode: &str, path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if ext.is_empty() {
        return false;
    }
    match mode {
        "VIDEO PROXY" | "VIDEO RAW" => matches!(
            ext.as_str(),
            "mov"
                | "mp4"
                | "mxf"
                | "mkv"
                | "avi"
                | "mpg"
                | "mpeg"
                | "m4v"
                | "webm"
                | "r3d"
        ),
        "AUDIO CLEAN" | "AUDIO RAW" => matches!(
            ext.as_str(),
            "wav"
                | "mp3"
                | "aif"
                | "aiff"
                | "flac"
                | "m4a"
                | "aac"
                | "ogg"
                | "opus"
        ),
        "STILLS" => matches!(
            ext.as_str(),
            "jpg"
                | "jpeg"
                | "png"
                | "tif"
                | "tiff"
                | "heic"
                | "heif"
                | "webp"
                | "bmp"
                | "gif"
        ),
        _ => true,
    }
}

fn detect_mode_for_path(path: &Path) -> Option<&'static str> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if ext.is_empty() {
        return None;
    }
    if ext == "mxf" {
        return Some("VIDEO PROXY");
    }
    if ext == "mp4" {
        return Some("VIDEO RAW");
    }
    let audio = matches!(
        ext.as_str(),
        "wav" | "mp3" | "aif" | "aiff" | "flac" | "m4a" | "aac" | "ogg" | "opus"
    );
    if audio {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_uppercase();
        if stem.starts_with("CLEAN") {
            return Some("AUDIO CLEAN");
        }
        return Some("AUDIO RAW");
    }
    let stills = matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "tif" | "tiff" | "heic" | "heif" | "webp" | "bmp" | "gif"
    );
    if stills {
        return Some("STILLS");
    }
    let video = matches!(
        ext.as_str(),
        "mov" | "mxf" | "mp4" | "mkv" | "avi" | "mpg" | "mpeg" | "m4v" | "webm" | "r3d"
    );
    if video {
        return Some("VIDEO RAW");
    }
    None
}

fn has_dir(path: &Path, child: &str) -> bool {
    path.join(child).is_dir()
}

fn ensure_dir(path: &Path) -> Result<(), io::Error> {
    if !path.exists() {
        fs::create_dir_all(path)?;
    }
    Ok(())
}

fn client_project_filename(client_name: &str) -> String {
    let parts: Vec<&str> = client_name.split('_').filter(|part| !part.is_empty()).collect();
    let base_parts = match parts.last().copied() {
        Some(last) if CLIENT_TYPES.contains(&last) && parts.len() > 1 => &parts[..parts.len() - 1],
        _ => &parts[..],
    };
    let stem = if base_parts.is_empty() {
        client_name.trim()
    } else {
        &base_parts.join("_")
    };
    format!("{stem}.prproj")
}

fn remove_file_with_retry(path: &Path) -> Result<(), io::Error> {
    let mut last_err: Option<io::Error> = None;
    for _ in 0..3 {
        match fs::remove_file(path) {
            Ok(_) => return Ok(()),
            Err(err) => {
                if err.kind() == io::ErrorKind::PermissionDenied {
                    if let Ok(mut perms) = fs::metadata(path).map(|m| m.permissions()) {
                        perms.set_readonly(false);
                        let _ = fs::set_permissions(path, perms);
                    }
                }
                last_err = Some(err);
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| {
        io::Error::new(io::ErrorKind::Other, "Failed to remove file")
    }))
}

fn unique_destination_path(
    dest_dir: &Path,
    file_name: &str,
    reserved: &mut HashSet<String>,
) -> PathBuf {
    let mut candidate = file_name.to_string();
    let mut counter = 2;

    let (stem, ext) = match Path::new(file_name).extension().and_then(|e| e.to_str()) {
        Some(ext) => (
            Path::new(file_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(file_name)
                .to_string(),
            Some(ext.to_string()),
        ),
        None => (file_name.to_string(), None),
    };

    loop {
        let candidate_path = dest_dir.join(&candidate);
        if !candidate_path.exists() && !reserved.contains(&candidate) {
            reserved.insert(candidate.clone());
            return candidate_path;
        }

        candidate = match &ext {
            Some(ext) => format!("{}__{}.{}", stem, counter, ext),
            None => format!("{}__{}", stem, counter),
        };
        counter += 1;
    }
}

fn list_files(paths: &[String]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for path_str in paths {
        let path = PathBuf::from(path_str);
        if path.is_dir() {
            for entry in WalkDir::new(&path)
                .into_iter()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_type().is_file())
            {
                let file_path = entry.path().to_path_buf();
                let key = fs::canonicalize(&file_path).unwrap_or_else(|_| file_path.clone());
                if seen.insert(key.clone()) {
                    files.push(key);
                }
            }
        } else if path.is_file() {
            let key = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if seen.insert(key.clone()) {
                files.push(key);
            }
        }
    }
    files
}

fn write_log_header(path: &Path) -> Result<(), io::Error> {
    if !path.exists() {
        fs::write(
            path,
            "timestamp,username,mode,client,operation,source_path,dest_path,result,error_message\n",
        )?;
    }
    Ok(())
}

fn csv_escape(value: &str) -> String {
    let escaped = value.replace('"', "\"\"");
    format!("\"{}\"", escaped)
}

fn append_log(path: &Path, entries: &[SortEntry]) -> Result<(), io::Error> {
    let mut lines = String::new();
    for entry in entries {
        let line = format!(
            "{},{},{},{},{},{},{},{},{}\n",
            csv_escape(&entry.timestamp),
            csv_escape(&entry.username),
            csv_escape(&entry.mode),
            csv_escape(&entry.client),
            csv_escape(&entry.operation),
            csv_escape(&entry.source_path),
            csv_escape(&entry.dest_path),
            csv_escape(&entry.result),
            csv_escape(&entry.error_message),
        );
        lines.push_str(&line);
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(lines.as_bytes())
        })
}

fn prune_logs(log_dir: &Path, max_days: i64, max_files: usize) -> Result<(), io::Error> {
    if !log_dir.exists() {
        return Ok(());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(log_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => continue,
        };
        if !name.starts_with("sort_log_") || !name.ends_with(".csv") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        entries.push((path, metadata));
    }

    let cutoff = chrono::Local::now() - chrono::Duration::days(max_days);
    for (path, meta) in &entries {
        if let Ok(modified) = meta.modified() {
            let modified: chrono::DateTime<chrono::Local> = modified.into();
            if modified < cutoff {
                let _ = fs::remove_file(path);
            }
        }
    }

    let mut remaining: Vec<_> = entries
        .into_iter()
        .filter(|(path, _)| path.exists())
        .collect();
    remaining.sort_by_key(|(_, meta)| meta.modified().ok());
    if remaining.len() > max_files {
        let remove_count = remaining.len() - max_files;
        for (path, _) in remaining.into_iter().take(remove_count) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

fn username() -> String {
    whoami::username()
}

#[tauri::command]
fn append_debug_log(message: String) -> Result<(), String> {
    let path = std::env::temp_dir().join("project-sorter-drag.log");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    writeln!(file, "{}", message).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn clear_debug_log() -> Result<(), String> {
    let path = std::env::temp_dir().join("project-sorter-drag.log");
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn event_in_scope(event: &Event, root: &Path) -> bool {
    event.paths.iter().any(|path| {
        if path.starts_with(root) {
            return true;
        }
        if let Ok(canon) = path.canonicalize() {
            return canon.starts_with(root);
        }
        false
    })
}

#[tauri::command]
async fn scan_project_root(project_root: String) -> Result<Vec<ClientInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&project_root);
        let mut clients = Vec::new();

        let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name.to_string(),
                None => continue,
            };
            if name == "_logs" {
                continue;
            }

            let is_excluded = name.starts_with("XX");
            if is_excluded {
                clients.push(ClientInfo {
                    name,
                    path: path.to_string_lossy().to_string(),
                    status: "Not a client".to_string(),
                    missing: Vec::new(),
                });
                continue;
            }

            let mut child_dirs = HashSet::new();
            if let Ok(entries) = fs::read_dir(&path) {
                for entry in entries.flatten() {
                    let entry_path = entry.path();
                    if entry_path.is_dir() {
                        if let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) {
                            child_dirs.insert(name.to_string());
                        }
                    }
                }
            }

            let mut subdir_cache: HashMap<String, HashSet<String>> = HashMap::new();
            let mut missing = Vec::new();
            for dir in TEMPLATE_DIRS.iter() {
                if let Some((parent, child)) = dir.split_once('/') {
                    if !child_dirs.contains(parent) {
                        missing.push(dir.to_string());
                        continue;
                    }
                    let subdirs = subdir_cache.entry(parent.to_string()).or_insert_with(|| {
                        let mut set = HashSet::new();
                        let parent_path = path.join(parent);
                        if let Ok(entries) = fs::read_dir(parent_path) {
                            for entry in entries.flatten() {
                                let entry_path = entry.path();
                                if entry_path.is_dir() {
                                    if let Some(name) =
                                        entry_path.file_name().and_then(|n| n.to_str())
                                    {
                                        set.insert(name.to_string());
                                    }
                                }
                            }
                        }
                        set
                    });
                    if !subdirs.contains(child) {
                        missing.push(dir.to_string());
                    }
                } else if !child_dirs.contains(*dir) {
                    missing.push(dir.to_string());
                }
            }

            let has_all_required = REQUIRED_DIRS.iter().all(|dir| child_dirs.contains(*dir));
            let status = if has_all_required && missing.is_empty() {
                "OK"
            } else {
                "Missing folders"
            };

            clients.push(ClientInfo {
                name,
                path: path.to_string_lossy().to_string(),
                status: status.to_string(),
                missing,
            });
        }

        clients.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(clients)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_watch_root(
    window: tauri::Window,
    project_root: String,
    state: tauri::State<Mutex<WatchState>>,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "Watcher lock poisoned".to_string())?;
    if let Some(stop_tx) = state.stop_tx.take() {
        let _ = stop_tx.send(());
    }
    if let Some(handle) = state.thread.take() {
        let _ = handle.join();
    }
    state.watcher = None;

    if project_root.trim().is_empty() {
        return Ok(());
    }

    let root_path = PathBuf::from(&project_root);
    if !root_path.is_dir() {
        return Err("Project root is not a directory".to_string());
    }
    let root_canon = root_path.canonicalize().unwrap_or(root_path.clone());

    let (event_tx, event_rx) = mpsc::channel::<notify::Result<Event>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let app_handle = window.app_handle().clone();
    let project_root_clone = project_root.clone();
    let root_for_thread = root_canon.clone();

    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = event_tx.send(res);
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root_canon, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let handle = std::thread::spawn(move || {
        let debounce = Duration::from_millis(500);
        let mut pending = false;
        let mut last_event = Instant::now();

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }

            match event_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(event)) => {
                    if event_in_scope(&event, &root_for_thread) {
                        pending = true;
                        last_event = Instant::now();
                    }
                }
                Ok(Err(_)) => {
                    pending = true;
                    last_event = Instant::now();
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }

            if pending && last_event.elapsed() >= debounce {
                let _ = app_handle.emit("clients-changed", project_root_clone.clone());
                pending = false;
            }
        }
    });

    state.watcher = Some(watcher);
    state.stop_tx = Some(stop_tx);
    state.thread = Some(handle);
    Ok(())
}

#[tauri::command]
fn create_client(
    project_root: String,
    client_name: String,
    client_type: String,
    huddle_template: Option<String>,
) -> Result<(), String> {
    let client_root = PathBuf::from(project_root).join(&client_name);
    if client_root.exists() {
        return Err("Client folder already exists".to_string());
    }
    for dir in TEMPLATE_DIRS.iter() {
        ensure_dir(&client_root.join(dir)).map_err(|e| e.to_string())?;
    }

    if client_type == "EXHIBITOR" || client_type == "PRODUCT" || client_type == "HUDDLE" {
        let template_source = if client_type == "HUDDLE"
            && huddle_template.as_deref() == Some("VIDEO_CALL")
        {
            PathBuf::from(CLIENT_SCENE_SWITCHING_TEMPLATE_SOURCE)
        } else {
            PathBuf::from(CLIENT_TEMPLATE_PROJECT_SOURCE)
        };
        if !template_source.exists() {
            return Err(format!(
                "Premiere template not found: {}",
                template_source.display()
            ));
        }

        let template_dest = client_root
            .join("02_EDIT")
            .join(client_project_filename(&client_name));
        fs::copy(&template_source, &template_dest).map_err(|e| {
            format!(
                "Failed to copy Premiere template from {} to {}: {}",
                template_source.display(),
                template_dest.display(),
                e
            )
        })?;
    }
    Ok(())
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", target.display()));
    }
    if !target.is_dir() {
        return Err(format!("Path is not a folder: {}", target.display()));
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to launch Explorer for {}: {}", target.display(), e))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open folder {}: {}", target.display(), e))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open folder {}: {}", target.display(), e))?;
        return Ok(());
    }
}

#[tauri::command]
fn fix_client(project_root: String, client_name: String) -> Result<(), String> {
    let client_root = PathBuf::from(project_root).join(&client_name);
    if !client_root.exists() {
        return Err("Client folder does not exist".to_string());
    }
    if client_name.starts_with("XX") {
        return Err("Folder is not recognized as a client".to_string());
    }

    for dir in TEMPLATE_DIRS.iter() {
        let path = client_root.join(dir);
        if !path.exists() {
            ensure_dir(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn sort_files(
    window: tauri::Window,
    project_root: String,
    client_name: String,
    mode: String,
    operation: String,
    dry_run: bool,
    paths: Vec<String>,
) -> Result<SortResult, String> {
    let window_clone = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let files = list_files(&paths);
        let mut files: Vec<PathBuf> = files;
        if mode != "AUTO" {
            files = files
                .into_iter()
                .filter(|path| is_allowed_for_mode(&mode, path))
                .collect();
        }
        let mut unique_files = Vec::new();
        let mut seen_sources = HashSet::new();
        for file_path in files {
            let key = fs::canonicalize(&file_path).unwrap_or_else(|_| file_path.clone());
            if seen_sources.insert(key.clone()) {
                unique_files.push(key);
            }
        }
        let files = unique_files;
        let total = files.len();
        if total == 0 {
            return Err("No files matched the selected mode.".to_string());
        }
        let mut processed = 0usize;
        let mut failed = 0usize;
        let mut skipped = 0usize;
        let mut entries: Vec<SortEntry> = Vec::new();
        let mut reserved_names = HashSet::new();
        let username = username();
        let mut ensured_dirs = HashSet::new();

        let log_dir = PathBuf::from(&project_root).join("_logs");
        if !dry_run {
            ensure_dir(&log_dir).map_err(|e| e.to_string())?;
            let _ = prune_logs(&log_dir, 30, 200);
        }
        let log_file_name = format!(
            "sort_log_{}.csv",
            chrono::Local::now().format("%Y-%m-%d")
        );
        let log_path = log_dir.join(log_file_name);
        if !dry_run {
            write_log_header(&log_path).map_err(|e| e.to_string())?;
        }

        for file_path in files {
            processed += 1;
            let source_path = file_path.to_string_lossy().to_string();
            let resolved_mode = if mode == "AUTO" {
                detect_mode_for_path(&file_path)
            } else {
                Some(mode.as_str())
            };
            let resolved_mode = match resolved_mode {
                Some(found) => found,
                None => {
                    skipped += 1;
                    entries.push(SortEntry {
                        timestamp: chrono::Local::now().to_rfc3339(),
                        username: username.clone(),
                        mode: mode.clone(),
                        client: client_name.clone(),
                        operation: operation.clone(),
                        source_path: source_path.clone(),
                        dest_path: "".to_string(),
                        result: "skipped".to_string(),
                        error_message: "Unsupported file type".to_string(),
                    });
                    let _ = window_clone.emit(
                        "sort-progress",
                        SortProgress {
                            processed,
                            total,
                            current: source_path,
                            result: "skipped".to_string(),
                        },
                    );
                    continue;
                }
            };
            let destination_rel = destination_for_mode(resolved_mode)
                .ok_or_else(|| "Unknown mode selected".to_string())?;
            let dest_dir = PathBuf::from(&project_root)
                .join(&client_name)
                .join(destination_rel);
            if !dry_run && ensured_dirs.insert(dest_dir.clone()) {
                ensure_dir(&dest_dir).map_err(|e| e.to_string())?;
            }
            let file_name = match file_path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name.to_string(),
                None => {
                    failed += 1;
                    entries.push(SortEntry {
                        timestamp: chrono::Local::now().to_rfc3339(),
                        username: username.clone(),
                        mode: resolved_mode.to_string(),
                        client: client_name.clone(),
                        operation: operation.clone(),
                        source_path: source_path.clone(),
                        dest_path: "".to_string(),
                        result: "failed".to_string(),
                        error_message: "Invalid file name".to_string(),
                    });
                    let _ = window_clone.emit(
                        "sort-progress",
                        SortProgress {
                            processed,
                            total,
                            current: source_path,
                            result: "failed".to_string(),
                        },
                    );
                    continue;
                }
            };

            let dest_path = unique_destination_path(&dest_dir, &file_name, &mut reserved_names);
            let dest_path_str = dest_path.to_string_lossy().to_string();
            let timestamp = chrono::Local::now().to_rfc3339();

            let result = if dry_run {
                skipped += 1;
                SortEntry {
                    timestamp,
                    username: username.clone(),
                    mode: resolved_mode.to_string(),
                    client: client_name.clone(),
                    operation: operation.clone(),
                    source_path: source_path.clone(),
                    dest_path: dest_path_str.clone(),
                    result: "skipped".to_string(),
                    error_message: "Dry run".to_string(),
                }
            } else {
                match operation.as_str() {
                    "copy" => match fs::copy(&file_path, &dest_path) {
                        Ok(_) => SortEntry {
                            timestamp,
                            username: username.clone(),
                            mode: resolved_mode.to_string(),
                            client: client_name.clone(),
                            operation: operation.clone(),
                            source_path: source_path.clone(),
                            dest_path: dest_path_str.clone(),
                            result: "ok".to_string(),
                            error_message: "".to_string(),
                        },
                        Err(err) => {
                            failed += 1;
                            SortEntry {
                                timestamp,
                                username: username.clone(),
                                mode: resolved_mode.to_string(),
                                client: client_name.clone(),
                                operation: operation.clone(),
                                source_path: source_path.clone(),
                                dest_path: dest_path_str.clone(),
                                result: "failed".to_string(),
                                error_message: err.to_string(),
                            }
                        }
                    },
                    "move" => match fs::rename(&file_path, &dest_path) {
                        Ok(_) => SortEntry {
                            timestamp,
                            username: username.clone(),
                            mode: resolved_mode.to_string(),
                            client: client_name.clone(),
                            operation: operation.clone(),
                            source_path: source_path.clone(),
                            dest_path: dest_path_str.clone(),
                            result: "ok".to_string(),
                            error_message: "".to_string(),
                        },
                        Err(err) => {
                            let raw = err.raw_os_error();
                            if raw == Some(EXDEV) || raw == Some(WINDOWS_NOT_SAME_DEVICE) {
                                match fs::copy(&file_path, &dest_path) {
                                    Ok(_) => match remove_file_with_retry(&file_path) {
                                        Ok(_) => SortEntry {
                                            timestamp,
                                            username: username.clone(),
                                            mode: resolved_mode.to_string(),
                                            client: client_name.clone(),
                                            operation: operation.clone(),
                                            source_path: source_path.clone(),
                                            dest_path: dest_path_str.clone(),
                                            result: "ok".to_string(),
                                            error_message: "".to_string(),
                                        },
                                        Err(remove_err) => {
                                            let rollback_msg = if dest_path.exists() {
                                                match fs::remove_file(&dest_path) {
                                                    Ok(_) => "Copied file was rolled back.".to_string(),
                                                    Err(rb_err) => {
                                                        format!("Rollback failed ({}).", rb_err)
                                                    }
                                                }
                                            } else {
                                                "Copied file was already missing.".to_string()
                                            };
                                            let hint = if remove_err.kind() == io::ErrorKind::PermissionDenied {
                                                " Source file is likely open in another app."
                                            } else {
                                                ""
                                            };
                                            failed += 1;
                                            SortEntry {
                                                timestamp,
                                                username: username.clone(),
                                                mode: resolved_mode.to_string(),
                                                client: client_name.clone(),
                                                operation: operation.clone(),
                                                source_path: source_path.clone(),
                                                dest_path: dest_path_str.clone(),
                                                result: "failed".to_string(),
                                                error_message: format!(
                                                    "Move failed: could not remove source ({}).{} {}",
                                                    remove_err, hint, rollback_msg
                                                ),
                                            }
                                        }
                                    },
                                    Err(err) => {
                                        failed += 1;
                                        SortEntry {
                                            timestamp,
                                            username: username.clone(),
                                            mode: resolved_mode.to_string(),
                                            client: client_name.clone(),
                                            operation: operation.clone(),
                                            source_path: source_path.clone(),
                                            dest_path: dest_path_str.clone(),
                                            result: "failed".to_string(),
                                            error_message: err.to_string(),
                                        }
                                    }
                                }
                            } else {
                                failed += 1;
                                SortEntry {
                                    timestamp,
                                    username: username.clone(),
                                    mode: resolved_mode.to_string(),
                                    client: client_name.clone(),
                                    operation: operation.clone(),
                                    source_path: source_path.clone(),
                                    dest_path: dest_path_str.clone(),
                                    result: "failed".to_string(),
                                    error_message: err.to_string(),
                                }
                            }
                        }
                    },
                    _ => {
                        failed += 1;
                        SortEntry {
                            timestamp,
                            username: username.clone(),
                            mode: resolved_mode.to_string(),
                            client: client_name.clone(),
                            operation: operation.clone(),
                            source_path: source_path.clone(),
                            dest_path: dest_path_str.clone(),
                            result: "failed".to_string(),
                            error_message: "Unknown operation".to_string(),
                        }
                    }
                }
            };

            let result_status = result.result.clone();
            entries.push(result);

            let _ = window_clone.emit(
                "sort-progress",
                SortProgress {
                    processed,
                    total,
                    current: source_path,
                    result: result_status,
                },
            );
        }

        if !dry_run {
            append_log(&log_path, &entries).map_err(|e| e.to_string())?;
        } else if !log_dir.exists() {
            ensure_dir(&log_dir).map_err(|e| e.to_string())?;
        }

        Ok(SortResult {
            processed,
            failed,
            skipped,
            entries,
            log_path: log_path.to_string_lossy().to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn undo_batch(entries: Vec<UndoEntry>) -> Result<UndoResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut processed = 0usize;
        let mut failed = 0usize;
        let mut results = Vec::new();

        for entry in entries {
            processed += 1;
            let source = PathBuf::from(&entry.source_path);
            let dest = PathBuf::from(&entry.dest_path);
            let outcome = match entry.operation.as_str() {
                "move" => {
                    if !dest.exists() {
                        Err("Destination missing".to_string())
                    } else if source.exists() {
                        Err("Source already exists".to_string())
                    } else {
                        if let Some(parent) = source.parent() {
                            ensure_dir(parent).map_err(|e| e.to_string())?;
                        }
                        match fs::rename(&dest, &source) {
                            Ok(_) => Ok(()),
                            Err(err) => Err(err.to_string()),
                        }
                    }
                }
                "copy" => {
                    if dest.exists() {
                        match fs::remove_file(&dest) {
                            Ok(_) => Ok(()),
                            Err(err) => Err(err.to_string()),
                        }
                    } else {
                        Ok(())
                    }
                }
                _ => Err("Unknown operation".to_string()),
            };

            match outcome {
                Ok(_) => results.push(UndoEntryResult {
                    source_path: entry.source_path,
                    dest_path: entry.dest_path,
                    result: "ok".to_string(),
                    error_message: "".to_string(),
                }),
                Err(message) => {
                    failed += 1;
                    results.push(UndoEntryResult {
                        source_path: entry.source_path,
                        dest_path: entry.dest_path,
                        result: "failed".to_string(),
                        error_message: message,
                    });
                }
            }
        }

        Ok(UndoResult {
            processed,
            failed,
            entries: results,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            scan_project_root,
            set_watch_root,
            create_client,
            open_folder,
            fix_client,
            sort_files,
            append_debug_log,
            clear_debug_log,
            undo_batch
        ])
        .manage(Mutex::new(WatchState {
            watcher: None,
            stop_tx: None,
            thread: None,
        }))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn destination_mapping() {
        assert_eq!(
            destination_for_mode("VIDEO PROXY"),
            Some("01_MEDIA/010_VIDEO_PROXY")
        );
        assert_eq!(
            destination_for_mode("APPROVAL EXPORTS"),
            Some("03_EXPORTS/APPROVAL")
        );
        assert_eq!(destination_for_mode("UNKNOWN"), None);
    }

    #[test]
    fn collision_naming() {
        let temp_dir = std::env::temp_dir().join("project_sorter_collision_test");
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        let existing = temp_dir.join("clip.mov");
        fs::write(&existing, "test").unwrap();

        let mut reserved = HashSet::new();
        let dest1 = unique_destination_path(&temp_dir, "clip.mov", &mut reserved);
        assert_eq!(
            dest1.file_name().and_then(|n| n.to_str()).unwrap(),
            "clip__2.mov"
        );

        let dest2 = unique_destination_path(&temp_dir, "clip.mov", &mut reserved);
        assert_eq!(
            dest2.file_name().and_then(|n| n.to_str()).unwrap(),
            "clip__3.mov"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn client_project_filename_uses_client_name_without_type() {
        assert_eq!(
            client_project_filename("DIGITAIN_EXHIBITOR"),
            "DIGITAIN.prproj"
        );
        assert_eq!(
            client_project_filename("THE_BIG_SHOW_PRODUCT"),
            "THE_BIG_SHOW.prproj"
        );
        assert_eq!(client_project_filename("DIGITAIN"), "DIGITAIN.prproj");
    }
}
