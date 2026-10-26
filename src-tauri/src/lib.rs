use libc::EXDEV;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use walkdir::WalkDir;

mod frameio;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ClientInfo {
    name: String,
    path: String,
    season: Option<String>,
    status: String,
    missing: Vec<String>,
    export_status: ExportStatus,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct ExportStatus {
    versions: Vec<ExportVersion>,
    approval_versions: Vec<ExportVersion>,
    latest_version: Option<u32>,
    latest_filename: Option<String>,
    approval_ready: bool,
    approval_in_progress: bool,
    approval_progress_phase: Option<String>,
    final_version: Option<u32>,
    final_filename: Option<String>,
    #[serde(default)]
    final_published_at: Option<String>,
    final_current: bool,
    issue: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ExportVersion {
    version: u32,
    filename: String,
    relative_path: String,
    added_at: String,
    frameio: Option<FrameIoRecord>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct FrameIoRecord {
    schema_version: u32,
    state: String,
    source_size: u64,
    source_modified_nanos: u128,
    destination_account_id: String,
    destination_project_id: String,
    destination_folder_id: String,
    file_id: Option<String>,
    share_id: Option<String>,
    share_url: Option<String>,
    updated_at: String,
    last_error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct ProjectRootOption {
    name: String,
    path: String,
    number: u32,
}

#[derive(Debug, Serialize, Clone)]
struct ClientExportStatusUpdate {
    name: String,
    export_status: ExportStatus,
}

#[derive(Debug, Serialize, Clone)]
struct ApprovalProgressStatus {
    client_name: String,
    phase: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
struct ClientScanProgress {
    project_root: String,
    scan_id: u64,
    phase: String,
    clients: Vec<ClientInfo>,
    export_updates: Vec<ClientExportStatusUpdate>,
    completed: usize,
    total: usize,
    reset: bool,
    client_names: Vec<String>,
    partial: bool,
    removed_names: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
struct ClientsChanged {
    project_root: String,
    client_names: Vec<String>,
    all_clients: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
struct VideoFingerprint {
    size: u64,
    modified: std::time::SystemTime,
}

#[derive(Debug, Serialize, Deserialize)]
struct FinalPromotionRecord {
    source_filename: String,
    version: u32,
    final_filename: String,
    source: VideoFingerprint,
    published: VideoFingerprint,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    migrated: bool,
}

const FINAL_PROMOTION_RECORD: &str = ".pepper-final.json";
const PRODUCTION_PROJECTS_ROOT: &str = r"Z:\The Huddle\Production";
const APPROVAL_PROGRESS_STALE_AFTER: Duration = Duration::from_secs(300);

fn approval_progress_marker_is_active(marker_path: &Path) -> bool {
    fs::metadata(marker_path)
        .and_then(|metadata| metadata.modified())
        .is_ok_and(|modified| {
            std::time::SystemTime::now()
                .duration_since(modified)
                .map(|age| age <= APPROVAL_PROGRESS_STALE_AFTER)
                .unwrap_or(true)
        })
}

fn approval_progress_phase(marker_path: &Path) -> Option<String> {
    if !approval_progress_marker_is_active(marker_path) {
        return None;
    }
    #[derive(Deserialize)]
    struct ProgressMarker {
        phase: Option<String>,
    }
    fs::read(marker_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ProgressMarker>(&bytes).ok())
        .and_then(|progress| progress.phase)
}

fn approval_progress_for_client(client_name: &str, client_path: &Path) -> Option<ApprovalProgressStatus> {
    let progress_dir = client_path.join("03_EXPORTS/APPROVAL/JSON/.staging");
    let entries = fs::read_dir(progress_dir).ok()?;
    let mut active: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !entry.file_type().ok()?.is_file()
                || !path.file_name()?.to_string_lossy().ends_with(".progress.json")
                || !approval_progress_marker_is_active(&path)
            {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect();
    active.sort_by(|left, right| right.0.cmp(&left.0));
    let (_, marker_path) = active.into_iter().next()?;
    Some(ApprovalProgressStatus {
        client_name: client_name.to_string(),
        phase: approval_progress_phase(&marker_path),
    })
}

fn video_fingerprint(path: &Path) -> io::Result<VideoFingerprint> {
    let metadata = fs::metadata(path)?;
    Ok(VideoFingerprint {
        size: metadata.len(),
        modified: metadata.modified()?,
    })
}

fn final_export_filename(client_path: &Path, source_filename: &str) -> Result<String, String> {
    let client_name = client_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Unable to determine the client folder name".to_string())?;
    let extension = Path::new(source_filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .ok_or_else(|| "Source export has no file extension".to_string())?;
    Ok(format!("{client_name}_FINAL.{extension}"))
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
const VIDEO_EXTENSIONS: [&str; 9] = [
    "mp4", "mov", "mxf", "m4v", "webm", "avi", "mkv", "mpg", "mpeg",
];
const CLIENT_TEMPLATE_PROJECT_SOURCE: &str = r#"Z:\The Huddle\Templates\Copied_Huddle Master Template 2026_4K_2\Huddle Master Template 2026_4K_2.prproj"#;
const CLIENT_SCENE_SWITCHING_TEMPLATE_SOURCE: &str = r#"Z:\The Huddle\Templates\Copied_Huddle Master Template Scenes Switching 2026 4K_1\Huddle Master Template Scenes Switching 2026 4K_1.prproj"#;
const CLIENT_TYPES: [&str; 5] = ["EXHIBITOR", "HUDDLE", "PRODUCT", "MARIYAMEETS", "SOCIAL"];
const TEMPLATE_DIRS: [&str; 13] = [
    "01_MEDIA",
    "01_MEDIA/010_VIDEO_PROXY",
    "01_MEDIA/020_VIDEO_RAW",
    "01_MEDIA/030_AUDIO_CLEAN",
    "01_MEDIA/040_AUDIO_RAW",
    "01_MEDIA/050_STILLS",
    "01_MEDIA/060_MUSIC",
    "01_MEDIA/070_GRAPHICS",
    "01_MEDIA/080_MISCELLANEOUS",
    "02_EDIT",
    "03_EXPORTS",
    "03_EXPORTS/APPROVAL",
    "04_FINAL",
];
const OPTIONAL_LEGACY_DIRS: [&str; 2] = ["070_GRAPHICS", "080_MISCELLANEOUS"];

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
            "mov" | "mp4" | "mxf" | "mkv" | "avi" | "mpg" | "mpeg" | "m4v" | "webm" | "r3d"
        ),
        "AUDIO CLEAN" | "AUDIO RAW" => matches!(
            ext.as_str(),
            "wav" | "mp3" | "aif" | "aiff" | "flac" | "m4a" | "aac" | "ogg" | "opus"
        ),
        "STILLS" => matches!(
            ext.as_str(),
            "jpg" | "jpeg" | "png" | "tif" | "tiff" | "heic" | "heif" | "webp" | "bmp" | "gif"
        ),
        _ => true,
    }
}

fn detect_mode_for_path(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
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

fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            VIDEO_EXTENSIONS
                .iter()
                .any(|candidate| ext.eq_ignore_ascii_case(candidate))
        })
        .unwrap_or(false)
}

fn versioned_stem(stem: &str) -> Result<(String, Option<u32>), String> {
    let upper = stem.to_ascii_uppercase();
    if let Some(index) = upper.rfind("_V") {
        let suffix = &stem[index + 2..];
        if suffix.is_empty() || !suffix.chars().all(|character| character.is_ascii_digit()) {
            return Err(format!("Malformed version suffix in {stem}"));
        }
        let version = suffix
            .parse::<u32>()
            .map_err(|_| format!("Invalid version number in {stem}"))?;
        if version == 0 {
            return Err(format!("Version numbers start at 1: {stem}"));
        }
        return Ok((stem[..index].to_string(), Some(version)));
    }
    Ok((stem.to_string(), None))
}

fn scan_video_versions(directory: &Path) -> Result<Vec<ExportVersion>, String> {
    let mut files = scan_video_versions_in(directory, directory)?;
    files.extend(scan_video_versions_in(
        directory,
        &directory.join("APPROVAL/PENDING"),
    )?);
    validate_video_versions(files)
}

fn include_superseded_versions(active: &[ExportVersion], exports_dir: &Path) -> Vec<ExportVersion> {
    // Superseded approval sources remain useful in the version player, but are
    // deliberately excluded from the active list used for publishing.
    let superseded_dir = exports_dir.join("APPROVAL/PENDING/_SUPERSEDED");
    let Ok(superseded) = scan_video_versions_in(exports_dir, &superseded_dir) else {
        return active.to_vec();
    };
    let active_base = active.first().and_then(|version| {
        Path::new(&version.filename)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| versioned_stem(stem).ok())
            .map(|(base, _)| base.to_lowercase())
    });
    let mut versions = active.to_vec();
    for version in superseded {
        let Some((base, _)) = Path::new(&version.filename)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| versioned_stem(stem).ok())
        else {
            continue;
        };
        if active_base
            .as_ref()
            .is_some_and(|active_base| !base.eq_ignore_ascii_case(active_base))
            || versions.iter().any(|current| {
                current.relative_path.eq_ignore_ascii_case(&version.relative_path)
                    || current.version == version.version
            })
        {
            continue;
        }
        versions.push(version);
    }
    versions.sort_by(|left, right| {
        left.version
            .cmp(&right.version)
            .then_with(|| left.filename.to_lowercase().cmp(&right.filename.to_lowercase()))
    });
    versions
}

fn scan_video_versions_in(root: &Path, directory: &Path) -> Result<Vec<ExportVersion>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Unable to read {}: {error}", directory.display())),
    };

    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() || !is_video_file(&entry.path()) {
            continue;
        }
        let path = entry.path();
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        // Approval renders and NLE intermediates are never promotion sources.
        let upper = stem.to_ascii_uppercase();
        if upper.contains("_APPROVAL") || upper.contains(".PART-") {
            continue;
        }
        let (_, version) = versioned_stem(stem)?;
        files.push(ExportVersion {
            version: version.unwrap_or(1),
            filename: entry.file_name().to_string_lossy().to_string(),
            relative_path: path
                .strip_prefix(root)
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .to_string(),
            added_at: chrono::DateTime::<chrono::Utc>::from(
                metadata
                    .created()
                    .or_else(|_| metadata.modified())
                    .map_err(|error| error.to_string())?,
            )
            .to_rfc3339(),
            frameio: None,
        });
    }
    Ok(files)
}

fn frameio_sidecar_path(video_path: &Path) -> PathBuf {
    let filename = video_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "approval-video".to_string());
    video_path.with_file_name(format!("{filename}.frameio.json"))
}

fn read_frameio_record(video_path: &Path) -> Option<FrameIoRecord> {
    let bytes = fs::read(frameio_sidecar_path(video_path)).ok()?;
    let record = serde_json::from_slice::<FrameIoRecord>(&bytes).ok()?;
    let metadata = fs::metadata(video_path).ok()?;
    let modified_nanos = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    (record.source_size == metadata.len() && record.source_modified_nanos == modified_nanos)
        .then_some(record)
}

fn scan_approval_versions(exports_dir: &Path) -> Result<Vec<ExportVersion>, String> {
    let approval_dir = exports_dir.join("APPROVAL");
    let entries = match fs::read_dir(&approval_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Unable to read {}: {error}", approval_dir.display())),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let path = entry.path();
        if !metadata.is_file() || !is_video_file(&path) {
            continue;
        }
        let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or_default();
        // Only the watcher’s finalized, watermarked approval render is a
        // deliverable. This excludes source copies, staging/partial names,
        // and other files that merely contain the word APPROVAL.
        const APPROVAL_SUFFIX: &str = "_APPROVAL_1080P_WM_TC";
        let upper_stem = stem.to_ascii_uppercase();
        let Some(source_stem) = upper_stem.strip_suffix(APPROVAL_SUFFIX).map(|_| &stem[..stem.len() - APPROVAL_SUFFIX.len()]) else {
            continue;
        };
        if metadata.len() == 0 {
            continue;
        }
        let (_, version) = versioned_stem(source_stem)?;
        let relative_path = path
            .strip_prefix(exports_dir)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .to_string();
        files.push(ExportVersion {
            version: version.unwrap_or(1),
            filename: entry.file_name().to_string_lossy().to_string(),
            relative_path,
            added_at: chrono::DateTime::<chrono::Utc>::from(
                metadata.created().or_else(|_| metadata.modified()).map_err(|error| error.to_string())?,
            ).to_rfc3339(),
            frameio: read_frameio_record(&path),
        });
    }
    files.sort_by(|left, right| left.version.cmp(&right.version).then_with(|| left.filename.to_lowercase().cmp(&right.filename.to_lowercase())));
    Ok(files)
}

fn validate_video_versions(files: Vec<ExportVersion>) -> Result<Vec<ExportVersion>, String> {
    let mut normalized_stem: Option<String> = None;
    let mut unversioned = Vec::new();
    let mut versioned = Vec::new();
    for file in files {
        let stem = Path::new(&file.filename)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let (base, version) = versioned_stem(stem)?;
        let normalized = base.to_lowercase();
        if let Some(previous) = &normalized_stem {
            if previous != &normalized {
                return Err(
                    "Multiple video deliverables found; choose one deliverable per client folder"
                        .to_string(),
                );
            }
        } else {
            normalized_stem = Some(normalized);
        }
        match version {
            Some(_) => versioned.push(file),
            None => unversioned.push(file),
        }
    }

    if unversioned.len() > 1 {
        return Err("Multiple unversioned video exports found".to_string());
    }
    let mut files = if versioned.is_empty() {
        unversioned
    } else {
        // A lone unversioned source with the same base name is the original V1.
        // This supports folders that gained explicit _V2, _V3, etc. suffixes later.
        let mut files = versioned;
        if let Some(mut original) = unversioned.into_iter().next() {
            original.version = 1;
            files.push(original);
        }
        files
    };
    files.sort_by(|a, b| {
        a.version
            .cmp(&b.version)
            .then_with(|| a.filename.to_lowercase().cmp(&b.filename.to_lowercase()))
    });
    for pair in files.windows(2) {
        if pair[0].version == pair[1].version {
            return Err(format!("Duplicate export version V{}", pair[0].version));
        }
    }
    Ok(files)
}

fn scan_export_status(client_path: &Path) -> ExportStatus {
    let exports_dir = client_path.join("03_EXPORTS");
    let final_dir = client_path.join("04_FINAL");
    let (exports, issue) = match scan_video_versions(&exports_dir) {
        Ok(versions) => (versions, None),
        Err(issue) => (Vec::new(), Some(issue)),
    };
    let display_versions = include_superseded_versions(&exports, &exports_dir);
    let approval_versions = scan_approval_versions(&exports_dir).unwrap_or_default();
    let latest = exports.last();
    let mut final_files: Vec<(String, std::time::SystemTime)> = fs::read_dir(&final_dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !entry.file_type().ok()?.is_file() || !is_video_file(&path) {
                return None;
            }
            Some((
                entry.file_name().to_string_lossy().to_string(),
                entry.metadata().ok()?.modified().ok()?,
            ))
        })
        .collect();
    final_files.sort_by(|left, right| right.1.cmp(&left.1));
    let promotion_record = fs::read(final_dir.join(FINAL_PROMOTION_RECORD))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<FinalPromotionRecord>(&bytes).ok())
        .filter(|record| {
            // Only use the record for the expected client filename and unchanged published video.
            (record.migrated
                || final_export_filename(client_path, &record.source_filename).as_deref()
                    == Ok(record.final_filename.as_str()))
                && video_fingerprint(&final_dir.join(&record.final_filename))
                    .ok()
                    .as_ref()
                    == Some(&record.published)
        });
    let approval_ready = latest.is_some_and(|export| {
        let source_stem = Path::new(&export.filename)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let expected = format!("{source_stem}_APPROVAL_1080p_WM_TC.mp4");
        exports_dir.join("APPROVAL").join(expected).is_file()
    });
    let approval_in_progress = latest.is_some_and(|export| {
        let source_stem = Path::new(&export.filename)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let review_name = format!("{source_stem}_APPROVAL_1080p_WM_TC.mp4.progress.json");
        let marker = exports_dir.join("APPROVAL/JSON/.staging").join(review_name);
        approval_progress_marker_is_active(&marker)
    });
    let approval_progress_phase = latest.and_then(|export| {
        let source_stem = Path::new(&export.filename).file_stem()?.to_str()?;
        let review_name = format!("{source_stem}_APPROVAL_1080p_WM_TC.mp4.progress.json");
        let marker = exports_dir.join("APPROVAL/JSON/.staging").join(review_name);
        approval_progress_phase(&marker)
    });
    let recorded_current = latest.is_some_and(|export| {
        promotion_record.as_ref().is_some_and(|record| {
            record.source_filename == export.filename
                && record.version == export.version
                && video_fingerprint(&exports_dir.join(&export.relative_path))
                    .ok()
                    .as_ref()
                    == Some(&record.source)
        })
    });
    // Older promotions renamed the video without recording its source version.
    // Verify those copies by content; cache unchanged pairs to avoid rereading NAS videos.
    let verified_legacy = if promotion_record.is_none() {
        final_files.iter().find_map(|file| {
            exports.iter().rev().find_map(|export| {
                let source_stem = Path::new(&export.filename).file_stem()?.to_str()?;
                let (base, _) = versioned_stem(source_stem).ok()?;
                let final_stem = Path::new(&file.0).file_stem()?.to_str()?;
                let matches_name = final_stem.eq_ignore_ascii_case(&format!("{base}_FINAL"))
                    || final_export_filename(client_path, &export.filename)
                        .is_ok_and(|name| name.eq_ignore_ascii_case(&file.0));
                (matches_name
                    && cached_files_match(
                        &exports_dir.join(&export.relative_path),
                        &final_dir.join(&file.0),
                    )
                    .unwrap_or(false))
                .then_some((file, export))
            })
        })
    } else {
        None
    };
    let matching_final = latest.and_then(|export| {
        final_files.iter().find(|(name, _)| {
            (recorded_current
                && promotion_record
                    .as_ref()
                    .is_some_and(|record| name == &record.final_filename))
                || name.eq_ignore_ascii_case(&export.filename)
                || verified_legacy.is_some_and(|(file, source)| {
                    name == &file.0 && source.filename == export.filename
                })
        })
    });
    let recorded_final = promotion_record.as_ref().and_then(|record| {
        final_files
            .iter()
            .find(|(name, _)| name == &record.final_filename)
    });
    let final_file = matching_final
        .or(recorded_final)
        .or(verified_legacy.map(|(file, _)| file))
        .or_else(|| final_files.first());
    let final_filename = final_file.map(|(name, _)| name.clone());
    let final_published_at = final_file.and_then(|(name, _)| {
        promotion_record
            .as_ref()
            .filter(|record| record.final_filename.as_str() == name.as_str())
            .and_then(|record| record.published_at.clone())
    }).or_else(|| final_file.and_then(|(name, _)| {
        let metadata = fs::metadata(final_dir.join(name)).ok()?;
        let created = metadata.created().or_else(|_| metadata.modified()).ok()?;
        Some(chrono::DateTime::<chrono::Utc>::from(created).to_rfc3339())
    }));
    let final_version = final_file.and_then(|(name, _)| {
        if let Some(record) = promotion_record
            .as_ref()
            .filter(|record| &record.final_filename == name)
        {
            return Some(record.version);
        }
        if let Some((_, export)) = verified_legacy.filter(|(file, _)| &file.0 == name) {
            return Some(export.version);
        }
        if final_export_filename(client_path, name)
            .is_ok_and(|canonical| canonical.eq_ignore_ascii_case(name))
        {
            return None;
        }
        Path::new(name)
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|stem| versioned_stem(stem).ok())
            .and_then(|(_, version)| version)
    });
    let final_current = matching_final.is_some();
    let latest_version = latest.map(|export| export.version);
    let latest_filename = latest.map(|export| export.filename.clone());
    ExportStatus {
        versions: display_versions,
        approval_versions,
        latest_version,
        latest_filename,
        approval_ready,
        approval_in_progress,
        approval_progress_phase,
        final_version,
        final_filename,
        final_published_at,
        final_current,
        issue,
    }
}

fn files_match(left: &Path, right: &Path) -> io::Result<bool> {
    let mut left = fs::File::open(left)?;
    let mut right = fs::File::open(right)?;
    let mut left_buffer = vec![0u8; 1024 * 1024];
    let mut right_buffer = vec![0u8; 1024 * 1024];
    loop {
        let left_read = left.read(&mut left_buffer)?;
        if left_read == 0 {
            return Ok(right.read(&mut right_buffer[..1])? == 0);
        }
        if let Err(error) = right.read_exact(&mut right_buffer[..left_read]) {
            return if error.kind() == io::ErrorKind::UnexpectedEof {
                Ok(false)
            } else {
                Err(error)
            };
        }
        if left_buffer[..left_read] != right_buffer[..left_read] {
            return Ok(false);
        }
    }
}

type FinalComparisonKey = (PathBuf, VideoFingerprint, PathBuf, VideoFingerprint);
static FINAL_COMPARISONS: OnceLock<Mutex<HashMap<FinalComparisonKey, bool>>> = OnceLock::new();

fn cached_files_match(source: &Path, final_file: &Path) -> io::Result<bool> {
    let key = (
        source.to_path_buf(),
        video_fingerprint(source)?,
        final_file.to_path_buf(),
        video_fingerprint(final_file)?,
    );
    if key.1.size != key.3.size {
        return Ok(false);
    }
    let cache = FINAL_COMPARISONS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(matches) = cache.lock().ok().and_then(|cache| cache.get(&key).copied()) {
        return Ok(matches);
    }
    let matches = files_match(source, final_file)?;
    if video_fingerprint(source)? != key.1 || video_fingerprint(final_file)? != key.3 {
        return Ok(false);
    }
    if let Ok(mut cache) = cache.lock() {
        if cache.len() >= 256 {
            cache.clear();
        }
        cache.insert(key, matches);
    }
    Ok(matches)
}

fn promote_latest_export_for_client(
    client_path: &Path,
    expected_filename: Option<&str>,
) -> Result<String, String> {
    let exports_dir = client_path.join("03_EXPORTS");
    let final_dir = client_path.join("04_FINAL");
    let versions = scan_video_versions(&exports_dir)?;
    let latest = versions
        .last()
        .ok_or_else(|| "No video export is available to promote".to_string())?;
    if expected_filename.is_some_and(|expected| expected != latest.filename) {
        return Err("The latest export changed. Refresh and confirm promotion again.".to_string());
    }
    fs::create_dir_all(&final_dir)
        .map_err(|error| format!("Unable to create FINAL folder: {error}"))?;
    let source = exports_dir.join(&latest.relative_path);
    let final_filename = final_export_filename(client_path, &latest.filename)?;
    let destination = final_dir.join(&final_filename);
    if source.canonicalize().ok() == destination.canonicalize().ok() {
        return Err("Export and FINAL paths unexpectedly resolve to the same file".to_string());
    }

    let staging_dir = final_dir.join(".staging");
    fs::create_dir_all(&staging_dir)
        .map_err(|error| format!("Unable to create FINAL staging folder: {error}"))?;
    let stamp = chrono::Utc::now().format("%Y%m%d_%H%M%S_%3f");
    let stage = staging_dir.join(format!(
        "{}.{}.{}.part",
        latest.filename,
        std::process::id(),
        stamp
    ));
    let source_before =
        fs::metadata(&source).map_err(|error| format!("Unable to read export: {error}"))?;
    let copied = match fs::copy(&source, &stage) {
        Ok(copied) => copied,
        Err(error) => {
            let _ = fs::remove_file(&stage);
            return Err(format!("Unable to stage FINAL copy: {error}"));
        }
    };
    let validation = (|| -> Result<bool, String> {
        let source_after = fs::metadata(&source).map_err(|error| error.to_string())?;
        let staged = fs::metadata(&stage).map_err(|error| error.to_string())?;
        if copied != source_before.len()
            || staged.len() != source_before.len()
            || source_after.len() != source_before.len()
            || source_after.modified().ok() != source_before.modified().ok()
        {
            return Ok(false);
        }
        files_match(&source, &stage).map_err(|error| error.to_string())
    })();
    match validation {
        Ok(true) => {}
        Ok(false) => {
            let _ = fs::remove_file(&stage);
            return Err("Staged copy validation failed; source export was preserved".to_string());
        }
        Err(error) => {
            let _ = fs::remove_file(&stage);
            return Err(format!("Unable to validate staged copy: {error}"));
        }
    }
    if let Err(error) = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&stage)
        .and_then(|file| file.sync_all())
    {
        let _ = fs::remove_file(&stage);
        return Err(format!("Unable to flush staged FINAL copy: {error}"));
    }

    let staged_record = stage.with_extension("record.part");
    let record_result = (|| -> Result<(), String> {
        let record = FinalPromotionRecord {
            source_filename: latest.filename.clone(),
            version: latest.version,
            final_filename: final_filename.clone(),
            source: VideoFingerprint {
                size: source_before.len(),
                modified: source_before
                    .modified()
                    .map_err(|error| error.to_string())?,
            },
            published: video_fingerprint(&stage).map_err(|error| error.to_string())?,
            published_at: Some(chrono::Utc::now().to_rfc3339()),
            migrated: false,
        };
        let bytes = serde_json::to_vec_pretty(&record).map_err(|error| error.to_string())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged_record)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())
    })();
    if let Err(error) = record_result {
        let _ = fs::remove_file(&stage);
        let _ = fs::remove_file(&staged_record);
        return Err(format!("Unable to stage FINAL version record: {error}"));
    }

    let mut archive_files: Vec<PathBuf> = match fs::read_dir(&final_dir) {
        Ok(entries) => entries,
        Err(error) => {
            let _ = fs::remove_file(&stage);
            let _ = fs::remove_file(&staged_record);
            return Err(format!("Unable to scan FINAL folder: {error}"));
        }
    }
    .filter_map(Result::ok)
    .filter_map(|entry| {
        let path = entry.path();
        (entry.file_type().ok()?.is_file() && is_video_file(&path)).then_some(path)
    })
    .collect();
    let record_path = final_dir.join(FINAL_PROMOTION_RECORD);
    if record_path.is_file() {
        archive_files.push(record_path.clone());
    }
    let archive_dir = if archive_files.is_empty() {
        None
    } else {
        let archive_root = final_dir.join("_ARCHIVE");
        if let Err(error) = fs::create_dir_all(&archive_root) {
            let _ = fs::remove_file(&stage);
            let _ = fs::remove_file(&staged_record);
            return Err(format!("Unable to create FINAL archive: {error}"));
        }
        let mut candidate = archive_root.join(stamp.to_string());
        let mut suffix = 2;
        while candidate.exists() {
            candidate = archive_root.join(format!("{}_{}", stamp, suffix));
            suffix += 1;
        }
        if let Err(error) = fs::create_dir(&candidate) {
            let _ = fs::remove_file(&stage);
            let _ = fs::remove_file(&staged_record);
            return Err(format!("Unable to create FINAL archive folder: {error}"));
        }
        Some(candidate)
    };
    let mut archived = Vec::new();
    if let Some(folder) = &archive_dir {
        for path in &archive_files {
            let target = folder.join(path.file_name().unwrap_or_default());
            if let Err(error) = fs::rename(path, &target) {
                for (original, moved) in archived.iter().rev() {
                    let _ = fs::rename(moved, original);
                }
                let _ = fs::remove_file(&stage);
                let _ = fs::remove_file(&staged_record);
                return Err(format!("Unable to archive existing FINAL video: {error}"));
            }
            archived.push((path.clone(), target));
        }
    }
    if let Err(error) = fs::rename(&stage, &destination) {
        for (original, moved) in archived.iter().rev() {
            let _ = fs::rename(moved, original);
        }
        let _ = fs::remove_file(&stage);
        let _ = fs::remove_file(&staged_record);
        return Err(format!("Unable to publish staged FINAL video: {error}"));
    }
    if let Err(error) = fs::rename(&staged_record, &record_path) {
        let _ = fs::remove_file(&destination);
        for (original, moved) in archived.iter().rev() {
            let _ = fs::rename(moved, original);
        }
        let _ = fs::remove_file(&staged_record);
        return Err(format!("Unable to publish FINAL version record: {error}"));
    }
    Ok(format!(
        "Promoted {} to {}{}",
        latest.filename,
        final_filename,
        archive_dir
            .map(|path| format!("; previous videos archived in {}", path.display()))
            .unwrap_or_default()
    ))
}

pub fn migrate_existing_finals(project_root: &Path) -> Result<usize, String> {
    if !project_root.is_dir() {
        return Err(format!("Project folder is unavailable: {}", project_root.display()));
    }
    let entries = fs::read_dir(project_root).map_err(|error| error.to_string())?;
    let mut migrated_count = 0;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let client_path = entry.path();
        if !client_path.is_dir() || !client_path.join("04_FINAL").is_dir() {
            continue;
        }
        let status = scan_export_status(&client_path);
        let (Some(source_filename), Some(final_filename)) =
            (status.latest_filename, status.final_filename)
        else {
            continue;
        };
        if status.issue.is_some() || status.final_current {
            continue;
        }
        let final_dir = client_path.join("04_FINAL");
        let final_path = final_dir.join(&final_filename);
        let source_path = client_path.join("03_EXPORTS").join(
            status.versions.iter()
                .find(|version| version.filename == source_filename)
                .map(|version| version.relative_path.as_str())
                .unwrap_or(&source_filename),
        );
        let Ok(source) = video_fingerprint(&source_path) else { continue };
        let Ok(published) = video_fingerprint(&final_path) else { continue };
        let record = FinalPromotionRecord {
            source_filename,
            version: status.latest_version.unwrap_or(1),
            final_filename,
            source,
            published,
            published_at: fs::metadata(&final_path)
                .and_then(|metadata| metadata.created().or_else(|_| metadata.modified()))
                .ok()
                .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339()),
            migrated: true,
        };
        let bytes = serde_json::to_vec_pretty(&record).map_err(|error| error.to_string())?;
        let staged_record = final_dir.join(format!("{FINAL_PROMOTION_RECORD}.migration.part"));
        fs::write(&staged_record, bytes).map_err(|error| error.to_string())?;
        let record_path = final_dir.join(FINAL_PROMOTION_RECORD);
        if record_path.exists() {
            fs::remove_file(&record_path).map_err(|error| error.to_string())?;
        }
        if let Err(error) = fs::rename(&staged_record, &record_path) {
            let _ = fs::remove_file(staged_record);
            return Err(format!("Unable to write published status for {}: {error}", client_path.display()));
        }
        migrated_count += 1;
    }
    Ok(migrated_count)
}

fn ensure_dir(path: &Path) -> Result<(), io::Error> {
    if !path.exists() {
        fs::create_dir_all(path)?;
    }
    Ok(())
}

fn client_project_filename(client_name: &str) -> String {
    let parts: Vec<&str> = client_name
        .split('_')
        .filter(|part| !part.is_empty())
        .collect();
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
    Err(last_err.unwrap_or_else(|| io::Error::new(io::ErrorKind::Other, "Failed to remove file")))
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

fn affected_clients(event: &Event, root: &Path) -> (bool, HashSet<String>) {
    let mut all_clients = false;
    let mut clients = HashSet::new();
    for event_path in &event.paths {
        let path = if event_path.starts_with(root) {
            event_path.clone()
        } else if let Ok(canonical) = event_path.canonicalize() {
            canonical
        } else {
            continue;
        };
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        if relative.as_os_str().is_empty() {
            all_clients = true;
            clients.clear();
            break;
        }
        let components: Vec<String> = relative.components()
            .map(|component| component.as_os_str().to_string_lossy().to_string())
            .collect();
        if components.is_empty() {
            continue;
        }
        let is_mariya_meets = root.file_name().and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("8_Mariya Meets")).unwrap_or(false);
        let season_path = is_mariya_meets && components[0].to_ascii_uppercase().starts_with("SEASON ");
        let client_index = if season_path { 1 } else { 0 };
        if components.len() <= client_index { all_clients = true; clients.clear(); break; }
        let client_name = components[client_index].clone();
        if client_name == "_logs" {
            continue;
        }
        if components.len() <= client_index + 1 {
            clients.insert(client_name);
            continue;
        }
        let section = &components[client_index + 1];
        let template_relative = components.iter().skip(client_index + 1).cloned().collect::<Vec<_>>().join("/");
        let template_path_changed = TEMPLATE_DIRS
            .iter()
            .any(|template| template.eq_ignore_ascii_case(&template_relative));
        if template_path_changed
            || section.eq_ignore_ascii_case("03_EXPORTS")
            || section.eq_ignore_ascii_case("04_FINAL")
        {
            clients.insert(client_name);
        }
    }
    (all_clients, clients)
}

fn scan_client_folders(name: &str, path: &Path) -> ClientInfo {
    let season = path.parent()
        .and_then(|parent| parent.file_name())
        .and_then(|value| value.to_str())
        .filter(|value| value.to_ascii_uppercase().starts_with("SEASON "))
        .map(str::to_string);
    if name.starts_with("XX") {
        return ClientInfo {
            name: name.to_string(),
            path: path.to_string_lossy().to_string(),
            season,
            status: "Not a client".to_string(),
            missing: Vec::new(),
            export_status: ExportStatus::default(),
        };
    }

    let mut child_dirs = HashSet::new();
    if let Ok(entries) = fs::read_dir(path) {
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
                            if let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) {
                                set.insert(name.to_string());
                            }
                        }
                    }
                }
                set
            });
            if !subdirs.contains(child) && !OPTIONAL_LEGACY_DIRS.contains(&child) {
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

    ClientInfo {
        name: name.to_string(),
        path: path.to_string_lossy().to_string(),
        season,
        status: status.to_string(),
        missing,
        export_status: ExportStatus::default(),
    }
}

#[tauri::command]
async fn scan_project_root(
    app_handle: tauri::AppHandle,
    project_root: String,
    scan_id: u64,
    replace_existing: bool,
    client_names: Option<Vec<String>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&project_root);
        let partial = client_names.is_some();
        let requested_names: HashSet<String> =
            client_names.unwrap_or_default().into_iter().collect();
        let is_mariya_meets = root.file_name().and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("8_Mariya Meets"))
            .unwrap_or(false);
        let mut client_paths = Vec::new();
        let mut removed_names = Vec::new();
        if partial {
            for name in &requested_names {
                if name == "_logs" || Path::new(name).components().count() != 1 {
                    continue;
                }
                let direct_path = root.join(name);
                if direct_path.is_dir() {
                    client_paths.push((name.clone(), direct_path));
                    continue;
                }
                let mut found = false;
                if is_mariya_meets {
                  if let Ok(entries) = fs::read_dir(&root) {
                    for season_entry in entries.flatten() {
                        let season_path = season_entry.path();
                        let is_season = season_path.file_name().and_then(|value| value.to_str())
                            .map(|value| value.to_ascii_uppercase().starts_with("SEASON ")).unwrap_or(false);
                        let path = season_path.join(name);
                        if is_season && path.is_dir() {
                            client_paths.push((name.clone(), path));
                            found = true;
                        }
                    }
                  }
                }
                if !found { removed_names.push(name.clone()); }
            }
        } else {
            let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
            let mut season_paths = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    continue;
                }
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(name) => name.to_string(),
                    None => continue,
                };
                if name == "_logs" {
                    continue;
                }
                let is_season = is_mariya_meets && name.to_ascii_uppercase().starts_with("SEASON ");
                if is_season {
                    season_paths.push((name, path));
                    continue;
                }
                client_paths.push((name, path));
            }
            if is_mariya_meets {
                season_paths.sort_by(|left, right| season_number(&right.0).cmp(&season_number(&left.0)).then_with(|| right.0.cmp(&left.0)));
                for (_, season_path) in season_paths {
                    let season_entries = fs::read_dir(&season_path).map_err(|error| error.to_string())?;
                    for season_entry in season_entries.flatten() {
                        let path = season_entry.path();
                        if !season_entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) { continue; }
                        let Some(name) = path.file_name().and_then(|value| value.to_str()) else { continue };
                        let upper_name = name.to_ascii_uppercase();
                        if name.starts_with("XX")
                            || !(upper_name.ends_with("_MARIYAMEETS") || upper_name.ends_with("_HUDDLE")) {
                            continue;
                        }
                        client_paths.push((name.to_string(), path));
                    }
                }
            }
        }
        client_paths.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
        removed_names.sort();
        let total = client_paths.len();
        let mut clients = Vec::with_capacity(total);

        // Send the first client rows before checking the rest of the project.
        // Export inspection runs in a second pass and arrives in separate batches.
        for path_chunk in client_paths.chunks(5) {
            let batch: Vec<ClientInfo> = path_chunk
                .iter()
                .map(|(name, path)| scan_client_folders(name, path))
                .collect();
            clients.extend(batch.iter().cloned());
            let completed = clients.len();
            app_handle
                .emit(
                    "clients-scan-progress",
                    ClientScanProgress {
                        project_root: project_root.clone(),
                        scan_id,
                        phase: "clients".to_string(),
                        clients: batch.clone(),
                        export_updates: Vec::new(),
                        completed,
                        total,
                        reset: replace_existing && completed == batch.len(),
                        client_names: Vec::new(),
                        partial,
                        removed_names: Vec::new(),
                    },
                )
                .map_err(|error| error.to_string())?;
        }

        // Export status is more expensive. Inspect one client, publish that result,
        // then move on to the next client to avoid a burst of NAS activity.
        for (index, client) in clients.iter().enumerate() {
            if client.status != "Not a client" {
                let update = ClientExportStatusUpdate {
                    name: client.name.clone(),
                    export_status: scan_export_status(Path::new(&client.path)),
                };
                app_handle
                    .emit(
                        "clients-scan-progress",
                        ClientScanProgress {
                            project_root: project_root.clone(),
                            scan_id,
                            phase: "exports".to_string(),
                            clients: Vec::new(),
                            export_updates: vec![update],
                            completed: index + 1,
                            total,
                            reset: false,
                            client_names: Vec::new(),
                            partial,
                            removed_names: Vec::new(),
                        },
                    )
                    .map_err(|error| error.to_string())?;
            }
        }

        app_handle
            .emit(
                "clients-scan-progress",
                ClientScanProgress {
                    project_root,
                    scan_id,
                    phase: "complete".to_string(),
                    clients: Vec::new(),
                    export_updates: Vec::new(),
                    completed: total,
                    total,
                    reset: replace_existing && clients.is_empty() && !partial,
                    client_names: clients.iter().map(|client| client.name.clone()).collect(),
                    partial,
                    removed_names,
                },
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn season_number(name: &str) -> u32 {
    name.get(6..).and_then(|value| value.trim().parse().ok()).unwrap_or(0)
}

#[tauri::command]
fn create_mariya_meets_season(project_root: String) -> Result<String, String> {
    let root = PathBuf::from(project_root);
    let is_mariya_meets = root.file_name().and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("8_Mariya Meets")).unwrap_or(false);
    if !is_mariya_meets { return Err("Season creation is only available in 8_Mariya Meets".to_string()); }
    let mut highest = 0;
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
            && name.to_ascii_uppercase().starts_with("SEASON ") {
            highest = highest.max(season_number(&name));
        }
    }
    let name = format!("SEASON {}", highest + 1);
    fs::create_dir(root.join(&name)).map_err(|error| error.to_string())?;
    Ok(name)
}

#[tauri::command]
async fn scan_approval_progress(
    project_root: String,
    client_names: Vec<String>,
) -> Result<Vec<ApprovalProgressStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(project_root);
        if !root.is_dir() {
            return Err("Project root is not a directory".to_string());
        }
        let mut progress = Vec::new();
        for name in client_names {
            if name == "_logs" || name == "." || name == ".." || Path::new(&name).components().count() != 1 {
                continue;
            }
            let client_path = root.join(&name);
            if !client_path.is_dir() {
                continue;
            }
            if let Some(status) = approval_progress_for_client(&name, &client_path) {
                progress.push(status);
            }
        }
        Ok(progress)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_project_roots() -> Result<Vec<ProjectRootOption>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = Path::new(PRODUCTION_PROJECTS_ROOT);
        let entries = fs::read_dir(root).map_err(|error| {
            format!("Unable to read project list at {}: {error}", root.display())
        })?;
        let mut projects = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some((number, _)) = name.split_once('_') else {
                continue;
            };
            if number.is_empty() || !number.chars().all(|character| character.is_ascii_digit()) {
                continue;
            }
            let Ok(number) = number.parse::<u32>() else {
                continue;
            };
            projects.push(ProjectRootOption {
                name: name.to_string(),
                path: path.to_string_lossy().to_string(),
                number,
            });
        }
        projects.sort_by(|left, right| {
            left.number
                .cmp(&right.number)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(projects)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn promote_latest_export(
    client_path: String,
    expected_filename: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        promote_latest_export_for_client(Path::new(&client_path), Some(&expected_filename))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn migrate_project_finals(project_root: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || migrate_existing_finals(Path::new(&project_root)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn set_watch_root(
    window: tauri::Window,
    project_root: String,
    state: tauri::State<Mutex<WatchState>>,
) -> Result<(), String> {
    let mut state = state
        .lock()
        .map_err(|_| "Watcher lock poisoned".to_string())?;
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
        let mut pending_all_clients = false;
        let mut pending_clients = HashSet::new();
        let mut last_event = Instant::now();

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }

            match event_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(event)) => {
                    let (all_clients, changed_clients) = affected_clients(&event, &root_for_thread);
                    if all_clients || !changed_clients.is_empty() {
                        pending = true;
                        pending_all_clients |= all_clients;
                        if all_clients {
                            pending_clients.clear();
                        } else if !pending_all_clients {
                            pending_clients.extend(changed_clients);
                        }
                        last_event = Instant::now();
                    }
                }
                Ok(Err(_)) => {
                    pending = true;
                    pending_all_clients = true;
                    pending_clients.clear();
                    last_event = Instant::now();
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => break,
            }

            if pending && last_event.elapsed() >= debounce {
                let mut client_names: Vec<String> = pending_clients.drain().collect();
                client_names.sort();
                let _ = app_handle.emit(
                    "clients-changed",
                    ClientsChanged {
                        project_root: project_root_clone.clone(),
                        client_names,
                        all_clients: pending_all_clients,
                    },
                );
                pending = false;
                pending_all_clients = false;
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
    let project_root = PathBuf::from(project_root);
    let is_mariya_meets = project_root.file_name().and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("8_Mariya Meets")).unwrap_or(false);
    let client_parent = if is_mariya_meets {
        let mut latest: Option<(u32, PathBuf)> = None;
        for entry in fs::read_dir(&project_root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                && name.to_ascii_uppercase().starts_with("SEASON ") {
                let number = season_number(&name);
                if latest.as_ref().map(|current| number > current.0).unwrap_or(true) {
                    latest = Some((number, entry.path()));
                }
            }
        }
        latest.map(|(_, path)| path).ok_or_else(|| "Create a season before adding a Mariya Meets project".to_string())?
    } else { project_root };
    let client_root = client_parent.join(&client_name);
    if client_root.exists() {
        return Err("Client folder already exists".to_string());
    }
    for dir in TEMPLATE_DIRS.iter() {
        ensure_dir(&client_root.join(dir)).map_err(|e| e.to_string())?;
    }

    if client_type == "EXHIBITOR" || client_type == "PRODUCT" || client_type == "HUDDLE" {
        let template_source =
            if client_type == "HUDDLE" && huddle_template.as_deref() == Some("VIDEO_CALL") {
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
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let runtime = app.state::<frameio::Runtime>();
            for argument in argv {
                let _ = runtime.accept_auth_callback(&argument);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(frameio::Runtime::default())
        .setup(|app| {
            use tauri_plugin_deep_link::DeepLinkExt;
            #[cfg(windows)]
            app.deep_link().register_all()?;
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let runtime = app_handle.state::<frameio::Runtime>();
                for url in event.urls() {
                    let _ = runtime.accept_auth_callback(url.as_str());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_project_roots,
            create_mariya_meets_season,
            scan_project_root,
            scan_approval_progress,
            promote_latest_export,
            migrate_project_finals,
            set_watch_root,
            create_client,
            open_folder,
            fix_client,
            sort_files,
            append_debug_log,
            clear_debug_log,
            undo_batch,
            frameio::frameio_start_auth,
            frameio::frameio_finish_auth,
            frameio::frameio_cancel_auth,
            frameio::frameio_open_external_url,
            frameio::frameio_list_accounts,
            frameio::frameio_get_storage,
            frameio::frameio_list_projects,
            frameio::frameio_upload
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

    fn test_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "project_sorter_{label}_{}_{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

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

    #[test]
    fn scans_versions_and_ignores_non_video_files() {
        let directory = test_dir("versions");
        fs::write(directory.join("Spotlight_V2.mp4"), b"v2").unwrap();
        fs::write(directory.join("Spotlight_V1.MOV"), b"v1").unwrap();
        fs::write(directory.join("thumbnail.jpg"), b"still").unwrap();
        let versions = scan_video_versions(&directory).unwrap();
        assert_eq!(
            versions.iter().map(|item| item.version).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(versions.last().unwrap().filename, "Spotlight_V2.mp4");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn lone_unversioned_export_is_v1_and_conflicts_are_reported() {
        let directory = test_dir("unversioned");
        fs::write(directory.join("Spotlight.mp4"), b"v1").unwrap();
        assert_eq!(scan_video_versions(&directory).unwrap()[0].version, 1);
        fs::write(directory.join("Spotlight_V2.mp4"), b"v2").unwrap();
        assert!(scan_video_versions(&directory)
            .unwrap_err()
            .contains("Unversioned"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn malformed_versions_are_reported() {
        let directory = test_dir("malformed");
        fs::write(directory.join("Spotlight_Vlatest.mp4"), b"bad").unwrap();
        assert!(scan_video_versions(&directory)
            .unwrap_err()
            .contains("Malformed version"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn export_status_tracks_approval_and_final_version() {
        let client = test_dir("status");
        let exports = client.join("03_EXPORTS");
        let approval = exports.join("APPROVAL");
        let final_dir = client.join("04_FINAL");
        fs::create_dir_all(&approval).unwrap();
        fs::create_dir_all(&final_dir).unwrap();
        fs::write(exports.join("Spotlight_V1.mp4"), b"v1").unwrap();
        fs::write(exports.join("Spotlight_V2.mp4"), b"v2").unwrap();
        fs::write(
            approval.join("Spotlight_V2_APPROVAL_1080p_WM_TC.mp4"),
            b"review",
        )
        .unwrap();
        fs::write(final_dir.join("Spotlight_V1.mp4"), b"old final").unwrap();
        let status = scan_export_status(&client);
        assert_eq!(status.latest_version, Some(2));
        assert!(status.approval_ready);
        assert_eq!(status.final_version, Some(1));
        assert!(!status.final_current);
        fs::remove_dir_all(client).unwrap();
    }

    #[test]
    fn pending_sources_are_detected_and_promoted_without_using_review_or_archived_videos() {
        let client = test_dir("pending-source");
        let exports = client.join("03_EXPORTS");
        let pending = exports.join("APPROVAL/PENDING");
        fs::create_dir_all(pending.join("_SUPERSEDED")).unwrap();
        fs::write(exports.join("Spotlight_V1.mp4"), b"first").unwrap();
        fs::write(pending.join("Spotlight_V3.mp4"), b"latest source").unwrap();
        fs::write(pending.join("_SUPERSEDED/Spotlight_V99.mp4"), b"archive").unwrap();
        fs::write(
            exports.join("APPROVAL/Spotlight_V3_APPROVAL_1080p_WM_TC.mp4"),
            b"watermarked",
        )
        .unwrap();
        fs::write(
            exports.join("Spotlight_V4_APPROVAL_1080p_WM_TC.mp4"),
            b"review",
        )
        .unwrap();

        let status = scan_export_status(&client);
        assert_eq!(status.latest_version, Some(3));
        assert!(status.approval_ready);
        assert!(status.issue.is_none());
        promote_latest_export_for_client(&client, None).unwrap();
        assert_eq!(
            fs::read(
                client
                    .join("04_FINAL")
                    .join(final_export_filename(&client, "Spotlight_V3.mp4").unwrap())
            )
            .unwrap(),
            b"latest source"
        );
        assert_eq!(
            fs::read(pending.join("Spotlight_V3.mp4")).unwrap(),
            b"latest source"
        );
        assert!(scan_export_status(&client).final_current);
        fs::remove_dir_all(client).unwrap();
    }

    #[test]
    fn duplicate_versions_across_export_and_pending_folders_are_ambiguous() {
        let client = test_dir("pending-duplicate");
        let exports = client.join("03_EXPORTS");
        fs::create_dir_all(exports.join("APPROVAL/PENDING")).unwrap();
        fs::write(exports.join("Spotlight_V2.mp4"), b"one").unwrap();
        fs::write(exports.join("APPROVAL/PENDING/Spotlight_V2.mp4"), b"two").unwrap();
        assert!(scan_export_status(&client)
            .issue
            .unwrap()
            .contains("Duplicate"));
        assert!(promote_latest_export_for_client(&client, None).is_err());
        assert!(!client.join("04_FINAL").exists());
        fs::remove_dir_all(client).unwrap();
    }

    #[test]
    fn promotion_rejects_a_newer_export_than_the_one_confirmed() {
        let client = test_dir("changed-export");
        let exports = client.join("03_EXPORTS");
        fs::create_dir_all(&exports).unwrap();
        fs::write(exports.join("Spotlight_V2.mp4"), b"confirmed").unwrap();
        fs::write(exports.join("Spotlight_V3.mp4"), b"newer").unwrap();
        let error =
            promote_latest_export_for_client(&client, Some("Spotlight_V2.mp4")).unwrap_err();
        assert!(error.contains("latest export changed"));
        assert!(!client.join("04_FINAL").exists());
        fs::remove_dir_all(client).unwrap();
    }

    #[test]
    fn legacy_final_is_visible_without_a_remaining_source_export() {
        let client = test_dir("legacy-final");
        fs::create_dir_all(client.join("04_FINAL")).unwrap();
        fs::write(client.join("04_FINAL/Spotlight_FINAL.mp4"), b"final").unwrap();
        let status = scan_export_status(&client);
        assert_eq!(status.final_version, None);
        assert_eq!(
            status.final_filename.as_deref(),
            Some("Spotlight_FINAL.mp4")
        );
        assert!(status.latest_filename.is_none());
        fs::create_dir_all(client.join("03_EXPORTS/APPROVAL/PENDING")).unwrap();
        fs::write(
            client.join("03_EXPORTS/APPROVAL/PENDING/Spotlight.mp4"),
            b"final",
        )
        .unwrap();
        assert!(scan_export_status(&client).final_current);
        fs::remove_dir_all(client).unwrap();
    }

    #[test]
    fn legacy_renamed_final_is_verified_against_source_versions() {
        let client = test_dir("legacy-versioned-source");
        let pending = client.join("03_EXPORTS/APPROVAL/PENDING");
        let final_dir = client.join("04_FINAL");
        fs::create_dir_all(&pending).unwrap();
        fs::create_dir_all(&final_dir).unwrap();
        let source = pending.join("EVENBETER_EXHIBITOR SPOTLIGHT_V3.mp4");
        let final_file = final_dir.join("EVENBETER_EXHIBITOR SPOTLIGHT_FINAL.mp4");
        fs::write(&source, b"version three").unwrap();
        fs::write(&final_file, b"version three").unwrap();
        let status = scan_export_status(&client);
        assert!(status.final_current);
        assert_eq!(status.final_version, Some(3));

        fs::write(
            pending.join("EVENBETER_EXHIBITOR SPOTLIGHT_V4.mp4"),
            b"new fourth version",
        )
        .unwrap();
        let status = scan_export_status(&client);
        assert!(!status.final_current);
        assert_eq!(status.final_version, Some(3));
        assert_eq!(status.latest_version, Some(4));

        fs::write(&final_file, b"a different final video").unwrap();
        let status = scan_export_status(&client);
        assert!(!status.final_current);
        assert_eq!(status.final_version, None);
        fs::remove_dir_all(client).unwrap();
    }

    #[test]
    fn canonical_final_keeps_version_tracking_and_archives_previous_delivery() {
        let root = test_dir("canonical-final");
        let client = root.join("CLIENT_TYPE");
        let exports = client.join("03_EXPORTS");
        let final_dir = client.join("04_FINAL");
        fs::create_dir_all(&exports).unwrap();
        fs::write(exports.join("Different_Source_Name_V2.MOV"), b"version two").unwrap();
        promote_latest_export_for_client(&client, None).unwrap();
        let final_file = final_dir.join("CLIENT_TYPE_FINAL.MOV");
        assert_eq!(fs::read(&final_file).unwrap(), b"version two");
        assert!(exports.join("Different_Source_Name_V2.MOV").exists());
        let status = scan_export_status(&client);
        assert_eq!(status.final_version, Some(2));
        assert_eq!(
            status.final_filename.as_deref(),
            Some("CLIENT_TYPE_FINAL.MOV")
        );
        assert!(status.final_current);

        fs::write(
            exports.join("Different_Source_Name_V3.MOV"),
            b"version three",
        )
        .unwrap();
        let status = scan_export_status(&client);
        assert_eq!(status.final_version, Some(2));
        assert!(!status.final_current);
        promote_latest_export_for_client(&client, Some("Different_Source_Name_V3.MOV")).unwrap();
        assert_eq!(fs::read(&final_file).unwrap(), b"version three");
        let archive = fs::read_dir(final_dir.join("_ARCHIVE"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read(archive.join("CLIENT_TYPE_FINAL.MOV")).unwrap(),
            b"version two"
        );
        let archived_record: FinalPromotionRecord =
            serde_json::from_slice(&fs::read(archive.join(FINAL_PROMOTION_RECORD)).unwrap())
                .unwrap();
        assert_eq!(archived_record.version, 2);

        fs::remove_dir_all(&exports).unwrap();
        assert_eq!(scan_export_status(&client).final_version, Some(3));
        fs::write(&final_file, b"externally replaced final").unwrap();
        assert_eq!(scan_export_status(&client).final_version, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_version_record_publication_restores_previous_final() {
        let root = test_dir("record-rollback");
        let client = root.join("CLIENT_TYPE");
        let exports = client.join("03_EXPORTS");
        let final_dir = client.join("04_FINAL");
        fs::create_dir_all(&exports).unwrap();
        fs::create_dir_all(final_dir.join(FINAL_PROMOTION_RECORD)).unwrap();
        fs::write(exports.join("Source_V2.mp4"), b"new video").unwrap();
        fs::write(final_dir.join("CLIENT_TYPE_FINAL.mp4"), b"previous video").unwrap();
        assert!(promote_latest_export_for_client(&client, None)
            .unwrap_err()
            .contains("version record"));
        assert_eq!(
            fs::read(final_dir.join("CLIENT_TYPE_FINAL.mp4")).unwrap(),
            b"previous video"
        );
        assert_eq!(
            fs::read(exports.join("Source_V2.mp4")).unwrap(),
            b"new video"
        );
        assert_eq!(fs::read_dir(final_dir.join(".staging")).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn promotion_archives_old_video_and_preserves_source_and_support_files() {
        let client = test_dir("promotion");
        let exports = client.join("03_EXPORTS");
        let final_dir = client.join("04_FINAL");
        fs::create_dir_all(&exports).unwrap();
        fs::create_dir_all(&final_dir).unwrap();
        fs::write(exports.join("Spotlight_V2.mp4"), b"new final video").unwrap();
        fs::write(final_dir.join("old-final.mp4"), b"old final video").unwrap();
        fs::write(final_dir.join("INFO.txt"), b"delivery notes").unwrap();

        let message = promote_latest_export_for_client(&client, None).unwrap();
        assert!(message.contains("Spotlight_V2.mp4"));
        assert_eq!(
            fs::read(exports.join("Spotlight_V2.mp4")).unwrap(),
            b"new final video"
        );
        assert_eq!(
            fs::read(final_dir.join(final_export_filename(&client, "Spotlight_V2.mp4").unwrap()))
                .unwrap(),
            b"new final video"
        );
        assert_eq!(
            fs::read(final_dir.join("INFO.txt")).unwrap(),
            b"delivery notes"
        );
        let archived: Vec<PathBuf> = WalkDir::new(final_dir.join("_ARCHIVE"))
            .into_iter()
            .filter_map(Result::ok)
            .map(|entry| entry.into_path())
            .filter(|path| path.is_file())
            .collect();
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].file_name().unwrap(), "old-final.mp4");
        fs::remove_dir_all(client).unwrap();
    }
}
