//! Read-only, one-folder-at-a-time browsing for the Import media workspace.
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::Manager;

pub(crate) fn media_kind(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" | "mov" | "mxf" | "mkv" | "avi" | "webm" | "m4v" | "r3d" | "mpg" | "mpeg" => {
            Some("video")
        }
        "wav" | "aif" | "aiff" | "mp3" | "flac" | "m4a" | "aac" | "ogg" | "opus" => Some("audio"),
        "jpg" | "jpeg" | "png" | "tif" | "tiff" | "heic" | "heif" | "webp" | "bmp" | "gif" => {
            Some("image")
        }
        _ => None,
    }
}

pub(crate) fn resolve_paths(paths: Vec<String>) -> Result<Vec<MediaEntry>, String> {
    let mut files = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for source in paths {
        let source = PathBuf::from(source);
        if !source.is_absolute() {
            return Err("Choose a full file or folder path.".into());
        }
        if !source.exists() {
            return Err(format!(
                "This source is no longer available: {}",
                source.display()
            ));
        }
        let candidates = if source.is_dir() {
            let mut found = Vec::new();
            for entry in walkdir::WalkDir::new(&source).follow_links(false) {
                let entry =
                    entry.map_err(|e| format!("Could not read the selected folder: {e}"))?;
                if entry.file_type().is_file() && media_kind(entry.path()).is_some() {
                    found.push(entry.into_path());
                }
            }
            found
        } else {
            vec![source]
        };
        for path in candidates {
            let Some(kind) = media_kind(&path) else {
                continue;
            };
            let canonical = path.canonicalize().map_err(|e| e.to_string())?;
            if !seen.insert(canonical) {
                continue;
            }
            let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
            if !metadata.is_file() {
                continue;
            }
            files.push(MediaEntry {
                name: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: path.to_string_lossy().into_owned(),
                kind: kind.into(),
                size: metadata.len(),
            });
        }
    }
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(files)
}

#[tauri::command]
pub async fn media_resolve_files(paths: Vec<String>) -> Result<Vec<MediaEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_paths(paths))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn media_prepare_preview(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        if media_kind(&path).is_none() || !path.is_file() {
            return Err("This recording is unavailable for preview.".into());
        }
        // Grant the asset protocol access to this selected file only, never an entire drive.
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        let scope = app.asset_protocol_scope();
        scope.allow_file(&path).map_err(|e| e.to_string())?;
        scope.allow_file(canonical).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct MediaLocation {
    name: String,
    path: String,
    kind: String,
    available: bool,
    total_bytes: Option<u64>,
    free_bytes: Option<u64>,
}
#[derive(Serialize)]
pub struct MediaEntry {
    name: String,
    pub(crate) path: String,
    kind: String,
    size: u64,
}
#[derive(Serialize)]
pub struct MediaFolder {
    path: String,
    parent: Option<String>,
    entries: Vec<MediaEntry>,
    truncated: bool,
}

#[cfg(windows)]
fn drive_locations() -> Vec<MediaLocation> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLogicalDrives() -> u32;
        fn GetDriveTypeW(root: *const u16) -> u32;
        fn GetVolumeInformationW(
            root: *const u16,
            name: *mut u16,
            length: u32,
            serial: *mut u32,
            max_component: *mut u32,
            flags: *mut u32,
            fs_name: *mut u16,
            fs_length: u32,
        ) -> i32;
        fn GetDiskFreeSpaceExW(
            path: *const u16,
            available: *mut u64,
            total: *mut u64,
            free: *mut u64,
        ) -> i32;
    }
    let mask = unsafe { GetLogicalDrives() };
    let mut locations = Vec::new();
    for letter in b'C'..=b'Z' {
        if mask & (1 << (letter - b'A')) == 0 {
            continue;
        }
        let path = format!("{}:\\", letter as char);
        let wide: Vec<u16> = Path::new(&path)
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let drive_type = unsafe { GetDriveTypeW(wide.as_ptr()) };
        // Network paths remain selectable, but are not probed during discovery.
        let kind = match drive_type {
            2 => "removable",
            3 => "drive",
            4 => "network",
            _ => continue,
        };
        let mut name = String::new();
        let mut total = None;
        let mut free = None;
        let mut available = true;
        if drive_type == 2 || drive_type == 3 {
            let mut label = [0u16; 261];
            let ok = unsafe {
                GetVolumeInformationW(
                    wide.as_ptr(),
                    label.as_mut_ptr(),
                    label.len() as u32,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    0,
                )
            };
            if ok != 0 {
                let len = label.iter().position(|c| *c == 0).unwrap_or(label.len());
                name = String::from_utf16_lossy(&label[..len]);
            } else if drive_type == 2 {
                available = false;
            }
            if available {
                let mut available_bytes = 0;
                let mut total_bytes = 0;
                if unsafe {
                    GetDiskFreeSpaceExW(
                        wide.as_ptr(),
                        &mut available_bytes,
                        &mut total_bytes,
                        std::ptr::null_mut(),
                    )
                } != 0
                {
                    total = Some(total_bytes);
                    free = Some(available_bytes);
                }
            }
        }
        if name.is_empty() {
            name = match kind {
                "removable" => "Memory card / recorder",
                "network" => "Network drive",
                _ => "Local drive",
            }
            .into();
        }
        locations.push(MediaLocation {
            name: format!("{name} ({}:)", letter as char),
            path,
            kind: kind.into(),
            available,
            total_bytes: total,
            free_bytes: free,
        });
    }
    locations.sort_by_key(|location| {
        if location.kind == "removable" {
            0
        } else if location.kind == "drive" {
            1
        } else {
            2
        }
    });
    locations
}

#[cfg(not(windows))]
fn drive_locations() -> Vec<MediaLocation> {
    let mut locations = vec![MediaLocation {
        name: "Computer".into(),
        path: "/".into(),
        kind: "drive".into(),
        available: true,
        total_bytes: None,
        free_bytes: None,
    }];
    for base in ["/Volumes", "/media", "/mnt"] {
        if let Ok(entries) = fs::read_dir(base) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    locations.push(MediaLocation {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        path: entry.path().to_string_lossy().into_owned(),
                        kind: "removable".into(),
                        available: true,
                        total_bytes: None,
                        free_bytes: None,
                    });
                }
            }
        }
    }
    locations
}

#[tauri::command]
pub async fn media_source_locations(project_root: String) -> Result<Vec<MediaLocation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut locations = drive_locations();
        let home =
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
        if let Some(home) = home {
            for (name, path) in [
                ("Home", home.clone()),
                ("Desktop", home.join("Desktop")),
                ("Downloads", home.join("Downloads")),
                ("Videos", home.join("Videos")),
                ("Documents", home.join("Documents")),
            ] {
                if path.is_dir() {
                    locations.push(MediaLocation {
                        name: name.into(),
                        path: path.to_string_lossy().into_owned(),
                        kind: "folder".into(),
                        available: true,
                        total_bytes: None,
                        free_bytes: None,
                    });
                }
            }
        }
        // Do not touch the NAS until the user opens this location.
        if !project_root.is_empty() {
            locations.push(MediaLocation {
                name: "This project".into(),
                path: project_root,
                kind: "project".into(),
                available: true,
                total_bytes: None,
                free_bytes: None,
            });
        }
        locations
    })
    .await
    .map_err(|e| e.to_string())
}

fn browse_folder(path: &Path) -> Result<MediaFolder, String> {
    if !path.is_absolute() {
        return Err("Enter a full folder path, such as C:\\Media or \\\\server\\share.".into());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(path).map_err(|e| format!("This folder could not be opened: {e}"))? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 2 != 0 {
                continue;
            }
        }
        let entry_path = entry.path();
        let kind = if metadata.is_dir() {
            "folder"
        } else {
            let Some(kind) = media_kind(&entry_path) else {
                continue;
            };
            kind
        };
        entries.push(MediaEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            kind: kind.into(),
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != "folder")
            .cmp(&(b.kind != "folder"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let truncated = entries.len() > 5000;
    entries.truncate(5000);
    Ok(MediaFolder {
        path: path.to_string_lossy().into_owned(),
        parent: path.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
        truncated,
    })
}

#[tauri::command]
pub async fn media_browse_folder(path: String) -> Result<MediaFolder, String> {
    tauri::async_runtime::spawn_blocking(move || browse_folder(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

fn valid_client_paths(paths: Vec<String>) -> Vec<String> {
    const REQUIRED: [&str; 4] = ["010_VIDEO_PROXY", "020_VIDEO_RAW", "030_AUDIO_CLEAN", "040_AUDIO_RAW"];
    paths.into_iter().filter(|path| {
        let base=Path::new(path);
        base.is_absolute() && REQUIRED.iter().all(|folder| base.join("01_MEDIA").join(folder).is_dir())
    }).collect()
}

#[tauri::command]
pub async fn media_valid_client_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || valid_client_paths(paths)).await.map_err(|error|error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inline_client_creation_builds_a_valid_destination_without_replacing_existing_clients() {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().to_string_lossy().into_owned();
        let name="Bright_Start_SOCIAL".to_string();
        crate::create_client_sync(root.clone(),name.clone(),"SOCIAL".into(),None).unwrap();
        let client=temp.path().join(&name).to_string_lossy().into_owned();
        assert_eq!(valid_client_paths(vec![client.clone()]),vec![client.clone()]);
        fs::write(Path::new(&client).join("keep.txt"),b"existing material").unwrap();
        assert!(crate::create_client_sync(root,name,"SOCIAL".into(),None).is_err());
        assert_eq!(fs::read(Path::new(&client).join("keep.txt")).unwrap(),b"existing material");
    }

    #[test]
    fn assignment_clients_need_all_four_media_folders() {
        let temp=tempfile::tempdir().unwrap();let client=temp.path().join("Client_SOCIAL");
        for folder in ["010_VIDEO_PROXY", "020_VIDEO_RAW", "040_AUDIO_RAW"] {fs::create_dir_all(client.join("01_MEDIA").join(folder)).unwrap();}
        let paths=vec![client.to_string_lossy().into_owned()];
        assert!(valid_client_paths(paths.clone()).is_empty());
        fs::create_dir_all(client.join("01_MEDIA/030_AUDIO_CLEAN")).unwrap();
        assert_eq!(valid_client_paths(paths.clone()),paths);
    }
    #[test]
    fn folder_selection_resolves_only_media_and_deduplicates_paths() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("Camera")).unwrap();
        let video = temp.path().join("Camera/Take.MP4");
        fs::write(&video, b"video").unwrap();
        fs::write(temp.path().join("Camera/Take.xml"), b"sidecar").unwrap();
        fs::write(temp.path().join("Project.prproj"), b"project").unwrap();
        fs::write(temp.path().join("Sound.OPUS"), b"audio").unwrap();
        let before = fs::metadata(&video).unwrap();
        let files = resolve_paths(vec![
            temp.path().to_string_lossy().into_owned(),
            video.to_string_lossy().into_owned(),
        ])
        .unwrap();
        assert_eq!(files.len(), 2);
        assert!(files
            .iter()
            .all(|file| file.kind == "video" || file.kind == "audio"));
        assert_eq!(fs::read(&video).unwrap(), b"video");
        assert_eq!(
            fs::metadata(&video).unwrap().modified().unwrap(),
            before.modified().unwrap()
        );
        assert_eq!(
            fs::metadata(&video).unwrap().created().ok(),
            before.created().ok()
        );
    }
    #[test]
    fn browser_preserves_paths_and_classifies_media_without_recursing() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("Card A")).unwrap();
        fs::write(temp.path().join("Card A/inside.mp4"), b"nested").unwrap();
        fs::write(temp.path().join("Take_01.MOV"), b"video").unwrap();
        fs::write(temp.path().join("Recorder.wav"), b"audio").unwrap();
        fs::write(temp.path().join("Notes.xml"), b"sidecar").unwrap();
        let listing = browse_folder(temp.path()).unwrap();
        assert_eq!(listing.entries.len(), 3);
        assert_eq!(listing.entries[0].kind, "folder");
        assert!(listing
            .entries
            .iter()
            .any(|e| e.name == "Take_01.MOV" && e.kind == "video"));
        assert!(listing
            .entries
            .iter()
            .any(|e| e.name == "Recorder.wav" && e.kind == "audio"));
        assert!(listing.entries.iter().all(|e| e.name != "Notes.xml"));
    }
    #[test]
    fn browser_rejects_relative_paths_and_reports_missing_folders() {
        assert!(browse_folder(Path::new("relative/path")).is_err());
        let temp = tempfile::tempdir().unwrap();
        assert!(browse_folder(&temp.path().join("missing")).is_err());
    }
}
