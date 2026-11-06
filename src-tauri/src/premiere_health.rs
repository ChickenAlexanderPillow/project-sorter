//! Read-only Premiere Pro media path inspection.
//!
//! The .prproj container is proprietary. Pepper intentionally supports only
//! PremiereData v3 XML projects with Media/FilePath entries and fails closed
//! when the container or project structure is unfamiliar.

use flate2::read::GzDecoder;
use quick_xml::{events::Event, Reader};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{self, BufReader, Read},
    path::{Component, Path, PathBuf},
};

const MAX_PROJECT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_XML_DEPTH: usize = 256;
const MAX_MEDIA_OBJECTS: usize = 250_000;

#[derive(Debug, Serialize)]
pub struct PremiereHealthReport {
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
    client_path: String,
    path: String,
) -> Result<PremiereHealthReport, String> {
    tauri::async_runtime::spawn_blocking(move || scan_sync(client_path, path))
        .await
        .map_err(|error| error.to_string())?
}

fn scan_sync(client_path: String, path: String) -> Result<PremiereHealthReport, String> {
    let client_root = PathBuf::from(client_path)
        .canonicalize()
        .map_err(|error| format!("Client folder is unavailable: {error}"))?;
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
        });
    }
    if items.is_empty() {
        return Err("No supported filesystem media references were found; Pepper cannot assess this project reliably".into());
    }
    let project_name = project_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Premiere project".into());
    Ok(PremiereHealthReport {
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
