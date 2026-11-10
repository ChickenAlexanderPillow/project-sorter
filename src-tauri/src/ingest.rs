//! Durable, source-preserving media collection for Pepper's ingest workspace.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}};
use uuid::Uuid;
#[path = "recording_metadata.rs"]
mod recording_metadata;
pub(crate) use recording_metadata::RecordingMetadata;

// Client browsing is read-only. Retained ingest evidence is used only when the
// current file still matches its hash; otherwise only embedded dates are read.
pub(crate) fn client_recording_metadata(root: &Path, paths: &[PathBuf]) -> Vec<(String, Option<RecordingMetadata>)> {
    let evidence = fs::metadata(manifest_path(root)).ok().filter(|m|m.len()<=64*1024*1024)
        .and_then(|_|fs::read(manifest_path(root)).ok())
        .and_then(|bytes|serde_json::from_slice::<Manifest>(&bytes).ok()).unwrap_or_default();
    let mut known = std::collections::HashMap::new();
    for file in &evidence.files {
        if let Some(metadata)=&file.recording_metadata {
            for path in file.destinations.iter().chain(std::iter::once(&file.inbox_path)) {
                known.insert(normalized_path(Path::new(path)),(file,metadata));
            }
        }
    }
    std::thread::scope(|scope| {
        let handles:Vec<_> = paths.chunks((paths.len().max(1)+3)/4).map(|chunk| {
            let known=&known;
            scope.spawn(move || chunk.iter().map(|path| {
                let read=|| {
                    let before=fs::metadata(path).ok()?;
                    let retained=known.get(&normalized_path(path)).filter(|(file,_)|file.size==before.len())
                        .filter(|(file,_)|hash(path).ok().as_deref()==Some(file.sha256.as_str()));
                    let metadata=retained.map(|(file,metadata)|{
                        let mut metadata=(*metadata).clone();
                        if metadata.warning.is_none() && metadata.start_source.as_deref().is_some_and(|s|s.starts_with("filesystem_")) {
                            metadata.warning=file.timestamp_warning.clone();
                        }
                        metadata
                    })
                        .unwrap_or_else(||recording_metadata::read(path,None,None,||Ok(())));
                    let after=fs::metadata(path).ok()?;
                    (before.len()==after.len() && before.modified().ok()==after.modified().ok()).then_some(metadata)
                };
                (path.to_string_lossy().into_owned(),read())
            }).collect::<Vec<_>>())
        }).collect();
        handles.into_iter().flat_map(|handle|handle.join().unwrap_or_default()).collect()
    })
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Manifest {
    pub schema_version: u32,
    pub files: Vec<IngestFile>,
    #[serde(default)]
    pub reviewed_groups: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct IngestFile {
    pub id: String,
    #[serde(default)]
    pub batch_id: String,
    #[serde(default)]
    pub collected_at: Option<String>,
    #[serde(default)]
    pub newly_collected: bool,
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub source_name: String,
    pub relative_path: String,
    pub inbox_path: String,
    pub role: String,
    pub size: u64,
    pub sha256: String,
    pub source_modified: Option<String>,
    pub source_created: Option<String>,
    pub timestamp_warning: Option<String>,
    #[serde(default)]
    pub recording_metadata: Option<RecordingMetadata>,
    pub status: String,
    #[serde(default)]
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub client: Option<String>,
    #[serde(default)]
    pub clients: Vec<String>,
    #[serde(default)]
    pub client_paths: Vec<String>,
    #[serde(default)]
    pub destinations: Vec<String>,
    #[serde(default)]
    pub duplicate_of: Option<String>,
    #[serde(default)]
    pub counterpart_id: Option<String>,
}

struct WriterLease { path: PathBuf, last_heartbeat: std::cell::Cell<std::time::Instant> }
impl WriterLease { fn heartbeat(&self)->Result<(),String>{if self.last_heartbeat.get().elapsed()<std::time::Duration::from_secs(10){return Ok(());}filetime::set_file_mtime(&self.path,filetime::FileTime::from_system_time(std::time::SystemTime::now())).map_err(|e|e.to_string())?;self.last_heartbeat.set(std::time::Instant::now());Ok(())} }
impl Drop for WriterLease { fn drop(&mut self) { let _ = fs::remove_file(&self.path); } }
fn acquire_lease(root: &Path) -> Result<WriterLease, String> {
    let dir = root.join("_INGEST/state"); fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    let path=dir.join("writer.lock");
    let mut f=fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e|format!("Ingest is locked by another writer ({}): {e}",path.display()))?;
    let machine=std::env::var("COMPUTERNAME").unwrap_or_else(|_|"unknown".into());let owner=format!("machine={machine}\npid={}\nstarted={}\n",std::process::id(),chrono::Utc::now().to_rfc3339());
    use std::io::Write; f.write_all(owner.as_bytes()).map_err(|e|e.to_string())?; f.sync_all().map_err(|e|e.to_string())?;
    Ok(WriterLease{path,last_heartbeat:std::cell::Cell::new(std::time::Instant::now())})
}

fn manifest_path(root: &Path) -> PathBuf { root.join("_INGEST/state/manifest.json") }
fn valid_client_name(name:&str)->bool{let mut parts=Path::new(name).components();matches!(parts.next(),Some(std::path::Component::Normal(_)))&&parts.next().is_none()}
fn valid_client_path(name:&str)->bool{let path=Path::new(name);!path.is_absolute()&&path.components().all(|c|matches!(c,std::path::Component::Normal(_)))&&!name.split(['\\','/']).any(|c|c.is_empty()||c=="_INGEST")}
fn read_manifest(root: &Path) -> Result<Manifest, String> {
    let path = manifest_path(root);
    if !path.exists() { let backup=path.with_extension("json.bak");if backup.exists(){let state:Manifest=serde_json::from_slice(&fs::read(&backup).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;let _=atomic_replace(&backup,&path);return Ok(state);}return Ok(Manifest { schema_version: 1, ..Default::default() }); }
    let bytes=fs::read(&path).map_err(|e|e.to_string())?;
    match serde_json::from_slice(&bytes){Ok(state)=>Ok(state),Err(primary)=>{let backup=path.with_extension("json.bak");if !backup.exists(){return Err(format!("Ingest manifest is invalid and no previous state is available: {primary}"));}let state:Manifest=serde_json::from_slice(&fs::read(&backup).map_err(|e|e.to_string())?).map_err(|backup_error|format!("Current and backup ingest manifests are invalid: {primary}; {backup_error}"))?;atomic_replace(&backup,&path)?;Ok(state)}}
}
fn write_manifest(root: &Path, state: &Manifest) -> Result<(), String> {
    let path = manifest_path(root);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut f = fs::File::create(&temp).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut f, state).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f); // SMB must see a closed, flushed file before it is renamed.
    if path.exists() { fs::copy(&path,path.with_extension("json.bak")).map_err(|e|e.to_string())?; }
    atomic_replace(&temp,&path)
}
fn append_journal(root:&Path,event:serde_json::Value)->Result<(),String>{let mut file=fs::OpenOptions::new().create(true).append(true).open(root.join("_INGEST/state/journal.jsonl")).map_err(|e|e.to_string())?;serde_json::to_writer(&mut file,&event).map_err(|e|e.to_string())?;file.write_all(b"\n").map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())}
#[cfg(windows)]
fn atomic_replace_once(from:&Path,to:&Path)->std::io::Result<()>{
    use std::os::windows::ffi::OsStrExt;
    let from:Vec<u16>=from.as_os_str().encode_wide().chain(Some(0)).collect();let to:Vec<u16>=to.as_os_str().encode_wide().chain(Some(0)).collect();
    #[link(name="kernel32")] unsafe extern "system" {fn MoveFileExW(existing:*const u16,new:*const u16,flags:u32)->i32;}
    const REPLACE:u32=0x1;const WRITE_THROUGH:u32=0x8;
    let ok=unsafe{MoveFileExW(from.as_ptr(),to.as_ptr(),REPLACE|WRITE_THROUGH)};
    if ok==0{Err(std::io::Error::last_os_error())}else{Ok(())}
}

fn atomic_replace(from:&Path,to:&Path)->Result<(),String>{
    retry_state_io(||atomic_replace_once(from,to))
        .map_err(|e|format!("Could not replace ingest state {} with {}: {e}",to.display(),from.display()))
}

// Readers on Windows/SMB can briefly deny rename/delete sharing. Never retry the
// media copy itself here, or turn a persistent permissions problem into success.
fn retry_state_io<T>(mut operation:impl FnMut()->std::io::Result<T>)->std::io::Result<T>{
    for attempt in 0..6 {
        match operation(){
            Err(error) if cfg!(windows)&&matches!(error.raw_os_error(),Some(5|32|33))&&attempt<5=>{
                std::thread::sleep(std::time::Duration::from_millis(50*(1<<attempt)));
            }
            result=>return result,
        }
    }
    unreachable!()
}
#[cfg(not(windows))]
fn atomic_replace_once(from:&Path,to:&Path)->std::io::Result<()>{fs::rename(from,to)}
fn hash(path: &Path) -> Result<String, String> { hash_with_lease(path, None) }
fn hash_with_lease(path: &Path, lease: Option<&WriterLease>) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new(); let mut buf = [0u8; 1024*1024];
    loop { let n = f.read(&mut buf).map_err(|e| e.to_string())?; if n == 0 { break; } h.update(&buf[..n]); if let Some(lease)=lease { lease.heartbeat()?; } }
    Ok(format!("{:x}", h.finalize()))
}
fn timestamp_ns(time:std::time::SystemTime)->Option<String>{time.duration_since(std::time::UNIX_EPOCH).ok().map(|d|d.as_nanos().to_string())}
fn time_from_ns(raw:&str)->Option<std::time::SystemTime>{let ns=raw.parse::<u128>().ok()?;let secs=u64::try_from(ns/1_000_000_000).ok()?;let nanos=(ns%1_000_000_000)as u32;Some(std::time::UNIX_EPOCH+std::time::Duration::new(secs,nanos))}
#[cfg(windows)]
fn preserve_creation_time(path:&Path,time:Option<std::time::SystemTime>)->Option<String>{
    use std::os::windows::{fs::OpenOptionsExt,io::AsRawHandle};
    #[repr(C)]struct FileTime{low:u32,high:u32}
    #[link(name="kernel32")]unsafe extern "system"{fn SetFileTime(file:*mut std::ffi::c_void,creation:*const FileTime,access:*const FileTime,write:*const FileTime)->i32;}
    let Some(time)=time else{return Some("Source creation time is unavailable".into())};
    let ticks=match time.duration_since(std::time::UNIX_EPOCH){Ok(d)=>(d.as_nanos()/100) as u64+116_444_736_000_000_000,Err(_)=>return Some("Source creation time predates the Windows file-time epoch".into())};let ft=FileTime{low:ticks as u32,high:(ticks>>32)as u32};
    let file=match fs::OpenOptions::new().write(true).custom_flags(0x0200_0000).open(path){Ok(f)=>f,Err(e)=>return Some(format!("Could not open copy to preserve creation time: {e}"))};
    if unsafe{SetFileTime(file.as_raw_handle() as *mut _,&ft,std::ptr::null(),std::ptr::null())}==0{Some(format!("Could not preserve source creation time: {}",std::io::Error::last_os_error()))}else{None}
}
#[cfg(not(windows))]
fn preserve_creation_time(_path:&Path,time:Option<std::time::SystemTime>)->Option<String>{if time.is_some(){Some("Destination filesystem creation time could not be set; original value is retained in the manifest".into())}else{Some("Source creation time is unavailable".into())}}
fn copy_with_heartbeat(source:&Path,dest:&Path,lease:&WriterLease)->Result<(),String>{
    let mut input=fs::File::open(source).map_err(|e|e.to_string())?;let mut output=fs::File::create(dest).map_err(|e|e.to_string())?;
    let mut buf=[0u8;1024*1024];loop{let n=input.read(&mut buf).map_err(|e|e.to_string())?;if n==0{break;}output.write_all(&buf[..n]).map_err(|e|e.to_string())?;lease.heartbeat()?;}output.sync_all().map_err(|e|e.to_string())
}
fn is_ingest_temporary(path:&Path)->bool{if path.extension().and_then(|x|x.to_str())!=Some("partial"){return false;}path.file_stem().and_then(|x|x.to_str()).and_then(|s|s.rsplit_once('.').map(|(_,id)|id.to_string())).and_then(|id|Uuid::parse_str(&id).ok()).is_some()}
#[cfg(windows)]
fn available_space(path:&Path)->Result<u64,String>{
 use std::os::windows::ffi::OsStrExt;let text:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();let mut free=0u64;
 #[link(name="kernel32")]unsafe extern "system"{fn GetDiskFreeSpaceExW(path:*const u16,available:*mut u64,total:*mut u64,total_free:*mut u64)->i32;}
 if unsafe{GetDiskFreeSpaceExW(text.as_ptr(),&mut free,std::ptr::null_mut(),std::ptr::null_mut())}==0{Err(std::io::Error::last_os_error().to_string())}else{Ok(free)}
}
#[cfg(unix)]
fn available_space(path:&Path)->Result<u64,String>{
 use std::os::unix::ffi::OsStrExt;let c=std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e|e.to_string())?;let mut stat:libc::statvfs=unsafe{std::mem::zeroed()};if unsafe{libc::statvfs(c.as_ptr(),&mut stat)}!=0{return Err(std::io::Error::last_os_error().to_string())}Ok(stat.f_bavail as u64*stat.f_frsize as u64)
}

#[derive(Serialize)]
pub struct LeaseStatus{locked:bool,owner:Option<String>,stale:bool}
#[derive(Serialize,Deserialize,Clone)]
pub struct IngestProgress{pub project_root:String,pub phase:String,pub source:String,pub completed:usize,pub total:usize,pub updated_at:String}
fn write_progress(root:&Path,phase:&str,source:&str,completed:usize,total:usize)->Result<(),String>{
    let path=root.join("_INGEST/state/progress.json");
    let temp=path.with_extension(format!("{}.tmp",Uuid::new_v4()));
    let progress=IngestProgress{project_root:root.to_string_lossy().into_owned(),phase:phase.into(),source:source.into(),completed,total,updated_at:chrono::Utc::now().to_rfc3339()};
    let result=(||{
        let mut file=fs::File::create(&temp).map_err(|e|e.to_string())?;
        serde_json::to_writer(&mut file,&progress).map_err(|e|e.to_string())?;
        file.sync_all().map_err(|e|e.to_string())?;
        drop(file);
        atomic_replace_once(&temp,&path).map_err(|e|e.to_string())
    })();
    if result.is_err(){let _=fs::remove_file(&temp);}
    result.map_err(|e|format!("Could not update ingest progress at {} while {phase} {source}: {e}",path.display()))
}
// Progress is a display hint, not a commit record. A reader/scanner holding this
// sidecar must not stop collection or filing. The next update will try again.
fn report_progress(root:&Path,phase:&str,source:&str,completed:usize,total:usize){
    if let Err(error)=write_progress(root,phase,source,completed,total){
        let _=append_journal(root,serde_json::json!({"action":"progress_update_deferred","at":chrono::Utc::now().to_rfc3339(),"error":error}));
    }
}
#[tauri::command]
pub fn ingest_progress(project_root:String)->Result<Option<IngestProgress>,String>{let path=PathBuf::from(project_root).join("_INGEST/state/progress.json");if !path.exists(){return Ok(None)}serde_json::from_slice(&fs::read(path).map_err(|e|e.to_string())?).map(Some).map_err(|e|e.to_string())}
#[derive(Serialize)]
pub struct SourceAvailability{pub source:String,pub available:bool}
#[tauri::command]
pub fn ingest_source_availability(project_root:String)->Result<Vec<SourceAvailability>,String>{let root=PathBuf::from(project_root);let manifest=read_manifest(&root)?;let mut sources:Vec<String>=manifest.files.iter().map(|f|f.source.clone()).collect();sources.sort();sources.dedup();Ok(sources.into_iter().map(|source|SourceAvailability{available:Path::new(&source).exists(),source}).collect())}
#[derive(Serialize)]
pub struct FilingPreview{pub file_id:String,pub name:String,pub role:String,pub client:String,pub destination:String,pub collision:bool,pub issue:Option<String>}
fn role_destination(role:&str)->Option<&'static str>{match role{"Proxy video"=>Some("01_MEDIA/010_VIDEO_PROXY"),"Full-resolution video"=>Some("01_MEDIA/020_VIDEO_RAW"),"Raw audio"=>Some("01_MEDIA/040_AUDIO_RAW"),"Clean audio"=>Some("01_MEDIA/030_AUDIO_CLEAN"),"Music"=>Some("01_MEDIA/060_MUSIC"),"Stills"=>Some("01_MEDIA/050_STILLS"),"Graphics"=>Some("01_MEDIA/070_GRAPHICS"),"Miscellaneous"=>Some("01_MEDIA/080_MISCELLANEOUS"),"Stock"=>Some("01_MEDIA/090_STOCK"),_=>None}}

fn normalized_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('/', "\\");
    if let Some(unc) = normalized.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}").to_lowercase()
    } else {
        normalized.strip_prefix(r"\\?\").unwrap_or(&normalized).to_lowercase()
    }
}

/// Read-only lookup used by Project Health to recognize a verified copy in
/// this client's standard NAS media folder. It never repairs or writes ingest state.
pub fn filed_media_copies(project_root: &Path, client_relative: &str) -> std::collections::HashMap<String, PathBuf> {
    const MAX_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;
    let mut copies = std::collections::HashMap::new();
    let path = manifest_path(project_root);
    let Ok(metadata) = fs::metadata(&path) else { return copies };
    if metadata.len() > MAX_MANIFEST_BYTES { return copies; }
    let Ok(bytes) = fs::read(path) else { return copies };
    let Ok(manifest) = serde_json::from_slice::<Manifest>(&bytes) else { return copies };
    let client_relative = client_relative.replace('/', "\\").trim_matches('\\').to_lowercase();
    if !valid_client_path(&client_relative) { return copies; }
    for file in manifest.files.iter().filter(|file| file.status == "Filed" && file.client_paths.len() == 1) {
        if file.client_paths[0].replace('/', "\\").trim_matches('\\').to_lowercase() != client_relative || file.destinations.len() != 1 {
            continue;
        }
        let destination_name = Path::new(&file.destinations[0]).file_name();
        let Some(destination_name) = destination_name.filter(|name| matches!(name.to_string_lossy().as_ref(), value if !value.is_empty() && value != "." && value != "..")) else { continue };
        let Some(role_dir) = role_destination(&file.role) else { continue };
        let destination = project_root.join(client_relative_path(&file.client_paths[0])).join(role_dir).join(destination_name);
        let Ok(destination_metadata) = fs::metadata(&destination) else { continue };
        if !destination_metadata.is_file() || destination_metadata.len() != file.size { continue; }
        let source = Path::new(&file.source);
        let source_path = if source.file_name().is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(&file.name))
            && Path::new(&file.relative_path).components().count() == 1 {
            source.to_path_buf()
        } else {
            source.join(&file.relative_path)
        };
        copies.insert(normalized_path(&source_path), destination);
    }
    copies
}

fn client_relative_path(path: &str) -> PathBuf {
    path.split(['\\', '/']).filter(|part| !part.is_empty()).collect()
}
#[tauri::command]
pub async fn ingest_preview_filing(project_root:String,eligible_client_paths:Option<Vec<String>>)->Result<Vec<FilingPreview>,String>{
 tauri::async_runtime::spawn_blocking(move||preview_filing_sync(project_root,eligible_client_paths)).await.map_err(|error|error.to_string())?
}
fn preview_filing_sync(project_root:String,eligible_client_paths:Option<Vec<String>>)->Result<Vec<FilingPreview>,String>{
 let root=PathBuf::from(project_root);let state=read_manifest(&root)?;let mut used=std::collections::HashSet::new();let mut rows=Vec::new();
 for f in state.files.iter().filter(|f|f.status=="Verified") {let mut clients=f.clients.clone();if clients.is_empty(){if let Some(c)=f.client.clone(){clients.push(c)}}let role=role_destination(&f.role);
  if !f.client_paths.is_empty()&&f.client_paths.len()!=clients.len(){return Err(format!("Client destination metadata is inconsistent for {}",f.name));}
  let mut targets:Vec<(String,String)>=clients.into_iter().enumerate().map(|(i,c)|(c.clone(),f.client_paths.get(i).cloned().unwrap_or(c))).collect();targets.sort_by(|a,b|a.1.cmp(&b.1));targets.dedup_by(|a,b|a.1==b.1);
  for (client,relative) in targets{if eligible_client_paths.as_ref().is_some_and(|paths|!paths.contains(&relative)){continue;}let mut issue=if role.is_none(){Some(format!("Choose a role and destination for {}",f.name))}else{None};let source=PathBuf::from(&f.inbox_path);let base=root.join(&relative);if client=="_INGEST"||!valid_client_name(&client)||!valid_client_path(&relative)||!base.is_dir(){issue=Some(format!("Client is unavailable or invalid: {client}"));}
   let mut destination=base.join(role.unwrap_or("01_MEDIA/080_MISCELLANEOUS")).join(&f.name);if issue.is_none()&&!destination.parent().unwrap().is_dir(){issue=Some(format!("Destination folder is missing for {client}"));}
   if issue.is_none()&&(!source.is_file()||hash(&source).ok().as_deref()!=Some(f.sha256.as_str())){issue=Some("Verified inbox copy is missing or changed".into());}
   let mut collision=false;let mut n=1;
   loop{let already_used=used.contains(&destination.to_string_lossy().to_string());let same=destination.exists()&&hash(&destination).ok().as_deref()==Some(f.sha256.as_str());if (!destination.exists()||same)&&!already_used{break;}collision=true;let stem=Path::new(&f.name).file_stem().unwrap_or_default().to_string_lossy();let ext=Path::new(&f.name).extension().and_then(|x|x.to_str()).unwrap_or("");let suffix=if ext.is_empty(){String::new()}else{format!(".{ext}")};destination=base.join(role.unwrap_or("01_MEDIA/080_MISCELLANEOUS")).join(format!("{stem} (Ingest {n}){suffix}"));n+=1;}
   if destination.to_string_lossy().encode_utf16().count()>32760{issue=Some("Destination path exceeds the Windows path limit".into());}
   if issue.is_none(){used.insert(destination.to_string_lossy().into_owned());}
   rows.push(FilingPreview{file_id:f.id.clone(),name:f.name.clone(),role:f.role.clone(),client:client.clone(),destination:destination.to_string_lossy().into_owned(),collision,issue});
  }
 }
 Ok(rows)
}
#[tauri::command]
pub fn ingest_lease_status(project_root:String)->LeaseStatus{
 let path=PathBuf::from(project_root).join("_INGEST/state/writer.lock");if !path.exists(){return LeaseStatus{locked:false,owner:None,stale:false}}
 let owner=fs::read_to_string(&path).ok();let stale=fs::metadata(&path).ok().and_then(|m|m.modified().ok()).and_then(|t|t.elapsed().ok()).map(|e|e>std::time::Duration::from_secs(180)).unwrap_or(false);
 LeaseStatus{locked:true,owner,stale}
}
#[tauri::command]
pub fn ingest_recover_stale_lease(project_root:String)->Result<(),String>{
 let root=PathBuf::from(project_root);let path=root.join("_INGEST/state/writer.lock");let age=fs::metadata(&path).and_then(|m|m.modified()).and_then(|t|t.elapsed().map_err(std::io::Error::other)).map_err(|e|e.to_string())?;
 if age<std::time::Duration::from_secs(180){return Err("Writer lease heartbeat is recent; recovery is not available yet".into());}
 let claimed=path.with_file_name(format!("writer.recovered.{}.lock",Uuid::new_v4()));fs::rename(&path,&claimed).map_err(|e|format!("Lease changed during recovery; retry: {e}"))?;
 fs::remove_file(&claimed).map_err(|e|e.to_string())?;
 let journal_path=root.join("_INGEST/state/journal.jsonl");let mut pending=std::collections::HashSet::new();
 if let Ok(contents)=fs::read_to_string(&journal_path){for line in contents.lines(){if let Ok(value)=serde_json::from_str::<serde_json::Value>(line){let path=value.get("temp_path").and_then(|v|v.as_str()).map(PathBuf::from);match value.get("action").and_then(|v|v.as_str()){Some("transfer_started")=>if let Some(p)=path{pending.insert(p);},Some("transfer_completed")=>if let Some(p)=path{pending.remove(&p);},_=>{}}}}}
 let canonical_root=root.canonicalize().map_err(|e|e.to_string())?;for temp in pending{if !is_ingest_temporary(&temp){continue;}if let (Ok(parent),Ok(candidate))=(temp.parent().unwrap_or(Path::new(".")).canonicalize(),temp.canonicalize()){if parent.starts_with(&canonical_root)&&candidate.starts_with(&canonical_root){let _=fs::remove_file(candidate);}}}
 append_journal(&root,serde_json::json!({"at":chrono::Utc::now().to_rfc3339(),"action":"stale_lease_recovered"}))
}

#[tauri::command]
pub fn ingest_load(project_root: String) -> Result<Manifest, String> { read_manifest(Path::new(&project_root)) }

#[tauri::command]
pub async fn ingest_collect(project_root: String, sources: Vec<String>) -> Result<Manifest, String> {
    let root=PathBuf::from(&project_root);let result=tauri::async_runtime::spawn_blocking(move || { let files=crate::media_browser::resolve_paths(sources)?; if files.is_empty(){return Err("No supported media files were found.".into());} collect_sync(project_root,files.into_iter().map(|f|f.path).collect()) }).await.map_err(|e|e.to_string())?;
    if let Ok(_lease)=acquire_lease(&root){let _=write_progress(&root,if result.is_ok(){"complete"}else{"paused"},"",1,1);}result
}

fn same_source_path(a:&Path,b:&Path)->bool{
    let key=|path:&Path|{
        let path=fs::canonicalize(path).unwrap_or_else(|_|path.to_path_buf());
        let text=path.to_string_lossy().replace('\\',"/");
        if cfg!(windows){text.to_lowercase()}else{text}
    };
    key(a)==key(b)
}

fn collect_sync(project_root: String, sources: Vec<String>) -> Result<Manifest, String> {
    let root = PathBuf::from(project_root);
    if !root.is_dir() { return Err("Project folder is unavailable".into()); }
    let _lease=acquire_lease(&root)?;
    collect_with_lease(&root, sources, &_lease)
}

// Upgrade old records only from their hash-verified originals. The dates saved
// at initial collection remain the filesystem fallback, even if the source was
// subsequently copied or its filesystem timestamps changed.
fn backfill_recording_metadata(root: &Path, state: &mut Manifest, lease: &WriterLease) -> Result<(), String> {
    let reserved = root.join("_INGEST").canonicalize().map_err(|e|e.to_string())?;
    for index in 0..state.files.len() {
        lease.heartbeat()?;
        let file = &state.files[index];
        if file.status == "Filed" || file.recording_metadata.is_some() { continue; }
        let source = PathBuf::from(&file.source);
        let original = if source.is_file() { source } else { source.join(&file.relative_path) };
        let Ok(original) = original.canonicalize() else { continue; };
        if original.starts_with(&reserved) || same_source_path(&original, Path::new(&file.inbox_path)) { continue; }
        let Ok(before) = fs::metadata(&original) else { continue; };
        if !before.is_file() || before.len() != file.size { continue; }
        report_progress(root,"metadata",&file.name,index,state.files.len());
        if hash_with_lease(&original,Some(lease)).ok().as_deref() != Some(file.sha256.as_str()) { continue; }
        let metadata = recording_metadata::read(&original, file.source_created.as_deref(), file.source_modified.as_deref(), || lease.heartbeat());
        let Ok(after) = fs::metadata(&original) else { continue; };
        if before.len() != after.len() || before.modified().ok() != after.modified().ok()
            || hash_with_lease(&original,Some(lease)).ok().as_deref() != Some(file.sha256.as_str()) { continue; }
        lease.heartbeat()?;
        // Retry temporary probe failures on a later collection, without replacing
        // existing evidence or making unavailable originals a collection error.
        if metadata.probe_error.is_some() { continue; }
        let id = file.id.clone();
        state.files[index].recording_metadata = Some(metadata);
        write_manifest(root,state)?;
        append_journal(root,serde_json::json!({"action":"recording_metadata_backfilled","at":chrono::Utc::now().to_rfc3339(),"file_id":id,"source":original}))?;
    }
    Ok(())
}

fn collect_with_lease(root: &Path, sources: Vec<String>, _lease: &WriterLease) -> Result<Manifest, String> {
    let inbox = root.join("_INGEST/sources"); fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    let mut state = read_manifest(&root)?;
    backfill_recording_metadata(root,&mut state,_lease)?;
    for source in sources {
        let src = PathBuf::from(&source);
        if !src.exists() { return Err(format!("Source is unavailable: {source}")); }
        let reserved=root.join("_INGEST");if src.starts_with(&reserved)&&!src.starts_with(&inbox){return Err("Choose files from _INGEST/sources; ingest state files are reserved".into());}
        let id = Uuid::new_v4().to_string(); let batch_dir = inbox.join(&id);
        let selected_root = if src.is_dir() { src.clone() } else { src.parent().unwrap_or(Path::new(".")).to_path_buf() };
        let candidates: Vec<PathBuf> = if src.is_file() { if is_ingest_temporary(&src){return Err("Incomplete ingest transfer files cannot be collected".into());}vec![src.clone()] } else {
            let mut found=Vec::new();for entry in walkdir::WalkDir::new(&src).follow_links(false).into_iter().filter_entry(|entry|!entry.path().starts_with(&reserved)){let entry=entry.map_err(|e|e.to_string())?;if entry.file_type().is_file()&&!is_ingest_temporary(entry.path()){found.push(entry.into_path());}}found
        };
        let required=candidates.iter().filter(|p|!p.starts_with(&inbox)).try_fold(0u64,|sum,p|fs::metadata(p).map(|m|sum.saturating_add(m.len())).map_err(|e|e.to_string()))?;
        let free=available_space(&inbox)?;if required>free.saturating_sub(free/20){return Err(format!("Not enough destination space: need {required} bytes, have {free} bytes available"));}
        fs::create_dir_all(&batch_dir).map_err(|e| e.to_string())?;
        append_journal(&root,serde_json::json!({"action":"source_started","at":chrono::Utc::now().to_rfc3339(),"source":source.clone(),"batch_id":id.clone()}))?;
        let total=candidates.len();let mut completed=0;
        report_progress(&root,"inventorying",&source,0,total);
        for original in candidates {
            if state.files.iter().any(|f|Path::new(&f.inbox_path)==original){continue;}
            let rel = original.strip_prefix(&selected_root).map_err(|e| e.to_string())?;
            let mut dest = batch_dir.join(rel);
            let in_place=original.starts_with(&inbox);
            if !in_place { if let Some(parent) = dest.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; } }
            let before = fs::metadata(&original).map_err(|e| e.to_string())?;
            let modified = before.modified().ok().and_then(timestamp_ns);
            let created_time=before.created().ok();let created = created_time.and_then(timestamp_ns);
            report_progress(&root,"verifying",&source,completed,total);
            let original_hash = hash_with_lease(&original,Some(_lease))?;
            // Retry identity is the original path AND its content, not merely a
            // matching filename/hash on another card. Keep existing decisions/IDs.
            if let Some(existing)=state.files.iter().find(|file|{
                file.sha256==original_hash
                    && (same_source_path(Path::new(&file.source),&original)
                        || same_source_path(&Path::new(&file.source).join(&file.relative_path),&original))
            }){
                let existing_copy=Path::new(&existing.inbox_path);
                let digest=hash_with_lease(existing_copy,Some(_lease)).map_err(|e|format!("Could not verify previously collected copy {}: {e}",existing_copy.display()))?;
                if digest!=existing.sha256{return Err(format!("Previously collected copy has changed: {}",existing_copy.display()));}
                append_journal(&root,serde_json::json!({"action":"source_already_collected","at":chrono::Utc::now().to_rfc3339(),"file_id":existing.id,"source":original}))?;
                completed+=1;
                continue;
            }
            // Probe the original before any copy. Never derive evidence from a destination.
            report_progress(&root,"metadata",&source,completed,total);
            let recording_metadata = Some(recording_metadata::read(&original, created.as_deref(), modified.as_deref(), || _lease.heartbeat()));
            let timestamp_warning=if in_place{dest=original.clone();None}else{
                let tmp = dest.with_extension(format!("{}.partial", Uuid::new_v4()));
                append_journal(&root,serde_json::json!({"action":"transfer_started","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp,"inbox_path":dest,"file_id":Uuid::new_v4().to_string()}))?;
                report_progress(&root,"collecting",&source,completed,total);
                if let Err(e)=copy_with_heartbeat(&original, &tmp,&_lease){let _=fs::remove_file(&tmp);let _=append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp}));return Err(e);}
                report_progress(&root,"verifying",&source,completed,total);
                let after = fs::metadata(&original).map_err(|e| e.to_string())?;
                if before.len()!=after.len() || before.modified().ok()!=after.modified().ok() || original_hash!=hash_with_lease(&tmp,Some(_lease))? || original_hash!=hash_with_lease(&original,Some(_lease))? {
                    let _ = fs::remove_file(&tmp);let _=append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp})); return Err(format!("Source changed during collection; retry: {}", original.display()));
                }
                let mut warning = match before.modified() {Ok(time)=>filetime::set_file_mtime(&tmp,filetime::FileTime::from_system_time(time)).err().map(|e|format!("Could not preserve source modification time: {e}")),Err(_)=>Some("Source modification time is unavailable".into())};
                if let Some(w)=preserve_creation_time(&tmp,created_time){warning=Some(warning.map(|old|format!("{old}; {w}")).unwrap_or(w));}
                if let Err(e)=fs::rename(&tmp,&dest){let _=fs::remove_file(&tmp);let _=append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp}));return Err(e.to_string());}append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp}))?;let _=fs::File::open(&dest).and_then(|f|f.sync_all());warning
            };
            let role = match crate::media_browser::media_kind(&original) {Some("video")=>"Full-resolution video",Some("audio")=>"Raw audio",Some("image")=>"Stills",_=>"Unclassified supporting file"};
            let file_id=Uuid::new_v4().to_string();let duplicate_of=state.files.iter().find(|f|f.sha256==original_hash).map(|f|f.id.clone());
            state.files.push(IngestFile { id:file_id, batch_id:id.clone(), collected_at:Some(chrono::Utc::now().to_rfc3339()), newly_collected:true, name: original.file_name().unwrap_or_default().to_string_lossy().into_owned(), source: source.clone(), source_name:src.file_name().unwrap_or_default().to_string_lossy().into_owned(), relative_path: rel.to_string_lossy().into_owned(), inbox_path: dest.to_string_lossy().into_owned(), role: role.into(), size: before.len(), sha256: original_hash.clone(), source_modified: modified, source_created: created, recording_metadata, timestamp_warning, status: "Verified".into(), group_id: None, group_name: None, client: None, clients:Vec::new(),client_paths:Vec::new(),destinations:Vec::new(),duplicate_of,counterpart_id:None });
            write_manifest(&root,&state)?;
            append_journal(&root,serde_json::json!({"action":"collected","at":chrono::Utc::now().to_rfc3339(),"file_id":state.files.last().unwrap().id,"sha256":original_hash}))?;
            completed+=1;report_progress(&root,"collecting",&source,completed,total);
        }
        append_journal(&root,serde_json::json!({"action":"source_complete","at":chrono::Utc::now().to_rfc3339(),"source":source.clone(),"batch_id":id,"files":completed}))?;
        if fs::read_dir(&batch_dir).map(|mut d|d.next().is_none()).unwrap_or(false){let _=fs::remove_dir(&batch_dir);}
    }
    write_manifest(&root, &state)?; Ok(state)
}

#[tauri::command]
pub fn ingest_save(project_root: String, manifest: Manifest) -> Result<(), String> {
    let root=PathBuf::from(project_root);let _lease=acquire_lease(&root)?;
    let current=read_manifest(&root)?;
    if manifest.files.iter().any(|f|!current.files.iter().any(|c|c.id==f.id)) {return Err("Manifest includes unknown files; refresh ingest state before saving".into());}
    let mut merged=current;
    for f in manifest.files { let Some(old)=merged.files.iter_mut().find(|c|c.id==f.id) else {continue};
        if old.sha256!=f.sha256||old.inbox_path!=f.inbox_path||old.source!=f.source||old.name!=f.name||old.relative_path!=f.relative_path||old.size!=f.size||old.source_modified!=f.source_modified||old.source_created!=f.source_created||old.batch_id!=f.batch_id||old.recording_metadata!=f.recording_metadata {return Err("Original file evidence cannot be edited".into());}
        if !old.destinations.is_empty()&&(old.clients!=f.clients||old.client_paths!=f.client_paths||old.client!=f.client||old.role!=f.role){return Err(format!("{} has already been filed. Reassigning filed media requires the explicit move workflow.",old.name));}
        if old.group_id!=f.group_id||old.group_name!=f.group_name||old.client!=f.client||old.clients!=f.clients||old.client_paths!=f.client_paths||old.role!=f.role||old.newly_collected!=f.newly_collected{append_journal(&root,serde_json::json!({"action":"decision_updated","at":chrono::Utc::now().to_rfc3339(),"file_id":f.id,"from_group":old.group_name.clone(),"to_group":f.group_name.clone(),"clients":f.clients.clone(),"client_paths":f.client_paths.clone(),"role":f.role}))?;}
        old.group_id=f.group_id;old.group_name=f.group_name;old.client=f.client;old.clients=f.clients;old.client_paths=f.client_paths;old.role=f.role;old.newly_collected=f.newly_collected;old.source_name=f.source_name;
    }
    merged.reviewed_groups=manifest.reviewed_groups;
    write_manifest(&root,&merged)
}

#[tauri::command]
pub async fn ingest_file(project_root:String,eligible_client_paths:Option<Vec<String>>)->Result<Manifest,String>{
    let root=PathBuf::from(&project_root);let result=tauri::async_runtime::spawn_blocking(move||file_selected_sync(project_root,eligible_client_paths)).await.map_err(|e|e.to_string())?;
    if let Ok(_lease)=acquire_lease(&root){let _=write_progress(&root,if result.is_ok(){"complete"}else{"paused"},"",1,1);}result
}
#[tauri::command]
pub async fn ingest_file_ids(project_root:String,file_ids:Vec<String>)->Result<Manifest,String>{
    if file_ids.is_empty(){return Err("Choose at least one staged file to organise".into());}
    let root=PathBuf::from(&project_root);let ids:std::collections::HashSet<String>=file_ids.into_iter().collect();
    let result=tauri::async_runtime::spawn_blocking(move||file_selected_sync_filtered(project_root,None,Some(ids))).await.map_err(|e|e.to_string())?;
    if let Ok(_lease)=acquire_lease(&root){let _=write_progress(&root,if result.is_ok(){"complete"}else{"paused"},"",1,1);}result
}
#[cfg(test)]
fn file_sync(project_root:String)->Result<Manifest,String>{file_selected_sync(project_root,None)}
fn file_selected_sync(project_root:String,eligible_client_paths:Option<Vec<String>>)->Result<Manifest,String>{
    file_selected_sync_filtered(project_root,eligible_client_paths,None)
}
fn file_selected_sync_filtered(project_root:String,eligible_client_paths:Option<Vec<String>>,eligible_file_ids:Option<std::collections::HashSet<String>>)->Result<Manifest,String>{
    let root=PathBuf::from(project_root);let _lease=acquire_lease(&root)?;let mut state=read_manifest(&root)?;
    file_with_lease(&root, &mut state, eligible_client_paths, eligible_file_ids, &_lease)
}
fn file_with_lease(root:&Path, state:&mut Manifest, eligible_client_paths:Option<Vec<String>>, eligible_file_ids:Option<std::collections::HashSet<String>>, _lease:&WriterLease)->Result<Manifest,String>{
    let total=state.files.iter().filter(|f|f.status=="Verified").map(|f|if f.clients.is_empty(){usize::from(f.client.is_some())}else{f.clients.len()}).sum::<usize>();let mut completed=0usize;
    for i in 0..state.files.len(){
        let f=state.files[i].clone();if f.status=="Filed"||f.status!="Verified"||eligible_file_ids.as_ref().is_some_and(|ids|!ids.contains(&f.id)){continue;}
        let mut names=f.clients.clone();if names.is_empty(){if let Some(c)=f.client.clone(){names.push(c)}}
        if !f.client_paths.is_empty()&&f.client_paths.len()!=names.len(){return Err(format!("Client destination metadata is inconsistent for {}",f.name));}
        let mut targets:Vec<(String,String)>=names.into_iter().enumerate().map(|(i,name)|{let rel=f.client_paths.get(i).cloned().unwrap_or_else(||name.clone());(name,rel)}).collect();
        if targets.is_empty(){continue;}
        targets.sort_by(|a,b|a.1.cmp(&b.1));targets.dedup_by(|a,b|a.1==b.1);let target_count=targets.len();
        if let Some(eligible)=eligible_client_paths.as_ref(){targets.retain(|(_,relative)|eligible.contains(relative));}
        if targets.is_empty(){continue;}
        let rel=role_destination(&f.role).ok_or_else(||format!("Choose a media type for {} before organising",f.name))?;
        let source=PathBuf::from(&f.inbox_path);if !source.is_file()||hash_with_lease(&source,Some(_lease))?!=f.sha256{return Err(format!("Inbox file is missing or changed: {}",f.name));}
        for (client,relative) in targets{
            if eligible_client_paths.as_ref().is_some_and(|paths|!paths.contains(&relative)){continue;}
            if client.is_empty()||client=="_INGEST"||!valid_client_name(&client)||!valid_client_path(&relative){return Err(format!("Invalid client destination: {client}"));}
            let client_root=root.join(&relative);if !client_root.is_dir(){return Err(format!("Client no longer exists: {client} ({relative})"));}
            if f.destinations.iter().any(|d|Path::new(d).parent().map(|p|p.starts_with(&client_root)).unwrap_or(false)){continue;}
            let dir=client_root.join(rel);if !dir.is_dir(){return Err(format!("Client destination folder is missing: {}",dir.display()));}
            let canonical_root=root.canonicalize().map_err(|e|e.to_string())?;let canonical_client=client_root.canonicalize().map_err(|e|e.to_string())?;let canonical_dir=dir.canonicalize().map_err(|e|e.to_string())?;
            if !canonical_client.starts_with(&canonical_root)||!canonical_dir.starts_with(&canonical_client){return Err(format!("Destination escapes its project client folder: {}",dir.display()));}
            report_progress(root,"filing",&f.name,completed,total);
            append_journal(&root,serde_json::json!({"action":"file_started","at":chrono::Utc::now().to_rfc3339(),"file_id":f.id,"client":client.clone(),"client_path":relative,"role":f.role}))?;
            let mut dest=dir.join(&f.name);let mut n=1;while dest.exists(){if hash_with_lease(&dest,Some(_lease)).ok().as_deref()==Some(f.sha256.as_str()){break;}let stem=Path::new(&f.name).file_stem().unwrap_or_default().to_string_lossy();let ext=Path::new(&f.name).extension().and_then(|x|x.to_str()).unwrap_or("");let suffix=if ext.is_empty(){String::new()}else{format!(".{ext}")};dest=dir.join(format!("{stem} (Ingest {n}){suffix}"));n+=1;}
            if dest.to_string_lossy().encode_utf16().count()>32760{return Err(format!("Destination path is too long: {}",dest.display()));}
            let free=available_space(&dir)?;if f.size>free.saturating_sub(free/50){return Err(format!("Not enough destination space for {}",f.name));}
            if !dest.exists(){let tmp=dest.with_extension(format!("{}.partial",Uuid::new_v4()));append_journal(&root,serde_json::json!({"action":"transfer_started","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp.to_string_lossy(),"file_id":f.id,"client":client.clone()}))?;if let Err(e)=copy_with_heartbeat(&source,&tmp,&_lease){let _=fs::remove_file(&tmp);let _=append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp.to_string_lossy()}));return Err(e);}if hash_with_lease(&tmp,Some(_lease))?!=f.sha256{let _=fs::remove_file(&tmp);let _=append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp.to_string_lossy()}));return Err(format!("Filing verification failed for {}",f.name));}if let Some(t)=f.source_modified.as_deref().and_then(time_from_ns){if let Err(e)=filetime::set_file_mtime(&tmp,filetime::FileTime::from_system_time(t)){state.files[i].timestamp_warning=Some(format!("Could not preserve filed modification time: {e}"));}}if let Some(raw)=f.source_created.as_deref(){if let Some(t)=time_from_ns(raw){if let Some(w)=preserve_creation_time(&tmp,Some(t)){state.files[i].timestamp_warning=Some(w);}}}if let Err(e)=fs::rename(&tmp,&dest){let _=fs::remove_file(&tmp);return Err(e.to_string());}append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp.to_string_lossy()}))?;}
            if fs::metadata(&dest).map_err(|e|e.to_string())?.len()!=f.size || hash_with_lease(&dest,Some(_lease))?!=f.sha256 {
                return Err(format!("Final NAS copy could not be verified: {}",dest.display()));
            }
            state.files[i].destinations.push(dest.to_string_lossy().into_owned());write_manifest(&root,&state)?;
            append_journal(&root,serde_json::json!({"action":"file_committed","at":chrono::Utc::now().to_rfc3339(),"file_id":f.id,"client":client,"client_path":relative,"destination":dest.to_string_lossy()}))?;
            completed+=1;report_progress(&root,"filing",&f.name,completed,total);
        }
        if state.files[i].destinations.len()>=target_count{state.files[i].status="Filed".into();write_manifest(&root,&state)?;}
    }
    Ok(state.clone())
}

#[derive(Clone, Deserialize)]
pub struct ProjectMediaCopy { pub source: String, pub role: String }
#[derive(Debug, Serialize)]
pub struct ProjectMediaCopyResult { pub copied: usize, pub already_present: usize }

/// A single writer lease covers collection, targeted assignment, and filing.
/// The frontend never saves a snapshot of unrelated import decisions.
#[tauri::command]
pub async fn ingest_copy_project_media(project_root:String, client_path:String, files:Vec<ProjectMediaCopy>)->Result<ProjectMediaCopyResult,String>{
    tauri::async_runtime::spawn_blocking(move||copy_project_media_sync(project_root,client_path,files)).await.map_err(|e|e.to_string())?
}
fn copy_project_media_sync(project_root:String,client_path:String,files:Vec<ProjectMediaCopy>)->Result<ProjectMediaCopyResult,String>{
    let root=PathBuf::from(project_root);
    let result=(||{
        if files.is_empty(){return Err("Choose at least one file to copy".into());}
        let canonical_root=root.canonicalize().map_err(|e|format!("Project folder is unavailable: {e}"))?;
        let client=PathBuf::from(client_path).canonicalize().map_err(|e|format!("Client folder is unavailable: {e}"))?;
        let relative=client.strip_prefix(&canonical_root).map_err(|_|"Client is outside the selected project")?;
        let relative=relative.to_string_lossy().replace('\\',"/");
        if !valid_client_path(&relative){return Err("Choose a client inside the selected project".into());}
        let client_name=client.file_name().ok_or("Invalid client folder")?.to_string_lossy().into_owned();
        let mut unique=std::collections::HashSet::new();
        let mut selected=Vec::new();
        for file in files {
            let source=PathBuf::from(&file.source).canonicalize().map_err(|e|format!("Source is unavailable ({}): {e}",file.source))?;
            if !source.is_file() || crate::media_browser::media_kind(&source).is_none(){return Err(format!("Choose a supported media file: {}",file.source));}
            let role=role_destination(&file.role).ok_or("Choose a valid destination type")?;
            let destination=client.join(role).canonicalize().map_err(|e|format!("Destination folder is unavailable ({role}): {e}"))?;
            if !destination.is_dir() || !destination.starts_with(&client){return Err("Destination is outside the selected client".into());}
            if !unique.insert(normalized_path(&source)){return Err("The same source was selected more than once".into());}
            selected.push((source,file.role));
        }
        let lease=acquire_lease(&root)?;
        let mut state=collect_with_lease(&root,selected.iter().map(|(p,_)|p.to_string_lossy().into_owned()).collect(),&lease)?;
        let mut ids=std::collections::HashSet::new();
        let mut already_present=0;
        for (source,role) in &selected {
            // Changed content at the same path is a separate collected version.
            let digest=hash_with_lease(source,Some(&lease))?;
            let file=state.files.iter_mut().find(|f|f.sha256==digest && (same_source_path(Path::new(&f.source),source)||same_source_path(&Path::new(&f.source).join(&f.relative_path),source))).ok_or("The staged source could not be identified")?;
            let same_client=file.client_paths.len()==1 && file.client_paths[0].replace('\\',"/").eq_ignore_ascii_case(&relative);
            if (!file.clients.is_empty() || file.client.is_some() || !file.client_paths.is_empty() || !file.destinations.is_empty()) && !same_client {
                return Err(format!("{} is assigned to another client in Import media. Review that assignment before copying.",file.name));
            }
            if !file.destinations.is_empty() && file.role!=*role {return Err(format!("{} is already filed as {}. Keep that destination type or review it in Import media.",file.name,file.role));}
            let expected=client.join(role_destination(role).unwrap()).canonicalize().map_err(|e|e.to_string())?;
            let mut verified=Vec::new();
            for destination in &file.destinations {
                let destination=Path::new(destination);
                if destination.parent().and_then(|p|p.canonicalize().ok()).as_ref()==Some(&expected)
                    && fs::metadata(destination).is_ok_and(|m|m.is_file()&&m.len()==file.size)
                    && hash_with_lease(destination,Some(&lease))?==file.sha256 {verified.push(destination.to_string_lossy().into_owned());}
            }
            verified.truncate(1);
            file.destinations=verified;
            if !file.destinations.is_empty(){already_present+=1;file.status="Filed".into();}
            else{file.status="Verified".into();}
            file.role=role.clone();file.client=Some(client_name.clone());file.clients=vec![client_name.clone()];file.client_paths=vec![relative.clone()];
            ids.insert(file.id.clone());
        }
        write_manifest(&root,&state)?;
        let filed=file_with_lease(&root,&mut state,None,Some(ids.clone()),&lease)?;
        if filed.files.iter().filter(|f|ids.contains(&f.id)&&f.status=="Filed"&&f.destinations.len()==1).count()!=ids.len(){return Err("Some selected files were not filed. Verified recovery copies remain in Import media.".into());}
        report_progress(&root,"complete","",selected.len(),selected.len());
        Ok(ProjectMediaCopyResult{copied:selected.len()-already_present,already_present})
    })();
    if result.is_err() && root.join("_INGEST/state").is_dir(){if let Ok(_lease)=acquire_lease(&root){report_progress(&root,"paused","",0,0);}}
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy_request(source:&Path)->ProjectMediaCopy{ProjectMediaCopy{source:source.to_string_lossy().into_owned(),role:"Raw audio".into()}}
    fn copy_to(root:&Path,client:&Path,files:Vec<ProjectMediaCopy>)->Result<ProjectMediaCopyResult,String>{
        copy_project_media_sync(root.to_string_lossy().into_owned(),client.to_string_lossy().into_owned(),files)
    }
    fn copy_layout(root:&Path)->PathBuf{
        let client=root.join("SEASON 2/Exact_CLIENT_Name");
        fs::create_dir_all(client.join("01_MEDIA/040_AUDIO_RAW")).unwrap();client
    }
    fn exercise_project_copy(root:&Path){
        let local=tempfile::tempdir().unwrap();let source=local.path().join("Take_001.wav");
        let bytes:Vec<u8>=(0..4*1024*1024).map(|i|(i%251)as u8).collect();fs::write(&source,&bytes).unwrap();
        let original=fs::metadata(&source).unwrap();let digest=hash(&source).unwrap();let client=copy_layout(root);
        let dir=client.join("01_MEDIA/040_AUDIO_RAW");fs::write(dir.join("Take_001.wav"),b"Existing media - preserve me").unwrap();
        // Unselected collected media and its assignment must remain unchanged.
        let unrelated=local.path().join("Other.wav");fs::write(&unrelated,b"unrelated").unwrap();
        let mut initial=collect_sync(root.to_string_lossy().into_owned(),vec![unrelated.to_string_lossy().into_owned()]).unwrap();
        initial.files[0].group_name=Some("Keep this group".into());initial.files[0].clients=vec!["Another_client".into()];
        write_manifest(root,&initial).unwrap();let untouched=serde_json::to_value(&initial.files[0]).unwrap();
        let first=copy_to(root,&client,vec![copy_request(&source)]).unwrap();assert_eq!((first.copied,first.already_present),(1,0));
        let state=read_manifest(root).unwrap();assert_eq!(state.files.len(),2);assert_eq!(serde_json::to_value(&state.files[0]).unwrap(),untouched);
        let filed=&state.files[1];assert_eq!(filed.status,"Filed");assert_eq!(filed.client_paths,vec!["SEASON 2/Exact_CLIENT_Name"]);
        let destination=PathBuf::from(&filed.destinations[0]);assert_eq!(hash(&destination).unwrap(),digest);assert_eq!(hash(Path::new(&filed.inbox_path)).unwrap(),digest);
        assert_eq!(fs::read(dir.join("Take_001.wav")).unwrap(),b"Existing media - preserve me");
        assert_eq!(destination.file_name().unwrap(),"Take_001 (Ingest 1).wav");
        let again=copy_to(root,&client,vec![copy_request(&source)]).unwrap();assert_eq!((again.copied,again.already_present),(0,1));assert_eq!(read_manifest(root).unwrap().files.len(),2);
        assert_eq!(filed_media_copies(root,"SEASON 2/Exact_CLIENT_Name").len(),1);
        // Same-length corruption must not be accepted on retry, or overwritten.
        fs::write(&destination,vec![0u8;bytes.len()]).unwrap();
        let repaired=copy_to(root,&client,vec![copy_request(&source)]).unwrap();assert_eq!(repaired.copied,1);
        let repaired_state=read_manifest(root).unwrap();let repaired_file=&repaired_state.files[1];
        assert_ne!(repaired_file.destinations[0],destination.to_string_lossy());assert_eq!(hash(Path::new(&repaired_file.destinations[0])).unwrap(),digest);
        assert_eq!(fs::read(&destination).unwrap(),vec![0u8;bytes.len()]);
        assert_eq!(hash(&source).unwrap(),digest);assert_eq!(fs::metadata(&source).unwrap().modified().unwrap(),original.modified().unwrap());
        assert_eq!(fs::metadata(&source).unwrap().created().ok(),original.created().ok());
        assert!(!root.join("_INGEST/state/writer.lock").exists());
        assert!(!walkdir::WalkDir::new(root).into_iter().flatten().any(|e|is_ingest_temporary(e.path())));
        eprintln!("Verified local -> {}: 4 MiB SHA-256 {digest}; collision preserved; retry reused; corrupt destination recovered; source timestamps unchanged",root.display());
    }
    #[test]
    fn recording_evidence_comes_from_original_is_immutable_and_old_manifests_load() {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("project");fs::create_dir(&root).unwrap();
        let source=temp.path().join("original.mp4");fs::write(&source,include_bytes!("../../tests/fixtures/recording.mp4")).unwrap();
        let original=fs::read(&source).unwrap();let source_meta=fs::metadata(&source).unwrap();
        let state=collect_sync(root.to_string_lossy().into_owned(),vec![source.to_string_lossy().into_owned()]).unwrap();
        let evidence=state.files[0].recording_metadata.as_ref().unwrap();
        assert_eq!(evidence.start_source.as_deref(),Some("format.creation_time"));
        assert_eq!(evidence.start_ns.as_deref(),Some("1767268800000000000"));
        assert!(evidence.duration_ns.as_ref().unwrap().parse::<u64>().unwrap()>=1_000_000_000);
        assert_eq!(state.files[0].source_created,source_meta.created().ok().and_then(timestamp_ns));
        assert_eq!(fs::read(&source).unwrap(),original);
        assert_eq!(fs::metadata(&source).unwrap().modified().unwrap(),source_meta.modified().unwrap());
        assert_eq!(read_manifest(&root).unwrap().files[0].recording_metadata,state.files[0].recording_metadata);
        let mut edited=state.clone();edited.files[0].recording_metadata.as_mut().unwrap().start_source=Some("filesystem_created".into());
        assert!(ingest_save(root.to_string_lossy().into_owned(),edited).unwrap_err().contains("Original file evidence"));
        let mut legacy=serde_json::to_value(&state).unwrap();legacy["files"][0].as_object_mut().unwrap().remove("recording_metadata");
        let legacy:Manifest=serde_json::from_value(legacy).unwrap();assert!(legacy.files[0].recording_metadata.is_none());
    }

    #[test]
    fn later_collection_upgrades_legacy_originals_without_changing_decisions() {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("project");fs::create_dir(&root).unwrap();
        let card=temp.path().join("card");fs::create_dir(&card).unwrap();
        let original=card.join("camera.mp4");fs::write(&original,include_bytes!("../../tests/fixtures/recording.mp4")).unwrap();
        let mut first=collect_sync(root.to_string_lossy().into_owned(),vec![card.to_string_lossy().into_owned()]).unwrap();
        first.files[0].recording_metadata=None;
        first.files[0].group_id=Some("manual".into());first.files[0].group_name=Some("Keep interview".into());
        first.files[0].clients=vec!["Keep_PRODUCT".into()];first.files[0].client_paths=vec!["Keep_PRODUCT".into()];
        first.reviewed_groups=vec!["manual".into()];
        let before=serde_json::to_value(&first.files[0]).unwrap();write_manifest(&root,&first).unwrap();
        let later=temp.path().join("recorder.mov");fs::write(&later,include_bytes!("../../tests/fixtures/recording.mp4")).unwrap();
        let next=collect_sync(root.to_string_lossy().into_owned(),vec![later.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(next.files.len(),2);assert_ne!(next.files[0].batch_id,next.files[1].batch_id);
        assert!(next.files.iter().all(|f|f.recording_metadata.as_ref().is_some_and(|m|m.start_ns.is_some()&&m.duration_ns.is_some())));
        let mut after=serde_json::to_value(&next.files[0]).unwrap();after["recording_metadata"]=serde_json::Value::Null;
        assert_eq!(before,after);assert_eq!(next.reviewed_groups,first.reviewed_groups);
        assert_eq!(next.files[0].recording_metadata,read_manifest(&root).unwrap().files[0].recording_metadata);
        let repeated=collect_sync(root.to_string_lossy().into_owned(),vec![original.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(repeated.files.len(),2);assert_eq!(repeated.files[0].recording_metadata,next.files[0].recording_metadata);
    }

    #[test]
    fn client_intervals_use_verified_evidence_and_never_destination_filesystem_dates() {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("project");fs::create_dir(&root).unwrap();
        let original=temp.path().join("original.mp4");fs::write(&original,include_bytes!("../../tests/fixtures/recording.mp4")).unwrap();
        let mut state=collect_sync(root.to_string_lossy().into_owned(),vec![original.to_string_lossy().into_owned()]).unwrap();
        let copied=root.join("client/01_MEDIA/020_VIDEO_RAW/copy.mp4");fs::create_dir_all(copied.parent().unwrap()).unwrap();fs::copy(&original,&copied).unwrap();
        let metadata=state.files[0].recording_metadata.as_mut().unwrap();metadata.start_source=Some("filesystem_created".into());metadata.start_ns=Some("1700000000000000000".into());
        state.files[0].destinations=vec![copied.to_string_lossy().into_owned()];write_manifest(&root,&state).unwrap();
        assert_eq!(client_recording_metadata(&root,&[copied.clone()])[0].1,state.files[0].recording_metadata);
        state.files[0].timestamp_warning=Some("Check source date".into());write_manifest(&root,&state).unwrap();
        assert!(client_recording_metadata(&root,&[copied.clone()])[0].1.as_ref().unwrap().warning.is_some());
        let external=root.join("client/01_MEDIA/020_VIDEO_RAW/external.mp4");fs::copy(&original,&external).unwrap();
        let result=client_recording_metadata(&root,&[external]);assert_eq!(result[0].1.as_ref().unwrap().start_source.as_deref(),Some("format.creation_time"));
        fs::write(&copied,vec![0;fs::metadata(&copied).unwrap().len() as usize]).unwrap();
        let result=client_recording_metadata(&root,&[copied]);let result=result[0].1.as_ref().unwrap();
        assert!(result.start_ns.is_none());assert!(result.duration_ns.is_none());assert!(result.probe_error.is_some());
    }

    #[test]
    fn legacy_backfill_does_not_infer_from_inbox_or_changed_or_unavailable_originals() {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("project");fs::create_dir(&root).unwrap();
        let missing=temp.path().join("missing.mp4");let changed=temp.path().join("changed.mp4");
        let in_place=root.join("_INGEST/sources/in-place.mp4");fs::create_dir_all(in_place.parent().unwrap()).unwrap();
        for path in [&missing,&changed,&in_place]{fs::write(path,include_bytes!("../../tests/fixtures/recording.mp4")).unwrap();}
        let mut state=collect_sync(root.to_string_lossy().into_owned(),vec![missing.to_string_lossy().into_owned(),changed.to_string_lossy().into_owned(),in_place.to_string_lossy().into_owned()]).unwrap();
        for file in &mut state.files {file.recording_metadata=None;}
        write_manifest(&root,&state).unwrap();fs::remove_file(&missing).unwrap();
        let mut altered=fs::read(&changed).unwrap();altered[100]^=1;fs::write(&changed,altered).unwrap();
        let later=temp.path().join("later.mp4");fs::write(&later,include_bytes!("../../tests/fixtures/recording.mp4")).unwrap();
        let next=collect_sync(root.to_string_lossy().into_owned(),vec![later.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(next.files.len(),4);assert!(next.files[..3].iter().all(|f|f.recording_metadata.is_none()));
        assert!(next.files[3].recording_metadata.as_ref().unwrap().duration_ns.is_some());
    }

    #[test]
    fn project_copy_verifies_retries_collisions_and_preserves_unrelated_decisions(){
        let temp=tempfile::tempdir().unwrap();exercise_project_copy(temp.path());
    }
    #[test]
    #[ignore = "Writes only generated fixtures in a temporary directory under PEPPER_NAS_TEST_ROOT"]
    fn project_copy_live_nas(){
        let parent=std::env::var("PEPPER_NAS_TEST_ROOT").expect("Set PEPPER_NAS_TEST_ROOT to an existing NAS test parent");
        let temp=tempfile::Builder::new().prefix("Pepper-copy-verification-").tempdir_in(&parent).unwrap();
        exercise_project_copy(temp.path());
    }
    #[test]
    fn project_copy_rejects_wrong_client_and_missing_destination_before_collection(){
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("show");let client=copy_layout(&root);
        let source=temp.path().join("REC.wav");fs::write(&source,b"recording").unwrap();
        let outside=temp.path().join("outside");fs::create_dir_all(&outside).unwrap();
        assert!(copy_to(&root,&outside,vec![copy_request(&source)]).unwrap_err().contains("outside"));
        let invalid=ProjectMediaCopy{source:source.to_string_lossy().into_owned(),role:"Music".into()};
        assert!(copy_to(&root,&client,vec![invalid]).unwrap_err().contains("unavailable"));
        assert!(!root.join("_INGEST").exists());
        assert!(copy_to(&root,&client,vec![copy_request(&source),copy_request(&source)]).unwrap_err().contains("more than once"));
        assert!(!root.join("_INGEST").exists());
    }
    #[test]
    fn project_copy_refuses_another_clients_filed_media(){
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("show");let client=copy_layout(&root);
        let other=root.join("Other_client");fs::create_dir_all(other.join("01_MEDIA/040_AUDIO_RAW")).unwrap();
        let source=temp.path().join("REC.wav");fs::write(&source,b"recording").unwrap();
        copy_to(&root,&client,vec![copy_request(&source)]).unwrap();
        assert!(copy_to(&root,&other,vec![copy_request(&source)]).unwrap_err().contains("another client"));
        assert!(!other.join("01_MEDIA/040_AUDIO_RAW/REC.wav").exists());
        assert_eq!(read_manifest(&root).unwrap().files[0].client.as_deref(),Some("Exact_CLIENT_Name"));
    }
    #[test]
    fn project_copy_recovers_a_partially_committed_file_and_rejects_changed_inbox(){
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("show");let client=copy_layout(&root);
        let source=temp.path().join("REC.wav");fs::write(&source,b"recording").unwrap();
        copy_to(&root,&client,vec![copy_request(&source)]).unwrap();
        let mut state=read_manifest(&root).unwrap();state.files[0].status="Verified".into();write_manifest(&root,&state).unwrap();
        let retry=copy_to(&root,&client,vec![copy_request(&source)]).unwrap();assert_eq!(retry.already_present,1);assert_eq!(read_manifest(&root).unwrap().files[0].status,"Filed");
        fs::write(&state.files[0].inbox_path,b"bad inbox").unwrap();
        assert!(copy_to(&root,&client,vec![copy_request(&source)]).unwrap_err().contains("changed"));
        assert_eq!(fs::read(&source).unwrap(),b"recording");assert!(!root.join("_INGEST/state/writer.lock").exists());
    }
    #[cfg(windows)]
    #[test]
    fn project_copy_handles_windows_destination_failure_then_retries(){
        use std::os::windows::fs::OpenOptionsExt;
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("show");let client=copy_layout(&root);
        let source=temp.path().join("REC.wav");fs::write(&source,b"recording").unwrap();
        let collected=collect_sync(root.to_string_lossy().into_owned(),vec![source.to_string_lossy().into_owned()]).unwrap();
        let lock=fs::OpenOptions::new().read(true).share_mode(0).open(&collected.files[0].inbox_path).unwrap();
        assert!(copy_to(&root,&client,vec![copy_request(&source)]).is_err());assert!(!client.join("01_MEDIA/040_AUDIO_RAW/REC.wav").exists());
        assert!(!root.join("_INGEST/state/writer.lock").exists());drop(lock);
        assert_eq!(copy_to(&root,&client,vec![copy_request(&source)]).unwrap().copied,1);
    }
    #[test]
    fn collection_preserves_source_and_separates_identical_names() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("show"); fs::create_dir_all(&root).unwrap();
        let a = temp.path().join("card_a"); let b = temp.path().join("card_b");
        fs::create_dir_all(&a).unwrap(); fs::create_dir_all(&b).unwrap();
        let pa=a.join("TAKE001.wav"); let pb=b.join("TAKE001.wav");
        fs::write(&pa,b"audio A").unwrap(); fs::write(&pb,b"audio B").unwrap();
        let before_a=fs::metadata(&pa).unwrap().modified().unwrap(); let before_b=fs::metadata(&pb).unwrap().modified().unwrap();
        let created_a=fs::metadata(&pa).unwrap().created().ok();
        let state=collect_sync(root.to_string_lossy().into_owned(),vec![pa.to_string_lossy().into_owned(),pb.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(state.files.len(),2); assert_ne!(state.files[0].inbox_path,state.files[1].inbox_path);
        assert_eq!(fs::read(&pa).unwrap(),b"audio A"); assert_eq!(fs::read(&pb).unwrap(),b"audio B");
        assert_eq!(fs::metadata(&pa).unwrap().modified().unwrap(),before_a); assert_eq!(fs::metadata(&pb).unwrap().modified().unwrap(),before_b);
        assert_eq!(fs::metadata(&pa).unwrap().created().ok(),created_a);
        assert_eq!(hash(Path::new(&state.files[0].inbox_path)).unwrap(),state.files[0].sha256);
        assert_eq!(hash(Path::new(&state.files[1].inbox_path)).unwrap(),state.files[1].sha256);
        let reopened=read_manifest(&root).unwrap();assert_eq!(reopened.files.len(),2);assert_eq!(reopened.files[0].source_created,state.files[0].source_created);
        let duplicate=collect_sync(root.to_string_lossy().into_owned(),vec![pa.to_string_lossy().into_owned()]).unwrap();assert_eq!(duplicate.files.len(),2);assert_eq!(duplicate.files[0].id,state.files[0].id);
    }

    #[test]
    fn interrupted_collection_resumes_without_duplicates_and_keeps_decisions(){
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("show");fs::create_dir_all(&root).unwrap();
        let card=temp.path().join("card");fs::create_dir_all(&card).unwrap();
        let a=card.join("A.mp4");let b=card.join("B.wav");fs::write(&a,b"video").unwrap();
        let root_string=root.to_string_lossy().into_owned();let sources=vec![a.to_string_lossy().into_owned(),b.to_string_lossy().into_owned()];
        assert!(collect_sync(root_string.clone(),sources.clone()).is_err());
        let mut partial=read_manifest(&root).unwrap();assert_eq!(partial.files.len(),1);
        partial.files[0].group_id=Some("interview".into());partial.files[0].role="Proxy video".into();write_manifest(&root,&partial).unwrap();
        fs::write(&b,b"audio").unwrap();
        let resumed=collect_sync(root_string.clone(),sources).unwrap();assert_eq!(resumed.files.len(),2);
        assert_eq!(resumed.files[0].id,partial.files[0].id);assert_eq!(resumed.files[0].role,"Proxy video");assert_eq!(resumed.files[0].group_id,partial.files[0].group_id);
        let folder_retry=collect_sync(root_string.clone(),vec![card.to_string_lossy().into_owned()]).unwrap();assert_eq!(folder_retry.files.len(),2);
        fs::write(&a,b"changed video").unwrap();let changed=collect_sync(root_string.clone(),vec![a.to_string_lossy().into_owned()]).unwrap();assert_eq!(changed.files.len(),3);
        let other=temp.path().join("other.mp4");fs::copy(&a,&other).unwrap();let other_copy=collect_sync(root_string,vec![other.to_string_lossy().into_owned()]).unwrap();assert_eq!(other_copy.files.len(),4);assert!(other_copy.files[3].duplicate_of.is_some());
    }

    #[cfg(windows)]
    #[test]
    fn state_replace_recovers_from_a_temporary_windows_reader_lock(){
        use std::os::windows::fs::OpenOptionsExt;
        let temp=tempfile::tempdir().unwrap();let root=temp.path();fs::create_dir_all(root.join("_INGEST/state")).unwrap();
        write_progress(root,"inventorying","card",0,1).unwrap();
        let reader=fs::OpenOptions::new().read(true).share_mode(1).open(root.join("_INGEST/state/progress.json")).unwrap();
        let release=std::thread::spawn(move||{std::thread::sleep(std::time::Duration::from_millis(180));drop(reader);});
        let replacement=root.join("replacement.json");fs::write(&replacement,b"{}").unwrap();
        atomic_replace(&replacement,&root.join("_INGEST/state/progress.json")).unwrap();release.join().unwrap();
        assert_eq!(fs::read(root.join("_INGEST/state/progress.json")).unwrap(),b"{}");
        assert_eq!(fs::read_dir(root.join("_INGEST/state")).unwrap().count(),1);
    }

    #[cfg(windows)]
    #[test]
    fn persistent_progress_lock_reports_operation_and_path_and_cleans_temp(){
        use std::os::windows::fs::OpenOptionsExt;
        let temp=tempfile::tempdir().unwrap();let root=temp.path();fs::create_dir_all(root.join("_INGEST/state")).unwrap();
        write_progress(root,"inventorying","card",0,1).unwrap();
        let _reader=fs::OpenOptions::new().read(true).share_mode(1).open(root.join("_INGEST/state/progress.json")).unwrap();
        let error=write_progress(root,"collecting","REC.wav",0,1).unwrap_err();
        assert!(error.contains("progress.json"));assert!(error.contains("REC.wav"));assert!(error.contains("collecting"));
        assert_eq!(fs::read_dir(root.join("_INGEST/state")).unwrap().count(),1);
    }

    #[cfg(windows)]
    #[test]
    fn collection_completes_while_progress_file_stays_locked(){
        use std::os::windows::fs::OpenOptionsExt;
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("show");fs::create_dir_all(root.join("_INGEST/state")).unwrap();
        let source=temp.path().join("REC.wav");fs::write(&source,b"audio").unwrap();
        write_progress(&root,"inventorying","card",0,1).unwrap();
        let reader=fs::OpenOptions::new().read(true).share_mode(1).open(root.join("_INGEST/state/progress.json")).unwrap();
        let first=collect_sync(root.to_string_lossy().into_owned(),vec![source.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(first.files.len(),1);assert_eq!(hash(Path::new(&first.files[0].inbox_path)).unwrap(),hash(&source).unwrap());
        let repeated=collect_sync(root.to_string_lossy().into_owned(),vec![source.to_string_lossy().into_owned()]).unwrap();assert_eq!(repeated.files.len(),1);
        assert!(fs::read_to_string(root.join("_INGEST/state/journal.jsonl")).unwrap().contains("progress_update_deferred"));
        drop(reader);report_progress(&root,"complete","card",1,1);
        assert_eq!(ingest_progress(root.to_string_lossy().into_owned()).unwrap().unwrap().phase,"complete");
    }

    #[test]
    fn filing_keeps_inbox_and_routes_shared_audio_without_overwriting(){
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("show");let inbox=root.join("_INGEST/sources/card");
        let a=root.join("Client_A/01_MEDIA/040_AUDIO_RAW");let b=root.join("Client_B/01_MEDIA/040_AUDIO_RAW");
        fs::create_dir_all(&inbox).unwrap();fs::create_dir_all(&a).unwrap();fs::create_dir_all(&b).unwrap();
        let incoming=inbox.join("REC.wav");fs::write(&incoming,b"recording").unwrap();fs::write(a.join("REC.wav"),b"existing different").unwrap();
        let digest=hash(&incoming).unwrap();let mut state=Manifest{schema_version:1,files:vec![IngestFile{id:"one".into(),batch_id:"batch".into(),collected_at:None,newly_collected:false,name:"REC.wav".into(),source:"card".into(),source_name:"card".into(),relative_path:"REC.wav".into(),inbox_path:incoming.to_string_lossy().into_owned(),role:"Raw audio".into(),size:9,sha256:digest.clone(),source_modified:None,source_created:None,recording_metadata:None,timestamp_warning:None,status:"Verified".into(),group_id:Some("group-one".into()),group_name:Some("Interview".into()),client:None,clients:vec!["Client_A".into(),"Client_B".into()],client_paths:vec!["Client_A".into(),"Client_B".into()],destinations:vec![],duplicate_of:None,counterpart_id:None}],reviewed_groups:vec![]};
        write_manifest(&root,&state).unwrap();state=file_sync(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(state.files[0].status,"Filed");assert_eq!(state.files[0].destinations.len(),2);assert!(incoming.exists());
        assert!(state.files[0].destinations.iter().all(|p|hash(Path::new(p)).unwrap()==digest));
        assert!(state.files[0].destinations.iter().any(|p|p.contains("Ingest 1")));
    }

    #[test]
    fn clean_audio_preview_and_filing_use_existing_clean_folder(){
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("show");
        let source=temp.path().join("REC.wav");fs::write(&source,b"clean recording").unwrap();
        let clean=root.join("Client_A/01_MEDIA/030_AUDIO_CLEAN");let raw=root.join("Client_A/01_MEDIA/040_AUDIO_RAW");
        fs::create_dir_all(&clean).unwrap();fs::create_dir_all(&raw).unwrap();
        let mut state=collect_sync(root.to_string_lossy().into_owned(),vec![source.to_string_lossy().into_owned()]).unwrap();
        state.files[0].role="Clean audio".into();state.files[0].clients=vec!["Client_A".into()];state.files[0].client_paths=vec!["Client_A".into()];
        write_manifest(&root,&state).unwrap();
        let preview=preview_filing_sync(root.to_string_lossy().into_owned(),None).unwrap();assert_eq!(preview.len(),1);assert!(preview[0].issue.is_none());assert_eq!(Path::new(&preview[0].destination),clean.join("REC.wav"));
        let filed=file_sync(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(filed.files[0].status,"Filed");assert_eq!(fs::read(clean.join("REC.wav")).unwrap(),b"clean recording");assert!(!raw.join("REC.wav").exists());assert!(source.exists());
    }

    #[test]
    fn review_and_organise_leave_unassigned_and_ineligible_media_for_later(){
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("show");
        let source=temp.path().join("REC.wav");fs::write(&source,b"recording").unwrap();
        let clean=root.join("Client_A/01_MEDIA/030_AUDIO_CLEAN");fs::create_dir_all(&clean).unwrap();
        let mut state=collect_sync(root.to_string_lossy().into_owned(),vec![source.to_string_lossy().into_owned()]).unwrap();
        let mut unavailable=state.files[0].clone();unavailable.id="old-client".into();unavailable.clients=vec!["Old client".into()];unavailable.client_paths=vec!["Old client".into()];
        let mut assigned=state.files[0].clone();assigned.id="assigned".into();assigned.role="Clean audio".into();assigned.clients=vec!["Client_A".into()];assigned.client_paths=vec!["Client_A".into()];
        state.files.push(unavailable);state.files.push(assigned);write_manifest(&root,&state).unwrap();
        let eligible=Some(vec!["Client_A".into()]);
        let preview=preview_filing_sync(root.to_string_lossy().into_owned(),eligible.clone()).unwrap();
        assert_eq!(preview.len(),1);assert_eq!(preview[0].file_id,"assigned");assert_eq!(preview[0].client,"Client_A");
        let filed=file_selected_sync(root.to_string_lossy().into_owned(),eligible).unwrap();
        assert_eq!(filed.files[0].status,"Verified");assert_eq!(filed.files[1].status,"Verified");assert_eq!(filed.files[2].status,"Filed");
        assert!(filed.files[0].destinations.is_empty());assert!(filed.files[1].destinations.is_empty());assert_eq!(filed.files[1].client_paths,vec!["Old client"]);
        assert!(Path::new(&filed.files[0].inbox_path).exists());assert!(source.exists());assert!(clean.join("REC.wav").exists());
        let empty=preview_filing_sync(root.to_string_lossy().into_owned(),Some(vec![])).unwrap();assert!(empty.is_empty());
    }

    #[test]
    fn lease_prevents_a_second_writer_and_backup_recovers_corrupt_manifest(){
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("show");fs::create_dir_all(&root).unwrap();
        let _lease=acquire_lease(&root).unwrap();assert!(acquire_lease(&root).is_err());drop(_lease);
        let first=Manifest{schema_version:1,files:vec![],reviewed_groups:vec![]};write_manifest(&root,&first).unwrap();
        let second=Manifest{schema_version:1,files:vec![],reviewed_groups:vec!["Interview".into()]};write_manifest(&root,&second).unwrap();
        fs::write(manifest_path(&root),b"not json").unwrap();let recovered=read_manifest(&root).unwrap();assert!(recovered.reviewed_groups.is_empty());
    }

    #[test]
    fn stale_lease_recovery_removes_only_journaled_partial_files(){
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("show");let source=root.join("_INGEST/sources/card");fs::create_dir_all(&source).unwrap();
        let tmp=source.join("REC.wav.550e8400-e29b-41d4-a716-446655440000.partial");fs::write(&tmp,b"partial").unwrap();
        let lock=root.join("_INGEST/state/writer.lock");fs::create_dir_all(lock.parent().unwrap()).unwrap();fs::write(&lock,b"dead owner").unwrap();filetime::set_file_mtime(&lock,filetime::FileTime::from_unix_time(0,0)).unwrap();
        append_journal(&root,serde_json::json!({"action":"transfer_started","temp_path":tmp})).unwrap();ingest_recover_stale_lease(root.to_string_lossy().into_owned()).unwrap();
        assert!(!tmp.exists());assert!(!lock.exists());
    }
}
