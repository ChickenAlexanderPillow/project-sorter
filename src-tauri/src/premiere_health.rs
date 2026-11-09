//! Read-only Premiere Pro media path inspection with a separate, compact
//! per-computer availability sidecar. The project and its media are never changed.
//!
//! The .prproj container is proprietary. Pepper intentionally supports only
//! PremiereData v3 XML projects with Media/FilePath entries and fails closed
//! when the container or project structure is unfamiliar.

use flate2::read::GzDecoder;
use quick_xml::{events::Event, Reader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const MAX_PROJECT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_XML_DEPTH: usize = 256;
const MAX_MEDIA_OBJECTS: usize = 250_000;
const AVAILABILITY_SCHEMA: u32 = 1;
const MAX_AVAILABILITY_REPORT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PEER_REPORTS: usize = 24;
const MAX_PEER_REPORT_AGE: chrono::Duration = chrono::Duration::days(90);

#[derive(Debug, Serialize)]
pub struct PremiereHealthReport {
    pub machine_name: String,
    pub availability_note: Option<String>,
    pub project_name: String,
    pub project_path: String,
    pub premiere_version: String,
    pub project_bytes: u64,
    pub expanded_bytes: u64,
    pub media_objects: usize,
    pub ignored_non_file_entries: usize,
    pub items: Vec<PremiereMediaItem>,
}

#[derive(Debug, Serialize)]
pub struct PremiereMediaItem {
    pub file_name: String,
    pub original_path: String,
    pub resolved_path: Option<String>,
    pub status: String,
    pub references: usize,
    pub available_on: Vec<MachineAvailability>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineAvailability {
    pub machine_name: String,
    pub last_seen: String,
}

#[derive(Debug, Serialize)]
struct AvailabilityRecord {
    schema_version: u32,
    project_key: String,
    machine_name: String,
    scanned_at: String,
    local_media_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ReadAvailabilityRecord {
    schema_version: u32,
    project_key: String,
    machine_name: String,
    scanned_at: String,
    local_media_ids: Vec<String>,
}

#[derive(Default)]
struct MediaFields {
    file_path: Option<String>,
    relative_path: Option<String>,
}

struct LimitedReader<R> {
    inner: R,
    read: u64,
    limit: u64,
}

impl<R: Read> Read for LimitedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.read >= self.limit {
            let mut probe = [0u8; 1];
            return match self.inner.read(&mut probe)? {
                0 => Ok(0),
                _ => Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Expanded Premiere project exceeds Pepper's 512 MB safety limit",
                )),
            };
        }
        let allowed = (self.limit - self.read).min(buffer.len() as u64) as usize;
        let count = self.inner.read(&mut buffer[..allowed])?;
        self.read += count as u64;
        Ok(count)
    }
}

fn xml_reader(path: &Path) -> Result<(Box<dyn Read>, u64), String> {
    let file =
        File::open(path).map_err(|error| format!("Cannot open Premiere project: {error}"))?;
    let size = file
        .metadata()
        .map_err(|error| format!("Cannot inspect Premiere project: {error}"))?
        .len();
    if size > MAX_PROJECT_BYTES {
        return Err("Premiere project exceeds Pepper's 512 MB safety limit".into());
    }
    let mut prefix = [0u8; 2];
    let mut input = BufReader::new(file);
    input
        .read_exact(&mut prefix)
        .map_err(|error| format!("Premiere project is empty or unreadable: {error}"))?;
    drop(input);

    let file = File::open(path).map_err(|error| error.to_string())?;
    let reader: Box<dyn Read> = if prefix == [0x1f, 0x8b] {
        Box::new(GzDecoder::new(BufReader::new(file)))
    } else {
        let mut input = BufReader::new(file);
        let mut signature = [0u8; 5];
        input
            .read_exact(&mut signature)
            .map_err(|error| format!("Premiere project is not readable XML: {error}"))?;
        if !signature.starts_with(b"<?xml") && !signature.starts_with(b"<Prem") {
            return Err(
                "Unsupported Premiere project container; expected gzip XML or plain XML".into(),
            );
        }
        drop(input);
        Box::new(BufReader::new(
            File::open(path).map_err(|error| error.to_string())?,
        ))
    };
    Ok((reader, size))
}

fn is_path_like(value: &str) -> bool {
    let value = value.trim();
    value.starts_with(r"\\")
        || value.starts_with('/')
        || (value.len() >= 3
            && value.as_bytes()[1] == b':'
            && matches!(value.as_bytes()[2], b'\\' | b'/'))
        || value.contains('\\')
        || value.contains('/')
        || Path::new(value).extension().is_some()
}

fn absolute_reference(value: &str, project_path: &Path) -> String {
    let cleaned = clean_project_path(value);
    let path = PathBuf::from(&cleaned);
    if path.is_absolute() {
        cleaned
    } else {
        project_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(path)
            .to_string_lossy()
            .into_owned()
    }
}

fn clean_project_path(value: &str) -> String {
    let normalized = value.trim().replace('/', "\\");
    if let Some(unc) = normalized.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        normalized.strip_prefix(r"\\?\").unwrap_or(&normalized).to_owned()
    }
}

#[cfg(test)]
mod location_tests {
    use super::*;

    #[test]
    fn unc_and_verbatim_unc_are_network_locations() {
        let project = Path::new(r"Z:\Client\Edit.prproj");
        assert!(is_nas_reference(Path::new(r"\\NASPLUS\Production\Media\clip.mp4"), project));
        assert!(is_nas_reference(Path::new(r"\\?\UNC\NASPLUS\Production\Media\clip.mp4"), project));
    }

    #[cfg(windows)]
    #[test]
    fn available_local_media_stays_local_even_beside_a_local_project() {
        let temp = tempfile::tempdir().unwrap();
        let media = temp.path().join("Local clip.mp4");
        fs::write(&media, b"test media").unwrap();
        let project = temp.path().join("Edit.prproj");
        assert!(!is_nas_reference(&media, &project));
        assert_eq!(inspect_path(&media.to_string_lossy(), &project).0, "available_local");
        assert_eq!(inspect_path(&temp.path().join("missing.mp4").to_string_lossy(), &project).0, "missing_local");
    }
}

fn season_remap(project_path: &Path, original: &str) -> Option<PathBuf> {
    let original = clean_project_path(original);
    let original_path = Path::new(&original);
    let project_path = PathBuf::from(clean_project_path(&project_path.to_string_lossy()));
    let ancestors = project_path.parent()?.ancestors();
    for season_dir in ancestors {
        let season_name = season_dir.file_name()?.to_string_lossy();
        if !season_name.to_ascii_uppercase().starts_with("SEASON ") {
            continue;
        }
        let legacy_root = season_dir.parent()?;
        let Some(relative) = original_path.strip_prefix(legacy_root).ok() else {
            continue;
        };
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            continue;
        }
        let candidate = season_dir.join(relative);
        if fs::metadata(&candidate).is_ok_and(|metadata| metadata.is_file()) {
            return Some(candidate);
        }
    }
    None
}

fn is_nas_reference(original: &Path, _project_path: &Path) -> bool {
    let original_text = clean_project_path(&original.to_string_lossy());
    if original_text.starts_with(r"\\") {
        return true;
    }
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::{Storage::FileSystem::GetDriveTypeW, System::WindowsProgramming::DRIVE_REMOTE};
        if original_text.as_bytes().get(1) == Some(&b':') {
            let root: Vec<u16> = format!("{}\\", &original_text[..2]).encode_utf16().chain(Some(0)).collect();
            return unsafe { GetDriveTypeW(PCWSTR(root.as_ptr())) } == DRIVE_REMOTE;
        }
    }
    false
}

fn inspect_path(original: &str, project_path: &Path) -> (String, Option<String>) {
    let cleaned = clean_project_path(original);
    let source = PathBuf::from(&cleaned);
    let nas = is_nas_reference(&source, project_path);
    match fs::metadata(&source) {
        Ok(metadata) if metadata.is_file() => {
            return (
                if nas {
                    "available_nas"
                } else {
                    "available_local"
                }
                .into(),
                Some(cleaned),
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => {
            return (
                if nas {
                    "unavailable_nas"
                } else {
                    "unavailable_local"
                }
                .into(),
                None,
            );
        }
    }
    if let Some(candidate) = season_remap(project_path, &cleaned) {
        return (
            "available_after_season_move".into(),
            Some(candidate.to_string_lossy().into_owned()),
        );
    }
    (
        if nas { "missing_nas" } else { "missing_local" }.into(),
        None,
    )
}

fn extract_media<R: Read>(reader: R) -> Result<(String, Vec<MediaFields>, u64), String> {
    let limited = LimitedReader {
        inner: reader,
        read: 0,
        limit: MAX_EXPANDED_BYTES,
    };
    let mut xml = Reader::from_reader(BufReader::new(limited));
    xml.config_mut().trim_text(true);
    let mut buffer = Vec::with_capacity(16 * 1024);
    let mut depth = 0usize;
    let mut root_version = None;
    let mut saw_root = false;
    let mut current_media: Option<(usize, MediaFields)> = None;
    let mut current_field: Option<(usize, String, String)> = None;
    let mut media = Vec::new();

    loop {
        match xml.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                depth += 1;
                if depth > MAX_XML_DEPTH {
                    return Err("Premiere project XML exceeds Pepper's nesting safety limit".into());
                }
                let name = event.local_name();
                if !saw_root {
                    saw_root = true;
                    if name.as_ref() != b"PremiereData" {
                        return Err("Unsupported Premiere project XML root".into());
                    }
                    for attr in event.attributes().with_checks(true) {
                        let attr =
                            attr.map_err(|error| format!("Invalid Premiere XML: {error}"))?;
                        if attr.key.local_name().as_ref() == b"Version" {
                            root_version = Some(
                                attr.decode_and_unescape_value(xml.decoder())
                                    .map_err(|error| format!("Invalid Premiere version: {error}"))?
                                    .into_owned(),
                            );
                        }
                    }
                    match root_version.as_deref() {
                        Some("3") => {}
                        Some(version) => {
                            return Err(format!(
                                "Premiere project XML version {version} is not supported yet"
                            ));
                        }
                        None => return Err("Premiere project version is missing".into()),
                    }
                }
                if name.as_ref() == b"Media" && current_media.is_none() {
                    if media.len() >= MAX_MEDIA_OBJECTS {
                        return Err(
                            "Premiere project contains too many media objects to scan safely"
                                .into(),
                        );
                    }
                    current_media = Some((depth, MediaFields::default()));
                } else if let Some((media_depth, _)) = current_media.as_ref() {
                    if depth == *media_depth + 1 {
                        let field = match name.as_ref() {
                            b"FilePath" => Some("FilePath"),
                            b"RelativePath" => Some("RelativePath"),
                            _ => None,
                        };
                        if let Some(field) = field {
                            current_field = Some((depth, field.into(), String::new()));
                        }
                    }
                }
            }
            Ok(Event::Text(event)) => {
                if let Some((field_depth, _, value)) = current_field.as_mut() {
                    if depth == *field_depth {
                        value.push_str(
                            &event
                                .unescape()
                                .map_err(|error| format!("Invalid Premiere path text: {error}"))?,
                        );
                    }
                }
            }
            Ok(Event::CData(event)) => {
                if let Some((field_depth, _, value)) = current_field.as_mut() {
                    if depth == *field_depth {
                        value.push_str(
                            &event
                                .decode()
                                .map_err(|error| format!("Invalid Premiere CDATA: {error}"))?,
                        );
                    }
                }
            }
            Ok(Event::End(event)) => {
                let name = event.local_name();
                if let Some((field_depth, field_name, value)) = current_field.as_ref() {
                    if depth == *field_depth {
                        if let Some((_, fields)) = current_media.as_mut() {
                            let value = value.trim().to_owned();
                            if field_name == "FilePath" {
                                fields.file_path = Some(value);
                            } else {
                                fields.relative_path = Some(value);
                            }
                        }
                        current_field = None;
                    }
                }
                if name.as_ref() == b"Media" {
                    if let Some((media_depth, fields)) = current_media.take() {
                        if media_depth == depth {
                            media.push(fields);
                        } else {
                            current_media = Some((media_depth, fields));
                        }
                    }
                }
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Empty(event)) => {
                if !saw_root {
                    return Err("Unsupported empty Premiere project XML".into());
                }
                if event.local_name().as_ref() == b"Media" {
                    if media.len() >= MAX_MEDIA_OBJECTS {
                        return Err(
                            "Premiere project contains too many media objects to scan safely"
                                .into(),
                        );
                    }
                    media.push(MediaFields::default());
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(format!("Premiere project XML could not be parsed: {error}")),
        }
        buffer.clear();
    }

    let version = root_version.ok_or_else(|| "Premiere project version is missing".to_string())?;
    if version != "3" {
        return Err(format!(
            "Premiere project XML version {version} is not supported yet"
        ));
    }
    let expanded_bytes = xml.get_ref().get_ref().read;
    Ok((version, media, expanded_bytes))
}

#[tauri::command]
pub async fn premiere_project_health_scan(
    project_root: String,
    client_path: String,
    path: String,
) -> Result<PremiereHealthReport, String> {
    tauri::async_runtime::spawn_blocking(move || scan_sync(project_root, client_path, path))
        .await
        .map_err(|error| error.to_string())?
}

fn sha256_text(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn availability_id(path: &str) -> String {
    sha256_text(&clean_project_path(path).to_lowercase())
}

fn safe_child_dir(parent: &Path, name: &str) -> io::Result<PathBuf> {
    let path = parent.join(name);
    match fs::create_dir(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(&path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Availability metadata path is not a safe directory"));
    }
    #[cfg(windows)]
    if name == ".pepper" { hide_availability_directory(&path); }
    Ok(path)
}

#[cfg(windows)]
fn hide_availability_directory(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileAttributesW(path: *const u16) -> u32;
        fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32;
    }
    let attributes = unsafe { GetFileAttributesW(path.as_ptr()) };
    if attributes != u32::MAX { let _ = unsafe { SetFileAttributesW(path.as_ptr(), attributes | 0x2) }; }
}

fn peer_availability(
    directory: &Path,
    own_file: &Path,
    project_key: &str,
) -> HashMap<String, Vec<MachineAvailability>> {
    let mut peers = HashMap::<String, Vec<MachineAvailability>>::new();
    let Ok(entries) = fs::read_dir(directory) else { return peers };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path())
        .filter(|path| path != own_file && path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    for path in paths.into_iter().take(MAX_PEER_REPORTS) {
        let Ok(metadata) = fs::metadata(&path) else { continue };
        if metadata.len() > MAX_AVAILABILITY_REPORT_BYTES { continue; }
        let Ok(bytes) = fs::read(&path) else { continue };
        let Ok(record) = serde_json::from_slice::<ReadAvailabilityRecord>(&bytes) else { continue };
        if record.schema_version != AVAILABILITY_SCHEMA || record.project_key != project_key
            || record.machine_name.trim().is_empty() || record.machine_name.len() > 128
            || record.local_media_ids.len() > MAX_MEDIA_OBJECTS
        { continue; }
        let Ok(scanned_at) = chrono::DateTime::parse_from_rfc3339(&record.scanned_at) else { continue };
        let age = chrono::Utc::now().signed_duration_since(scanned_at.with_timezone(&chrono::Utc));
        if age < chrono::Duration::zero() || age > MAX_PEER_REPORT_AGE { continue; }
        for id in record.local_media_ids {
            if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) { continue; }
            peers.entry(id).or_default().push(MachineAvailability {
                machine_name: record.machine_name.clone(),
                last_seen: record.scanned_at.clone(),
            });
        }
    }
    peers
}

#[cfg(windows)]
fn replace_availability_file(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    #[link(name = "kernel32")]
    unsafe extern "system" { fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32; }
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) };
    if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

#[cfg(not(windows))]
fn replace_availability_file(from: &Path, to: &Path) -> io::Result<()> { fs::rename(from, to) }

fn write_availability_report(directory: &Path, file: &Path, record: &AvailabilityRecord) -> io::Result<()> {
    let temp = directory.join(format!(".{}.{}.tmp", file.file_name().unwrap_or_default().to_string_lossy(), Uuid::new_v4()));
    let result = (|| {
        let mut output = OpenOptions::new().write(true).create_new(true).open(&temp)?;
        serde_json::to_writer(&mut output, record).map_err(io::Error::other)?;
        if output.metadata()?.len() > MAX_AVAILABILITY_REPORT_BYTES {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Availability report exceeds Pepper's size limit"));
        }
        output.flush()?;
        output.sync_all()?;
        drop(output);
        for attempt in 0..6 {
            match replace_availability_file(&temp, file) {
                Err(error) if cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33)) && attempt < 5 =>
                    std::thread::sleep(Duration::from_millis(40 * (1 << attempt))),
                result => return result,
            }
        }
        unreachable!()
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result
}

fn scan_sync(project_root: String, client_path: String, path: String) -> Result<PremiereHealthReport, String> {
    let project_root_path = PathBuf::from(&project_root);
    let canonical_project_root = project_root_path.canonicalize()
        .map_err(|error| format!("Project folder is unavailable: {error}"))?;
    let client_root = PathBuf::from(client_path)
        .canonicalize()
        .map_err(|error| format!("Client folder is unavailable: {error}"))?;
    if !client_root.starts_with(&canonical_project_root) {
        return Err("Choose a client folder inside the selected project".into());
    }
    let client_relative = client_root.strip_prefix(&canonical_project_root)
        .map_err(|_| "Client folder is outside the selected project".to_string())?
        .to_string_lossy().replace('\\', "/");
    let selected_path = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("Premiere project is unavailable: {error}"))?;
    if !selected_path.starts_with(&client_root) {
        return Err("Choose a Premiere project inside the selected client folder".into());
    }
    // Keep the selected mapped-drive spelling for NAS classification and
    // season-folder matching. canonicalize() may translate Z: to a UNC path.
    let project_path = PathBuf::from(&path);
    if !project_path.is_file() {
        return Err("Premiere project is unavailable".into());
    }
    if !project_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("prproj"))
    {
        return Err("Choose a .prproj file".into());
    }
    let (reader, project_bytes) = xml_reader(&project_path)?;
    let (version, media, expanded_bytes) = extract_media(reader)?;
    let relative_project = selected_path.strip_prefix(&client_root)
        .map_err(|_| "Premiere project is outside the selected client folder".to_string())?
        .to_string_lossy().replace('\\', "/").to_lowercase();
    let project_key = sha256_text(&relative_project);
    let mut items: Vec<PremiereMediaItem> = Vec::new();
    let mut index = std::collections::HashMap::<String, usize>::new();
    let mut ignored_non_file_entries = 0;
    for object in media {
        let Some(original) = object
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|value| is_path_like(value))
        else {
            ignored_non_file_entries += 1;
            continue;
        };
        let absolute_path = absolute_reference(original, &project_path);
        let key = absolute_path.to_ascii_lowercase();
        if let Some(existing) = index.get(&key).copied() {
            items[existing].references += 1;
            continue;
        }
        let (status, resolved_path) = inspect_path(&absolute_path, &project_path);
        let file_name = Path::new(&absolute_path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| original.to_owned());
        index.insert(key, items.len());
        items.push(PremiereMediaItem {
            file_name,
            original_path: original.to_owned(),
            resolved_path,
            status,
            references: 1,
            available_on: Vec::new(),
        });
    }
    if items.is_empty() {
        return Err("No supported filesystem media references were found; Pepper cannot assess this project reliably".into());
    }
    let project_name = project_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Premiere project".into());
    let machine_name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown computer".into());
    let machine_key = sha256_text(&machine_name.trim().to_lowercase());
    let mut availability_note = None;
    let copied_media = crate::ingest::filed_media_copies(&project_root_path, &client_relative);
    for item in &mut items {
        let source_path = absolute_reference(&item.original_path, &project_path);
        let source_key = clean_project_path(&source_path).to_lowercase();
        if let Some(destination) = copied_media.get(&source_key) {
            item.resolved_path = Some(destination.to_string_lossy().into_owned());
            item.status = "copied_to_nas".into();
        }
    }
    let availability_dir = (|| {
        let pepper = safe_child_dir(&client_root, ".pepper")?;
        let health = safe_child_dir(&pepper, "media-health")?;
        safe_child_dir(&health, &project_key)
    })();
    match availability_dir {
        Ok(directory) => {
            let own_file = directory.join(format!("{machine_key}.json"));
            let peers = peer_availability(&directory, &own_file, &project_key);
            for item in &mut items {
                item.available_on = peers.get(&availability_id(&item.original_path)).cloned().unwrap_or_default();
            }
            let mut local_media_ids: Vec<String> = items.iter()
                .filter(|item| item.status == "available_local")
                .map(|item| availability_id(&item.original_path)).collect();
            local_media_ids.sort();
            local_media_ids.dedup();
            let record = AvailabilityRecord {
                schema_version: AVAILABILITY_SCHEMA,
                project_key: project_key.clone(),
                machine_name: machine_name.clone(),
                scanned_at: chrono::Utc::now().to_rfc3339(),
                local_media_ids,
            };
            if let Err(error) = write_availability_report(&directory, &own_file, &record) {
                availability_note = Some(format!("Could not read or update shared computer history: {error}"));
            }
        }
        Err(error) => availability_note = Some(format!("Could not read or update shared computer history: {error}")),
    }
    Ok(PremiereHealthReport {
        machine_name,
        availability_note,
        project_name,
        project_path: project_path.to_string_lossy().into_owned(),
        premiere_version: version,
        project_bytes,
        expanded_bytes,
        media_objects: items.len(),
        ignored_non_file_entries,
        items,
    })
}
