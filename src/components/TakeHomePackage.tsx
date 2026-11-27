import { activityPercent, finishBackgroundActivity, reportBackgroundActivity } from "./notificationActivity";
import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowUpFromLine, ArrowRight, ArrowLeft, Check, Ellipsis, CircleAlert, FileCheck2, FilePlus2, History, Info, LoaderCircle, RefreshCw, Server, ShieldCheck, Usb, X } from 'lucide-react';
import './TakeHomePackage.css';

type PackageInfo = { package_root:string; package_id:string; files:number; updated_at:string };
type ChangeStatus = { to_drive:number|null; to_nas:number|null; drive_blocked:boolean };
type PreviewFile = { path:string; action:string };
type ReturnPreview = { package_root:string; plan_token:string; to_drive:number; to_nas:number; drive_blocked:boolean; home_updates:number; new_home_files:number; nas_updates:number; unchanged:number; nas_only:number; retained_home_deletions:number; conflicts:number; files_truncated:number; files:PreviewFile[] };
type ArchiveVersion = { id:string; path:string; archived_at:string; size:number };
type ArchiveListing = { versions:ArchiveVersion[]; truncated:boolean };
type TakeHomeProgress = { operation_id:string; phase:string; current_file:string; bytes_done:number; bytes_total:number; files_done:number; files_total:number };

const savedKey=(clientPath:string)=>`pepper.takehome.package:${clientPath.toLowerCase()}`;
const displayPath=(path:string)=>path.replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\/,'');
const archiveLabel=(id:string)=>{const match=id.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);return match?`${match[3]}/${match[2]}/${match[1]} ${match[4]}:${match[5]}:${match[6]} UTC`:id;};

export function TakeHomePackage({projectRoot,clientPath,clientName,onFilesChanged,active=true}:{active?:boolean;projectRoot:string;clientPath:string;clientName:string;onFilesChanged:()=>void}) {
  const [packagePath,setPackagePath]=useState('');
  const [candidate,setCandidate]=useState('');
  const [info,setInfo]=useState<PackageInfo|null>(null);
  const [changes,setChanges]=useState<ChangeStatus|null>(null);
  const [checkRevision,setCheckRevision]=useState(0);
  const statusEpoch=useRef(0);
  const [statusChecking,setStatusChecking]=useState(false);
  const operationBusy=useRef(false);
  const [preview,setPreview]=useState<ReturnPreview|null>(null);
  const [busy,setBusy]=useState(false);
  const [activity,setActivity]=useState('Checking drive');
  const [error,setError]=useState('');
  const optionsRef=useRef<HTMLDetailsElement>(null);
  const transferHintId=useId();
  const [archive,setArchive]=useState<ArchiveListing|null>(null);
  const [showArchive,setShowArchive]=useState(false);
  const [showHelp,setShowHelp]=useState(false);
  const [restoreTarget,setRestoreTarget]=useState<ArchiveVersion|null>(null);
  const [progress,setProgress]=useState<TakeHomeProgress|null>(null);

  useEffect(()=>{
    let active=true; const saved=localStorage.getItem(savedKey(clientPath));
    if(!saved)return;
    void invoke<PackageInfo>('takehome_validate',{clientPath,packagePath:saved})
      .then(value=>{if(active){setPackagePath(value.package_root);setInfo(value);}})
      .catch(reason=>{if(active){setPackagePath(saved);setError(String(reason));}});
    return()=>{active=false;};
  },[clientPath]);

  useEffect(()=>{
    if(!active||!packagePath||!info||operationBusy.current)return;
    const epoch=++statusEpoch.current;
    setStatusChecking(true);
    void invoke<ChangeStatus>('takehome_status',{clientPath,packagePath})
      .then(value=>{if(statusEpoch.current===epoch&&!operationBusy.current)setChanges(value);})
      .catch(reason=>{if(statusEpoch.current===epoch){setChanges(null);setError(String(reason));}})
      .finally(()=>{if(statusEpoch.current===epoch)setStatusChecking(false);});
    return()=>{if(statusEpoch.current===epoch){statusEpoch.current++;setStatusChecking(false);}};
  },[active,clientPath,packagePath,info?.updated_at,checkRevision]);

  useEffect(()=>{
    if(!active||!info||busy||preview)return;
    // Returning from Explorer can reveal newly edited files, but only requests
    // metadata status; content verification belongs to the chosen operation.
    let timer:number|undefined;
    const refresh=()=>{window.clearTimeout(timer);timer=window.setTimeout(()=>{if(!statusChecking)setCheckRevision(value=>value+1);},250);};
    window.addEventListener('focus',refresh);
    return()=>{window.clearTimeout(timer);window.removeEventListener('focus',refresh);};
  },[active,info,busy,preview,statusChecking]);

  const closeOptions=()=>{if(optionsRef.current)optionsRef.current.open=false;};
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(!optionsRef.current?.contains(event.target as Node))closeOptions();};
    document.addEventListener('pointerdown',close);
    return()=>document.removeEventListener('pointerdown',close);
  },[]);

  async function chooseFolder(){
    if(operationBusy.current)return;
    operationBusy.current=true;statusEpoch.current++;setStatusChecking(false);setBusy(true);setError('');setProgress(null);setActivity('Checking drive');
    try{
      const selected=await open({directory:true,multiple:false,title:'Select the portable drive package folder'});
      if(typeof selected!=='string')return;
      setChanges(null);setPreview(null);setCandidate('');setInfo(null);setPackagePath('');
      try{
        const value=await invoke<PackageInfo>('takehome_validate',{clientPath,packagePath:selected});
        setInfo(value);setPackagePath(value.package_root);localStorage.setItem(savedKey(clientPath),value.package_root);
      }catch(reason){
        if(String(reason).includes('No package manifest found'))setCandidate(selected);
        else {setPackagePath(selected);setError(String(reason));}
      }
    }catch(reason){setError(String(reason));}
    finally{operationBusy.current=false;setBusy(false);}
  }

  function reportDriveActivity(operationId:string,label:string,value?:TakeHomeProgress) {
    reportBackgroundActivity({id:`drive:${operationId}`,kind:'drive',title:label,context:clientName,
      detail:value?.current_file ? value.current_file.split(/[\\/]/).pop() || value.current_file : value?.phase || 'Preparing files\u2026',
      percent:value && value.bytes_total > 1 ? activityPercent(value.bytes_done,value.bytes_total) : null});
  }

  async function run<T>(operation:(operationId:string)=>Promise<T>,label:string){
    if(operationBusy.current)return;operationBusy.current=true;statusEpoch.current++;setStatusChecking(false);setBusy(true);setError('');setProgress(null);setActivity(label);
    const operationId=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let unlisten:(()=>void)|undefined;
    reportDriveActivity(operationId,label);
    try{
      unlisten=await listen<TakeHomeProgress>('pepper-takehome-progress',event=>{if(event.payload.operation_id===operationId){setProgress(event.payload);reportDriveActivity(operationId,label,event.payload);}});
      return await operation(operationId);
    }
    catch(reason){const detail=String(reason);if(!/No (NAS|drive) changes/.test(detail))setError(detail);}
    finally{unlisten?.();finishBackgroundActivity(`drive:${operationId}`);operationBusy.current=false;setBusy(false);}
  }

  async function prepare(){
    if(!candidate)return;
    const value=await run(operationId=>invoke<PackageInfo>('takehome_prepare',{operationId,projectRoot,clientPath,destinationParent:candidate}),'Copying to drive');
    if(value){setInfo(value);setPackagePath(value.package_root);setPreview(null);localStorage.setItem(savedKey(clientPath),value.package_root);}
  }
  async function update(){
    if(!packagePath||!info||changes?.to_drive===0||changes?.drive_blocked)return;
    setChanges(null);
    const value=await run(operationId=>invoke<PackageInfo>('takehome_update',{operationId,clientPath,packagePath}),'Updating drive');
    if(value){setInfo(value);setPreview(null);}else{setCheckRevision(value=>value+1);}
  }
  async function reviewReturn(){
    if(!packagePath||!info||changes?.to_nas===0)return;
    setShowArchive(false);setRestoreTarget(null);
    const value=await run(operationId=>invoke<ReturnPreview>('takehome_return_preview',{operationId,clientPath,packagePath}),'Comparing files');
    if(value){setChanges(value);if(value.to_nas>0)setPreview(value);setShowArchive(false);setRestoreTarget(null);}
  }
  async function applyReturn(){
    if(!packagePath||!preview||preview.to_nas===0)return;
    setChanges(null);
    const expected=preview;
    const value=await run(operationId=>invoke<PackageInfo>('takehome_return_apply',{operationId,clientPath,packagePath,planToken:expected.plan_token}), 'Syncing to NAS');
    if(value){setInfo(value);setPreview(null);localStorage.setItem(savedKey(clientPath),value.package_root);onFilesChanged();if(showArchive)void invoke<ArchiveListing>('takehome_archive_list',{clientPath}).then(setArchive).catch(()=>{});}else{setPreview(null);setCheckRevision(value=>value+1);}
  }

  async function toggleArchive(){
    if(showArchive){setShowArchive(false);setRestoreTarget(null);return;}
    const value=await run(()=>invoke<ArchiveListing>('takehome_archive_list',{clientPath}),'Loading saved versions');
    if(value){setArchive(value);setShowArchive(true);setPreview(null);}
  }
  async function restoreVersion(version:ArchiveVersion){
    if(operationBusy.current)return;operationBusy.current=true;statusEpoch.current++;setStatusChecking(false);setBusy(true);setError('');setProgress(null);setActivity('Restoring version');let stop:(()=>void)|undefined;
    const operationId=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
    reportDriveActivity(operationId,'Restoring version');
    try{
      stop=await listen<TakeHomeProgress>('pepper-takehome-progress',event=>{if(event.payload.operation_id===operationId){setProgress(event.payload);reportDriveActivity(operationId,'Restoring version',event.payload);}});
      await invoke('takehome_archive_restore',{operationId,clientPath,archiveId:version.id,relativePath:version.path});
      setRestoreTarget(null);onFilesChanged();
      const value=await invoke<ArchiveListing>('takehome_archive_list',{clientPath});setArchive(value);
    }catch(reason){setError(String(reason));}
    finally{stop?.();finishBackgroundActivity(`drive:${operationId}`);operationBusy.current=false;setBusy(false);setCheckRevision(value=>value+1);}
  }

  const formatCount=(count:number,label:string)=>`${count.toLocaleString()} ${label}${count===1?'':'s'}`;
  const formatBytes=(bytes:number)=>bytes>=1024**3?`${(bytes/1024**3).toFixed(1)} GB`:bytes>=1024**2?`${(bytes/1024**2).toFixed(0)} MB`:bytes>=1024?`${(bytes/1024).toFixed(0)} KB`:`${bytes} B`;
  const progressPercent=progress?Math.min(100,Math.round(progress.bytes_done/Math.max(1,progress.bytes_total)*100)):0;
  const returnCount=preview?preview.home_updates+preview.new_home_files+preview.conflicts:0;
  const syncCount=returnCount;
  const transferHint=info&&!busy&&!preview
    ? changes?.drive_blocked?'Bring drive edits back first'
      : changes?.to_drive===0&&changes.to_nas===0?'Already transferred'
      : changes?.to_drive===0?'Drive copy is current'
      : changes?.to_nas===0?'No changes to bring back'
      : ''
    : '';
  const reviewFiles=preview?.files.filter(file=>['Use home copy on NAS','Add new home file to NAS','Home copy wins; preserve previous NAS version'].includes(file.action))||[];
  const fileAction=(action:string)=>action.startsWith('Home copy wins')?'Drive wins · NAS archived':action==='Use home copy on NAS'?'Update NAS':action==='Add new home file to NAS'?'Add to NAS':action==='Keep newer NAS copy and update drive'?'Update drive':action==='No change'?'Unchanged':action.startsWith('Keep NAS')?'Keep on NAS':action;
  return <section className="thp-panel" aria-label={`${clientName} drive transfers`} aria-busy={busy}>
    <header className="thp-heading">
      <h3>Drive transfer</h3>
      <details ref={optionsRef} className="thp-options" onKeyDown={event=>{if(event.key==='Escape'){closeOptions();optionsRef.current?.querySelector('summary')?.focus();}}}>
        <summary className="thp-icon" aria-label="Drive options" title="Drive options"><Ellipsis size={16}/></summary>
        <div className="thp-options-menu" role="group" aria-label="Drive options">
          {info&&<button type="button" disabled={busy||statusChecking} onClick={()=>{closeOptions();setPreview(null);setCheckRevision(value=>value+1);}}><RefreshCw size={14}/>Refresh</button>}
          <button type="button" disabled={busy} onClick={()=>{closeOptions();void toggleArchive();}}><History size={14}/>{showArchive?'Hide saved versions':'Saved versions'}</button>
          <button type="button" onClick={()=>{closeOptions();setShowHelp(value=>!value);}}><Info size={14}/>Premiere relinking</button>
        </div>
      </details>
    </header>
    <div className="thp-route">
      <div className="thp-endpoint"><Server size={22}/><div><strong>Project NAS</strong><span title={displayPath(clientPath)}>{clientName}</span></div></div>
      <div className="thp-directions" role="group" aria-label="Transfer direction">
        <button type="button" disabled={busy||(!info&&!candidate)||!!preview||(!!info&&(changes?.to_drive===0||changes?.drive_blocked))} onClick={()=>void (info?update():prepare())} title={!info?'Copy full client to drive':changes?.drive_blocked?'Bring drive edits back before updating the drive':changes?.to_drive===0?'No NAS changes to copy':changes?.to_drive==null?'Check NAS changes and copy to drive':`Copy ${formatCount(changes.to_drive,'file')} to drive`} aria-label="Copy from NAS to drive" aria-describedby={transferHint&&(changes?.to_drive===0||changes?.drive_blocked)?transferHintId:undefined}><span>To drive</span><ArrowRight size={17}/></button>
        <button type="button" disabled={busy||!info||!!preview||changes?.to_nas===0} onClick={()=>void reviewReturn()} title={changes?.to_nas===0?'No drive changes to copy':changes?.to_nas==null?'Check drive changes before copying to NAS':`Review ${formatCount(changes.to_nas,'file')} before copying to NAS`} aria-label="Review changes from drive to NAS" aria-describedby={transferHint&&changes?.to_nas===0?transferHintId:undefined}><ArrowLeft size={17}/><span>To NAS</span></button>
      </div>
      <button type="button" className={`thp-endpoint thp-drive ${info?'connected':''}`} disabled={busy} onClick={()=>void chooseFolder()} title={info?`${displayPath(packagePath)}\nLast synced ${new Date(info.updated_at).toLocaleString()}`:displayPath(packagePath||candidate)||'Choose a drive folder'}>
        <Usb size={22}/><div><strong>{info?'Portable drive':candidate?'Ready to copy':packagePath?'Reconnect drive':'Select drive'}</strong><span>{displayPath(packagePath||candidate)||'Choose a destination'}</span></div><RefreshCw size={13}/>
      </button>
    </div>
    {transferHint&&<p id={transferHintId} className="thp-transfer-hint" role="status">{changes?.drive_blocked?<ArrowLeft size={12}/>:<Check size={12}/>}<span>{transferHint}</span></p>}
    {busy&&<div className="thp-progress" role="status">
      <div className="thp-progress-heading"><strong><LoaderCircle size={13} className="thp-spin"/>{progress?.phase||activity}</strong>{progress&&<span>{progressPercent}%</span>}</div>
      {progress&&<><div className="thp-progress-track" role="progressbar" aria-label={progress.phase} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}><span style={{width:`${progressPercent}%`}}/></div>
      <div className="thp-progress-detail"><span title={progress.current_file}>{progress.current_file||'Preparing…'}</span><small>{progress.bytes_total>1?`${formatBytes(progress.bytes_done)} / ${formatBytes(progress.bytes_total)}`:''}{progress.files_total?` · ${progress.files_done}/${progress.files_total} files`:''}</small></div></>}
    </div>}
    {error&&<p className="thp-feedback thp-error" role="alert"><CircleAlert size={14}/>{error}</p>}
    {preview&&<div className="thp-review">
      <header className="thp-review-heading"><strong><ArrowUpFromLine size={15}/>Drive → NAS</strong><button type="button" className="thp-icon" title="Close review" aria-label="Close return review" disabled={busy} onClick={()=>setPreview(null)}><X size={15}/></button></header>
      <div className="thp-summary-stats">
        <div><FileCheck2 size={15}/><strong>{preview.home_updates.toLocaleString()}</strong><span>Updated</span></div>
        <div><FilePlus2 size={15}/><strong>{preview.new_home_files.toLocaleString()}</strong><span>New</span></div>
        <div className={preview.conflicts?'attention':''}><CircleAlert size={15}/><strong>{preview.conflicts.toLocaleString()}</strong><span>Conflicts</span></div>
        <div><ShieldCheck size={15}/><strong>{(preview.nas_updates+preview.nas_only+preview.retained_home_deletions).toLocaleString()}</strong><span>Kept on NAS</span></div>
      </div>
      {preview.conflicts>0&&<p className="thp-note thp-conflict"><CircleAlert size={13}/>Conflicts use the drive copy. Previous NAS versions are saved.</p>}
      {reviewFiles.length>0&&<div className="thp-file-list" aria-label="Files to sync">{reviewFiles.map((file,index)=><div key={`${file.path}-${file.action}-${index}`}><code title={file.path}>{file.path}</code><span title={file.action}>{fileAction(file.action)}</span></div>)}</div>}
      <p className="thp-note">{formatCount(preview.unchanged,'file')} unchanged</p>
      {preview.files_truncated>0&&<small className="thp-truncated">{preview.files.length.toLocaleString()} of {(preview.files.length+preview.files_truncated).toLocaleString()} files shown</small>}
      <div className="thp-review-footer"><span><ShieldCheck size={13}/>Drive deletions stay on NAS</span><button type="button" className="thp-primary" disabled={busy||!syncCount} onClick={()=>void applyReturn()}><ArrowUpFromLine size={14}/>{syncCount?`Sync ${formatCount(syncCount,'file')}`:'No changes'}</button></div>
    </div>}
    {showArchive&&<div className="thp-review thp-archive">
      {!!archive?.versions.length&&<header className="thp-review-heading"><strong>Saved versions{archive?.versions.length?` (${archive.versions.length.toLocaleString()})`:''}</strong><span className="thp-archive-hint" title="Restoring saves the current NAS version first."><ShieldCheck size={13}/></span></header>}
      {!archive?.versions.length&&<p className="thp-archive-empty"><History size={16}/>No saved versions yet</p>}
      <div className="thp-archive-list">
      {archive?.versions.map((version,index)=><div className="thp-archive-row" key={`${version.id}/${version.path}/${index}`}>
        <div><code title={version.path}>{version.path}</code><small>{archiveLabel(version.archived_at)} · {formatBytes(version.size)}</small></div>
        {restoreTarget?.id===version.id&&restoreTarget.path===version.path
          ? <span className="thp-archive-confirm"><button type="button" className="thp-secondary" onClick={()=>void restoreVersion(version)} disabled={busy}>Confirm restore</button><button type="button" className="thp-icon" title="Cancel restore" aria-label="Cancel restore" onClick={()=>setRestoreTarget(null)} disabled={busy}><X size={13}/></button></span>
          : <button type="button" className="thp-secondary" disabled={busy} onClick={()=>setRestoreTarget(version)}><History size={13}/>Restore</button>}
      </div>)}
      </div>
      {archive?.truncated&&<small className="thp-truncated">Newest 1,000 files shown</small>}
    </div>}
    {showHelp&&<p className="thp-note">Premiere may ask you to relink media after switching drives or computers.</p>}

  </section>;
}

