use libc::EXDEV;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use tauri::Emitter;

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

const REQUIRED_DIRS: [&str; 4] = ["01_MEDIA", "02_EDIT", "03_EXPORTS", "04_FINAL"];
const TEMPLATE_DIRS: [&str; 10] = [
    "01_MEDIA",
    "01_MEDIA/010_VIDEO_PROXY",
    "01_MEDIA/020_VIDEO_RAW",
    "01_MEDIA/030_AUDIO_CLEAN",
    "01_MEDIA/040_AUDIO_RAW",
    "01_MEDIA/050_STILLS",
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

fn has_dir(path: &Path, child: &str) -> bool {
    path.join(child).is_dir()
}

fn ensure_dir(path: &Path) -> Result<(), io::Error> {
    if !path.exists() {
        fs::create_dir_all(path)?;
    }
    Ok(())
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
    for path_str in paths {
        let path = PathBuf::from(path_str);
        if path.is_dir() {
            for entry in WalkDir::new(&path)
                .into_iter()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_type().is_file())
            {
                files.push(entry.path().to_path_buf());
            }
        } else if path.is_file() {
            files.push(path);
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

fn username() -> String {
    whoami::username()
}

#[tauri::command]
fn scan_project_root(project_root: String) -> Result<Vec<ClientInfo>, String> {
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

        let has_all_required = REQUIRED_DIRS.iter().all(|dir| has_dir(&path, dir));
        let missing: Vec<String> = TEMPLATE_DIRS
            .iter()
            .filter(|dir| !has_dir(&path, dir))
            .map(|dir| dir.to_string())
            .collect();

        let status = if has_all_required {
            if missing.is_empty() {
                "OK"
            } else {
                "Missing folders"
            }
        } else {
            "Not a client"
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
}

#[tauri::command]
fn create_client(project_root: String, client_name: String) -> Result<(), String> {
    let client_root = PathBuf::from(project_root).join(&client_name);
    if client_root.exists() {
        return Err("Client folder already exists".to_string());
    }
    for dir in TEMPLATE_DIRS.iter() {
        ensure_dir(&client_root.join(dir)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn fix_client(project_root: String, client_name: String) -> Result<(), String> {
    let client_root = PathBuf::from(project_root).join(&client_name);
    if !client_root.exists() {
        return Err("Client folder does not exist".to_string());
    }

    let has_all_required = REQUIRED_DIRS
        .iter()
        .all(|dir| client_root.join(dir).is_dir());
    if !has_all_required {
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
        let destination_rel = destination_for_mode(&mode)
            .ok_or_else(|| "Unknown mode selected".to_string())?;
        let dest_dir = PathBuf::from(&project_root)
            .join(&client_name)
            .join(destination_rel);
        if !dry_run {
            ensure_dir(&dest_dir).map_err(|e| e.to_string())?;
        }

        let files = list_files(&paths);
        let total = files.len();
        let mut processed = 0usize;
        let mut failed = 0usize;
        let mut skipped = 0usize;
        let mut entries: Vec<SortEntry> = Vec::new();
        let mut reserved_names = HashSet::new();
        let username = username();

        let log_dir = PathBuf::from(&project_root).join("_logs");
        if !dry_run {
            ensure_dir(&log_dir).map_err(|e| e.to_string())?;
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
            let file_name = match file_path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name.to_string(),
                None => {
                    failed += 1;
                    entries.push(SortEntry {
                        timestamp: chrono::Local::now().to_rfc3339(),
                        username: username.clone(),
                        mode: mode.clone(),
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
                    mode: mode.clone(),
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
                            mode: mode.clone(),
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
                                mode: mode.clone(),
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
                            mode: mode.clone(),
                            client: client_name.clone(),
                            operation: operation.clone(),
                            source_path: source_path.clone(),
                            dest_path: dest_path_str.clone(),
                            result: "ok".to_string(),
                            error_message: "".to_string(),
                        },
                        Err(err) => {
                            if err.raw_os_error() == Some(EXDEV) {
                                match fs::copy(&file_path, &dest_path)
                                    .and_then(|_| fs::remove_file(&file_path))
                                {
                                    Ok(_) => SortEntry {
                                        timestamp,
                                        username: username.clone(),
                                        mode: mode.clone(),
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
                                            mode: mode.clone(),
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
                                    mode: mode.clone(),
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
                            mode: mode.clone(),
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            scan_project_root,
            create_client,
            fix_client,
            sort_files,
            undo_batch
        ])
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
}
