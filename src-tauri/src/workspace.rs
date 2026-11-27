//! Shared workspace settings stored beside the project catalog.
//!
//! Workspace persistence is deliberately isolated from client and media APIs:
//! this module only reads or writes files inside `<workspace>/.pepper`.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

const SCHEMA_VERSION: u32 = 1;
const MAX_HISTORY: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub name: String,
    /// Workspace-relative project folder. Never a per-computer absolute path.
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceClientType {
    pub id: String,
    pub name: String,
    pub folder_template_id: String,
    pub features: Vec<String>,
    /// Only supported, documented options are accepted by validation.
    #[serde(default)]
    pub feature_options: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProfile {
    pub id: String,
    pub name: String,
    pub project_ids: Vec<String>,
    pub allowed_client_type_ids: Vec<String>,
    pub default_client_type_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolder {
    pub id: String,
    pub path: String,
    pub purpose: String,
    pub enabled: bool,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolderTemplate {
    pub id: String,
    pub name: String,
    pub folders: Vec<WorkspaceFolder>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceResource {
    pub id: String,
    pub name: String,
    /// Shared template locations are relative to the workspace root.
    pub relative_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    pub schema_version: u32,
    pub revision: u64,
    pub content_hash: String,
    pub workspace_id: String,
    pub display_name: String,
    pub projects: Vec<WorkspaceProject>,
    pub project_show_names: Vec<String>,
    pub client_types: Vec<WorkspaceClientType>,
    pub profiles: Vec<WorkspaceProfile>,
    pub folder_templates: Vec<WorkspaceFolderTemplate>,
    pub resources: Vec<WorkspaceResource>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHistoryEntry {
    pub file_name: String,
    pub revision: u64,
    pub content_hash: String,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLockInfo {
    pub path: String,
    pub content: String,
    pub modified: Option<String>,
    pub can_offer_recovery: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiscovery {
    pub status: String,
    pub root: String,
    pub config: Option<WorkspaceConfig>,
    pub writable: bool,
    pub message: Option<String>,
    pub lock: Option<WorkspaceLockInfo>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LockRecord {
    host: String,
    user: String,
    started_at: String,
}

struct WorkspaceLock(PathBuf);

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct MetadataDirGuard {
    path: PathBuf,
    created: bool,
    keep: bool,
}

impl Drop for MetadataDirGuard {
    fn drop(&mut self) {
        if self.created && !self.keep {
            let _ = fs::remove_dir(&self.path);
        }
    }
}

fn paths(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Workspace root is unavailable: {error}"))?;
    if !canonical_root.is_dir() {
        return Err("Workspace root must be an available folder".into());
    }
    let metadata = canonical_root.join(".pepper");
    if let Ok(info) = fs::symlink_metadata(&metadata) {
        if is_link_or_reparse(&info) {
            return Err("The .pepper metadata folder cannot be a symbolic link".into());
        }
        let canonical_metadata = metadata
            .canonicalize()
            .map_err(|error| format!("Could not validate workspace metadata folder: {error}"))?;
        if !canonical_metadata.starts_with(&canonical_root) || !canonical_metadata.is_dir() {
            return Err("Workspace metadata must remain inside the selected workspace".into());
        }
    }
    Ok((canonical_root, metadata))
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

fn config_path(metadata: &Path) -> PathBuf {
    metadata.join("workspace.json")
}

fn history_dir(metadata: &Path, create: bool) -> Result<PathBuf, String> {
    let history = metadata.join("history");
    if create && !history.exists() {
        match fs::create_dir(&history) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "Could not create workspace recovery history: {error}"
                ))
            }
        }
    }
    if history.exists() {
        let info = fs::symlink_metadata(&history)
            .map_err(|error| format!("Could not inspect recovery history: {error}"))?;
        if is_link_or_reparse(&info) || !info.is_dir() {
            return Err("Workspace recovery history must be a folder inside .pepper".into());
        }
        let canonical = history.canonicalize().map_err(|error| error.to_string())?;
        let canonical_metadata = metadata.canonicalize().map_err(|error| error.to_string())?;
        if !canonical.starts_with(canonical_metadata) {
            return Err("Workspace recovery history must remain inside .pepper".into());
        }
    }
    Ok(history)
}

fn lock_path(metadata: &Path) -> PathBuf {
    metadata.join("workspace.lock")
}

fn lock_info(path: &Path) -> Option<WorkspaceLockInfo> {
    let metadata = fs::metadata(path).ok()?;
    let modified_system = metadata.modified().ok();
    let modified = modified_system.map(|time| format_system_time(time));
    let content = fs::read_to_string(path)
        .unwrap_or_else(|error| format!("Lock record unavailable: {error}"));
    let stale_after = std::time::Duration::from_secs(5 * 60);
    let can_offer_recovery = modified_system
        .and_then(|time| SystemTime::now().duration_since(time).ok())
        .is_some_and(|age| age > stale_after);
    Some(WorkspaceLockInfo {
        path: path.to_string_lossy().into_owned(),
        content,
        modified,
        can_offer_recovery,
    })
}

fn format_system_time(time: SystemTime) -> String {
    let duration = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    duration.as_secs().to_string()
}

fn read_active(metadata: &Path) -> Result<Option<WorkspaceConfig>, String> {
    let path = config_path(metadata);
    if !path.exists() {
        return Ok(None);
    }
    let info = fs::symlink_metadata(&path)
        .map_err(|error| format!("Workspace configuration is unreadable: {error}"))?;
    if is_link_or_reparse(&info) || !info.is_file() {
        return Err("Workspace configuration must be a regular file inside .pepper".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Workspace configuration is unreadable: {error}"))?;
    let canonical_metadata = metadata
        .canonicalize()
        .map_err(|error| format!("Workspace metadata is unavailable: {error}"))?;
    if !canonical.starts_with(&canonical_metadata) || !canonical.is_file() {
        return Err("Workspace configuration must remain inside .pepper".into());
    }
    let data = fs::read(&canonical)
        .map_err(|error| format!("Workspace configuration is unreadable: {error}"))?;
    let config: WorkspaceConfig = serde_json::from_slice(&data)
        .map_err(|error| format!("Workspace configuration is invalid: {error}"))?;
    if config.schema_version > SCHEMA_VERSION {
        return Err(format!(
            "This workspace uses schema version {}; update Pepper to open it",
            config.schema_version
        ));
    }
    validate(&config)?;
    let expected = content_hash(&config)?;
    if config.content_hash != expected {
        return Err(
            "Workspace configuration content hash does not match; the file may be damaged".into(),
        );
    }
    Ok(Some(config))
}

pub fn discover(root: &str) -> WorkspaceDiscovery {
    let input = PathBuf::from(root);
    let canonical = match input.canonicalize() {
        Ok(path) if path.is_dir() => path,
        Ok(_) => return unavailable(root, "Workspace root must be a folder"),
        Err(error) => return unavailable(root, &format!("Workspace root is unavailable: {error}")),
    };
    let (canonical, metadata) = match paths(&canonical) {
        Ok(value) => value,
        Err(error) => return unavailable(root, &error),
    };
    if !metadata.exists() {
        return WorkspaceDiscovery {
            status: "absent".into(),
            root: canonical.to_string_lossy().into_owned(),
            config: None,
            writable: can_write_parent(&canonical),
            message: None,
            lock: None,
        };
    }
    let lock = lock_info(&lock_path(&metadata));
    match read_active(&metadata) {
        Ok(Some(config)) => WorkspaceDiscovery {
            status: "valid".into(),
            root: canonical.to_string_lossy().into_owned(),
            config: Some(config),
            writable: can_write_parent(&metadata),
            message: None,
            lock,
        },
        Ok(None) => WorkspaceDiscovery {
            status: "absent".into(),
            root: canonical.to_string_lossy().into_owned(),
            config: None,
            writable: can_write_parent(&metadata),
            message: None,
            lock,
        },
        Err(error) => {
            let status = if error.contains("schema version") {
                "unsupported"
            } else {
                "invalid"
            };
            WorkspaceDiscovery {
                status: status.into(),
                root: canonical.to_string_lossy().into_owned(),
                config: None,
                writable: can_write_parent(&metadata),
                message: Some(error),
                lock,
            }
        }
    }
}

fn unavailable(root: &str, message: &str) -> WorkspaceDiscovery {
    WorkspaceDiscovery {
        status: "unavailable".into(),
        root: root.into(),
        config: None,
        writable: false,
        message: Some(message.into()),
        lock: None,
    }
}

fn can_write_parent(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        path.metadata()
            .map(|metadata| metadata.file_attributes() & 0x1 == 0)
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|metadata| metadata.permissions().mode() & 0o222 != 0)
            .unwrap_or(false)
    }
}

pub fn starter(
    root: &str,
    projects: Vec<WorkspaceProject>,
    project_show_names: Vec<String>,
    display_name: String,
) -> WorkspaceConfig {
    let project_catalog = projects.clone();
    let template = WorkspaceFolderTemplate {
        id: "standard".into(),
        name: "Standard Pepper folders".into(),
        folders: vec![
            folder("media", "01_MEDIA", "media", true),
            folder("proxy", "01_MEDIA/010_VIDEO_PROXY", "video_proxy", false),
            folder("raw_video", "01_MEDIA/020_VIDEO_RAW", "video_raw", false),
            folder(
                "clean_audio",
                "01_MEDIA/030_AUDIO_CLEAN",
                "audio_clean",
                false,
            ),
            folder("raw_audio", "01_MEDIA/040_AUDIO_RAW", "audio_raw", false),
            folder("stills", "01_MEDIA/050_STILLS", "stills", false),
            folder("music", "01_MEDIA/060_MUSIC", "music", false),
            folder("graphics", "01_MEDIA/070_GRAPHICS", "graphics", false),
            folder("misc", "01_MEDIA/080_MISCELLANEOUS", "misc", false),
            folder("stock", "01_MEDIA/090_STOCK", "stock", false),
            folder("edit", "02_EDIT", "edit", true),
            folder("exports", "03_EXPORTS", "exports", true),
            folder("approval", "03_EXPORTS/APPROVAL", "approval", false),
            folder("clips", "03_EXPORTS/CLIPS", "clips", false),
            folder("final", "04_FINAL", "final", true),
        ],
    };
    let client_types = vec![
        starter_client_type("exhibitor", "Exhibitor", vec!["premiere_project"]),
        starter_client_type("huddle", "Huddle", vec!["premiere_project"]),
        starter_client_type("product", "Product", vec!["premiere_project"]),
        starter_client_type(
            "mariyameets",
            "Mariya Meets",
            vec!["premiere_project", "seasons"],
        ),
        starter_client_type("social", "Social", vec!["social_project"]),
        starter_client_type("report", "Report", vec!["reporting"]),
    ];
    let mut standard_projects = Vec::new();
    let mut special: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for project in projects {
        let name = project.name.to_ascii_lowercase();
        let profile = if name.contains("socials") {
            "socials"
        } else if name.contains("analysis") {
            "analysis"
        } else if name.contains("remote") {
            "remote"
        } else if name.contains("mariya meets") {
            "mariya"
        } else {
            "standard"
        };
        if profile == "standard" {
            standard_projects.push(project.id.clone());
        }
        special.entry(profile.into()).or_default().push(project.id);
    }
    let profiles = vec![
        profile(
            "standard",
            "Standard projects",
            standard_projects,
            vec!["exhibitor", "huddle", "product", "social"],
            "exhibitor",
        ),
        profile(
            "remote",
            "Remote projects",
            special.remove("remote").unwrap_or_default(),
            vec!["exhibitor", "huddle", "product"],
            "exhibitor",
        ),
        profile(
            "socials",
            "Socials projects",
            special.remove("socials").unwrap_or_default(),
            vec!["social"],
            "social",
        ),
        profile(
            "analysis",
            "Analysis projects",
            special.remove("analysis").unwrap_or_default(),
            vec!["report"],
            "report",
        ),
        profile(
            "mariya",
            "Mariya Meets projects",
            special.remove("mariya").unwrap_or_default(),
            vec!["mariyameets"],
            "mariyameets",
        ),
        profile(
            "fallback",
            "Other projects",
            Vec::new(),
            vec!["exhibitor", "huddle", "product", "social"],
            "exhibitor",
        ),
    ];
    let config = WorkspaceConfig {
        schema_version: SCHEMA_VERSION,
        revision: 0,
        content_hash: String::new(),
        workspace_id: uuid::Uuid::new_v4().to_string(),
        display_name: if display_name.trim().is_empty() {
            Path::new(root)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Pepper workspace")
                .to_string()
        } else {
            display_name
        },
        projects: project_catalog,
        project_show_names,
        client_types,
        profiles,
        folder_templates: vec![template],
        resources: vec![
            WorkspaceResource {
                id: "premiere_standard".into(),
                name: "Standard Premiere template".into(),
                relative_path: None,
            },
            WorkspaceResource {
                id: "premiere_video_call".into(),
                name: "Video call Premiere template".into(),
                relative_path: None,
            },
        ],
    };
    config
}

fn folder(id: &str, path: &str, purpose: &str, required: bool) -> WorkspaceFolder {
    WorkspaceFolder {
        id: id.into(),
        path: path.into(),
        purpose: purpose.into(),
        enabled: true,
        required,
    }
}

fn starter_client_type(id: &str, name: &str, features: Vec<&str>) -> WorkspaceClientType {
    let feature_options = if id == "huddle" {
        BTreeMap::from([(
            "premiere_project".into(),
            vec!["standard".into(), "video_call".into()],
        )])
    } else if id == "mariyameets" {
        BTreeMap::from([("seasons".into(), vec!["enabled".into()])])
    } else {
        BTreeMap::new()
    };
    WorkspaceClientType {
        id: id.into(),
        name: name.into(),
        folder_template_id: "standard".into(),
        features: features.into_iter().map(str::to_owned).collect(),
        feature_options,
    }
}

fn profile(
    id: &str,
    name: &str,
    project_ids: Vec<String>,
    allowed: Vec<&str>,
    default: &str,
) -> WorkspaceProfile {
    WorkspaceProfile {
        id: id.into(),
        name: name.into(),
        project_ids,
        allowed_client_type_ids: allowed.into_iter().map(str::to_owned).collect(),
        default_client_type_id: default.into(),
    }
}

pub fn projects_from_filesystem(root: &Path) -> Result<Vec<WorkspaceProject>, String> {
    let entries = fs::read_dir(root)
        .map_err(|error| format!("Could not read workspace project catalog: {error}"))?;
    let mut projects = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.eq_ignore_ascii_case(".pepper") {
            continue;
        }
        let Some((prefix, _)) = name.split_once('_') else {
            continue;
        };
        if prefix.is_empty() || !prefix.chars().all(|character| character.is_ascii_digit()) {
            continue;
        }
        let relative_path = name.replace('\\', "/");
        projects.push(WorkspaceProject {
            id: format!("project:{}", relative_path.to_ascii_lowercase()),
            name,
            relative_path,
        });
    }
    projects.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(projects)
}

fn valid_relative_path(path: &str) -> bool {
    let path = Path::new(path);
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && !path.components().any(|component| {
            let part = component.as_os_str().to_string_lossy();
            let upper = part.to_ascii_uppercase();
            part.eq_ignore_ascii_case(".pepper")
                || part.is_empty()
                || part.ends_with('.')
                || part.ends_with(' ')
                || part.chars().any(|character| {
                    matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
                        || character.is_control()
                })
                || matches!(
                    upper.split('.').next().unwrap_or(""),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
}

fn unique_ids<'a>(mut items: impl Iterator<Item = &'a String>) -> bool {
    let mut ids = HashSet::new();
    items.all(|id| !id.trim().is_empty() && ids.insert(id.to_ascii_lowercase()))
}

pub fn validate(config: &WorkspaceConfig) -> Result<(), String> {
    if config.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "Unsupported workspace schema version {}",
            config.schema_version
        ));
    }
    if config.workspace_id.trim().is_empty() || config.display_name.trim().is_empty() {
        return Err("Workspace identity and name are required".into());
    }
    if !unique_ids(config.projects.iter().map(|item| &item.id))
        || !unique_ids(config.client_types.iter().map(|item| &item.id))
        || !unique_ids(config.profiles.iter().map(|item| &item.id))
        || !unique_ids(config.folder_templates.iter().map(|item| &item.id))
        || !unique_ids(config.resources.iter().map(|item| &item.id))
    {
        return Err("Workspace identifiers must be unique and nonempty".into());
    }
    for project in &config.projects {
        if !valid_relative_path(&project.relative_path) || project.name.trim().is_empty() {
            return Err(format!(
                "Project '{}' must use a workspace-relative path",
                project.name
            ));
        }
    }
    let mut project_show_names = HashSet::new();
    for name in &config.project_show_names {
        let normalized = name.trim().to_ascii_lowercase();
        if normalized.is_empty()
            || !project_show_names.insert(normalized)
            || name.chars().any(char::is_control)
        {
            return Err(
                "Project catalog names must be nonempty, unique, and contain no control characters"
                    .into(),
            );
        }
    }
    let types: HashSet<&str> = config
        .client_types
        .iter()
        .map(|item| item.id.as_str())
        .collect();
    let templates: HashSet<&str> = config
        .folder_templates
        .iter()
        .map(|item| item.id.as_str())
        .collect();
    if config
        .client_types
        .iter()
        .any(|item| !templates.contains(item.folder_template_id.as_str()))
    {
        return Err("Every client type must reference an existing folder template".into());
    }
    for item in &config.client_types {
        if item.features.iter().any(|feature| {
            !matches!(
                feature.as_str(),
                "premiere_project" | "seasons" | "social_project" | "reporting"
            )
        }) {
            return Err(format!(
                "Client type '{}' includes an unsupported Pepper feature",
                item.name
            ));
        }
        for (feature, options) in &item.feature_options {
            if !item.features.contains(feature) {
                return Err(format!(
                    "Options are set for a disabled feature on '{}'",
                    item.name
                ));
            }
            if feature == "premiere_project"
                && options
                    .iter()
                    .any(|option| !matches!(option.as_str(), "standard" | "video_call"))
            {
                return Err(format!(
                    "Client type '{}' has an unsupported Premiere template option",
                    item.name
                ));
            }
            if feature == "seasons"
                && options
                    .iter()
                    .any(|option| !matches!(option.as_str(), "enabled"))
            {
                return Err(format!(
                    "Client type '{}' has an unsupported season option",
                    item.name
                ));
            }
        }
    }
    let project_ids: HashSet<&str> = config
        .projects
        .iter()
        .map(|item| item.id.as_str())
        .collect();
    let mut assigned = HashSet::new();
    for item in &config.profiles {
        if item.allowed_client_type_ids.is_empty()
            || !item
                .allowed_client_type_ids
                .iter()
                .all(|id| types.contains(id.as_str()))
            || !item
                .allowed_client_type_ids
                .contains(&item.default_client_type_id)
        {
            return Err(format!(
                "Profile '{}' must choose its default from its allowed client types",
                item.name
            ));
        }
        for id in &item.project_ids {
            if !project_ids.contains(id.as_str()) {
                return Err(format!(
                    "Profile '{}' refers to a project that is no longer in the catalog",
                    item.name
                ));
            }
            if !assigned.insert(id.to_ascii_lowercase()) {
                return Err(format!(
                    "Project '{}' is assigned to more than one profile",
                    id
                ));
            }
        }
    }
    for template in &config.folder_templates {
        if template.name.trim().is_empty()
            || !unique_ids(template.folders.iter().map(|folder| &folder.id))
        {
            return Err("Folder templates require unique folder identifiers and a name".into());
        }
        let mut paths = HashSet::new();
        let mut routed_purposes = HashSet::new();
        let mut required_media = false;
        let mut required_edit = false;
        let mut required_exports = false;
        let mut required_final = false;
        for folder in &template.folders {
            if !valid_relative_path(&folder.path) {
                return Err(format!(
                    "Folder '{}' must be a safe relative path inside the client",
                    folder.path
                ));
            }
            let normalized = folder.path.replace('\\', "/").to_ascii_lowercase();
            if !paths.insert(normalized) {
                return Err(format!(
                    "Folder path '{}' collides with another path",
                    folder.path
                ));
            }
            if folder.required && !folder.enabled {
                return Err(format!(
                    "Required folder '{}' cannot be disabled",
                    folder.path
                ));
            }
            if !matches!(
                folder.purpose.as_str(),
                "media"
                    | "video_proxy"
                    | "video_raw"
                    | "audio_clean"
                    | "audio_raw"
                    | "stills"
                    | "music"
                    | "graphics"
                    | "misc"
                    | "stock"
                    | "edit"
                    | "exports"
                    | "approval"
                    | "clips"
                    | "final"
                    | "other"
            ) {
                return Err(format!(
                    "Folder '{}' uses an unsupported Pepper purpose",
                    folder.path
                ));
            }
            if folder.purpose != "other" && !routed_purposes.insert(folder.purpose.as_str()) {
                return Err(format!(
                    "Folder purpose '{}' can be routed only once per structure",
                    folder.purpose
                ));
            }
            if folder.required && folder.path.eq_ignore_ascii_case("01_MEDIA") {
                required_media = true;
            }
            if folder.required && folder.path.eq_ignore_ascii_case("02_EDIT") {
                required_edit = true;
            }
            if folder.required && folder.path.eq_ignore_ascii_case("03_EXPORTS") {
                required_exports = true;
            }
            if folder.required && folder.path.eq_ignore_ascii_case("04_FINAL") {
                required_final = true;
            }
        }
        if !required_media || !required_edit || !required_exports || !required_final {
            return Err(
                "01_MEDIA, 02_EDIT, 03_EXPORTS, and 04_FINAL are required Pepper folders".into(),
            );
        }
    }
    for resource in &config.resources {
        if let Some(path) = resource.relative_path.as_deref() {
            if !valid_relative_path(path) {
                return Err(format!(
                    "Shared resource '{}' must use a workspace-relative path",
                    resource.name
                ));
            }
        }
    }
    Ok(())
}

fn content_hash(config: &WorkspaceConfig) -> Result<String, String> {
    let mut copy = config.clone();
    copy.content_hash.clear();
    let serialized = serde_json::to_vec(&copy).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    digest.update(serialized);
    Ok(format!("{:x}", digest.finalize()))
}

fn acquire_lock(metadata: &Path) -> Result<WorkspaceLock, String> {
    let path = lock_path(metadata);
    let record = LockRecord {
        host: whoami::fallible::hostname().unwrap_or_else(|_| "unknown".into()),
        user: whoami::username(),
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    let mut file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "Workspace is locked for editing. Wait for the other save or review the lock before recovery.".into()
        } else { format!("Could not acquire workspace save lock: {error}") }
    })?;
    let data = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    if let Err(error) = file.write_all(&data).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(format!("Could not write workspace lock: {error}"));
    }
    Ok(WorkspaceLock(path))
}

#[cfg(windows)]
fn atomic_replace(from: &Path, to: &Path) -> Result<(), String> {
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
    .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn atomic_replace(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|error| error.to_string())
}

pub fn save(
    root: &str,
    mut draft: WorkspaceConfig,
    expected_revision: Option<u64>,
    expected_hash: Option<&str>,
) -> Result<WorkspaceConfig, String> {
    validate(&draft)?;
    let (canonical_root, metadata) = paths(Path::new(root))?;
    let mut created_metadata = false;
    if !metadata.exists() {
        match fs::create_dir(&metadata) {
            Ok(()) => created_metadata = true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "Could not create workspace metadata folder: {error}"
                ))
            }
        }
    }
    let mut metadata_guard = MetadataDirGuard {
        path: metadata.clone(),
        created: created_metadata,
        keep: false,
    };
    let canonical_metadata = metadata.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_metadata.starts_with(&canonical_root) {
        return Err("Workspace metadata escaped the selected root".into());
    }
    let _lock = match acquire_lock(&canonical_metadata) {
        Ok(lock) => lock,
        Err(error) => {
            if created_metadata {
                let _ = fs::remove_dir(&canonical_metadata);
            }
            return Err(error);
        }
    };
    let active = read_active(&canonical_metadata)?;
    match (&active, expected_revision, expected_hash) {
        (None, None, None) => {}
        (Some(current), Some(revision), Some(hash)) if current.revision == revision && current.content_hash == hash => {}
        (None, Some(_), Some(_)) => return Err("Workspace settings were removed after this draft was opened. Review the workspace before saving.".into()),
        (Some(_), None, None) => return Err("Workspace settings were created after setup began. Reload them before saving.".into()),
        _ => return Err("Workspace settings changed on another computer. Review changes and reload the latest settings before saving.".into()),
    }
    if let Some(current) = &active {
        draft.workspace_id = current.workspace_id.clone();
        for previous_type in &current.client_types {
            if !draft
                .client_types
                .iter()
                .any(|item| item.id.eq_ignore_ascii_case(&previous_type.id))
                && existing_clients_use_type(&canonical_root, &previous_type.id)?
            {
                return Err(format!(
                    "Client type '{}' is still used by existing clients. Keep its definition, or move those clients in a separate reviewed workflow.",
                    previous_type.name
                ));
            }
        }
    }
    draft.schema_version = SCHEMA_VERSION;
    draft.revision = active
        .as_ref()
        .map(|current| current.revision + 1)
        .unwrap_or(1);
    draft.content_hash.clear();
    draft.content_hash = content_hash(&draft)?;
    validate(&draft)?;
    let serialized = serde_json::to_vec_pretty(&draft).map_err(|error| error.to_string())?;
    let path = config_path(&canonical_metadata);
    if let Some(current) = &active {
        let history = history_dir(&canonical_metadata, true)?;
        let previous = serde_json::to_vec_pretty(current).map_err(|error| error.to_string())?;
        let snapshot = history.join(format!(
            "revision-{:08}-{}.json",
            current.revision,
            &current.content_hash[..12.min(current.content_hash.len())]
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(snapshot)
            .map_err(|error| format!("Could not preserve previous workspace settings: {error}"))?;
        file.write_all(&previous)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not write workspace recovery history: {error}"))?;
    }
    let temporary = canonical_metadata.join(format!("workspace-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create workspace settings draft: {error}"))?;
    if let Err(error) = file.write_all(&serialized).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not write workspace settings draft: {error}"));
    }
    drop(file);
    if let Err(error) = atomic_replace(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not activate workspace settings; the current revision remains unchanged: {error}"));
    }
    metadata_guard.keep = true;
    prune_history(&canonical_metadata);
    Ok(draft)
}

fn prune_history(metadata: &Path) {
    let history = metadata.join("history");
    let Ok(entries) = fs::read_dir(history) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((entry.path(), modified))
        })
        .collect();
    files.sort_by_key(|(_, modified)| *modified);
    let remove_count = files.len().saturating_sub(MAX_HISTORY);
    if remove_count > 0 {
        for (path, _) in files.into_iter().take(remove_count) {
            let _ = fs::remove_file(path);
        }
    }
}

fn client_uses_type(client_path: &Path, type_id: &str) -> bool {
    let metadata_type = fs::read(client_path.join(".pepper-client.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("client_type")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        });
    if metadata_type
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case(type_id))
    {
        return true;
    }
    client_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.to_ascii_uppercase()
                .ends_with(&format!("_{}", type_id.to_ascii_uppercase()))
        })
}

fn existing_clients_use_type(root: &Path, type_id: &str) -> Result<bool, String> {
    for project in projects_from_filesystem(root)? {
        let project_path = root.join(&project.relative_path);
        for entry in fs::read_dir(&project_path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.eq_ignore_ascii_case(".pepper")
                || name.eq_ignore_ascii_case("_ingest")
                || name.eq_ignore_ascii_case("_logs")
            {
                continue;
            }
            let path = entry.path();
            if name.to_ascii_uppercase().starts_with("SEASON ") {
                for child in fs::read_dir(&path).map_err(|error| error.to_string())? {
                    let child = child.map_err(|error| error.to_string())?;
                    if child
                        .file_type()
                        .map_err(|error| error.to_string())?
                        .is_dir()
                        && client_uses_type(&child.path(), type_id)
                    {
                        return Ok(true);
                    }
                }
            } else if client_uses_type(&path, type_id) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub fn history(root: &str) -> Result<Vec<WorkspaceHistoryEntry>, String> {
    let (_, metadata) = paths(Path::new(root))?;
    let history = history_dir(&metadata, false)?;
    if !history.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(history).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let mut data = Vec::new();
        File::open(entry.path())
            .and_then(|mut file| file.read_to_end(&mut data))
            .map_err(|error| error.to_string())?;
        let Ok(config) = serde_json::from_slice::<WorkspaceConfig>(&data) else {
            continue;
        };
        if validate(&config).is_err() || content_hash(&config)? != config.content_hash {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(format_system_time);
        result.push(WorkspaceHistoryEntry {
            file_name,
            revision: config.revision,
            content_hash: config.content_hash,
            modified,
        });
    }
    result.sort_by_key(|entry| entry.revision);
    Ok(result)
}

pub fn snapshot(root: &str, file_name: &str) -> Result<WorkspaceConfig, String> {
    if file_name.contains('/') || file_name.contains('\\') || !file_name.starts_with("revision-") {
        return Err("Choose a valid workspace recovery revision".into());
    }
    let (_, metadata) = paths(Path::new(root))?;
    let history = history_dir(&metadata, false)?;
    let path = history.join(file_name);
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not read recovery revision: {error}"))?;
    let canonical_history = history.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.starts_with(canonical_history) || !canonical.is_file() {
        return Err("Recovery revision must remain inside workspace history".into());
    }
    let data = fs::read(canonical)
        .map_err(|error| format!("Could not read recovery revision: {error}"))?;
    let config: WorkspaceConfig =
        serde_json::from_slice(&data).map_err(|error| error.to_string())?;
    validate(&config)?;
    if content_hash(&config)? != config.content_hash {
        return Err("Recovery revision content hash is invalid".into());
    }
    Ok(config)
}

pub fn load_for_project(project_root: &Path) -> Result<Option<WorkspaceConfig>, String> {
    let Some(workspace_root) = project_root.parent() else {
        return Ok(None);
    };
    if !workspace_root.is_dir() {
        return Ok(None);
    }
    let discovery = discover(&workspace_root.to_string_lossy());
    match discovery.status.as_str() {
        "valid" => Ok(discovery.config),
        "absent" => Ok(None),
        "unavailable" => Err(discovery
            .message
            .unwrap_or_else(|| "Workspace settings are unavailable".into())),
        "unsupported" | "invalid" => Err(discovery
            .message
            .unwrap_or_else(|| "Workspace settings cannot be used".into())),
        _ => Err("Workspace settings could not be loaded".into()),
    }
}

pub fn project_id(workspace_root: &Path, project_root: &Path) -> Option<String> {
    let relative = project_root.strip_prefix(workspace_root).ok()?;
    let normalized = relative
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    Some(format!("project:{normalized}"))
}

pub fn register_project(
    root: &str,
    project_path: &str,
    name: &str,
) -> Result<WorkspaceConfig, String> {
    let canonical_root = Path::new(root)
        .canonicalize()
        .map_err(|error| format!("Workspace root is unavailable: {error}"))?;
    let canonical_project = Path::new(project_path)
        .canonicalize()
        .map_err(|error| format!("Project folder is unavailable: {error}"))?;
    if canonical_project.parent() != Some(canonical_root.as_path()) || !canonical_project.is_dir() {
        return Err("Project must be a direct child of this workspace folder".into());
    }
    let relative_path = canonical_project
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Project folder name is invalid")?
        .replace('\\', "/");
    if !valid_relative_path(&relative_path) || relative_path.eq_ignore_ascii_case(".pepper") {
        return Err("Project folder name is not valid for the shared project catalog".into());
    }
    let discovery = discover(&canonical_root.to_string_lossy());
    let mut config = discovery.config.ok_or_else(|| {
        discovery.message.unwrap_or_else(|| {
            "Workspace settings must be configured before registering projects".into()
        })
    })?;
    let id = project_id(&canonical_root, &canonical_project)
        .ok_or("Could not create project identifier")?;
    if !config
        .projects
        .iter()
        .any(|project| project.id.eq_ignore_ascii_case(&id))
    {
        config.projects.push(WorkspaceProject {
            id,
            name: name.trim().to_string(),
            relative_path,
        });
        config
            .projects
            .sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    }
    save(
        &canonical_root.to_string_lossy(),
        config.clone(),
        Some(config.revision),
        Some(&config.content_hash),
    )
}

pub fn profile_for_project<'a>(
    config: &'a WorkspaceConfig,
    project_root: &Path,
) -> Option<&'a WorkspaceProfile> {
    let workspace_root = project_root.parent()?;
    let id = project_id(workspace_root, project_root)?;
    config
        .profiles
        .iter()
        .find(|profile| {
            profile
                .project_ids
                .iter()
                .any(|project| project.eq_ignore_ascii_case(&id))
        })
}

pub fn client_type<'a>(config: &'a WorkspaceConfig, id: &str) -> Option<&'a WorkspaceClientType> {
    config
        .client_types
        .iter()
        .find(|item| item.id.eq_ignore_ascii_case(id))
}

/// Resolve the immutable routing snapshot captured when a client was created.
/// `None` means to use Pepper's established destination for legacy clients.
pub fn destination_for_client(client_path: &Path, purpose: &str) -> Result<Option<String>, String> {
	destination_for_client_in_config(client_path, purpose, None)
}

pub fn destination_for_client_in_config(
    client_path: &Path,
    purpose: &str,
    _config: Option<&WorkspaceConfig>,
) -> Result<Option<String>, String> {
	if purpose.is_empty() || purpose.eq_ignore_ascii_case("other") {
		return Ok(None);
	}
	let metadata_path = client_path.join(".pepper-client.json");
	let metadata = match fs::read(&metadata_path) {
		Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
			.map_err(|error| format!("Client routing metadata is invalid and was left unchanged: {error}"))?,
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(format!("Could not read client routing metadata: {error}")),
	};
	let Some(path) = metadata
		.get("folder_destinations")
		.and_then(|destinations| destinations.get(purpose))
		.and_then(serde_json::Value::as_str)
	else {
		// Clients predating the shared templates keep Pepper's established paths.
		return Ok(None);
	};
	if !valid_relative_path(path)
		|| path.split(['\\', '/']).any(|part| part.eq_ignore_ascii_case(".pepper"))
	{
		return Err(format!("Saved '{}' destination is unsafe; no files were moved", purpose));
	}
	Ok(Some(path.to_owned()))
}

pub fn season_support_available(project_root: &Path) -> Result<bool, String> {
    match load_for_project(project_root)? {
        Some(config) => {
            let Some(profile) = profile_for_project(&config, project_root) else {
                return Ok(false);
            };
            Ok(profile.allowed_client_type_ids.iter().any(|id| {
                client_type(&config, id)
                    .is_some_and(|item| item.features.iter().any(|feature| feature == "seasons"))
            }))
        }
        None => Ok(project_root
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("8_Mariya Meets"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starter_save_is_metadata_only_and_revision_checked() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("01_Existing project");
        fs::create_dir_all(&project).unwrap();
        let sentinel = project.join("client/01_MEDIA/source.mp4");
        fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
        fs::write(&sentinel, b"keep exactly").unwrap();
        let projects = projects_from_filesystem(temp.path()).unwrap();
        assert_eq!(projects.len(), 1);
        let root = temp.path().to_string_lossy().into_owned();
        let config = starter(&root, projects, Vec::new(), "Test workspace".into());
        validate(&config).unwrap();
        let first = save(&root, config.clone(), None, None).unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(fs::read(&sentinel).unwrap(), b"keep exactly");
        assert!(temp.path().join(".pepper/workspace.json").is_file());
        assert!(!temp.path().join("01_Existing project/.pepper").exists());

        let mut second_draft = first.clone();
        second_draft.display_name = "Renamed workspace".into();
        let second = save(
            &root,
            second_draft,
            Some(first.revision),
            Some(&first.content_hash),
        )
        .unwrap();
        assert_eq!(second.revision, 2);
        assert!(save(
            &root,
            config,
            Some(first.revision),
            Some(&first.content_hash)
        )
        .is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"keep exactly");
        assert_eq!(history(&root).unwrap().len(), 1);
    }

    #[test]
    fn validation_rejects_unsafe_folder_paths_and_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_string_lossy().into_owned();
        let mut config = starter(&root, Vec::new(), Vec::new(), "Test workspace".into());
        config.folder_templates[0]
            .folders
            .push(folder("escape", "../outside", "media", false));
        assert!(validate(&config)
            .unwrap_err()
            .contains("safe relative path"));

        let mut config = starter(&root, Vec::new(), Vec::new(), "Test workspace".into());
        config.profiles[0].default_client_type_id = "unknown".into();
        assert!(validate(&config).unwrap_err().contains("default"));
    }

    #[test]
    fn routing_is_frozen_per_client_and_legacy_clients_keep_pepper_paths() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("Legacy_SOCIAL");
        let customized = temp.path().join("Customized_SOCIAL");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&customized).unwrap();
        let config = starter(
            &temp.path().to_string_lossy(),
            Vec::new(),
            Vec::new(),
            "Test workspace".into(),
        );
        let mut edited = config.clone();
        edited.folder_templates[0].folders.iter_mut().find(|folder| folder.purpose == "video_raw").unwrap().path = "MEDIA/NEW_RAW".into();

        fs::write(
            legacy.join(".pepper-client.json"),
            br#"{"schema_version":1,"client_type":"SOCIAL"}"#,
        )
        .unwrap();
        assert_eq!(
            destination_for_client_in_config(&legacy, "video_raw", Some(&edited)).unwrap(),
            None,
            "Existing clients without a routing snapshot must retain their legacy destinations"
        );

        fs::write(
            customized.join(".pepper-client.json"),
            br#"{"schema_version":1,"client_type":"SOCIAL","folder_destinations":{"video_raw":"01_MEDIA/020_VIDEO_RAW"}}"#,
        )
        .unwrap();
        assert_eq!(
            destination_for_client_in_config(&customized, "video_raw", Some(&edited)).unwrap(),
            Some("01_MEDIA/020_VIDEO_RAW".into()),
            "Later workspace template edits must not reroute an already-created client"
        );
        assert!(destination_for_client_in_config(&customized, "video_raw", None).unwrap().is_some());

        fs::write(
            customized.join(".pepper-client.json"),
            br#"{"schema_version":1,"folder_destinations":{"video_raw":"../outside"}}"#,
        )
        .unwrap();
        assert!(destination_for_client_in_config(&customized, "video_raw", None).is_err());
    }
}
