//! Verified, reversible whole-client copies for editing away from the NAS.
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs, io::{Read, Write}, path::{Component, Path, PathBuf}, sync::{Mutex, OnceLock}, time::{Duration, Instant}};
use tauri::AppHandle;
#[cfg(not(test))]
use tauri::Emitter;
use uuid::Uuid;
use walkdir::WalkDir;

const META_DIR: &str = ".pepper-takehome";
const DRIVE_MANIFEST: &str = ".pepper-takehome-package.json";
const SCHEMA: u32 = 2;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct FileRecord { path: String, size: u64, sha256: String }

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Manifest {
    schema: u32,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    package_path: String,
    package_id: String,
    client_name: String,
    client_path: String,
    updated_at: String,
    files: Vec<FileRecord>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PackageInfo { pub package_root: String, pub package_id: String, pub files: usize, pub updated_at: String }

#[derive(Clone, Debug, Serialize)]
pub struct ReturnPreview {
    pub package_root: String, pub plan_token: String,
    pub home_updates: usize, pub new_home_files: usize, pub nas_updates: usize,
    pub unchanged: usize, pub nas_only: usize, pub retained_home_deletions: usize,
    pub to_drive: usize, pub to_nas: usize, pub drive_blocked: bool,
    pub conflicts: usize, pub files_truncated: usize, pub files: Vec<PreviewFile>,
}
#[derive(Clone, Debug, Serialize)]
pub struct ChangeStatus {
    // None means metadata cannot establish content equality. The operation
    // must verify it; it does NOT mean that a transfer is already required.
    pub to_drive:Option<usize>, pub to_nas:Option<usize>, pub drive_blocked:bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct PreviewFile { pub path: String, pub action: String }

#[derive(Clone, Debug, Serialize)]
pub struct ArchiveVersion { pub id:String, pub path:String, pub archived_at:String, pub size:u64 }

#[derive(Clone, Debug, Serialize)]
pub struct ArchiveListing { pub versions:Vec<ArchiveVersion>, pub truncated:bool }

#[derive(Clone, Debug, Serialize)]
pub struct TakeHomeProgress {
    pub operation_id:String, pub phase:String, pub current_file:String,
    pub bytes_done:u64, pub bytes_total:u64, pub files_done:usize, pub files_total:usize,
}

struct ProgressReporter { #[cfg(not(test))] app:AppHandle, #[cfg(test)] on_file_done:Option<Box<dyn FnMut(usize)>>, operation_id:String, phase:String, current_file:String, bytes_done:u64, bytes_total:u64, files_done:usize, files_total:usize, last_emit:Instant }
impl ProgressReporter {
    fn new(_app:AppHandle,operation_id:String)->Self{Self{#[cfg(not(test))] app:_app,#[cfg(test)] on_file_done:None,operation_id,phase:"Starting".into(),current_file:String::new(),bytes_done:0,bytes_total:0,files_done:0,files_total:0,last_emit:Instant::now()}}
    fn send(&mut self,force:bool){if !force&&self.last_emit.elapsed().as_millis()<100{return;}self.last_emit=Instant::now();let progress=TakeHomeProgress{operation_id:self.operation_id.clone(),phase:self.phase.clone(),current_file:self.current_file.clone(),bytes_done:self.bytes_done,bytes_total:self.bytes_total,files_done:self.files_done,files_total:self.files_total};#[cfg(not(test))] {let _=self.app.emit("pepper-takehome-progress",progress);}#[cfg(test)] drop(progress);}
    fn begin(&mut self,phase:&str,total:u64,files:usize){self.phase=phase.into();self.current_file.clear();self.bytes_done=0;self.bytes_total=total.max(1);self.files_done=0;self.files_total=files;self.send(true);}
    fn file(&mut self,path:&str){self.current_file=path.into();self.send(false);}
    fn advance(&mut self,phase:&str,bytes:u64){self.phase=phase.into();self.bytes_done=self.bytes_done.saturating_add(bytes).min(self.bytes_total);self.send(false);}
    fn file_done(&mut self){self.files_done=self.files_done.saturating_add(1).min(self.files_total);self.send(false);#[cfg(test)] if let Some(hook)=&mut self.on_file_done{hook(self.files_done);}}
    fn finish(&mut self,phase:&str){self.phase=phase.into();self.bytes_done=self.bytes_total;self.files_done=self.files_total;self.current_file.clear();self.send(true);}
}

#[derive(Clone, Debug, Serialize)]
enum Action { HomeToNas(String), NewHomeToNas(String), ConflictHomeToNas(String), NasToHome(String), Unchanged(String), NasOnly(String), HomeDeletion(String) }
struct ReturnPlan { actions:Vec<Action>, home:BTreeMap<String,FileRecord>, nas:BTreeMap<String,FileRecord> }
impl Action { fn preview(&self) -> PreviewFile { match self {
    Self::HomeToNas(p)=>PreviewFile{path:p.clone(),action:"Use home copy on NAS".into()},
    Self::NewHomeToNas(p)=>PreviewFile{path:p.clone(),action:"Add new home file to NAS".into()},
    Self::ConflictHomeToNas(p)=>PreviewFile{path:p.clone(),action:"Home copy wins; preserve previous NAS version".into()},
    Self::NasToHome(p)=>PreviewFile{path:p.clone(),action:"Keep newer NAS copy and update drive".into()},
    Self::Unchanged(p)=>PreviewFile{path:p.clone(),action:"No change".into()},
    Self::NasOnly(p)=>PreviewFile{path:p.clone(),action:"Keep NAS-only file".into()},
    Self::HomeDeletion(p)=>PreviewFile{path:p.clone(),action:"Keep NAS file (not deleted)".into()},
} } }

// Cache content digests only with a filesystem change stamp and file identity.
// Unsupported filesystems fall back to hashing. This cache never verifies a copy.
#[derive(Clone)]
struct CachedHash { stamp:Vec<u64>, record:FileRecord, checked:Instant }
static HASH_CACHE:OnceLock<Mutex<BTreeMap<PathBuf,CachedHash>>>=OnceLock::new();
fn hash_cache()->&'static Mutex<BTreeMap<PathBuf,CachedHash>> { HASH_CACHE.get_or_init(||Mutex::new(BTreeMap::new())) }
fn remember_verified_file(path:&Path,file:&fs::File,record:&FileRecord){
    if let (Some(stamp),Ok(mut cache))=(file_stamp(file),hash_cache().lock()){
        if cache.len()>=20_000{cache.retain(|_,entry|entry.checked.elapsed()<Duration::from_secs(600));if cache.len()>=20_000{cache.clear();}}
        cache.insert(path.to_path_buf(),CachedHash{stamp,record:record.clone(),checked:Instant::now()});
    }
}

#[cfg(windows)]
fn file_stamp(file:&fs::File)->Option<Vec<u64>> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{Foundation::HANDLE,Storage::FileSystem::{GetFileInformationByHandle,GetFileInformationByHandleEx,FileBasicInfo,FILE_BASIC_INFO,BY_HANDLE_FILE_INFORMATION}};
    let handle=HANDLE(file.as_raw_handle());
    let mut basic=FILE_BASIC_INFO::default();let mut identity=BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        GetFileInformationByHandleEx(handle,FileBasicInfo,&mut basic as *mut _ as *mut _,std::mem::size_of::<FILE_BASIC_INFO>() as u32).ok()?;
        GetFileInformationByHandle(handle,&mut identity).ok()?;
    }
    if basic.ChangeTime==0 || (identity.nFileIndexHigh==0&&identity.nFileIndexLow==0){return None;}
    Some(vec![basic.CreationTime as u64,basic.LastWriteTime as u64,basic.ChangeTime as u64,identity.dwVolumeSerialNumber as u64,identity.nFileIndexHigh as u64,identity.nFileIndexLow as u64,identity.nFileSizeHigh as u64,identity.nFileSizeLow as u64])
}
#[cfg(unix)]
fn file_stamp(file:&fs::File)->Option<Vec<u64>> {
    use std::os::unix::fs::MetadataExt;
    let m=file.metadata().ok()?;Some(vec![m.dev(),m.ino(),m.len(),m.mtime() as u64,m.mtime_nsec() as u64,m.ctime() as u64,m.ctime_nsec() as u64])
}
#[cfg(not(any(windows,unix)))]
fn file_stamp(_file:&fs::File)->Option<Vec<u64>> { None }

fn hash_open_file(file:&mut fs::File,path:&Path,mut progress:impl FnMut(u64))->Result<FileRecord,String>{
    let before=file.metadata().map_err(|e|e.to_string())?;let stamp=file_stamp(file);
    let mut digest=Sha256::new(); let mut buffer=vec![0u8;1024*1024];let mut size=0u64;
    loop { let count=file.read(&mut buffer).map_err(|e|format!("Could not hash {}: {e}",path.display()))?; if count==0 {break;} digest.update(&buffer[..count]);size+=count as u64;progress(count as u64); }
    let after=file.metadata().map_err(|e|e.to_string())?;
    if before.len()!=size||after.len()!=size||before.modified().ok()!=after.modified().ok()||stamp!=file_stamp(file){return Err(format!("File changed while checking: {}",path.display()));}
    Ok(FileRecord{path:String::new(),size,sha256:format!("{:x}",digest.finalize())})
}
#[cfg(test)]
fn hash_file_with_progress(path:&Path,progress:impl FnMut(u64))->Result<FileRecord,String>{
    let mut file=open_stable_source(path)?;
    hash_open_file(&mut file,path,progress)
}
fn checked_hash(path:&Path,mut progress:impl FnMut(u64))->Result<FileRecord,String>{
    let mut file=open_stable_source(path)?;
    let stamp=file_stamp(&file);
    if let Some(stamp)=&stamp {
        let cached=hash_cache().lock().map_err(|_|"Hash cache unavailable")?.get(path).filter(|entry|&entry.stamp==stamp&&entry.checked.elapsed()<Duration::from_secs(600)).cloned();
        if let Some(cached)=cached {progress(cached.record.size);return Ok(cached.record);}
    }
    let record=hash_open_file(&mut file,path,&mut progress)?;
    if let Some(stamp)=stamp.filter(|stamp|Some(stamp.clone())==file_stamp(&file)){
        let mut cache=hash_cache().lock().map_err(|_|"Hash cache unavailable")?;
        if cache.len()>=20_000 {cache.retain(|_,entry|entry.checked.elapsed()<Duration::from_secs(600));if cache.len()>=20_000{cache.clear();}}
        cache.insert(path.to_path_buf(),CachedHash{stamp,record:record.clone(),checked:Instant::now()});
    }
    Ok(record)
}
fn open_stable_source(path:&Path)->Result<fs::File,String>{
    let mut options=fs::OpenOptions::new();options.read(true);
    // Deny simultaneous writes while reading on Windows, including already-open
    // writers. Renames remain possible and are detected by the identity checks.
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(0x1|0x4);}
    options.open(path).map_err(|e|format!("Could not read a stable source {}: {e}",path.display()))
}

fn metadata_inventory(root:&Path)->Result<BTreeMap<String,FileRecord>,String>{
    let mut result=BTreeMap::new();
    for relative in file_paths(root)?{
        let path=safe_join(root,&relative)?;
        // No content reads and no source write lock for a background hint.
        let file=fs::File::open(&path).map_err(|e|e.to_string())?;
        let size=file.metadata().map_err(|e|e.to_string())?.len();
        let stamp=file_stamp(&file);
        let cached=hash_cache().lock().map_err(|_|"Hash cache unavailable")?.get(&path)
            .filter(|entry|Some(&entry.stamp)==stamp.as_ref()&&entry.checked.elapsed()<Duration::from_secs(600)).cloned();
        let sha256=cached.map_or_else(String::new,|entry|entry.record.sha256);
        result.insert(relative.clone(),FileRecord{path:relative,size,sha256});
    }
    Ok(result)
}

fn known_equal(left:&FileRecord,right:&FileRecord)->Option<bool>{
    if left.size!=right.size{Some(false)}
    else if !left.sha256.is_empty()&&!right.sha256.is_empty(){Some(left.sha256==right.sha256)}
    else{None}
}
fn metadata_directions(home:&BTreeMap<String,FileRecord>,nas:&BTreeMap<String,FileRecord>,manifest:&Manifest)->ChangeStatus{
    let baseline:BTreeMap<_,_>=manifest.files.iter().map(|r|(r.path.as_str(),r)).collect();
    let keys:BTreeSet<_>=home.keys().chain(nas.keys()).collect();
    let (mut drive,mut to_nas)=(0usize,0usize);
    let (mut drive_unknown,mut nas_unknown,mut blocked)=(false,false,false);
    for path in keys{
        let h=home.get(path);let n=nas.get(path);let base=baseline.get(path.as_str()).copied();
        let equal=match(h,n){(Some(h),Some(n))=>known_equal(h,n),_=>Some(false)};
        if n.is_some(){
            match equal{Some(true)=>{},Some(false)=>drive+=1,None=>drive_unknown=true}
        }
        if let Some(h)=h{
            let changed=base.map_or(Some(true),|base|known_equal(h,base).map(|same|!same));
            if n.is_none(){
                to_nas+=1;
                if changed==Some(true){blocked=true;}
                continue;
            }
            match (equal,changed){
                (Some(true),_)|(_,Some(false))=>{},
                (Some(false),Some(true))=>{to_nas+=1;blocked=true;},
                _=>nas_unknown=true,
            }
        }
    }
    ChangeStatus{to_drive:(!drive_unknown).then_some(drive),to_nas:(!nas_unknown).then_some(to_nas),drive_blocked:blocked}
}

fn status_sync(client_path:String,package_path:String)->Result<ChangeStatus,String>{
    let client=fs::canonicalize(client_path).map_err(|e|e.to_string())?;
    let package=fs::canonicalize(package_path).map_err(|e|e.to_string())?;
    let (manifest,_)=validate_package(&client,&package)?;
    let (home,nas)=align_inventory_paths(metadata_inventory(&package)?,metadata_inventory(&client)?,&manifest);
    Ok(metadata_directions(&home,&nas,&manifest))
}
#[tauri::command]
pub async fn takehome_status(client_path:String,package_path:String)->Result<ChangeStatus,String>{
    tauri::async_runtime::spawn_blocking(move||status_sync(client_path,package_path)).await.map_err(|e|e.to_string())?
}

fn inventory_with_progress(root:&Path,reporter:&mut ProgressReporter,phase:&str)->Result<BTreeMap<String,FileRecord>,String>{
    reporter.begin(if phase=="Checking drive"{"Listing drive files"}else{"Listing NAS files"},1,0);
    let paths=file_paths(root)?;let mut total=0u64;
    for relative in &paths {total=total.saturating_add(fs::metadata(safe_join(root,relative)?).map_err(|e|e.to_string())?.len());}
    reporter.begin(phase,total,paths.len());let mut result=BTreeMap::new();
    for relative in paths {reporter.file(&relative);let mut record=checked_hash(&safe_join(root,&relative)?,|bytes|reporter.advance(phase,bytes))?;record.path=relative.clone();result.insert(relative,record);reporter.file_done();}
    reporter.finish(phase);Ok(result)
}

fn safe_relative(raw: &str) -> Result<PathBuf,String> {
    let normalized=raw.replace('\\',"/"); let path=Path::new(&normalized);
    if normalized.is_empty() || path.is_absolute() || path.components().any(|c|!matches!(c,Component::Normal(_)))
        || normalized.split('/').any(|part|part.is_empty() || part=="." || part==".." || part.contains(':') || part.ends_with(['.',' ']) || part.eq_ignore_ascii_case(META_DIR) || part.eq_ignore_ascii_case(DRIVE_MANIFEST)) {
        return Err(format!("Unsafe package path: {raw}"));
    }
    Ok(path.to_path_buf())
}

fn rel_string(path: &Path) -> String { path.components().map(|c|c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/") }

fn is_link(metadata:&fs::Metadata)->bool{
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if metadata.file_attributes()&0x400!=0{return true;} }
    metadata.file_type().is_symlink()
}
fn check_metadata_dir(root:&Path)->Result<(),String>{
    match fs::symlink_metadata(root.join(META_DIR)){
        Ok(m) if is_link(&m)||!m.is_dir()=>Err("Package metadata must be a real folder, not a link.".into()),
        Ok(_)=>Ok(()),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),Err(e)=>Err(e.to_string())
    }
}
fn safe_join(root:&Path,relative:&str)->Result<PathBuf,String>{
    match fs::symlink_metadata(root){
        Ok(m) if is_link(&m)||!m.is_dir()=>return Err("Transfer root must be a real folder.".into()),
        Ok(_)=>{},Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>return Err(e.to_string())
    }
    let relative=safe_relative(relative)?;let mut path=root.to_path_buf();
    for part in relative.components(){
        path.push(part);
        match fs::symlink_metadata(&path){
            Ok(m) if is_link(&m)=>return Err(format!("Linked paths cannot be transferred: {}",path.display())),
            Ok(_)=>{},Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>return Err(e.to_string())
        }
    }
    Ok(path)
}

// OS locks are released on process exit/disconnection. Never delete a live lock
// based on its age; a large copy can legitimately run for hours.
struct TransferLocks { _files:Vec<fs::File> }
impl TransferLocks{
    fn acquire(roots:&[&Path])->Result<Self,String>{
        let mut roots:Vec<_>=roots.iter().map(|p|p.to_path_buf()).collect();roots.sort();roots.dedup();
        let mut files=Vec::new();
        for root in roots{
            check_metadata_dir(&root)?;ensure_hidden_dir(&root.join(META_DIR))?;
            let path=root.join(META_DIR).join("transfer.lock");
            if fs::symlink_metadata(&path).is_ok_and(|m|is_link(&m)||!m.is_file()){return Err("Transfer lock is not a regular file.".into());}
            let file=fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).map_err(|e|e.to_string())?;
            file.try_lock().map_err(|error|match error{
                fs::TryLockError::WouldBlock=>"Another Drive operation is using this client or drive. Wait for it to finish.".to_string(),
                fs::TryLockError::Error(error)=>format!("Could not lock this location safely: {error}")
            })?;
            files.push(file);
        }
        Ok(Self{_files:files})
    }
}

fn file_paths(root:&Path)->Result<Vec<String>,String>{
    let mut result=Vec::new();
    for entry in WalkDir::new(root).follow_links(false).min_depth(1).into_iter().filter_entry(|e|e.file_name()!=std::ffi::OsStr::new(META_DIR)) {
        let entry=entry.map_err(|e|format!("Could not scan client files: {e}"))?;
        if is_link(&fs::symlink_metadata(entry.path()).map_err(|e|e.to_string())?){return Err(format!("A linked folder or file must be resolved before packaging: {}",entry.path().display()));}
        if !entry.file_type().is_file() || is_staging_name(entry.file_name()){continue;}
        let relative=entry.path().strip_prefix(root).map_err(|e|e.to_string())?;
        if relative.components().count()==1&&entry.file_name()==std::ffi::OsStr::new(DRIVE_MANIFEST){continue;}
        let key=rel_string(relative);safe_relative(&key)?;result.push(key);
    }
    result.sort();
    #[cfg(windows)] {let mut names=BTreeSet::new();if result.iter().any(|p|!names.insert(p.to_lowercase())){return Err("Case-colliding filenames must be renamed before transfer.".into());}}
    Ok(result)
}

fn copy_empty_and_parent_directories(source:&Path,destination:&Path)->Result<(),String>{
    for entry in WalkDir::new(source).follow_links(false).min_depth(1).into_iter().filter_entry(|e|e.file_name()!=std::ffi::OsStr::new(META_DIR)) {
        let entry=entry.map_err(|e|format!("Could not scan client folders: {e}"))?;
        if is_link(&fs::symlink_metadata(entry.path()).map_err(|e|e.to_string())?){return Err(format!("A linked folder or file must be resolved before packaging: {}",entry.path().display()));}
        if !entry.file_type().is_dir(){continue;}
        let relative=entry.path().strip_prefix(source).map_err(|e|e.to_string())?;
        safe_relative(&rel_string(relative))?;
        fs::create_dir_all(safe_join(destination,&rel_string(relative))?).map_err(|e|format!("Could not create package folder {}: {e}",relative.display()))?;
    }
    Ok(())
}

fn manifest_path(package: &Path) -> PathBuf { package.join(DRIVE_MANIFEST) }
fn state_path(client: &Path) -> PathBuf { client.join(META_DIR).join("state.json") }
fn is_staging_name(name:&std::ffi::OsStr)->bool {
    let name=name.to_string_lossy();
    if let Some(id)=name.strip_prefix(".pepper-copy-").and_then(|s|s.strip_suffix(".partial")) {
        Uuid::parse_str(id).is_ok()
    } else { name.strip_prefix(".pepper-state-").and_then(|s|s.strip_suffix(".partial")).is_some_and(|id|Uuid::parse_str(id).is_ok()) }
}
fn cleanup_staging(root:&Path)->Result<(),String>{
    for entry in WalkDir::new(root).follow_links(false).min_depth(1).into_iter().filter_entry(|e|fs::symlink_metadata(e.path()).is_ok_and(|m|!is_link(&m))){
        let entry=entry.map_err(|e|e.to_string())?;
        if entry.file_type().is_file()&&is_staging_name(entry.file_name()){
            fs::remove_file(entry.path()).map_err(|e|format!("Could not clear an interrupted transfer temporary file: {e}"))?;
        }
    }
    Ok(())
}
fn read_manifest(path: &Path) -> Result<Manifest,String> {
    let metadata=fs::symlink_metadata(path).map_err(|e|format!("Could not inspect package manifest {}: {e}",path.display()))?;
    if is_link(&metadata) || !metadata.is_file() || metadata.len()>64*1024*1024 { return Err("Package manifests must be regular files smaller than 64 MB.".into()); }
    let bytes=fs::read(path).map_err(|e|format!("Could not read package manifest {}: {e}",path.display()))?;
    let value:Manifest=serde_json::from_slice(&bytes).map_err(|e|format!("Package manifest is invalid: {e}"))?;
    if value.schema!=1 && value.schema!=SCHEMA { return Err("This package was created by an incompatible Pepper version.".into()); }
    if value.package_id.is_empty(){return Err("Package identity is missing.".into());}
    let mut paths=BTreeSet::new();
    for entry in &value.files {
        safe_relative(&entry.path)?;
        if !paths.insert(entry.path.to_lowercase()) || entry.sha256.len()!=64 || !entry.sha256.bytes().all(|c|c.is_ascii_hexdigit()){return Err("Package manifest contains duplicate paths or invalid checksums.".into());}
    }
    Ok(value)
}

fn write_manifest(path: &Path, manifest: &Manifest) -> Result<(),String> {
    write_json_atomic(path,manifest)
}
fn write_json_atomic(path:&Path,value:&impl Serialize)->Result<(),String>{
    let parent=path.parent().ok_or("Manifest has no parent folder")?; fs::create_dir_all(parent).map_err(|e|e.to_string())?;
    let temp=parent.join(format!(".pepper-state-{}.partial",Uuid::new_v4()));
    let bytes=serde_json::to_vec_pretty(value).map_err(|e|e.to_string())?;
    let result=(||{
        let mut output=fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e|e.to_string())?;
        output.write_all(&bytes).and_then(|_|output.sync_all()).map_err(|e|format!("Could not flush package state: {e}"))?;
        drop(output);replace_staged(&temp,path)
    })();
    if result.is_err(){let _=fs::remove_file(&temp);}
    result?;
    if path.file_name().is_some_and(|name|name==std::ffi::OsStr::new(DRIVE_MANIFEST)) { mark_hidden(path)?; }
    Ok(())
}

fn pending_path(client:&Path)->PathBuf { client.join(META_DIR).join("pending-state.json") }
fn commit_pair(client:&Path,package:&Path,next:&Manifest)->Result<(),String>{
    // This flushed record makes a two-location manifest update recoverable.
    write_manifest(&pending_path(client),next)?;
    write_manifest(&manifest_path(package),next)?;
    write_manifest(&state_path(client),next)?;
    fs::remove_file(pending_path(client)).map_err(|e|format!("Transfer completed but checkpoint cleanup failed: {e}"))
}
fn recover_pair(client:&Path,package:&Path)->Result<(),String>{
    if pending_path(client).try_exists().map_err(|e|e.to_string())?{
        let (effective,_)=validate_package(client,package)?;
        commit_pair(client,package,&effective)?;
    }
    Ok(())
}

#[cfg(windows)]
fn mark_hidden(path:&Path)->Result<(),String>{
    use std::os::windows::ffi::OsStrExt;
    #[link(name="kernel32")]
    unsafe extern "system"{fn GetFileAttributesW(path:*const u16)->u32;fn SetFileAttributesW(path:*const u16,attributes:u32)->i32;}
    let wide:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();
    let attrs=unsafe{GetFileAttributesW(wide.as_ptr())};
    if attrs==u32::MAX{return Err(format!("Could not inspect package metadata attributes: {}",std::io::Error::last_os_error()));}
    if unsafe{SetFileAttributesW(wide.as_ptr(),attrs|0x2)}==0{return Err(format!("Could not hide package metadata: {}",std::io::Error::last_os_error()));}
    Ok(())
}
#[cfg(not(windows))]
fn mark_hidden(_path:&Path)->Result<(),String>{Ok(())}

fn ensure_hidden_dir(path:&Path)->Result<(),String>{fs::create_dir_all(path).map_err(|e|e.to_string())?;mark_hidden(path)}

#[cfg(windows)]
fn replace_staged(staged:&Path,destination:&Path)->Result<(),String>{
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{MoveFileExW,MOVEFILE_REPLACE_EXISTING,MOVEFILE_WRITE_THROUGH};
    let from:Vec<u16>=staged.as_os_str().encode_wide().chain(Some(0)).collect();
    let to:Vec<u16>=destination.as_os_str().encode_wide().chain(Some(0)).collect();
    let flags=MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH;
    match unsafe{MoveFileExW(windows::core::PCWSTR(from.as_ptr()),windows::core::PCWSTR(to.as_ptr()),flags)} {
        Ok(())=>Ok(()),
        Err(first)=>{
            #[link(name="kernel32")]
            unsafe extern "system"{fn GetFileAttributesW(path:*const u16)->u32;fn SetFileAttributesW(path:*const u16,attributes:u32)->i32;}
            let attrs=unsafe{GetFileAttributesW(to.as_ptr())};
            if attrs==u32::MAX || attrs&0x1==0 { return Err(format!("Could not install {}: {first}",destination.display())); }
            if unsafe{SetFileAttributesW(to.as_ptr(),attrs&!0x1)}==0 { return Err(format!("Could not replace read-only file {}: {}",destination.display(),std::io::Error::last_os_error())); }
            match unsafe{MoveFileExW(windows::core::PCWSTR(from.as_ptr()),windows::core::PCWSTR(to.as_ptr()),flags)} {
                Ok(())=>Ok(()),
                Err(error)=>{let _=unsafe{SetFileAttributesW(to.as_ptr(),attrs)};Err(format!("Could not install {}: {error}",destination.display()))}
            }
        }
    }
}
#[cfg(not(windows))]
fn replace_staged(staged:&Path,destination:&Path)->Result<(),String>{
    fs::rename(staged,destination).map_err(|e|format!("Could not install {}: {e}",destination.display()))
}

#[cfg(test)]
fn copy_verified_record_with_progress(source:&Path,destination:&Path,expected:Option<&FileRecord>,mut progress:impl FnMut(&str,u64))->Result<FileRecord,String>{
    copy_verified_guarded(source,destination,expected,&mut progress,||Ok(()))
}
fn copy_verified_guarded(source:&Path,destination:&Path,expected:Option<&FileRecord>,mut progress:impl FnMut(&str,u64),mut before_install:impl FnMut()->Result<(),String>)->Result<FileRecord,String>{
    let parent=destination.parent().ok_or("Destination has no parent folder")?;
    fs::create_dir_all(parent).map_err(|e|format!("Could not create {}: {e}",parent.display()))?;
    let staged=parent.join(format!(".pepper-copy-{}.partial",Uuid::new_v4()));
    let result=(|| {
        let mut input=open_stable_source(source)?;
        let before=input.metadata().map_err(|e|e.to_string())?;let stamp=file_stamp(&input);
        ensure_copy_space(parent,before.len())?;
        let mut output=fs::OpenOptions::new().write(true).create_new(true).open(&staged).map_err(|e|format!("Could not stage {}: {e}",destination.display()))?;
        let mut digest=Sha256::new();let mut buffer=vec![0u8;1024*1024];let mut size=0u64;
        loop {let count=input.read(&mut buffer).map_err(|e|format!("Could not read {}: {e}",source.display()))?;if count==0{break;}output.write_all(&buffer[..count]).map_err(|e|format!("Could not write {}: {e}",destination.display()))?;digest.update(&buffer[..count]);size=size.saturating_add(count as u64);progress("Copying",count as u64);}
        output.sync_all().map_err(|e|format!("Could not flush {}: {e}",destination.display()))?;
        drop(output);
        let source_hash=FileRecord{path:String::new(),size,sha256:format!("{:x}",digest.finalize())};
        let after=input.metadata().map_err(|e|e.to_string())?;
        if before.len()!=size||after.len()!=size||before.modified().ok()!=after.modified().ok()||stamp!=file_stamp(&input)||expected.is_some_and(|r|r.size!=size||r.sha256!=source_hash.sha256){return Err(format!("Source changed since checking: {}",source.display()));}
        filetime::set_file_mtime(&staged,filetime::FileTime::from_last_modification_time(&before)).map_err(|e|format!("Could not preserve the modified time for {}: {e}",source.display()))?;
        // Keep the verified file handle open through installation. Its sharing
        // mode prevents writes, so its post-rename stamp can safely seed the
        // metadata-only status cache without another content read.
        let mut verified=open_stable_source(&staged)?;
        let staged_hash=hash_open_file(&mut verified,&staged,|bytes|progress("Verifying",bytes))?;
        if source_hash.size!=staged_hash.size || source_hash.sha256!=staged_hash.sha256 { return Err(format!("Copy verification failed for {}",source.display())); }
        let source_metadata=fs::metadata(source).map_err(|e|e.to_string())?;
        let current=fs::File::open(source).map_err(|e|e.to_string())?;
        if source_metadata.len()!=before.len()||source_metadata.modified().ok()!=before.modified().ok()||stamp!=file_stamp(&current){return Err(format!("Source changed during verification: {}",source.display()));}
        before_install()?;
        let final_source=fs::File::open(source).map_err(|e|e.to_string())?;
        let final_metadata=final_source.metadata().map_err(|e|e.to_string())?;
        if final_metadata.len()!=before.len()||final_metadata.modified().ok()!=before.modified().ok()||stamp!=file_stamp(&final_source){return Err(format!("Source changed before installation: {}",source.display()));}
        replace_staged(&staged,destination)?;
        remember_verified_file(source,&input,&source_hash);
        remember_verified_file(destination,&verified,&source_hash);
        Ok(source_hash)
    })();
    if result.is_err() { let _=fs::remove_file(staged); }
    result
}

#[cfg(windows)]
fn ensure_copy_space(folder:&Path,size:u64)->Result<(),String>{
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let path:Vec<u16>=folder.as_os_str().encode_wide().chain(Some(0)).collect();let mut free=0u64;
    unsafe{GetDiskFreeSpaceExW(windows::core::PCWSTR(path.as_ptr()),Some(&mut free),None,None)}.map_err(|e|format!("Could not check destination space: {e}"))?;
    if free<size.saturating_add(1024*1024){return Err(format!("Not enough destination space for this file: need {size} bytes; {free} bytes available."));}Ok(())
}
#[cfg(not(windows))]
fn ensure_copy_space(_folder:&Path,_size:u64)->Result<(),String>{Ok(())}

fn check_destination(path:&Path,expected:Option<&FileRecord>)->Result<(),String>{
    match (fs::symlink_metadata(path),expected){
        (Err(e),None) if e.kind()==std::io::ErrorKind::NotFound=>Ok(()),
        (Ok(m),Some(expected)) if m.is_file()&&!is_link(&m)=>{
            let current=checked_hash(path,|_|{})?;
            if current.size==expected.size&&current.sha256==expected.sha256{Ok(())}else{Err(format!("Destination changed after checking; it was not replaced: {}",path.display()))}
        },
        (Err(e),_) if e.kind()!=std::io::ErrorKind::NotFound=>Err(e.to_string()),
        _=>Err(format!("Destination changed after checking; it was not replaced: {}",path.display()))
    }
}
fn copy_planned(source_root:&Path,destination_root:&Path,relative:&str,source:&FileRecord,destination:Option<&FileRecord>,progress:impl FnMut(&str,u64))->Result<FileRecord,String>{
    let src=safe_join(source_root,relative)?;let dst=safe_join(destination_root,relative)?;
    check_destination(&dst,destination)?;
    copy_verified_guarded(&src,&dst,Some(source),progress,||{
        safe_join(source_root,relative)?;safe_join(destination_root,relative)?;check_destination(&dst,destination)
    })
}

fn validate_client(project_root: &str, client_path: &str) -> Result<(PathBuf,PathBuf),String> {
    let root=fs::canonicalize(project_root).map_err(|e|format!("Could not access project root: {e}"))?;
    let client=fs::canonicalize(client_path).map_err(|e|format!("Could not access client folder: {e}"))?;
    if !client.starts_with(&root) || client==root || !client.is_dir() { return Err("Choose a client folder inside the selected project.".into()); }
    match fs::symlink_metadata(client.join(META_DIR)) {
        Ok(metadata) => if is_link(&metadata) || !metadata.is_dir() { return Err("The reserved Pepper package metadata path must be a real folder, not a file or linked folder.".into()); },
        Err(e) if e.kind()==std::io::ErrorKind::NotFound => {},
        Err(e)=>return Err(format!("Could not inspect package metadata folder: {e}")),
    }
    Ok((root,client))
}

fn validate_package(client: &Path, package: &Path) -> Result<(Manifest,Manifest),String> {
    let package=fs::canonicalize(package).map_err(|e|format!("Could not access portable package: {e}"))?;
    if !package.is_dir() || package==client || package.starts_with(client) || client.starts_with(&package) { return Err("Select the client package folder on the portable drive, outside the NAS client.".into()); }
    check_metadata_dir(client)?;check_metadata_dir(&package)?;
    let optional=|path:&Path|->Result<Option<Manifest>,String>{if path.try_exists().map_err(|e|e.to_string())?{read_manifest(path).map(Some)}else{Ok(None)}};
    let drive=optional(&manifest_path(&package))?;
    let state=optional(&state_path(client))?;
    let pending=optional(&pending_path(client))?;
    let identity=drive.as_ref().or(state.as_ref()).or(pending.as_ref()).ok_or("No package manifest found.")?;
    if identity.client_name!=client.file_name().unwrap_or_default().to_string_lossy()
        || drive.iter().chain(state.iter()).chain(pending.iter()).any(|m|m.package_id!=identity.package_id||m.client_name!=identity.client_name) {
        return Err("This drive package does not match the selected NAS client.".into());
    }
    if let Some(pending)=pending{
        if drive.is_none() && fs::canonicalize(&pending.package_path).ok().as_ref()!=Some(&package){return Err("The unfinished package belongs to another drive folder.".into());}
        let newest=drive.iter().chain(state.iter()).map(|m|m.revision).max().unwrap_or(0);
        if pending.revision<newest||pending.revision>newest.saturating_add(1){return Err("The interrupted package checkpoint is inconsistent.".into());}
        return Ok((pending.clone(),pending));
    }
    let drive=drive.ok_or("The drive package manifest is missing.")?;let state=state.ok_or("The NAS package state is missing.")?;
    if drive.schema!=state.schema||drive.revision!=state.revision||drive.files!=state.files{return Err("The drive and NAS package checkpoints disagree. Keep both copies; do not overwrite their metadata.".into());}
    Ok((drive,state))
}

fn records(map: BTreeMap<String,FileRecord>) -> Vec<FileRecord> { map.into_values().collect() }
fn package_info(package: &Path, manifest: &Manifest) -> PackageInfo { PackageInfo{package_root:package.to_string_lossy().into_owned(),package_id:manifest.package_id.clone(),files:manifest.files.len(),updated_at:manifest.updated_at.clone()} }

#[tauri::command]
pub async fn takehome_prepare(app:AppHandle,operation_id:String,project_root:String,client_path:String,destination_parent:String)->Result<PackageInfo,String>{
    tauri::async_runtime::spawn_blocking(move||prepare_sync(app,operation_id,project_root,client_path,destination_parent)).await.map_err(|e|e.to_string())?
}
fn prepare_sync(app:AppHandle,operation_id:String,project_root:String,client_path:String,destination_parent:String)->Result<PackageInfo,String>{
    let mut reporter=ProgressReporter::new(app,operation_id);
    prepare_with_reporter(project_root,client_path,destination_parent,&mut reporter)
}
fn prepare_with_reporter(project_root:String,client_path:String,destination_parent:String,reporter:&mut ProgressReporter)->Result<PackageInfo,String>{
    let (_root,client)=validate_client(&project_root,&client_path)?;
    let _locks=TransferLocks::acquire(&[&client])?;
    if client.join(DRIVE_MANIFEST).exists() { return Err(format!("The client already contains the reserved package metadata name {DRIVE_MANIFEST}. Rename that file before preparing a take-home package.")); }
    if state_path(&client).try_exists().map_err(|e|e.to_string())?||pending_path(&client).try_exists().map_err(|e|e.to_string())? { return Err("This client already has a take-home package. Select its existing package to update or bring work back.".into()); }
    let parent=fs::canonicalize(&destination_parent).map_err(|e|format!("Could not access the selected drive folder: {e}"))?;
    if !parent.is_dir() || parent.starts_with(&client) || parent.starts_with(&_root) { return Err("Choose a writable folder on the portable drive, outside this project.".into()); }
    let name=client.file_name().ok_or("Client folder has no name")?;
    let package=parent.join(name);
    if package.exists() { return Err(format!("The destination already contains '{}'. Choose another folder or select its existing package.",name.to_string_lossy())); }
    fs::create_dir(&package).map_err(|e|format!("Could not create a new package folder: {e}"))?;
    let _drive_lock=TransferLocks::acquire(&[&package])?;
    let result=(|| {
        reporter.begin("Listing client files",1,0);
        let source=file_paths(&client)?;
        let mut total=0u64;for relative in &source{total=total.saturating_add(fs::metadata(client.join(safe_relative(relative)?)).map_err(|e|e.to_string())?.len());}
        reporter.begin("Copying",total.saturating_mul(2),source.len());
        copy_empty_and_parent_directories(&client,&package)?;
        let mut copied=BTreeMap::new();
        let mut manifest=Manifest{schema:SCHEMA,revision:0,package_path:package.to_string_lossy().into_owned(),package_id:Uuid::new_v4().to_string(),client_name:name.to_string_lossy().into_owned(),client_path:client.to_string_lossy().into_owned(),updated_at:Utc::now().to_rfc3339(),files:Vec::new()};
        commit_pair(&client,&package,&manifest)?;
        for relative in source {
            reporter.file(&relative);let src=safe_join(&client,&relative)?;let dst=safe_join(&package,&relative)?;
            let mut record=copy_verified_guarded(&src,&dst,None,|phase,bytes|reporter.advance(phase,bytes),||{safe_join(&client,&relative)?;safe_join(&package,&relative)?;check_destination(&dst,None)})?;
            record.path=relative.clone();copied.insert(relative,record);
            manifest.files=records(copied.clone());manifest.revision+=1;manifest.updated_at=Utc::now().to_rfc3339();
            commit_pair(&client,&package,&manifest)?;reporter.file_done();
        }
        reporter.finish("Complete");Ok(package_info(&package,&manifest))
    })();
    result.map_err(|error:String|format!("{error} Verified files were kept in {}. Reconnect this package to resume.",package.display()))
}

#[tauri::command]
pub async fn takehome_validate(client_path:String,package_path:String)->Result<PackageInfo,String>{
    tauri::async_runtime::spawn_blocking(move||{let client=fs::canonicalize(client_path).map_err(|e|e.to_string())?;let package=fs::canonicalize(package_path).map_err(|e|e.to_string())?;let (drive,_)=validate_package(&client,&package)?;Ok(package_info(&package,&drive))}).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn takehome_update(app:AppHandle,operation_id:String,client_path:String,package_path:String)->Result<PackageInfo,String>{
    tauri::async_runtime::spawn_blocking(move||update_sync(app,operation_id,client_path,package_path)).await.map_err(|e|e.to_string())?
}
fn update_sync(app:AppHandle,operation_id:String,client_path:String,package_path:String)->Result<PackageInfo,String>{
    let mut reporter=ProgressReporter::new(app,operation_id);
    update_with_reporter(client_path,package_path,&mut reporter)
}
fn update_with_reporter(client_path:String,package_path:String,reporter:&mut ProgressReporter)->Result<PackageInfo,String>{
    let client=fs::canonicalize(client_path).map_err(|e|format!("Could not access client: {e}"))?; let package=fs::canonicalize(package_path).map_err(|e|format!("Could not access package: {e}"))?;
    let _locks=TransferLocks::acquire(&[&client,&package])?;recover_pair(&client,&package)?;
    let (drive,state)=validate_package(&client,&package)?; let baseline: BTreeMap<_,_>=drive.files.iter().map(|f|(f.path.clone(),f.clone())).collect();
    let home=inventory_with_progress(&package,reporter,"Checking drive")?;
    let nas=inventory_with_progress(&client,reporter,"Checking NAS")?;
    let (home,nas)=align_inventory_paths(home,nas,&drive);
    for (path,now) in &home { if baseline.get(path).map_or(true,|old|old.sha256!=now.sha256) && nas.get(path).map(|n|n.sha256.as_str())!=Some(now.sha256.as_str()) { return Err(format!("Home edits must be brought back before updating the drive. First changed file: {path}")); } }
    let updates:Vec<_>=nas.iter().filter(|(path,record)|home.get(*path).map_or(true,|old|old.sha256!=record.sha256)).map(|(path,record)|(path.clone(),record.clone())).collect();
    if updates.is_empty(){return Err("No NAS changes to copy to the drive.".into());}
    cleanup_staging(&package)?;
    let total=updates.iter().fold(0u64,|sum,(_,record)|sum.saturating_add(record.size.saturating_mul(2)));
    reporter.begin("Updating drive",total,updates.len());copy_empty_and_parent_directories(&client,&package)?;
    let mut merged=home.clone();let mut next=state;next.schema=SCHEMA;
    for (path,record) in &updates {
        reporter.file(path);let mut copied=copy_planned(&client,&package,path,record,home.get(path),|phase,bytes|reporter.advance(phase,bytes))?;
        copied.path=path.clone();merged.insert(path.clone(),copied);
        next.files=records(merged.clone());next.revision+=1;next.package_path=package.to_string_lossy().into_owned();next.updated_at=Utc::now().to_rfc3339();
        commit_pair(&client,&package,&next)?;reporter.file_done();
    }
    reporter.finish("Complete");Ok(package_info(&package,&next))
}

fn return_plan(client:&Path,package:&Path,manifest:&Manifest,reporter:&mut ProgressReporter)->Result<ReturnPlan,String>{
    let home=inventory_with_progress(package,reporter,"Checking drive")?; let nas=inventory_with_progress(client,reporter,"Checking NAS")?;
    let (home,nas)=align_inventory_paths(home,nas,manifest);
    Ok(plan_inventories(home,nas,manifest))
}
fn align_inventory_paths(home:BTreeMap<String,FileRecord>,nas:BTreeMap<String,FileRecord>,manifest:&Manifest)->(BTreeMap<String,FileRecord>,BTreeMap<String,FileRecord>){
    #[cfg(windows)] {
        let mut names:BTreeMap<String,String>=manifest.files.iter().map(|r|(r.path.to_lowercase(),r.path.clone())).collect();
        for path in nas.keys().chain(home.keys()){names.entry(path.to_lowercase()).or_insert_with(||path.clone());}
        let remap=|files:BTreeMap<String,FileRecord>|files.into_iter().map(|(path,mut record)|{let path=names[&path.to_lowercase()].clone();record.path=path.clone();(path,record)}).collect();
        (remap(home),remap(nas))
    }
    #[cfg(not(windows))] {let _=manifest;(home,nas)}
}
fn reconcile_common(client:&Path,package:&Path,manifest:&Manifest,plan:&ReturnPlan)->Result<Manifest,String>{
    let mut common:BTreeMap<_,_>=manifest.files.iter().map(|r|(r.path.clone(),r.clone())).collect();
    for (path,home) in &plan.home{
        if plan.nas.get(path).is_some_and(|nas|nas.sha256==home.sha256&&nas.size==home.size){common.insert(path.clone(),home.clone());}
    }
    let files=records(common);
    if files==manifest.files{return Ok(manifest.clone());}
    // Also recovers a process exit after installing a file but before its
    // checkpoint: only identical, checked bytes on BOTH sides advance baseline.
    let next=Manifest{schema:SCHEMA,files,revision:manifest.revision.saturating_add(1),package_path:package.to_string_lossy().into_owned(),updated_at:Utc::now().to_rfc3339(),..manifest.clone()};
    commit_pair(client,package,&next)?;Ok(next)
}
fn plan_inventories(home:BTreeMap<String,FileRecord>,nas:BTreeMap<String,FileRecord>,manifest:&Manifest)->ReturnPlan{
    let baseline:BTreeMap<_,_>=manifest.files.iter().map(|f|(f.path.clone(),f)).collect();
    let keys:BTreeSet<String>=home.keys().chain(nas.keys()).chain(baseline.keys()).cloned().collect(); let mut actions=Vec::new();
    for path in keys {
        let h=home.get(&path);let n=nas.get(&path);let b=baseline.get(&path).copied();
        let home_changed=match (h,b){(Some(current),Some(base))=>current.sha256!=base.sha256,(Some(_),None)=>true,_=>false};
        let nas_changed=match (n,b){(Some(current),Some(base))=>current.sha256!=base.sha256,(Some(_),None)=>true,_=>false};
        if let (Some(h),Some(n))=(h,n){if h.sha256==n.sha256{actions.push(Action::Unchanged(path));continue;}}
        match (h,n,home_changed,nas_changed,b) {
            (Some(h),Some(n),true,true,_) if h.sha256!=n.sha256=>actions.push(Action::ConflictHomeToNas(path)),
            (Some(h),Some(n),true,_,_) if h.sha256!=n.sha256=>actions.push(Action::HomeToNas(path)),
            (Some(_),Some(_),false,true,Some(_))=>actions.push(Action::NasToHome(path)),
            (Some(_),Some(_),_,_,_)=>actions.push(Action::Unchanged(path)),
            (Some(_),None,_,_,None)=>actions.push(Action::NewHomeToNas(path)),
            (Some(_),None,_,_,Some(_))=>actions.push(Action::HomeToNas(path)),
            (None,Some(_),_,_,None)=>actions.push(Action::NasOnly(path)),
            (None,Some(_),_,_,Some(_))=>actions.push(Action::HomeDeletion(path)),
            (None,None,_,_,_)=>{},
        }
    }
    ReturnPlan{actions,home,nas}
}

fn direction_counts(plan:&ReturnPlan,manifest:&Manifest)->(usize,usize,bool){
    let baseline:BTreeMap<_,_>=manifest.files.iter().map(|r|(r.path.as_str(),r)).collect();
    let to_drive=plan.nas.iter().filter(|(path,record)|plan.home.get(*path).map_or(true,|home|home.sha256!=record.sha256)).count();
    let to_nas=plan.actions.iter().filter(|a|matches!(a,Action::HomeToNas(_)|Action::NewHomeToNas(_)|Action::ConflictHomeToNas(_))).count();
    let blocked=plan.home.iter().any(|(path,home)|baseline.get(path.as_str()).map_or(true,|base|base.sha256!=home.sha256)&&plan.nas.get(path).map_or(true,|nas|nas.sha256!=home.sha256));
    (to_drive,to_nas,blocked)
}

fn make_preview(package:&Path,plan:&ReturnPlan,manifest:&Manifest)->Result<ReturnPreview,String>{
    let actions=&plan.actions;
    // Put actionable files first so the preview limit cannot hide them behind unchanged media.
    let all_files:Vec<_>=actions.iter().filter(|a|matches!(a,Action::HomeToNas(_)|Action::NewHomeToNas(_)|Action::ConflictHomeToNas(_))).chain(actions.iter().filter(|a|!matches!(a,Action::HomeToNas(_)|Action::NewHomeToNas(_)|Action::ConflictHomeToNas(_)))).map(Action::preview).collect();
    let (to_drive,to_nas,drive_blocked)=direction_counts(plan,manifest);
    let serialized=serde_json::to_vec(&(actions,&plan.home,&plan.nas)).map_err(|e|e.to_string())?;let token=format!("{:x}",Sha256::digest(serialized));
    let files_truncated=all_files.len().saturating_sub(500);let files=all_files.into_iter().take(500).collect();
    Ok(ReturnPreview{to_drive,to_nas,drive_blocked,package_root:package.to_string_lossy().into_owned(),plan_token:token,
        home_updates:actions.iter().filter(|a|matches!(a,Action::HomeToNas(_))).count(),
        new_home_files:actions.iter().filter(|a|matches!(a,Action::NewHomeToNas(_))).count(),
        nas_updates:actions.iter().filter(|a|matches!(a,Action::NasToHome(_))).count(),
        unchanged:actions.iter().filter(|a|matches!(a,Action::Unchanged(_))).count(),nas_only:actions.iter().filter(|a|matches!(a,Action::NasOnly(_))).count(),
        retained_home_deletions:actions.iter().filter(|a|matches!(a,Action::HomeDeletion(_))).count(),conflicts:actions.iter().filter(|a|matches!(a,Action::ConflictHomeToNas(_))).count(),files_truncated,files})
}

#[tauri::command]
pub async fn takehome_return_preview(app:AppHandle,operation_id:String,client_path:String,package_path:String)->Result<ReturnPreview,String>{
    tauri::async_runtime::spawn_blocking(move||{
        let client=fs::canonicalize(client_path).map_err(|e|e.to_string())?;let package=fs::canonicalize(package_path).map_err(|e|e.to_string())?;
        let _locks=TransferLocks::acquire(&[&client,&package])?;recover_pair(&client,&package)?;
        let (drive,_)=validate_package(&client,&package)?;let mut reporter=ProgressReporter::new(app,operation_id);
        let plan=return_plan(&client,&package,&drive,&mut reporter)?;let drive=reconcile_common(&client,&package,&drive,&plan)?;
        let plan=plan_inventories(plan.home,plan.nas,&drive);let preview=make_preview(&package,&plan,&drive)?;
        reporter.finish("Review ready");Ok(preview)
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn takehome_return_apply(app:AppHandle,operation_id:String,client_path:String,package_path:String,plan_token:String)->Result<PackageInfo,String>{
    tauri::async_runtime::spawn_blocking(move||apply_return_sync(app,operation_id,client_path,package_path,plan_token)).await.map_err(|e|e.to_string())?
}
fn apply_return_sync(app:AppHandle,operation_id:String,client_path:String,package_path:String,plan_token:String)->Result<PackageInfo,String>{
    let mut reporter=ProgressReporter::new(app,operation_id);
    apply_with_reporter(client_path,package_path,plan_token,&mut reporter)
}
fn apply_with_reporter(client_path:String,package_path:String,plan_token:String,reporter:&mut ProgressReporter)->Result<PackageInfo,String>{
    let client=fs::canonicalize(client_path).map_err(|e|e.to_string())?;let package=fs::canonicalize(package_path).map_err(|e|e.to_string())?;
    let _locks=TransferLocks::acquire(&[&client,&package])?;recover_pair(&client,&package)?;
    let (drive,state)=validate_package(&client,&package)?;
    let plan=return_plan(&client,&package,&drive,reporter)?;let preview=make_preview(&package,&plan,&drive)?;if preview.plan_token!=plan_token{return Err("The files changed after review. Review the updated return summary before applying.".into());}
    if preview.to_nas==0{return Err("No drive changes to copy to the NAS.".into());}
    cleanup_staging(&client)?;
    let mut total=0u64;
    for action in &plan.actions {if let Action::HomeToNas(path)|Action::NewHomeToNas(path)|Action::ConflictHomeToNas(path)=action{
        total=total.saturating_add(plan.home[path].size.saturating_mul(2));if let Some(old)=plan.nas.get(path){total=total.saturating_add(old.size.saturating_mul(2));}
    }}
    reporter.begin("Copying to NAS",total,preview.to_nas);
    // Advance the common baseline only for files synced in this direction.
    // Pending NAS edits must remain pending for the separate To drive action.
    let mut baseline:BTreeMap<_,_>=drive.files.iter().map(|r|(r.path.clone(),r.clone())).collect();
    let mut next=state;next.schema=SCHEMA;
    for action in &plan.actions {if let Action::HomeToNas(path)|Action::NewHomeToNas(path)|Action::ConflictHomeToNas(path)=action{
        reporter.file(path);let dst=safe_join(&client,path)?;
        if let Some(old)=plan.nas.get(path){archive_file_with_progress(&client,&dst,path,Some(old),reporter)?;}
        let mut copied=copy_planned(&package,&client,path,&plan.home[path],plan.nas.get(path),|phase,bytes|reporter.advance(phase,bytes))?;
        copied.path=path.clone();baseline.insert(path.clone(),copied);
        next.files=records(baseline.clone());next.revision+=1;next.package_path=package.to_string_lossy().into_owned();next.updated_at=Utc::now().to_rfc3339();
        commit_pair(&client,&package,&next)?;reporter.file_done();
    }}
    reporter.finish("Complete");Ok(package_info(&package,&next))
}

fn archive_file_with_progress(client:&Path,source:&Path,relative:&str,expected:Option<&FileRecord>,reporter:&mut ProgressReporter)->Result<(),String>{
    let metadata=client.join(META_DIR);ensure_hidden_dir(&metadata)?;
    let archive_root=metadata.join("archive");
    if fs::symlink_metadata(&archive_root).is_ok_and(|m|is_link(&m)){return Err("The version archive path is a linked folder and cannot be used safely.".into());}
    let version=archive_root.join(format!("{}-{}",Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),Uuid::new_v4()));
    let archive=safe_join(&version,relative)?;
    let mut record=copy_verified_guarded(source,&archive,expected,|phase,bytes|reporter.advance(phase,bytes),||check_destination(&archive,None)).map_err(|e|format!("Could not preserve the NAS version before replacement: {e}"))?;
    record.path=relative.into();ensure_hidden_dir(&version.join(META_DIR))?;
    write_json_atomic(&version.join(META_DIR).join("archive-record.json"),&record)
}
fn checked_archive_record(version:&Path,relative:&str,archived:&Path)->Result<Option<FileRecord>,String>{
    check_metadata_dir(version)?;let receipt=version.join(META_DIR).join("archive-record.json");
    if !receipt.try_exists().map_err(|e|e.to_string())?{return Ok(None);} // Legacy archive: current NAS file is still preserved before restoring.
    let metadata=fs::symlink_metadata(&receipt).map_err(|e|e.to_string())?;
    if is_link(&metadata)||!metadata.is_file()||metadata.len()>1024*1024{return Err("Invalid archive checksum record.".into());}
    let record:FileRecord=serde_json::from_slice(&fs::read(receipt).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if record.path!=relative{return Err("The archived file does not match its checksum record.".into());}
    let actual=checked_hash(archived,|_|{})?;
    if actual.sha256!=record.sha256||actual.size!=record.size{return Err("The archived file failed its checksum check. The current NAS file was kept.".into());}
    Ok(Some(record))
}

#[tauri::command]
pub async fn takehome_archive_list(client_path:String)->Result<ArchiveListing,String>{
    tauri::async_runtime::spawn_blocking(move||archive_list_sync(client_path)).await.map_err(|e|e.to_string())?
}
fn archive_list_sync(client_path:String)->Result<ArchiveListing,String>{
    let client=fs::canonicalize(client_path).map_err(|e|format!("Could not access client: {e}"))?;
    check_metadata_dir(&client)?;
    let root=client.join(META_DIR).join("archive");
    if fs::symlink_metadata(&root).is_ok_and(|m|is_link(&m)){return Err("The version archive path is a linked folder and cannot be read safely.".into());}
    let entries=match fs::read_dir(&root){Ok(entries)=>entries,Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(ArchiveListing{versions:Vec::new(),truncated:false}),Err(e)=>return Err(format!("Could not read version archive: {e}"))};
    let mut folders=Vec::new();
    for entry in entries {let entry=entry.map_err(|e|e.to_string())?;let metadata=fs::symlink_metadata(entry.path()).map_err(|e|e.to_string())?;if metadata.is_dir()&&!is_link(&metadata){folders.push(entry.path());}}
    folders.sort_by(|a,b|b.file_name().cmp(&a.file_name()));
    let mut versions=Vec::new();let mut truncated=false;
    'folders: for folder in folders {
        check_metadata_dir(&folder)?;
        let id=folder.file_name().unwrap_or_default().to_string_lossy().into_owned();
        for entry in WalkDir::new(&folder).follow_links(false).min_depth(1).into_iter().filter_entry(|e|e.file_name()!=std::ffi::OsStr::new(META_DIR)) {
            let entry=entry.map_err(|e|format!("Could not scan version archive: {e}"))?;
            if is_link(&fs::symlink_metadata(entry.path()).map_err(|e|e.to_string())?){return Err("A linked file was found in the version archive.".into());}
            if !entry.file_type().is_file(){continue;}
            let relative=entry.path().strip_prefix(&folder).map_err(|e|e.to_string())?;let path=rel_string(relative);safe_relative(&path)?;
            let size=entry.metadata().map_err(|e|e.to_string())?.len();
            if versions.len()==1000{truncated=true;break 'folders;}
            versions.push(ArchiveVersion{id:id.clone(),path,archived_at:id.clone(),size});
        }
    }
    Ok(ArchiveListing{versions,truncated})
}

#[tauri::command]
pub async fn takehome_archive_restore(app:AppHandle,operation_id:String,client_path:String,archive_id:String,relative_path:String)->Result<(),String>{
    tauri::async_runtime::spawn_blocking(move||archive_restore_sync(app,operation_id,client_path,archive_id,relative_path)).await.map_err(|e|e.to_string())?
}
fn archive_restore_sync(app:AppHandle,operation_id:String,client_path:String,archive_id:String,relative_path:String)->Result<(),String>{
    let mut reporter=ProgressReporter::new(app,operation_id);
    restore_with_reporter(client_path,archive_id,relative_path,&mut reporter)
}
fn restore_with_reporter(client_path:String,archive_id:String,relative_path:String,reporter:&mut ProgressReporter)->Result<(),String>{
    if archive_id.is_empty()||archive_id=="."||archive_id==".."||!archive_id.chars().all(|c|c.is_ascii_alphanumeric()||matches!(c,'-'|'.')){return Err("Invalid archived version identifier.".into());}
    let client=fs::canonicalize(client_path).map_err(|e|format!("Could not access client: {e}"))?;let relative=safe_relative(&relative_path)?;
    let _locks=TransferLocks::acquire(&[&client])?;
    let base=client.join(META_DIR).join("archive");if fs::symlink_metadata(&base).is_ok_and(|m|is_link(&m)){return Err("The version archive path is linked and cannot be used safely.".into());}
    let base=fs::canonicalize(base).map_err(|e|format!("Could not access version archive: {e}"))?;
    let archive_entry=base.join(&archive_id);let entry_meta=fs::symlink_metadata(&archive_entry).map_err(|e|format!("Could not find archived version: {e}"))?;
    if is_link(&entry_meta)||!entry_meta.is_dir(){return Err("The selected archive version is not a regular folder.".into());}
    let archive_root=fs::canonicalize(archive_entry).map_err(|e|e.to_string())?;if !archive_root.starts_with(&base){return Err("Archived version escapes the client archive.".into());}
    let archived=archive_root.join(&relative);let metadata=fs::symlink_metadata(&archived).map_err(|e|format!("Could not access archived file: {e}"))?;
    if is_link(&metadata)||!metadata.is_file(){return Err("The selected archived item is not a regular file.".into());}
    let canonical=fs::canonicalize(&archived).map_err(|e|e.to_string())?;if !canonical.starts_with(&archive_root){return Err("Archived path escapes its version folder.".into());}
    let expected=checked_archive_record(&archive_root,&relative_path,&canonical)?;
    let destination=safe_join(&client,&relative_path)?;let existing=if destination.try_exists().map_err(|e|e.to_string())?{Some(checked_hash(&destination,|_|{})?)}else{None};let archived_size=fs::metadata(&canonical).map_err(|e|e.to_string())?.len();let existing_size=if destination.exists(){fs::metadata(&destination).map_err(|e|e.to_string())?.len()}else{0};
    let files=if destination.exists(){2}else{1};reporter.begin("Restoring saved version",archived_size.saturating_add(existing_size).saturating_mul(2),files);reporter.file(&relative_path);
    if destination.exists(){archive_file_with_progress(&client,&destination,&relative_path,existing.as_ref(),reporter)?;reporter.file_done();reporter.file(&relative_path);}
    copy_verified_guarded(&canonical,&destination,expected.as_ref(),|phase,bytes|reporter.advance(phase,bytes),||{safe_join(&client,&relative_path)?;check_destination(&destination,existing.as_ref())})?;reporter.file_done();reporter.finish("Complete");Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    fn record(path:&str,hash:&str)->FileRecord{FileRecord{path:path.into(),size:4,sha256:hash.into()}}
    fn map(entries:&[(&str,&str)])->BTreeMap<String,FileRecord>{entries.iter().map(|(p,h)|(p.to_string(),record(p,h))).collect()}
    fn manifest(entries:&[(&str,&str)])->Manifest{Manifest{schema:SCHEMA,revision:0,package_path:String::new(),package_id:"test".into(),client_name:"client".into(),client_path:"client".into(),updated_at:"test".into(),files:records(map(entries))}}
    #[test]
    fn directions_distinguish_edits_conflicts_additions_and_missing_files(){
        let base=manifest(&[("file","old")]);
        let cases=[
            (map(&[("file","old")]),map(&[("file","old")]),(0,0,false)),
            (map(&[("file","old")]),map(&[("file","nas")]),(1,0,false)),
            (map(&[("file","home")]),map(&[("file","old")]),(1,1,true)),
            (map(&[("file","same")]),map(&[("file","same")]),(0,0,false)),
            (map(&[("file","home")]),map(&[("file","nas")]),(1,1,true)),
            (map(&[("file","old"),("new","home")]),map(&[("file","old")]),(0,1,true)),
            (map(&[("file","old")]),map(&[("file","old"),("new","nas")]),(1,0,false)),
            (map(&[]),map(&[("file","old")]),(1,0,false)),
            (map(&[("file","old")]),map(&[]),(0,1,false)),
        ];
        for (home,nas,expected) in cases {
            let plan=plan_inventories(home,nas,&base);assert_eq!(direction_counts(&plan,&base),expected);
            let status=metadata_directions(&plan.home,&plan.nas,&base);
            assert_eq!((status.to_drive,status.to_nas,status.drive_blocked),(Some(expected.0),Some(expected.1),expected.2));
        }
    }
    #[test]
    fn return_preview_only_counts_home_changes_for_to_nas(){
        let base=manifest(&[("project","old"),("media","old")]);
        let plan=plan_inventories(map(&[("project","home"),("media","old")]),map(&[("project","old"),("media","nas")]),&base);
        let preview=make_preview(Path::new("package"),&plan,&base).unwrap();
        assert_eq!((preview.to_nas,preview.to_drive,preview.nas_updates),(1,2,1));
        // Once the home project is returned, the unrelated NAS media is still pending.
        let next=manifest(&[("project","home"),("media","old")]);
        let after=plan_inventories(map(&[("project","home"),("media","old")]),map(&[("project","home"),("media","nas")]),&next);
        assert_eq!(direction_counts(&after,&next),(1,0,false));
    }
    #[test]
    fn actionable_files_are_not_truncated_behind_unchanged_media(){
        let mut entries=Vec::new();for index in 0..600{entries.push((format!("a{index:04}"),"same"));}
        let refs:Vec<_>=entries.iter().map(|(p,h)|(p.as_str(),*h)).collect();
        let base=manifest(&refs);let mut home=map(&refs);let nas=map(&refs);home.insert("z-project".into(),record("z-project","new"));
        let preview=make_preview(Path::new("package"),&plan_inventories(home,nas,&base),&base).unwrap();
        assert_eq!(preview.files[0].path,"z-project");assert_eq!(preview.to_nas,1);assert_eq!(preview.files.len(),500);assert_eq!(preview.files_truncated,101);
    }
    #[test]
    fn digest_cache_reuses_unchanged_files_and_detects_same_size_preserved_mtime_edits(){
        let temp=tempfile::tempdir().unwrap();let path=temp.path().join("media");fs::write(&path,b"aaaa").unwrap();
        let first=checked_hash(&path,|_|{}).unwrap();
        let stamp=file_stamp(&fs::File::open(&path).unwrap());
        if stamp.is_some(){
            let checked=hash_cache().lock().unwrap().get(&path).unwrap().checked;
            assert_eq!(first,checked_hash(&path,|_|{}).unwrap());
            assert_eq!(checked,hash_cache().lock().unwrap().get(&path).unwrap().checked);
        }
        let mtime=filetime::FileTime::from_last_modification_time(&fs::metadata(&path).unwrap());
        fs::write(&path,b"bbbb").unwrap();filetime::set_file_mtime(&path,mtime).unwrap();
        let edited=checked_hash(&path,|_|{}).unwrap();assert_ne!(first.sha256,edited.sha256);
        fs::remove_file(&path).unwrap();fs::write(&path,b"cccc").unwrap();filetime::set_file_mtime(&path,mtime).unwrap();
        assert_ne!(edited.sha256,checked_hash(&path,|_|{}).unwrap().sha256);
    }
    #[test]
    fn source_changed_since_plan_cannot_replace_destination(){
        let temp=tempfile::tempdir().unwrap();let src=temp.path().join("source");let dst=temp.path().join("dest");fs::write(&src,b"old!").unwrap();fs::write(&dst,b"safe").unwrap();
        let expected=checked_hash(&src,|_|{}).unwrap();fs::write(&src,b"new!").unwrap();
        assert!(copy_verified_record_with_progress(&src,&dst,Some(&expected),|_,_|{}).is_err());
        assert_eq!(fs::read(&dst).unwrap(),b"safe");assert_eq!(fs::read_dir(temp.path()).unwrap().count(),2);
    }
    #[test]
    fn source_mutated_during_copy_is_rejected(){
        let temp=tempfile::tempdir().unwrap();let src=temp.path().join("source");let dst=temp.path().join("dest");fs::write(&src,vec![1u8;2*1024*1024]).unwrap();
        let mut changed=false;let mut write_denied=false;
        let result=copy_verified_record_with_progress(&src,&dst,None,|phase,_|{if phase=="Copying"&&!changed{changed=true;write_denied=fs::write(&src,vec![2u8;2*1024*1024]).is_err();}});
        if cfg!(windows){assert!(write_denied);assert!(result.is_ok());assert_eq!(fs::read(&src).unwrap(),fs::read(&dst).unwrap());}
        else{assert!(result.is_err());assert!(!dst.exists());}
    }
    #[test]
    fn verified_copy_preserves_content_and_mtime(){
        let temp=tempfile::tempdir().unwrap();let src=temp.path().join("source");let dst=temp.path().join("dest");fs::write(&src,b"content").unwrap();
        let expected=checked_hash(&src,|_|{}).unwrap();let copied=copy_verified_record_with_progress(&src,&dst,Some(&expected),|_,_|{}).unwrap();
        assert_eq!(expected,copied);assert_eq!(checked_hash(&dst,|_|{}).unwrap(),expected);
        assert_eq!(fs::metadata(src).unwrap().modified().unwrap(),fs::metadata(dst).unwrap().modified().unwrap());
    }
    fn silent()->ProgressReporter{ProgressReporter{on_file_done:None,operation_id:"test".into(),phase:String::new(),current_file:String::new(),bytes_done:0,bytes_total:0,files_done:0,files_total:0,last_emit:Instant::now()}}
    fn package_fixture()->(tempfile::TempDir,PathBuf,PathBuf,Manifest){
        let temp=tempfile::tempdir().unwrap();let client=temp.path().join("client");let drive=temp.path().join("drive");fs::create_dir_all(&client).unwrap();fs::create_dir_all(&drive).unwrap();
        for name in ["project","media"]{fs::write(client.join(name),b"base").unwrap();fs::write(drive.join(name),b"base").unwrap();}
        let mut files=Vec::new();for name in ["project","media"]{let mut record=checked_hash(&client.join(name),|_|{}).unwrap();record.path=name.into();files.push(record);}
        let manifest=Manifest{files,..manifest(&[])};write_manifest(&manifest_path(&drive),&manifest).unwrap();write_manifest(&state_path(&client),&manifest).unwrap();
        (temp,client,drive,manifest)
    }
    #[test]
    fn no_op_commands_leave_files_manifests_and_archives_untouched(){
        let (_temp,client,drive,manifest)=package_fixture();
        let state_before=fs::read(state_path(&client)).unwrap();let drive_before=fs::read(manifest_path(&drive)).unwrap();
        let plan=return_plan(&client,&drive,&manifest,&mut silent()).unwrap();let preview=make_preview(&drive,&plan,&manifest).unwrap();
        assert_eq!((preview.to_drive,preview.to_nas),(0,0));
        assert!(update_with_reporter(client.to_string_lossy().into(),drive.to_string_lossy().into(),&mut silent()).unwrap_err().contains("No NAS changes"));
        assert!(apply_with_reporter(client.to_string_lossy().into(),drive.to_string_lossy().into(),preview.plan_token,&mut silent()).unwrap_err().contains("No drive changes"));
        assert_eq!(state_before,fs::read(state_path(&client)).unwrap());assert_eq!(drive_before,fs::read(manifest_path(&drive)).unwrap());assert!(!client.join(META_DIR).join("archive").exists());
    }
    #[test]
    fn each_direction_copies_only_its_pending_changes_and_second_attempt_is_blocked(){
        let (_temp,client,drive,manifest)=package_fixture();
        fs::write(drive.join("project"),b"home edit").unwrap();fs::write(client.join("media"),b"NAS edit").unwrap();
        let plan=return_plan(&client,&drive,&manifest,&mut silent()).unwrap();let preview=make_preview(&drive,&plan,&manifest).unwrap();
        apply_with_reporter(client.to_string_lossy().into(),drive.to_string_lossy().into(),preview.plan_token,&mut silent()).unwrap();
        assert_eq!(fs::read(client.join("project")).unwrap(),b"home edit");assert_eq!(fs::read(drive.join("media")).unwrap(),b"base");
        let next=read_manifest(&manifest_path(&drive)).unwrap();let plan=return_plan(&client,&drive,&next,&mut silent()).unwrap();let preview=make_preview(&drive,&plan,&next).unwrap();
        assert_eq!((preview.to_drive,preview.to_nas),(1,0));
        assert!(apply_with_reporter(client.to_string_lossy().into(),drive.to_string_lossy().into(),preview.plan_token,&mut silent()).is_err());
        update_with_reporter(client.to_string_lossy().into(),drive.to_string_lossy().into(),&mut silent()).unwrap();assert_eq!(fs::read(drive.join("media")).unwrap(),b"NAS edit");
        assert!(update_with_reporter(client.to_string_lossy().into(),drive.to_string_lossy().into(),&mut silent()).is_err());
        let archive=archive_list_sync(client.to_string_lossy().into()).unwrap();assert_eq!(archive.versions.len(),1);
    }
    #[test]
    fn stale_review_is_rejected_before_creating_an_archive(){
        let (_temp,client,drive,manifest)=package_fixture();fs::write(drive.join("project"),b"edit").unwrap();
        let plan=return_plan(&client,&drive,&manifest,&mut silent()).unwrap();let preview=make_preview(&drive,&plan,&manifest).unwrap();
        fs::write(drive.join("project"),b"later edit").unwrap();
        assert!(apply_with_reporter(client.to_string_lossy().into(),drive.to_string_lossy().into(),preview.plan_token,&mut silent()).unwrap_err().contains("changed after review"));
        assert_eq!(fs::read(client.join("project")).unwrap(),b"base");assert!(!client.join(META_DIR).join("archive").exists());
    }
    #[test]
    fn destination_edits_during_copy_are_never_overwritten(){
        let temp=tempfile::tempdir().unwrap();let source=temp.path().join("source");let destination=temp.path().join("destination");
        fs::create_dir(&source).unwrap();fs::create_dir(&destination).unwrap();fs::write(source.join("clip"),vec![3u8;2*1024*1024]).unwrap();fs::write(destination.join("clip"),b"old").unwrap();
        let src=checked_hash(&source.join("clip"),|_|{}).unwrap();let old=checked_hash(&destination.join("clip"),|_|{}).unwrap();let mut changed=false;
        assert!(copy_planned(&source,&destination,"clip",&src,Some(&old),|_,_|{if !changed{changed=true;fs::write(destination.join("clip"),b"new edit").unwrap();}}).is_err());
        assert_eq!(fs::read(destination.join("clip")).unwrap(),b"new edit");
        assert_eq!(fs::read_dir(&destination).unwrap().count(),1);
    }
    #[test]
    fn new_destination_files_that_appear_during_copy_are_kept(){
        let temp=tempfile::tempdir().unwrap();let source=temp.path().join("source");let destination=temp.path().join("destination");
        fs::create_dir(&source).unwrap();fs::create_dir(&destination).unwrap();fs::write(source.join("clip"),b"incoming").unwrap();
        let src=checked_hash(&source.join("clip"),|_|{}).unwrap();
        assert!(copy_planned(&source,&destination,"clip",&src,None,|phase,_|{if phase=="Verifying"{fs::write(destination.join("clip"),b"appeared").unwrap();}}).is_err());
        assert_eq!(fs::read(destination.join("clip")).unwrap(),b"appeared");
    }
    #[test]
    fn a_second_writer_is_blocked_and_the_lock_can_be_reused(){
        let temp=tempfile::tempdir().unwrap();let first=TransferLocks::acquire(&[temp.path()]).unwrap();
        assert!(TransferLocks::acquire(&[temp.path()]).is_err());drop(first);assert!(TransferLocks::acquire(&[temp.path()]).is_ok());
    }
    #[test]
    fn interrupted_manifest_pair_is_readable_and_recoverable(){
        let (_temp,client,drive,mut next)=package_fixture();
        let client=fs::canonicalize(client).unwrap();let drive=fs::canonicalize(drive).unwrap();
        next.revision=1;next.package_path=drive.to_string_lossy().into_owned();next.updated_at="checkpoint".into();
        write_manifest(&pending_path(&client),&next).unwrap();write_manifest(&manifest_path(&drive),&next).unwrap();
        assert_eq!(validate_package(&client,&drive).unwrap().0.revision,1);
        let _locks=TransferLocks::acquire(&[&client,&drive]).unwrap();recover_pair(&client,&drive).unwrap();
        assert_eq!(read_manifest(&state_path(&client)).unwrap().revision,1);assert!(!pending_path(&client).exists());
    }
    #[test]
    fn matching_copies_recover_the_install_before_checkpoint_gap(){
        let (_temp,client,drive,manifest)=package_fixture();
        let client=fs::canonicalize(client).unwrap();let drive=fs::canonicalize(drive).unwrap();
        fs::write(client.join("project"),b"completed copy").unwrap();fs::write(drive.join("project"),b"completed copy").unwrap();
        let plan=return_plan(&client,&drive,&manifest,&mut silent()).unwrap();
        let next=reconcile_common(&client,&drive,&manifest,&plan).unwrap();assert_eq!(next.revision,1);
        // A later deliberate revert on the drive must be a home edit, rather
        // than being mistaken for the pre-interruption common baseline.
        fs::write(drive.join("project"),b"base").unwrap();
        let plan=return_plan(&client,&drive,&next,&mut silent()).unwrap();assert_eq!(direction_counts(&plan,&next),(1,1,true));
    }
    #[test]
    fn archives_have_checksums_and_corrupt_versions_cannot_replace_current_files(){
        let (_temp,client,_drive,_manifest)=package_fixture();let source=client.join("project");let expected=checked_hash(&source,|_|{}).unwrap();
        archive_file_with_progress(&client,&source,"project",Some(&expected),&mut silent()).unwrap();
        let listing=archive_list_sync(client.to_string_lossy().into()).unwrap();assert_eq!(listing.versions.len(),1);
        let version=&listing.versions[0];let archived=client.join(META_DIR).join("archive").join(&version.id).join("project");
        fs::write(&source,b"current edit").unwrap();
        restore_with_reporter(client.to_string_lossy().into(),version.id.clone(),"project".into(),&mut silent()).unwrap();assert_eq!(fs::read(&source).unwrap(),b"base");
        fs::write(&source,b"keep current").unwrap();fs::write(&archived,b"corrupt").unwrap();
        assert!(restore_with_reporter(client.to_string_lossy().into(),version.id.clone(),"project".into(),&mut silent()).unwrap_err().contains("checksum"));
        assert_eq!(fs::read(&source).unwrap(),b"keep current");
    }
    #[test]
    fn legacy_packages_upgrade_only_when_transferring(){
        let (_temp,client,drive,mut legacy)=package_fixture();legacy.schema=1;
        write_manifest(&manifest_path(&drive),&legacy).unwrap();write_manifest(&state_path(&client),&legacy).unwrap();
        assert_eq!(validate_package(&client,&drive).unwrap().0.schema,1);
        fs::write(client.join("media"),b"new version").unwrap();update_with_reporter(client.to_string_lossy().into(),drive.to_string_lossy().into(),&mut silent()).unwrap();
        assert_eq!(read_manifest(&manifest_path(&drive)).unwrap().schema,SCHEMA);assert_eq!(read_manifest(&state_path(&client)).unwrap().schema,SCHEMA);
    }
    #[test]
    #[cfg(windows)]
    fn case_only_renames_do_not_create_false_transfers(){
        let (_temp,client,drive,manifest)=package_fixture();fs::rename(drive.join("project"),drive.join("PROJECT")).unwrap();
        let plan=return_plan(&client,&drive,&manifest,&mut silent()).unwrap();assert_eq!(direction_counts(&plan,&manifest),(0,0,false));
    }
    #[test]
    fn background_status_never_hashes_unknown_files_or_changes_manifests(){
        let (_temp,client,drive,_manifest)=package_fixture();let client=fs::canonicalize(client).unwrap();let drive=fs::canonicalize(drive).unwrap();
        for root in [&client,&drive]{for file in ["project","media"]{hash_cache().lock().unwrap().remove(&root.join(file));}}
        let before=fs::read(state_path(&client)).unwrap();
        let status=status_sync(client.to_string_lossy().into(),drive.to_string_lossy().into()).unwrap();
        assert_eq!((status.to_drive,status.to_nas),(None,None));
        for root in [&client,&drive]{for file in ["project","media"]{assert!(!hash_cache().lock().unwrap().contains_key(&root.join(file)));}}
        assert_eq!(before,fs::read(state_path(&client)).unwrap());
    }
    #[test]
    fn background_status_reuses_checked_versions_and_invalidates_edits(){
        let (_temp,client,drive,manifest)=package_fixture();let client=fs::canonicalize(client).unwrap();let drive=fs::canonicalize(drive).unwrap();
        return_plan(&client,&drive,&manifest,&mut silent()).unwrap();
        let checked=hash_cache().lock().unwrap().get(&drive.join("project")).unwrap().checked;
        let status=status_sync(client.to_string_lossy().into(),drive.to_string_lossy().into()).unwrap();
        assert_eq!((status.to_drive,status.to_nas),(Some(0),Some(0)));
        assert_eq!(checked,hash_cache().lock().unwrap().get(&drive.join("project")).unwrap().checked);
        let mtime=filetime::FileTime::from_last_modification_time(&fs::metadata(drive.join("project")).unwrap());
        fs::write(drive.join("project"),b"edit").unwrap();filetime::set_file_mtime(drive.join("project"),mtime).unwrap();
        let status=status_sync(client.to_string_lossy().into(),drive.to_string_lossy().into()).unwrap();
        assert_eq!(status.to_nas,None); // Unknown content must remain actionable.
        let plan=return_plan(&client,&drive,&manifest,&mut silent()).unwrap();assert_eq!(direction_counts(&plan,&manifest),(1,1,true));
    }
    #[test]
    fn unknown_files_do_not_hide_other_direction_uncertainty(){
        let base=manifest(&[("a","base"),("z","base")]);
        let status=metadata_directions(&map(&[("a",""),("z","base")]),&map(&[("a","base")]),&base);
        assert_eq!(status.to_nas,None);assert_eq!(status.to_drive,None);
    }
    #[test]
    fn copied_files_immediately_supply_background_status_without_rereading(){
        let (_temp,client,drive,_manifest)=package_fixture();fs::write(client.join("media"),b"updated media").unwrap();
        update_with_reporter(client.to_string_lossy().into(),drive.to_string_lossy().into(),&mut silent()).unwrap();
        let status=status_sync(client.to_string_lossy().into(),drive.to_string_lossy().into()).unwrap();
        assert_eq!((status.to_drive,status.to_nas,status.drive_blocked),(Some(0),Some(0),false));
    }
    #[test]
    #[cfg(windows)]
    fn open_writers_and_impossible_space_requests_fail_before_copying(){
        let temp=tempfile::tempdir().unwrap();let source=temp.path().join("live.mov");fs::write(&source,b"still recording").unwrap();
        let _writer=fs::OpenOptions::new().write(true).open(&source).unwrap();let destination=temp.path().join("copy.mov");
        assert!(copy_verified_record_with_progress(&source,&destination,None,|_,_|{}).is_err());assert!(!destination.exists());
        assert!(ensure_copy_space(temp.path(),u64::MAX-1024).is_err());
    }
    #[test]
    #[cfg(windows)]
    fn junctions_cannot_redirect_transfer_or_metadata_paths(){
        let temp=tempfile::tempdir().unwrap();let outside=tempfile::tempdir().unwrap();fs::write(outside.path().join("keep.mov"),b"original").unwrap();
        for name in ["linked",META_DIR]{
            let status=std::process::Command::new("cmd").args(["/c","mklink","/J"]).arg(temp.path().join(name)).arg(outside.path()).output().unwrap();assert!(status.status.success());
        }
        assert!(safe_join(temp.path(),"linked/keep.mov").is_err());assert!(TransferLocks::acquire(&[temp.path()]).is_err());
        assert!(file_paths(temp.path()).is_err());assert_eq!(fs::read(outside.path().join("keep.mov")).unwrap(),b"original");
    }
    #[test]
    fn unsafe_and_duplicate_manifest_paths_are_rejected(){
        for path in ["../outside","folder/../../outside","a/./b","a//b","clip.mov:secret","folder./file","folder /file"]{assert!(safe_relative(path).is_err(),"{path}");}
        let (_temp,client,drive,mut bad)=package_fixture();bad.files.push(bad.files[0].clone());
        write_manifest(&manifest_path(&drive),&bad).unwrap();assert!(validate_package(&client,&drive).is_err());
    }
    #[test]
    fn staging_cleanup_only_removes_recognized_temporary_files(){
        let temp=tempfile::tempdir().unwrap();let partial=temp.path().join(format!(".pepper-copy-{}.partial",Uuid::new_v4()));fs::write(&partial,b"unfinished").unwrap();
        fs::write(temp.path().join(".pepper-copy-my-edit.partial"),b"user file").unwrap();fs::write(temp.path().join("camera.partial"),b"user file").unwrap();
        cleanup_staging(temp.path()).unwrap();assert!(!partial.exists());assert_eq!(fs::read_dir(temp.path()).unwrap().count(),2);
    }
    #[test]
    #[ignore = "Helper subprocess; only invoked by crash recovery test"]
    fn interrupted_prepare_worker(){
        let Some(root)=std::env::var_os("PEPPER_CRASH_FIXTURE") else{return;};let root=PathBuf::from(root);
        let mut reporter=silent();reporter.on_file_done=Some(Box::new(|done|{if done==1{std::process::exit(77);}}));
        let _=prepare_with_reporter(root.join("project").to_string_lossy().into(),root.join("project/client").to_string_lossy().into(),root.join("portable").to_string_lossy().into(),&mut reporter);
        panic!("Worker did not reach the checkpoint");
    }
    #[test]
    fn killed_batch_resumes_completed_files_without_recopying(){
        let temp=tempfile::tempdir().unwrap();let client=temp.path().join("project/client");let portable=temp.path().join("portable");fs::create_dir_all(&client).unwrap();fs::create_dir(&portable).unwrap();
        for name in ["a","b","c"]{fs::write(client.join(name),vec![7u8;2*1024*1024]).unwrap();}
        let status=std::process::Command::new(std::env::current_exe().unwrap()).args(["takehome::tests::interrupted_prepare_worker","--ignored","--exact","--nocapture"]).env("PEPPER_CRASH_FIXTURE",temp.path()).status().unwrap();assert_eq!(status.code(),Some(77));
        let drive=portable.join("client");assert!(drive.join("a").exists());assert!(!drive.join("b").exists());
        let stamp=file_stamp(&fs::File::open(drive.join("a")).unwrap());
        update_with_reporter(client.to_string_lossy().into(),drive.to_string_lossy().into(),&mut silent()).unwrap();
        assert_eq!(stamp,file_stamp(&fs::File::open(drive.join("a")).unwrap()));
        let manifest=read_manifest(&manifest_path(&drive)).unwrap();assert_eq!(manifest.files.len(),3);
        assert_eq!(fs::read(client.join("c")).unwrap(),fs::read(drive.join("c")).unwrap());
    }
    #[test]
    #[ignore = "Writes an isolated 1 GiB batch; run explicitly"]
    fn large_batch_stability(){
        let temp=tempfile::tempdir().unwrap();let client=temp.path().join("project/client");let portable=temp.path().join("portable");fs::create_dir_all(&client).unwrap();fs::create_dir(&portable).unwrap();
        let block=vec![0x5au8;1024*1024];
        for index in 0..16{let mut file=fs::File::create(client.join(format!("clip-{index:02}.mov"))).unwrap();for _ in 0..64{file.write_all(&block).unwrap();}file.sync_all().unwrap();}
        let start=Instant::now();let info=prepare_with_reporter(temp.path().join("project").to_string_lossy().into(),client.to_string_lossy().into(),portable.to_string_lossy().into(),&mut silent()).unwrap();
        let drive=PathBuf::from(info.package_root);let manifest=read_manifest(&manifest_path(&drive)).unwrap();assert_eq!(manifest.files.len(),16);
        for record in &manifest.files{let actual=hash_file_with_progress(&drive.join(&record.path),|_|{}).unwrap();assert_eq!(actual.sha256,record.sha256);assert_eq!(actual.size,64*1024*1024);}
        assert_eq!(file_paths(&drive).unwrap().len(),16);
        println!("Verified 16 x 64 MiB files (1 GiB batch), source-preserving staged copies and destination readback: {:?}",start.elapsed());
    }
    #[test]
    #[ignore = "Read-only benchmark; requires PEPPER_BENCH_CLIENT and PEPPER_BENCH_DRIVE"]
    fn benchmark_connected_package(){
        let client=PathBuf::from(std::env::var("PEPPER_BENCH_CLIENT").unwrap());let drive=PathBuf::from(std::env::var("PEPPER_BENCH_DRIVE").unwrap());
        let (manifest,_)=validate_package(&client,&drive).unwrap();
        let start=Instant::now();let first=return_plan(&client,&drive,&manifest,&mut silent()).unwrap();let initial=start.elapsed();
        let start=Instant::now();let second=return_plan(&client,&drive,&manifest,&mut silent()).unwrap();let repeated=start.elapsed();
        assert_eq!(make_preview(&drive,&first,&manifest).unwrap().plan_token,make_preview(&drive,&second,&manifest).unwrap().plan_token);
        println!("Read-only package check: {} files across both locations; first {:?}, repeated {:?}; directions {:?}",first.home.len()+first.nas.len(),initial,repeated,direction_counts(&second,&manifest));
    }

}
