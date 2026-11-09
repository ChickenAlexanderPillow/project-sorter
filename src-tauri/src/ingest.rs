//! Durable, source-preserving media collection for Pepper's ingest workspace.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}};
use uuid::Uuid;

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

struct WriterLease { path: PathBuf }
impl WriterLease { fn heartbeat(&self)->Result<(),String>{filetime::set_file_mtime(&self.path,filetime::FileTime::from_system_time(std::time::SystemTime::now())).map_err(|e|e.to_string())} }
impl Drop for WriterLease { fn drop(&mut self) { let _ = fs::remove_file(&self.path); } }
fn acquire_lease(root: &Path) -> Result<WriterLease, String> {
    let dir = root.join("_INGEST/state"); fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    let path=dir.join("writer.lock");
    let mut f=fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e|format!("Ingest is locked by another writer ({}): {e}",path.display()))?;
    let machine=std::env::var("COMPUTERNAME").unwrap_or_else(|_|"unknown".into());let owner=format!("machine={machine}\npid={}\nstarted={}\n",std::process::id(),chrono::Utc::now().to_rfc3339());
    use std::io::Write; f.write_all(owner.as_bytes()).map_err(|e|e.to_string())?; f.sync_all().map_err(|e|e.to_string())?;
    Ok(WriterLease{path})
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
fn hash(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new(); let mut buf = [0u8; 1024*1024];
    loop { let n = f.read(&mut buf).map_err(|e| e.to_string())?; if n == 0 { break; } h.update(&buf[..n]); }
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
fn role_destination(role:&str)->Option<&'static str>{match role{"Proxy video"=>Some("01_MEDIA/010_VIDEO_PROXY"),"Full-resolution video"=>Some("01_MEDIA/020_VIDEO_RAW"),"Raw audio"=>Some("01_MEDIA/040_AUDIO_RAW"),"Clean audio"=>Some("01_MEDIA/030_AUDIO_CLEAN"),"Music"=>Some("01_MEDIA/060_MUSIC"),"Stills"=>Some("01_MEDIA/050_STILLS"),"Graphics"=>Some("01_MEDIA/070_GRAPHICS"),"Miscellaneous"=>Some("01_MEDIA/080_MISCELLANEOUS"),_=>None}}

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
    let inbox = root.join("_INGEST/sources"); fs::create_dir_all(&inbox).map_err(|e| e.to_string())?;
    let mut state = read_manifest(&root)?;
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
            let original_hash = hash(&original)?;
            // Retry identity is the original path AND its content, not merely a
            // matching filename/hash on another card. Keep existing decisions/IDs.
            if let Some(existing)=state.files.iter().find(|file|{
                file.sha256==original_hash
                    && (same_source_path(Path::new(&file.source),&original)
                        || same_source_path(&Path::new(&file.source).join(&file.relative_path),&original))
            }){
                let existing_copy=Path::new(&existing.inbox_path);
                let digest=hash(existing_copy).map_err(|e|format!("Could not verify previously collected copy {}: {e}",existing_copy.display()))?;
                if digest!=existing.sha256{return Err(format!("Previously collected copy has changed: {}",existing_copy.display()));}
                append_journal(&root,serde_json::json!({"action":"source_already_collected","at":chrono::Utc::now().to_rfc3339(),"file_id":existing.id,"source":original}))?;
                completed+=1;
                continue;
            }
            let timestamp_warning=if in_place{dest=original.clone();None}else{
                let tmp = dest.with_extension(format!("{}.partial", Uuid::new_v4()));
                append_journal(&root,serde_json::json!({"action":"transfer_started","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp,"inbox_path":dest,"file_id":Uuid::new_v4().to_string()}))?;
                report_progress(&root,"collecting",&source,completed,total);
                if let Err(e)=copy_with_heartbeat(&original, &tmp,&_lease){let _=fs::remove_file(&tmp);let _=append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp}));return Err(e);}
                report_progress(&root,"verifying",&source,completed,total);
                let after = fs::metadata(&original).map_err(|e| e.to_string())?;
                if before.len()!=after.len() || before.modified().ok()!=after.modified().ok() || original_hash!=hash(&tmp)? || original_hash!=hash(&original)? {
                    let _ = fs::remove_file(&tmp);let _=append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp})); return Err(format!("Source changed during collection; retry: {}", original.display()));
                }
                let mut warning = match before.modified() {Ok(time)=>filetime::set_file_mtime(&tmp,filetime::FileTime::from_system_time(time)).err().map(|e|format!("Could not preserve source modification time: {e}")),Err(_)=>Some("Source modification time is unavailable".into())};
                if let Some(w)=preserve_creation_time(&tmp,created_time){warning=Some(warning.map(|old|format!("{old}; {w}")).unwrap_or(w));}
                if let Err(e)=fs::rename(&tmp,&dest){let _=fs::remove_file(&tmp);let _=append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp}));return Err(e.to_string());}append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp}))?;let _=fs::File::open(&dest).and_then(|f|f.sync_all());warning
            };
            let role = match crate::media_browser::media_kind(&original) {Some("video")=>"Full-resolution video",Some("audio")=>"Raw audio",Some("image")=>"Stills",_=>"Unclassified supporting file"};
            let file_id=Uuid::new_v4().to_string();let duplicate_of=state.files.iter().find(|f|f.sha256==original_hash).map(|f|f.id.clone());
            state.files.push(IngestFile { id:file_id, batch_id:id.clone(), collected_at:Some(chrono::Utc::now().to_rfc3339()), newly_collected:true, name: original.file_name().unwrap_or_default().to_string_lossy().into_owned(), source: source.clone(), source_name:src.file_name().unwrap_or_default().to_string_lossy().into_owned(), relative_path: rel.to_string_lossy().into_owned(), inbox_path: dest.to_string_lossy().into_owned(), role: role.into(), size: before.len(), sha256: original_hash.clone(), source_modified: modified, source_created: created, timestamp_warning, status: "Verified".into(), group_id: None, group_name: None, client: None, clients:Vec::new(),client_paths:Vec::new(),destinations:Vec::new(),duplicate_of,counterpart_id:None });
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
        if old.sha256!=f.sha256||old.inbox_path!=f.inbox_path||old.source!=f.source||old.name!=f.name||old.relative_path!=f.relative_path||old.size!=f.size||old.source_modified!=f.source_modified||old.source_created!=f.source_created||old.batch_id!=f.batch_id {return Err("Original file evidence cannot be edited".into());}
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
        let source=PathBuf::from(&f.inbox_path);if !source.is_file()||hash(&source)?!=f.sha256{return Err(format!("Inbox file is missing or changed: {}",f.name));}
        for (client,relative) in targets{
            if eligible_client_paths.as_ref().is_some_and(|paths|!paths.contains(&relative)){continue;}
            if client.is_empty()||client=="_INGEST"||!valid_client_name(&client)||!valid_client_path(&relative){return Err(format!("Invalid client destination: {client}"));}
            let client_root=root.join(&relative);if !client_root.is_dir(){return Err(format!("Client no longer exists: {client} ({relative})"));}
            if f.destinations.iter().any(|d|Path::new(d).parent().map(|p|p.starts_with(&client_root)).unwrap_or(false)){continue;}
            let dir=client_root.join(rel);if !dir.is_dir(){return Err(format!("Client destination folder is missing: {}",dir.display()));}
            let canonical_root=root.canonicalize().map_err(|e|e.to_string())?;let canonical_client=client_root.canonicalize().map_err(|e|e.to_string())?;let canonical_dir=dir.canonicalize().map_err(|e|e.to_string())?;
            if !canonical_client.starts_with(&canonical_root)||!canonical_dir.starts_with(&canonical_client){return Err(format!("Destination escapes its project client folder: {}",dir.display()));}
            append_journal(&root,serde_json::json!({"action":"file_started","at":chrono::Utc::now().to_rfc3339(),"file_id":f.id,"client":client.clone(),"client_path":relative,"role":f.role}))?;
            let mut dest=dir.join(&f.name);let mut n=1;while dest.exists(){if hash(&dest).ok().as_deref()==Some(f.sha256.as_str()){break;}let stem=Path::new(&f.name).file_stem().unwrap_or_default().to_string_lossy();let ext=Path::new(&f.name).extension().and_then(|x|x.to_str()).unwrap_or("");let suffix=if ext.is_empty(){String::new()}else{format!(".{ext}")};dest=dir.join(format!("{stem} (Ingest {n}){suffix}"));n+=1;}
            if dest.to_string_lossy().encode_utf16().count()>32760{return Err(format!("Destination path is too long: {}",dest.display()));}
            let free=available_space(&dir)?;if f.size>free.saturating_sub(free/50){return Err(format!("Not enough destination space for {}",f.name));}
            if !dest.exists(){let tmp=dest.with_extension(format!("{}.partial",Uuid::new_v4()));append_journal(&root,serde_json::json!({"action":"transfer_started","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp.to_string_lossy(),"file_id":f.id,"client":client.clone()}))?;if let Err(e)=copy_with_heartbeat(&source,&tmp,&_lease){let _=fs::remove_file(&tmp);let _=append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp.to_string_lossy()}));return Err(e);}if hash(&tmp)?!=f.sha256{let _=fs::remove_file(&tmp);let _=append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp.to_string_lossy()}));return Err(format!("Filing verification failed for {}",f.name));}if let Some(t)=f.source_modified.as_deref().and_then(time_from_ns){if let Err(e)=filetime::set_file_mtime(&tmp,filetime::FileTime::from_system_time(t)){state.files[i].timestamp_warning=Some(format!("Could not preserve filed modification time: {e}"));}}if let Some(raw)=f.source_created.as_deref(){if let Some(t)=time_from_ns(raw){if let Some(w)=preserve_creation_time(&tmp,Some(t)){state.files[i].timestamp_warning=Some(w);}}}if let Err(e)=fs::rename(&tmp,&dest){let _=fs::remove_file(&tmp);return Err(e.to_string());}append_journal(&root,serde_json::json!({"action":"transfer_completed","at":chrono::Utc::now().to_rfc3339(),"temp_path":tmp.to_string_lossy()}))?;}
            state.files[i].destinations.push(dest.to_string_lossy().into_owned());write_manifest(&root,&state)?;
            append_journal(&root,serde_json::json!({"action":"file_committed","at":chrono::Utc::now().to_rfc3339(),"file_id":f.id,"client":client,"client_path":relative,"destination":dest.to_string_lossy()}))?;
            completed+=1;report_progress(&root,"filing",&f.name,completed,total);
        }
        if state.files[i].destinations.len()>=target_count{state.files[i].status="Filed".into();write_manifest(&root,&state)?;}
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let digest=hash(&incoming).unwrap();let mut state=Manifest{schema_version:1,files:vec![IngestFile{id:"one".into(),batch_id:"batch".into(),collected_at:None,newly_collected:false,name:"REC.wav".into(),source:"card".into(),source_name:"card".into(),relative_path:"REC.wav".into(),inbox_path:incoming.to_string_lossy().into_owned(),role:"Raw audio".into(),size:9,sha256:digest.clone(),source_modified:None,source_created:None,timestamp_warning:None,status:"Verified".into(),group_id:Some("group-one".into()),group_name:Some("Interview".into()),client:None,clients:vec!["Client_A".into(),"Client_B".into()],client_paths:vec!["Client_A".into(),"Client_B".into()],destinations:vec![],duplicate_of:None,counterpart_id:None}],reviewed_groups:vec![]};
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
