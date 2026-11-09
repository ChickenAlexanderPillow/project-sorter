//! Native file-reference dragging. Only paths are offered; no media is copied.
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

static DRAGGING: AtomicBool = AtomicBool::new(false);
struct DragGuard;
impl Drop for DragGuard {
    fn drop(&mut self) {
        DRAGGING.store(false, Ordering::Release);
    }
}

fn validate_paths(client: &Path, paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() || paths.len() > 2000 || !client.is_absolute() {
        return Err("Choose between 1 and 2,000 client files.".into());
    }
    let root = client
        .canonicalize()
        .map_err(|e| format!("Client folder unavailable: {e}"))?;
    let roots: Vec<PathBuf> = [
        "01_MEDIA/010_VIDEO_PROXY",
        "01_MEDIA/020_VIDEO_RAW",
        "01_MEDIA/030_AUDIO_CLEAN",
        "01_MEDIA/040_AUDIO_RAW",
        "01_MEDIA/050_STILLS",
        "01_MEDIA/060_MUSIC",
        "01_MEDIA/070_GRAPHICS",
        "01_MEDIA/090_STOCK",
        "02_EDIT",
    ]
    .iter()
    .filter_map(|dir| client.join(dir).canonicalize().ok())
    .filter(|dir| dir.starts_with(&root))
    .collect();
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for original in paths {
        if original.contains('\0') {
            return Err("Invalid file path.".into());
        }
        let path = Path::new(&original);
        let project = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| {
                matches!(
                    s.to_ascii_lowercase().as_str(),
                    "prproj" | "aep" | "aepx" | "drp" | "sesx" | "blend"
                )
            })
            .unwrap_or(false);
        if !path.is_absolute() || (!project && crate::media_browser::media_kind(path).is_none()) {
            return Err("Only media and editing projects can be dragged.".into());
        }
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("{} is unavailable: {e}", path.display()))?;
        if !canonical.is_file() || !roots.iter().any(|root| canonical.starts_with(root)) {
            return Err("The file is outside this client's media and Edit folders.".into());
        }
        // Canonical paths are for validation only. Preserve mapped drives and
        // original UNC spelling in Premiere's reference.
        #[cfg(windows)]
        let original = crate::file_locations::shell_folder_path(Path::new(&original));
        if seen.insert(original.to_lowercase()) {
            result.push(original);
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn client_files_start_drag(
    app: tauri::AppHandle,
    client_path: String,
    paths: Vec<String>,
) -> Result<String, String> {
    DRAGGING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "A file drag is already in progress.".to_string())?;
    let guard = DragGuard;
    // NAS metadata access can stall during disconnection. Keep it off the UI
    // thread and bound how long a gesture waits before reporting an error.
    let validation = tauri::async_runtime::spawn_blocking(move || {
        validate_paths(Path::new(&client_path), paths)
    });
    let paths = tokio::time::timeout(std::time::Duration::from_secs(5), validation)
        .await
        .map_err(|_| "The media folder did not respond. Check the NAS connection.".to_string())?
        .map_err(|e| e.to_string())??;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _guard = guard;
        #[cfg(windows)]
        let result = native::start(paths).map_err(|e| format!("Could not drag these files: {e}"));
        #[cfg(not(windows))]
        let result: Result<String, String> = {
            let _ = paths;
            Err("Native file dragging is currently available on Windows.".into())
        };
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[cfg(windows)]
mod native {
    use std::{
        mem::{size_of, ManuallyDrop},
        ptr,
    };
    use windows::{
        core::*,
        Win32::{
            Foundation::*,
            System::{
                Com::*,
                Memory::*,
                Ole::*,
                SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
            },
            UI::{
                Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
                Shell::{SHCreateStdEnumFmtEtc, DROPFILES},
                WindowsAndMessaging::{GetCursorPos, GetWindowThreadProcessId, WindowFromPoint},
            },
        },
    };

    #[implement(IDataObject)]
    struct FileReferences {
        paths: Vec<u16>,
    }
    fn format() -> FORMATETC {
        FORMATETC {
            cfFormat: CF_HDROP.0,
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
            ..Default::default()
        }
    }
    fn check(value: *const FORMATETC) -> HRESULT {
        let Some(value) = (unsafe { value.as_ref() }) else {
            return E_POINTER;
        };
        if value.cfFormat != CF_HDROP.0 {
            return DV_E_FORMATETC;
        }
        if value.dwAspect != DVASPECT_CONTENT.0 {
            return DV_E_DVASPECT;
        }
        if value.lindex != -1 {
            return DV_E_LINDEX;
        }
        if value.tymed & TYMED_HGLOBAL.0 as u32 == 0 {
            return DV_E_TYMED;
        }
        S_OK
    }
    pub(super) fn encode_paths(paths: &[String]) -> Vec<u16> {
        paths
            .iter()
            .flat_map(|path| path.encode_utf16().chain([0]))
            .chain([0])
            .collect()
    }
    #[allow(non_snake_case)]
    impl IDataObject_Impl for FileReferences_Impl {
        fn GetData(&self, requested: *const FORMATETC) -> Result<STGMEDIUM> {
            check(requested).ok()?;
            let bytes = size_of::<DROPFILES>() + self.paths.len() * size_of::<u16>();
            unsafe {
                let handle = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes)?;
                let address = GlobalLock(handle);
                if address.is_null() {
                    let _ = GlobalFree(Some(handle));
                    return Err(Error::from_win32());
                }
                ptr::write(
                    address.cast::<DROPFILES>(),
                    DROPFILES {
                        pFiles: size_of::<DROPFILES>() as u32,
                        fWide: true.into(),
                        ..Default::default()
                    },
                );
                ptr::copy_nonoverlapping(
                    self.paths.as_ptr(),
                    address
                        .cast::<u8>()
                        .add(size_of::<DROPFILES>())
                        .cast::<u16>(),
                    self.paths.len(),
                );
                let _ = GlobalUnlock(handle);
                // Ownership passes to the recipient, which calls ReleaseStgMedium.
                Ok(STGMEDIUM {
                    tymed: TYMED_HGLOBAL.0 as u32,
                    u: STGMEDIUM_0 { hGlobal: handle },
                    pUnkForRelease: ManuallyDrop::new(None),
                })
            }
        }
        fn QueryGetData(&self, value: *const FORMATETC) -> HRESULT {
            check(value)
        }
        fn EnumFormatEtc(&self, direction: u32) -> Result<IEnumFORMATETC> {
            if direction != DATADIR_GET.0 as u32 {
                return Err(E_NOTIMPL.into());
            }
            unsafe { SHCreateStdEnumFmtEtc(&[format()]) }
        }
        fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> Result<()> {
            Err(DV_E_FORMATETC.into())
        }
        fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, output: *mut FORMATETC) -> HRESULT {
            if output.is_null() {
                return E_POINTER;
            }
            unsafe {
                (*output).ptd = ptr::null_mut();
            }
            E_NOTIMPL
        }
        fn SetData(&self, _: *const FORMATETC, _: *const STGMEDIUM, _: BOOL) -> Result<()> {
            Err(E_NOTIMPL.into())
        }
        fn DAdvise(&self, _: *const FORMATETC, _: u32, _: Ref<'_, IAdviseSink>) -> Result<u32> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }
        fn DUnadvise(&self, _: u32) -> Result<()> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }
        fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }
    }

    #[implement(IDropSource)]
    struct FileDrag;
    #[allow(non_snake_case)]
    impl IDropSource_Impl for FileDrag_Impl {
        fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
            if escape.as_bool() {
                return DRAGDROP_S_CANCEL;
            }
            if keys & MK_LBUTTON == MODIFIERKEYS_FLAGS(0) {
                // Dropping back onto Pepper must never re-ingest or reassign.
                let mut point = POINT::default();
                let mut pid = 0;
                unsafe {
                    if GetCursorPos(&mut point).is_err() {
                        return DRAGDROP_S_CANCEL;
                    }
                    GetWindowThreadProcessId(WindowFromPoint(point), Some(&mut pid));
                }
                return if pid == std::process::id() {
                    DRAGDROP_S_CANCEL
                } else {
                    DRAGDROP_S_DROP
                };
            }
            S_OK
        }
        fn GiveFeedback(&self, _: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }
    struct OleGuard;
    impl Drop for OleGuard {
        fn drop(&mut self) {
            unsafe {
                OleUninitialize();
            }
        }
    }
    pub(super) fn start(paths: Vec<String>) -> Result<String> {
        unsafe {
            // An IPC/SMB delay must not turn a released gesture into a new drop.
            if GetAsyncKeyState(VK_LBUTTON.0 as i32) >= 0 {
                return Ok("cancelled".into());
            }
            OleInitialize(None)?;
            let _ole = OleGuard;
            let data: IDataObject = FileReferences {
                paths: encode_paths(&paths),
            }
            .into();
            let source: IDropSource = FileDrag.into();
            let mut effect = DROPEFFECT_NONE;
            // This negotiates a non-destructive drag. No filesystem copy occurs
            // here; Premiere receives CF_HDROP and imports the existing paths.
            let result = DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect);
            if result == DRAGDROP_S_CANCEL {
                return Ok("cancelled".into());
            }
            result.ok()?;
            Ok(if effect == DROPEFFECT_NONE {
                "cancelled"
            } else {
                "dropped"
            }
            .into())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn data_object_advertises_and_round_trips_unicode_network_references() {
            let paths = vec![
                r"Z:\The Huddle\Client\音声.wav".into(),
                r"\\NASPLUS\Vault\Client\Camera A.mp4".into(),
                format!(r"Z:\{}\long.mp4", "folder\\".repeat(60)),
            ];
            let object: IDataObject = FileReferences {
                paths: encode_paths(&paths),
            }
            .into();
            unsafe {
                object.QueryGetData(&format()).ok().unwrap();
                let enumerator = object.EnumFormatEtc(DATADIR_GET.0 as u32).unwrap();
                let mut entries = [FORMATETC::default()];
                enumerator.Next(&mut entries, None).ok().unwrap();
                assert_eq!(entries[0].cfFormat, CF_HDROP.0);
                for _ in 0..2 {
                    let mut medium = object.GetData(&format()).unwrap();
                    let address = GlobalLock(medium.u.hGlobal);
                    let header = &*address.cast::<DROPFILES>();
                    assert!(header.fWide.as_bool());
                    let words = std::slice::from_raw_parts(
                        address
                            .cast::<u8>()
                            .add(header.pFiles as usize)
                            .cast::<u16>(),
                        encode_paths(&paths).len(),
                    );
                    assert_eq!(words, encode_paths(&paths));
                    let _ = GlobalUnlock(medium.u.hGlobal);
                    ReleaseStgMedium(&mut medium);
                }
                let mut unsupported = format();
                unsupported.cfFormat = 1;
                assert!(object.GetData(&unsupported).is_err());
                assert!(object.GetData(ptr::null()).is_err());
                assert_eq!(object.QueryGetData(&unsupported), DV_E_FORMATETC);
            }
        }
        #[test]
        fn a_released_gesture_cannot_start_a_drag() {
            if unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } >= 0 {
                assert_eq!(start(vec![r"Z:\missing.mp4".into()]).unwrap(), "cancelled");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_rejects_missing_outside_and_nonmedia_files() {
        let temp = tempfile::tempdir().unwrap();
        let client = temp.path().join("client");
        std::fs::create_dir_all(client.join("01_MEDIA/040_AUDIO_RAW")).unwrap();
        let file = client.join("01_MEDIA/040_AUDIO_RAW/REC.wav");
        std::fs::write(&file, b"fixture").unwrap();
        let path = file.to_string_lossy().to_string();
        assert_eq!(
            validate_paths(&client, vec![path.clone(), path.clone()])
                .unwrap()
                .len(),
            1
        );
        assert!(validate_paths(&client, vec![]).is_err());
        assert!(validate_paths(&client, vec!["relative.wav".into()]).is_err());
        assert!(validate_paths(
            &client,
            vec![client.join("missing.wav").to_string_lossy().into()]
        )
        .is_err());
        let outside = temp.path().join("outside.wav");
        std::fs::write(&outside, b"outside").unwrap();
        assert!(validate_paths(&client, vec![outside.to_string_lossy().into()]).is_err());
        let exe = file.with_extension("exe");
        std::fs::write(&exe, b"exe").unwrap();
        assert!(validate_paths(&client, vec![exe.to_string_lossy().into()]).is_err());
        assert_eq!(std::fs::read(file).unwrap(), b"fixture");
    }
}
