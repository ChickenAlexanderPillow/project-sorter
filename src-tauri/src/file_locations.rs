use std::path::{Path, PathBuf};

fn containing_folder(path: &Path) -> Result<&Path, String> {
    if !path.is_absolute() {
        return Err("File location must be an absolute path".into());
    }
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "File has no containing folder".into())
}

#[cfg(windows)]
pub(crate) fn shell_folder_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    }
}

fn open_directory(path: &Path) -> Result<(), String> {
    let target = path
        .canonicalize()
        .map_err(|error| format!("Folder is unavailable: {}: {error}", path.display()))?;
    if !target.is_dir() {
        return Err(format!("Path is not a folder: {}", path.display()));
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::{w, PCWSTR};
        use windows::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

        let shell_path = shell_folder_path(&target);
        let wide: Vec<u16> = std::ffi::OsStr::new(&shell_path).encode_wide().chain(Some(0)).collect();
        // Pass the folder as a shell item, not an Explorer command line. In
        // particular, spaces and trailing backslashes must not be re-parsed.
        let result = unsafe {
            ShellExecuteW(None, w!("open"), PCWSTR(wide.as_ptr()), None, None, SW_SHOWNORMAL)
        };
        let code = result.0 as isize;
        if code <= 32 {
            return Err(format!("Windows could not open folder {shell_path} (shell error {code})"));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let status = std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" })
            .arg(&target).status().map_err(|error| format!("Could not open folder: {error}"))?;
        if status.success() { Ok(()) } else { Err(format!("Could not open folder: {}", path.display())) }
    }
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    if path.trim().is_empty() { return Err("Folder path is empty".into()); }
    open_directory(Path::new(&path))
}

#[tauri::command]
pub fn open_file_location(path: String) -> Result<(), String> {
    let file = PathBuf::from(path);
    let parent = containing_folder(&file)?;
    match selectable_file(&file)? {
        Some(target) => select_file(&target),
        // Missing media cannot be selected. Its saved folder can still help
        // the editor find a replacement; unavailable folders return an error.
        None => open_directory(parent),
    }
}

fn selectable_file(path: &Path) -> Result<Option<PathBuf>, String> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => path.canonicalize().map(Some)
            .map_err(|error| format!("File is unavailable: {}: {error}", path.display())),
        Ok(_) => Err(format!("Path is not a file: {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("File is unavailable: {}: {error}", path.display())),
    }
}

#[cfg(windows)]
fn select_file(path: &Path) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{Common::ITEMIDLIST, ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems},
    };

    struct Apartment(bool);
    impl Drop for Apartment {
        fn drop(&mut self) { if self.0 { unsafe { CoUninitialize() }; } }
    }
    struct ShellItem(*mut ITEMIDLIST);
    impl Drop for ShellItem {
        fn drop(&mut self) { unsafe { ILFree(Some(self.0)) }; }
    }

    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
        return Err(format!("Could not initialize file selection: {initialized:?}"));
    }
    let _apartment = Apartment(initialized.is_ok());
    let name = HSTRING::from(shell_folder_path(path));
    let item = unsafe { ILCreateFromPathW(PCWSTR(name.as_ptr())) };
    if item.is_null() {
        return Err(format!("Windows could not locate file: {}", path.display()));
    }
    let item = ShellItem(item);
    // With no child array, the fully qualified item is selected in its parent.
    // https://learn.microsoft.com/windows/win32/api/shlobj_core/nf-shlobj_core-shopenfolderandselectitems
    unsafe { SHOpenFolderAndSelectItems(item.0, None, 0) }
        .map_err(|error| format!("Windows could not select {}: {error}", path.display()))
}

#[cfg(not(windows))]
fn select_file(path: &Path) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path)
        .map_err(|error| format!("Could not reveal {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_can_still_have_an_existing_folder() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("not present.mp4");
        assert_eq!(containing_folder(&missing).unwrap(), temp.path());
        assert!(!missing.exists());
        assert_eq!(selectable_file(&missing).unwrap(), None);
    }

    #[test]
    fn relative_and_empty_file_locations_are_rejected() {
        assert!(containing_folder(Path::new("clip.mp4")).is_err());
        assert!(containing_folder(Path::new("")).is_err());
        assert!(open_folder(String::new()).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn preserves_roots_spaces_unicode_and_unc_names() {
        assert_eq!(containing_folder(Path::new(r"C:\clip.mp4")).unwrap(), Path::new(r"C:\"));
        assert_eq!(containing_folder(Path::new(r"\\nas\Production\Client_Name\clip.mp4")).unwrap(), Path::new(r"\\nas\Production\Client_Name"));
        assert_eq!(shell_folder_path(Path::new(r"\\?\Z:\The Huddle\Client_Name")), r"Z:\The Huddle\Client_Name");
        assert_eq!(shell_folder_path(Path::new(r"\\?\UNC\nas\Production\Client Name")), r"\\nas\Production\Client Name");
        assert_eq!(shell_folder_path(Path::new("C:\\Users\\Editor\\Caf\u{e9}")), "C:\\Users\\Editor\\Caf\u{e9}");
    }

    #[test]
    fn unavailable_folder_returns_an_error_without_opening_a_default_folder() {
        let temp = tempfile::tempdir().unwrap();
        assert!(open_directory(&temp.path().join("missing folder")).is_err());
    }

    #[test]
    fn existing_file_is_selected_rather_than_opening_only_its_parent() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("Clip with spaces (1).mp4");
        std::fs::write(&file, b"media").unwrap();
        assert_eq!(selectable_file(&file).unwrap(), Some(file.canonicalize().unwrap()));
        assert!(selectable_file(temp.path()).is_err());
    }
}
