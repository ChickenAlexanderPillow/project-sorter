use std::{
    fs,
    path::{Component, Path, PathBuf},
};

// Only real, immediate media subfolders can be direct drop targets.
pub(crate) fn destination(client: &Path, folder: &str) -> Result<PathBuf, String> {
    let parts: Vec<_> = Path::new(folder).components().collect();
    if parts.len() != 2
        || parts[0] != Component::Normal("01_MEDIA".as_ref())
        || !matches!(parts[1], Component::Normal(_))
    {
        return Err("Choose a folder inside 01_MEDIA.".into());
    }
    let root = client.canonicalize().map_err(|e| e.to_string())?;
    let mut path = client.to_path_buf();
    for part in parts {
        path.push(part);
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_dir()
            || crate::is_link_or_reparse(&metadata)
            || !path
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(&root)
        {
            return Err("Media drop folders must be real folders inside the client.".into());
        }
    }
    Ok(path)
}

#[derive(serde::Serialize)]
pub struct MediaDropFolder {
    path: String,
    role: Option<String>,
}

const FOLDER_ROLES: [(&str, &str, &str); 9] = [
    ("video_proxy", "010_VIDEO_PROXY", "Proxy video"),
    ("video_raw", "020_VIDEO_RAW", "Full-resolution video"),
    ("audio_clean", "030_AUDIO_CLEAN", "Clean audio"),
    ("audio_raw", "040_AUDIO_RAW", "Raw audio"),
    ("stills", "050_STILLS", "Stills"),
    ("music", "060_MUSIC", "Music"),
    ("graphics", "070_GRAPHICS", "Graphics"),
    ("misc", "080_MISCELLANEOUS", "Miscellaneous"),
    ("stock", "090_STOCK", "Stock"),
];

fn folders(client: &Path) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(client.join("01_MEDIA"))
        .map_err(|e| format!("Could not read 01_MEDIA: {e}"))?;
    let mut folders = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = format!("01_MEDIA/{name}");
        if destination(client, &relative).is_ok() {
            folders.push(relative);
        }
    }
    folders.sort_by_key(|name| name.to_lowercase());
    Ok(folders)
}

fn folder_options(client: &Path) -> Result<Vec<MediaDropFolder>, String> {
    let folders = folders(client)?;
    let routes: Vec<_> = FOLDER_ROLES
        .iter()
        .map(|(purpose, legacy, role)| {
            let path = crate::workspace::destination_for_client(client, purpose)?
                .unwrap_or_else(|| format!("01_MEDIA/{legacy}"));
            Ok((path.replace('\\', "/").to_lowercase(), role.to_string()))
        })
        .collect::<Result<_, String>>()?;
    Ok(folders
        .into_iter()
        .map(|path| {
            let role = routes
                .iter()
                .find(|(route, _)| route == &path.to_lowercase())
                .map(|(_, role)| role.clone())
                .or_else(|| {
                    FOLDER_ROLES
                        .iter()
                        .find(|(_, legacy, _)| {
                            path.eq_ignore_ascii_case(&format!("01_MEDIA/{legacy}"))
                        })
                        .map(|(_, _, role)| role.to_string())
                });
            MediaDropFolder { path, role }
        })
        .collect())
}

#[tauri::command]
pub async fn client_media_drop_folders(
    client_path: String,
) -> Result<Vec<MediaDropFolder>, String> {
    tauri::async_runtime::spawn_blocking(move || folder_options(Path::new(&client_path)))
        .await
        .map_err(|e| e.to_string())?
}

fn source_kinds(paths: &[String]) -> Result<Vec<String>, String> {
    let mut kinds = std::collections::BTreeSet::new();
    for source in paths {
        let path = Path::new(&source);
        if path.is_dir() {
            for entry in walkdir::WalkDir::new(path)
                .follow_links(false)
                .into_iter()
                .filter_entry(|entry| {
                    entry.depth() == 0
                        || !entry.file_type().is_dir()
                        || !entry
                            .file_name()
                            .to_string_lossy()
                            .eq_ignore_ascii_case(".pepper")
                })
            {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_type().is_file() {
                    // Sidecars and supporting files do not make a folder mixed-media.
                    if let Some(kind) = crate::media_browser::media_kind(entry.path()) {
                        kinds.insert(kind.to_string());
                    }
                }
            }
        } else if let Some(kind) = crate::media_browser::media_kind(path) {
            kinds.insert(kind.to_string());
        } else {
            kinds.insert("other".to_string());
        }
    }
    Ok(kinds.into_iter().collect())
}

#[tauri::command]
pub async fn media_drop_kinds(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || source_kinds(&paths))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct DropGroup {
    kind: String,
    label: String,
    file_count: usize,
    bytes_total: u64,
    paths: Vec<String>,
}

#[derive(serde::Deserialize, Clone)]
pub(crate) struct DropRoute {
    pub folder: String,
    pub paths: Vec<String>,
}

pub(crate) fn validate_routes(
    client: &Path,
    sources: &[String],
    routes: &[DropRoute],
) -> Result<std::collections::HashMap<PathBuf, String>, String> {
    let mut expected = std::collections::HashSet::new();
    for source in sources {
        let path = Path::new(source);
        if !path.is_file() {
            return Err(
                "A reviewed source is no longer available. Drop the selection again.".into(),
            );
        }
        expected.insert(path.canonicalize().map_err(|error| error.to_string())?);
    }
    let mut plan = std::collections::HashMap::new();
    for route in routes {
        destination(client, &route.folder)?;
        for source in &route.paths {
            let path = Path::new(source)
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !expected.contains(&path) || plan.insert(path, route.folder.clone()).is_some() {
                return Err("Each reviewed file must have exactly one destination.".into());
            }
        }
    }
    if plan.len() != expected.len() {
        return Err("Choose a destination for every reviewed file.".into());
    }
    Ok(plan)
}

#[derive(serde::Serialize)]
pub struct DropPreview {
    file_count: usize,
    bytes_total: u64,
    paths: Vec<String>,
    groups: Vec<DropGroup>,
    folders: Vec<MediaDropFolder>,
}

fn preview(client: &Path, folder: Option<&str>, paths: &[String]) -> Result<DropPreview, String> {
    if let Some(folder) = folder {
        destination(client, folder)?;
    }
    let folders = folder_options(client)?;
    let files = crate::list_files(paths);
    if files.is_empty() {
        return Err("No files were found in this selection.".into());
    }
    let mut groups = Vec::new();
    for (kind, label) in [
        ("video", "Videos"),
        ("audio", "Audio files"),
        ("image", "Images"),
        ("other", "Supporting files"),
    ] {
        let selected: Vec<_> = files
            .iter()
            .filter(|path| crate::media_browser::media_kind(path).unwrap_or("other") == kind)
            .collect();
        if selected.is_empty() {
            continue;
        }
        let bytes_total = selected.iter().try_fold(0u64, |total, path| {
            fs::metadata(path)
                .map(|metadata| total.saturating_add(metadata.len()))
                .map_err(|error| error.to_string())
        })?;
        groups.push(DropGroup {
            kind: kind.into(),
            label: label.into(),
            file_count: selected.len(),
            bytes_total,
            paths: selected
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
        });
    }
    Ok(DropPreview {
        file_count: files.len(),
        bytes_total: groups.iter().map(|group| group.bytes_total).sum(),
        paths: files
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        groups,
        folders,
    })
}

#[tauri::command]
pub async fn media_drop_preview(
    client_path: String,
    destination_folder: Option<String>,
    paths: Vec<String>,
) -> Result<DropPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        preview(
            Path::new(&client_path),
            destination_folder.as_deref(),
            &paths,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmation_counts_and_freezes_files_without_transferring() {
        let temp = tempfile::tempdir().unwrap();
        let client = temp.path().join("client");
        let source = temp.path().join("source");
        fs::create_dir_all(client.join("01_MEDIA/020_VIDEO_RAW")).unwrap();
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("clip.mov"), b"video").unwrap();
        fs::write(source.join("nested/clip.xmp"), b"metadata").unwrap();
        let selection = vec![
            source.to_string_lossy().into_owned(),
            source.join("clip.mov").to_string_lossy().into_owned(),
        ];
        let summary = preview(&client, Some("01_MEDIA/020_VIDEO_RAW"), &selection).unwrap();
        assert_eq!(summary.file_count, 2);
        assert_eq!(summary.bytes_total, 13);
        assert!(summary.paths.iter().all(|path| Path::new(path).is_file()));
        assert_eq!(
            fs::read_dir(client.join("01_MEDIA/020_VIDEO_RAW"))
                .unwrap()
                .count(),
            0
        );
        fs::write(source.join("new.mov"), b"later").unwrap();
        assert_eq!(crate::list_files(&summary.paths).len(), 2);
        assert!(preview(&client, Some("../outside"), &selection).is_err());
    }
    #[test]
    fn mixed_review_groups_every_file_and_validates_the_whole_plan_before_writing() {
        let root = tempfile::tempdir().unwrap();
        let client = root.path().join("client");
        for folder in [
            "020_VIDEO_RAW",
            "040_AUDIO_RAW",
            "050_STILLS",
            "080_MISCELLANEOUS",
        ] {
            fs::create_dir_all(client.join("01_MEDIA").join(folder)).unwrap();
        }
        let mut sources = Vec::new();
        for name in ["clip.mp4", "mic.wav", "still.png", "clip.xmp"] {
            let path = root.path().join(name);
            fs::write(&path, name).unwrap();
            sources.push(path.to_string_lossy().into_owned());
        }
        let review = preview(&client, None, &sources).unwrap();
        assert_eq!(review.file_count, 4);
        assert_eq!(
            review
                .groups
                .iter()
                .map(|group| group.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["video", "audio", "image", "other"]
        );
        let folders = [
            "020_VIDEO_RAW",
            "040_AUDIO_RAW",
            "050_STILLS",
            "080_MISCELLANEOUS",
        ];
        let mut routes: Vec<_> = review
            .groups
            .iter()
            .zip(folders)
            .map(|(group, folder)| DropRoute {
                folder: format!("01_MEDIA/{folder}"),
                paths: group.paths.clone(),
            })
            .collect();
        let plan = validate_routes(&client, &review.paths, &routes).unwrap();
        assert_eq!(plan.len(), 4);
        assert_eq!(
            plan[&Path::new(&sources[1]).canonicalize().unwrap()],
            "01_MEDIA/040_AUDIO_RAW"
        );
        assert!(validate_routes(&client, &review.paths, &routes[..3]).is_err());
        routes[1].paths.push(sources[0].clone());
        assert!(validate_routes(&client, &review.paths, &routes).is_err());
        routes[1].paths.pop();
        routes[3].folder = "../outside".into();
        assert!(validate_routes(&client, &review.paths, &routes).is_err());
        assert!(sources.iter().all(|source| Path::new(source).is_file()));
        assert_eq!(
            fs::read_dir(client.join("01_MEDIA/020_VIDEO_RAW"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn lists_real_folders_and_rejects_escaping_targets() {
        let root = std::env::temp_dir().join(format!("pepper-drop-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("01_MEDIA/020_VIDEO_RAW")).unwrap();
        fs::create_dir_all(root.join("01_MEDIA/Custom folder")).unwrap();
        fs::write(root.join("01_MEDIA/file.txt"), "test").unwrap();
        assert_eq!(
            folders(&root).unwrap(),
            vec!["01_MEDIA/020_VIDEO_RAW", "01_MEDIA/Custom folder"]
        );
        for invalid in [
            "../outside",
            "01_MEDIA/../02_EDIT",
            "02_EDIT/child",
            "01_MEDIA",
            "01_MEDIA/Custom folder/nested",
        ] {
            assert!(destination(&root, invalid).is_err(), "{invalid}");
        }
        assert!(destination(&root, "01_MEDIA/missing").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn drag_classification_matches_ingest_for_files_and_folder_contents() {
        let root = std::env::temp_dir().join(format!("pepper-drop-kinds-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("still.HEIC"), b"image").unwrap();
        assert_eq!(
            source_kinds(&[root.to_string_lossy().into_owned()]).unwrap(),
            vec!["image"]
        );
        fs::write(root.join("nested/mic.wav"), b"audio").unwrap();
        fs::write(root.join("nested/clip.MOV"), b"video").unwrap();
        assert_eq!(
            source_kinds(&[root.to_string_lossy().into_owned()]).unwrap(),
            vec!["audio", "image", "video"]
        );
        assert_eq!(
            source_kinds(&[root.join("still.HEIC").to_string_lossy().into_owned()]).unwrap(),
            vec!["image"]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn single_media_type_folders_ignore_sidecars_and_pepper_metadata() {
        let root = tempfile::tempdir().unwrap();
        for (name, expected) in [
            ("clip.MOV", "video"),
            ("mic.wav", "audio"),
            ("still.HEIC", "image"),
        ] {
            let folder = root.path().join(expected);
            fs::create_dir_all(folder.join("nested")).unwrap();
            fs::create_dir_all(folder.join(".pepper")).unwrap();
            fs::write(folder.join("nested").join(name), b"media").unwrap();
            fs::write(folder.join("clip.mov.xmp"), b"sidecar").unwrap();
            fs::write(folder.join("README.txt"), b"notes").unwrap();
            fs::write(folder.join(".pepper/preview.mp4"), b"metadata preview").unwrap();
            fs::write(folder.join(".pepper/thumbnail.png"), b"metadata thumbnail").unwrap();
            assert_eq!(
                source_kinds(&[folder.to_string_lossy().into_owned()]).unwrap(),
                vec![expected]
            );
        }
        let video = root.path().join("video");
        let audio = root.path().join("audio");
        assert_eq!(
            source_kinds(&[
                video.to_string_lossy().into_owned(),
                audio.to_string_lossy().into_owned()
            ])
            .unwrap(),
            vec!["audio", "video"]
        );
        assert_eq!(
            source_kinds(&[video.join("README.txt").to_string_lossy().into_owned()]).unwrap(),
            vec!["other"]
        );
    }

    #[test]
    fn custom_routing_keeps_media_roles_and_legacy_folder_filtering() {
        let root = std::env::temp_dir().join(format!("pepper-drop-roles-{}", uuid::Uuid::new_v4()));
        for folder in ["020_VIDEO_RAW", "Camera originals", "Custom"] {
            fs::create_dir_all(root.join("01_MEDIA").join(folder)).unwrap();
        }
        fs::write(
            root.join(".pepper-client.json"),
            br#"{"folder_destinations":{"video_raw":"01_MEDIA/Camera originals"}}"#,
        )
        .unwrap();
        let options = folder_options(&root).unwrap();
        assert_eq!(
            options
                .iter()
                .filter(|folder| folder.role.as_deref() == Some("Full-resolution video"))
                .count(),
            2
        );
        assert!(options
            .iter()
            .find(|folder| folder.path.ends_with("/Custom"))
            .unwrap()
            .role
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn junctions_cannot_redirect_media_drops() {
        let root = std::env::temp_dir().join(format!("pepper-drop-links-{}", uuid::Uuid::new_v4()));
        let client = root.join("client");
        let outside = root.join("outside");
        fs::create_dir_all(client.join("01_MEDIA")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let link = client.join("01_MEDIA").join("Linked");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        assert!(destination(&client, "01_MEDIA/Linked").is_err());
        assert!(folders(&client).unwrap().is_empty());
        fs::remove_dir(&link).unwrap();
        fs::remove_dir(client.join("01_MEDIA")).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(client.join("01_MEDIA"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        fs::create_dir(outside.join("Raw")).unwrap();
        assert!(destination(&client, "01_MEDIA/Raw").is_err());
        fs::remove_dir(client.join("01_MEDIA")).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
