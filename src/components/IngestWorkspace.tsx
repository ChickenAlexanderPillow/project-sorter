import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, ArrowRight, Check, CheckCheck, CircleAlert, Copy, FileAudio, Folder, FolderInput, LoaderCircle, Network, Plus, ShieldCheck, X } from "lucide-react";
import type { CreateIngestClient } from "./NewIngestClient";
import { RetainedView } from "./RetainedView";
import { GroupWorkspace } from "./GroupWorkspace";
import "./IngestWorkspace.css";
import { ClientLabel, parseClientLabel } from "./ClientLabel";
import { MediaSourceBrowser } from "./MediaSourceBrowser";
import { defaultRole, mediaKind, mediaRoleIcon, type SourceMedia } from "./MediaTypes";
import { MediaSources } from "./MediaSources";
import "./ImportSelection.css";

type IngestFile = { id:string; batch_id:string; collected_at:string|null; newly_collected:boolean; name:string; source:string; source_name:string; relative_path:string; inbox_path:string; role:string; size:number; sha256:string; source_modified:string|null; source_created:string|null; timestamp_warning:string|null; status:string; group_id?:string|null; group_name:string|null; client:string|null; clients:string[]; client_paths:string[]; destinations:string[]; duplicate_of:string|null; counterpart_id:string|null };
type Manifest = { schema_version:number; files:IngestFile[]; reviewed_groups:string[] };
type Client = { name:string; path:string; status:string };
type Lease = { locked:boolean; owner:string|null; stale:boolean };
type Progress = { project_root:string; phase:string; source:string; completed:number; total:number };
type ReviewDestination = { file_id:string; name:string; role:string; client:string; destination:string; collision:boolean; issue:string|null };
type StagedSource = SourceMedia;
function SourcesIcon({size=16}:{size?:number}) { return <FileAudio size={size}/>; }
const STEPS = [{ id:1, label:"Collect", icon:SourcesIcon }, { id:2, label:"Group", icon:Network }];
const blank:Manifest = { schema_version:1, files:[], reviewed_groups:[] };
const basename = (path:string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const bytes = (size:number) => size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(1)} GB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
const fileClients = (file:IngestFile) => file.clients?.length ? file.clients : file.client ? [file.client] : [];
const fileRole = (row:ReviewDestination) => ({"Raw audio":"Raw Audio","Clean audio":"Clean Audio","Proxy video":"Proxy Video","Full-resolution video":"Full-Res Video"} as Record<string,string>)[row.role] || "Media";
export function IngestWorkspace({projectRoot, projectTitle, clients, onBack, onCreateClient}:{projectRoot:string; projectTitle:string; clients:Client[]; onBack:()=>void; onCreateClient:CreateIngestClient}) {
  const storageKey = `pepper.ingest.view:${projectRoot}`;
  const readView = () => { try { return JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { return {}; } };
  const initialView = useRef(readView()).current;
  const [manifest, setManifest] = useState<Manifest>(blank);
  const manifestRef = useRef(manifest);
  const [step, setStep] = useState<number>(Number(initialView.step)>1?2:1);
  const [staged, setStaged] = useState<StagedSource[]>((initialView.staged || []).map((item:StagedSource)=>({...item,name:item.name||basename(item.path),kind:item.kind||mediaKind(item.path)||"unknown",size:item.size||0,role:item.role||defaultRole(item.path)})));
  const [resolvingSources,setResolvingSources] = useState(Boolean(initialView.staged?.length));
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"saved"|"saving"|"failed">("saved");
  const [lease, setLease] = useState<Lease>({locked:false, owner:null, stale:false});
  const operation=useRef(false);
  const operationEpoch=useRef(0);
  const [progress, setProgress] = useState<Progress|null>(null);
  const [review, setReview] = useState<ReviewDestination[]|null>(null), [reviewedConflicts, setReviewedConflicts] = useState(false);
  const [confirmationOpen,setConfirmationOpen]=useState(false);
  const reviewCache=useRef<{key:string;rows:ReviewDestination[]}|null>(null);
  const [validClientPaths,setValidClientPaths]=useState<string[]>([]);
  const [clientsChecked,setClientsChecked]=useState(false);
  const [sourceBrowser, setSourceBrowser] = useState(false), [filedNotice, setFiledNotice] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve()), saveVersion = useRef(0), live = useRef(true);
  const updateManifest = (next:Manifest) => { manifestRef.current = next; setManifest(next); };
  const load = async () => { const next = await invoke<Manifest>("ingest_load", {projectRoot}); if (live.current) updateManifest(next); };
  useEffect(() => { live.current = true; void load().then(() => setLoaded(true)).catch(e => { setError(String(e)); setLoaded(true); }); return () => { live.current = false; }; }, [projectRoot]);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify({step, staged})); } catch { /* View persistence is optional. */ } }, [storageKey, step, staged]);
  useEffect(() => {
    let active = true;
    const poll = async () => { const ownOperation=operation.current, epoch=operationEpoch.current; try { const [nextLease, nextProgress] = await Promise.all([invoke<Lease>("ingest_lease_status", {projectRoot}), invoke<Progress|null>("ingest_progress", {projectRoot})]); if (!active || epoch!==operationEpoch.current) return; if(!ownOperation&&!operation.current)setLease(nextLease); setProgress(nextProgress); } catch { /* Operation errors are reported by the initiating action. */ } };
    void poll(); const timer = window.setInterval(() => void poll(), 1500); return () => { active = false; window.clearInterval(timer); };
  }, [projectRoot]);
  useEffect(() => {
    let active=true;
    const previous=initialView.staged as StagedSource[]|undefined;
    if(previous?.length) void invoke<Omit<SourceMedia,'role'>[]>('media_resolve_files',{paths:previous.map(item=>item.path)}).then(files=>{if(active)setStaged(files.map(file=>{const old=previous.find(item=>item.path===file.path);return {...file,role:['Proxy video','Full-resolution video','Raw audio','Clean audio'].includes(old?.role||'')?old!.role:defaultRole(file.path)};}));}).catch(e=>{if(active){setStaged([]);setError(String(e));}}).finally(()=>{if(active)setResolvingSources(false);});
    return()=>{active=false;};
  },[projectRoot]);
  useEffect(() => { const drop = (e:Event) => { const paths=(e as CustomEvent<string[]>).detail;if(!Array.isArray(paths))return;setResolvingSources(true);void invoke<Omit<SourceMedia,'role'>[]>('media_resolve_files',{paths}).then(files=>{setStaged(current=>[...current,...files.filter(file=>!current.some(s=>s.path===file.path)).map(file=>({...file,role:defaultRole(file.path)}))]);if(!files.length)setError('No supported video, audio or image files were found.');setStep(1);}).catch(e=>setError(String(e))).finally(()=>setResolvingSources(false)); }; window.addEventListener("pepper-ingest-drop", drop); return () => window.removeEventListener("pepper-ingest-drop", drop); }, []);
  const persist = (next:Manifest) => {
    updateManifest(next); setReview(null); setReviewedConflicts(false); setSaveState("saving");
    const version = ++saveVersion.current;
    queue.current = queue.current.catch(() => undefined).then(() => invoke("ingest_save", {projectRoot, manifest:next})).then(() => { if (live.current && version === saveVersion.current) setSaveState("saved"); }).catch(e => { if (live.current) { setSaveState("failed"); setError(String(e)); } throw e; });
    void queue.current.catch(() => undefined);
  };
  useEffect(() => {
    if (!loaded || busy || lease.locked || saveState !== "saved") return;
    let active = true;
    void queue.current.then(() => invoke<Manifest>("ingest_load", {projectRoot})).then(next => {
      if (active && JSON.stringify(next) !== JSON.stringify(manifestRef.current)) updateManifest(next);
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [loaded, busy, lease.locked, projectRoot]);
  const mutate = (change:(current:Manifest)=>Manifest) => { if (busy || lease.locked) return; persist(change(manifestRef.current)); };

  const readOnly = busy || lease.locked || !loaded || resolvingSources;
  const relativePath = (path:string) => { const prefix = projectRoot.replace(/[\\/]+$/, ""); return path.toLowerCase().startsWith(prefix.toLowerCase() + "\\") || path.toLowerCase().startsWith(prefix.toLowerCase() + "/") ? path.slice(prefix.length + 1).replace(/\\/g, "/") : path; };
  const clientSignature=JSON.stringify(clients.filter(client=>client.status!=="Not a client"&&parseClientLabel(client.name).type).map(client=>client.path));
  useEffect(()=>{
    let active=true;setValidClientPaths([]);setClientsChecked(false);
    const paths=JSON.parse(clientSignature) as string[];
    void invoke<string[]>('media_valid_client_paths',{paths}).then(valid=>{if(active){setValidClientPaths(valid);setClientsChecked(true);}}).catch(error=>{if(active)setError(`Could not check client media folders: ${String(error)}`);});
    return()=>{active=false;};
  },[clientSignature,projectRoot]);
  const clientOptions=clients.filter(client=>validClientPaths.includes(client.path)&&parseClientLabel(client.name).type).map(client=>({...client,path:relativePath(client.path)}));
  const reviewKey=JSON.stringify([manifest.files.map(file=>[file.id,file.status,file.role,file.name,file.sha256,file.client,file.clients,file.client_paths,file.destinations]),clientOptions.map(client=>client.path)]);
  useEffect(() => {
    if (!confirmationOpen || busy || !loaded || !clientsChecked || saveState !== "saved") return;
    const cached=reviewCache.current;if(cached?.key===reviewKey){setReview(cached.rows);return;}
    let active = true; setReview(null);
    void queue.current.then(() => invoke<ReviewDestination[]>("ingest_preview_filing", {projectRoot,eligibleClientPaths:clientOptions.map(client=>client.path)})).then(rows => { if (active) {reviewCache.current={key:reviewKey,rows};setReview(rows);} }).catch(e => { if (active) {setError(String(e));setReview([]);} });
    return () => { active = false; };
  }, [confirmationOpen, busy, loaded, projectRoot, reviewKey, saveState, clientsChecked, validClientPaths]);

  const assignedPaths=(file:IngestFile)=>file.client_paths?.length?file.client_paths:fileClients(file);
  const unassigned = manifest.files.filter(file=>file.status!=='Filed'&&!assignedPaths(file).some(path=>clientOptions.some(client=>client.path===path))).length;
  const issues = review?.filter(r => r.issue) || [];
  const conflicts = review?.filter(r => r.collision) || [];
  const filingCount = new Set((review || []).map(r => r.file_id)).size;
  const canLeave = saveState === "saved" && !busy;
  const canAdvance = (n:number) => n === 1 ? manifest.files.length > 0 && staged.length === 0 : true;
  const go = (next:number) => { if(next===4){setError("");setReviewedConflicts(false);setConfirmationOpen(true);return;}setStep(next);setError(""); };
  const addSources = (files:SourceMedia[]) => { setStaged(current => [...current,...files.filter(file=>mediaKind(file.path)&&!current.some(s=>s.path===file.path))]); go(1); };
  const setSourceTypes = (paths:string[],role:string) => {
    setStaged(current=>current.map(item=>paths.includes(item.path)&&['video','audio'].includes(mediaKind(item.path)||'')?{...item,role}:item));
    if(manifest.files.some(file=>paths.includes(file.inbox_path)&&file.status!=='Filed'&&['video','audio'].includes(mediaKind(file.name)||''))) mutate(m=>({...m,files:m.files.map(file=>paths.includes(file.inbox_path)&&file.status!=='Filed'&&['video','audio'].includes(mediaKind(file.name)||'')?{...file,role}:file)}));
  };
  const videosNeedType=staged.filter(item=>mediaKind(item.path)==='video'&&!['Proxy video','Full-resolution video'].includes(item.role)).length;
  const collect = async () => {
    if(operation.current || videosNeedType || resolvingSources)return;
    operation.current=true; operationEpoch.current++; setBusy(true); setProgress(null); setLease({locked:false,owner:null,stale:false}); setError("");
    try {
      await queue.current;
      let next = await invoke<Manifest>("ingest_collect", {projectRoot, sources:staged.map(s => s.path)});
      const oldIds = new Set(manifestRef.current.files.map(f => f.id));
      next = {...next, reviewed_groups:next.reviewed_groups.filter(id => id !== "ungrouped"), files:next.files.map(f => { const source = staged.find(s => s.path === f.source); return !oldIds.has(f.id) && source ? {...f,role:source.role} : f; })};
      await invoke("ingest_save", {projectRoot, manifest:next}); updateManifest(next); setStaged(current => current.filter(s => !staged.some(done => done.path === s.path))); setSaveState("saved"); setLease({locked:false,owner:null,stale:false}); go(2);
      try { const view = JSON.parse(localStorage.getItem(storageKey) || "{}"); localStorage.setItem(storageKey, JSON.stringify({...view, staged:(view.staged || []).filter((s:StagedSource) => !staged.some(done => done.path === s.path))})); } catch { /* View persistence is optional. */ }
    } catch (e) { setError(String(e)); await load().catch(() => undefined); } finally { operationEpoch.current++; operation.current=false; setLease({locked:false,owner:null,stale:false}); setBusy(false); }
  };
  const assignFiles = (ids:string[], paths:string[], share=false) => mutate(m=>({...m,files:m.files.map(file=>{
    if(!ids.includes(file.id)||file.status==='Filed')return file;
    const existing=file.client_paths?.length?file.client_paths:fileClients(file);
    const next=share?[...new Set([...existing,...paths])]:paths;
    const names=next.map(path=>clientOptions.find(client=>client.path===path)?.name||path);
    return {...file,client:names[0]||null,clients:names,client_paths:next};
  })}));
  const fileMedia = async () => {
    if(operation.current || busy || lease.locked || saveState!=="saved")return;
    operation.current=true; operationEpoch.current++;
    setBusy(true); setProgress(null); setLease({locked:false,owner:null,stale:false}); setFiledNotice(false); setError("");
    try {
      await queue.current;
      const next=await invoke<Manifest>("ingest_file", {projectRoot,eligibleClientPaths:clientOptions.map(client=>client.path)});
      updateManifest(next); setFiledNotice(true); setReview(null); setConfirmationOpen(false);
    } catch (e) {
      setError(String(e)); await load().catch(() => undefined);
    } finally {
      operationEpoch.current++; operation.current=false;
      setLease({locked:false,owner:null,stale:false}); setBusy(false);
    }
  };
  const summary = step===1 ? (staged.length ? `${staged.length} files ready to copy` : manifest.files.length ? `${manifest.files.length} files copied - ${bytes(manifest.files.reduce((n,f)=>n+f.size,0))}` : "Your original media stays untouched") : `${manifest.files.length-unassigned} ${manifest.files.length-unassigned===1?"file":"files"} assigned to clients${unassigned?` - ${unassigned} awaiting a client`:''}`;
  const sourceSelector = <button className="ig-button" disabled={readOnly} onClick={()=>setSourceBrowser(true)}><Plus size={15}/> Add media</button>;

  return <main className="ig-workspace">
    <header className="ig-heading"><button className="ig-text-button" disabled={saveState !== "saved"} onClick={onBack}><ArrowLeft size={15}/> Production</button><span className="ig-heading-divider"/><span className="ig-project">{projectTitle}<small title="Import media"><FolderInput size={15} aria-label="Import media"/></small></span><span className={`ig-save ${saveState}`} role="status">{saveState === "saving" ? <><LoaderCircle size={12} className="ig-spin"/> Saving</> : saveState === "failed" ? <button className="ig-text-button" onClick={() => persist(manifestRef.current)}>Retry save</button> : <><Check size={12}/> Saved</>}</span></header>
    <nav className="ig-steps" aria-label="Import steps">{STEPS.map(({id:next,label, icon:Icon}) => { const unlocked = next <= step || STEPS.filter(item=>item.id<next).every(item=>canAdvance(item.id)); return <button key={label} aria-current={step === next ? "step" : undefined} disabled={!unlocked || !canLeave || !loaded} className={step === next ? "active" : next < step ? "complete" : ""} onClick={() => go(next)}><span className="ig-step-icon"><Icon size={15}/></span><span>{label}</span></button>; })}</nav>
    <div className="ig-body"><div className="ig-step-heading"><div><h1>{step===1?"Bring in your media":"Group media by client"}</h1></div>{sourceSelector}</div>
    {error && !confirmationOpen && <div className="ig-alert" role="alert"><CircleAlert size={16}/><span>{error}</span><button className="ig-icon-button" aria-label="Dismiss error" onClick={() => setError("")}><X size={14}/></button></div>}
    {lease.locked && !busy && <div className="ig-alert"><ShieldCheck size={16}/><span>Someone else is working on this import. You can look around while they finish.<details><summary>Session details</summary><pre>{lease.owner}</pre>{lease.stale && <button className="ig-button" onClick={async () => { try { await invoke("ingest_recover_stale_lease", {projectRoot}); setLease({locked:false, owner:null, stale:false}); await load(); } catch(e) { setError(String(e)); } }}>Recover inactive session</button>}</details></span></div>}
    {!loaded ? <div className="ig-loading"><LoaderCircle className="ig-spin" size={20}/> Opening your media…</div> : <>
    <RetainedView active={step===1}>
      {resolvingSources && <p className="ig-quiet-note"><LoaderCircle className="ig-spin" size={15}/> Finding media files...</p>}
      <MediaSources staged={staged} copied={manifest.files.filter(file=>mediaKind(file.name)).map(file=>({id:file.id,path:file.inbox_path,name:file.name,kind:mediaKind(file.name)!,role:file.role,size:file.size,status:file.status,source_name:file.source_name||basename(file.source)}))} disabled={readOnly} onBrowse={()=>setSourceBrowser(true)} onRemove={path=>setStaged(current=>current.filter(item=>item.path!==path))} onType={setSourceTypes}/>
      {videosNeedType > 0 && <p className="ig-quiet-note"><CircleAlert size={14}/> {videosNeedType} video{videosNeedType===1?' needs':'s need'} a type.</p>}
    </RetainedView>

    <RetainedView active={step===2}>{filedNotice&&<div className="ig-success ig-group-filed-notice"><CheckCheck size={17}/><span><strong>Media organised</strong><small>The selected media is in its client folders. Add late media whenever it arrives.</small></span></div>}<GroupWorkspace files={manifest.files} clients={clientOptions} disabled={readOnly} onAssign={assignFiles} onCreateClient={onCreateClient}/></RetainedView>
    </>}
    </div>
    {sourceBrowser && <MediaSourceBrowser projectRoot={projectRoot} onAdd={addSources} onClose={() => setSourceBrowser(false)}/>}
    {confirmationOpen&&<div className="ig-confirm-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)setConfirmationOpen(false);}}><section className="ig-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="ig-confirm-title"><header className="ig-confirm-heading"><div><span>FINAL CHECK</span><h2 id="ig-confirm-title">Are these assignments correct?</h2><p>Review where the selected media will go before Pepper copies it into client folders.</p></div><button className="ig-icon-button" aria-label="Close confirmation" disabled={busy} onClick={()=>setConfirmationOpen(false)}><X size={17}/></button></header>
      {error&&<div className="ig-alert ig-confirm-error" role="alert"><CircleAlert size={15}/><span>{error}</span><button className="ig-icon-button" aria-label="Dismiss error" onClick={()=>setError("")}><X size={13}/></button></div>}
      {review===null?<div className="ig-confirm-loading"><LoaderCircle className="ig-spin" size={17}/>{clientsChecked?"Checking your selections…":"Checking client folders…"}</div>:<div className="ig-confirm-content">
        {filingCount>0&&<div className="ig-confirm-summary">{filingCount} {filingCount===1?'file':'files'} across {new Set(review.map(row=>row.client)).size} {new Set(review.map(row=>row.client)).size===1?'client':'clients'}</div>}
        {[...new Set(review.map(row=>row.client))].map(client=>{const rows=review.filter(row=>row.client===client);const roles=[...new Set(rows.map(fileRole))];return <section className="ig-confirm-client" key={client}><header><Folder size={16}/><ClientLabel name={client}/><small>{rows.length} {rows.length===1?'file':'files'}</small></header><div>{roles.map(role=>{const typed=rows.filter(row=>fileRole(row)===role);const Icon=mediaRoleIcon(typed[0].name,typed[0].role);return <section className="ig-confirm-media-type" key={role}><header><span className="ig-media-role-chip"><Icon size={13} aria-hidden="true"/>{role}</span><small>{typed.length}</small></header><ul>{typed.map((row,index)=><li key={`${row.file_id}-${index}`} title={row.name}>{row.name}</li>)}</ul></section>;})}</div></section>;})}
        {!filingCount&&<div className="ig-confirm-empty"><Folder size={21}/><strong>Nothing ready to organise yet</strong><span>Assign media to an available client, then review it here.</span></div>}
        {unassigned>0&&<p className="ig-confirm-later">{unassigned} {unassigned===1?'file has':'files have'} no client yet and will stay in the project inbox for later.</p>}
        {(issues.length>0||conflicts.length>0)&&<div className="ig-confirm-issues"><h3><CircleAlert size={15}/> Check these files</h3>{review.filter(row=>row.issue||row.collision).map((row,index)=><p key={`${row.file_id}-${index}`}><strong>{row.name}</strong><span>{row.issue||'A file with this name already exists. Pepper will choose an available name.'}</span></p>)}{conflicts.length>0&&<label><input type="checkbox" checked={reviewedConflicts} onChange={event=>setReviewedConflicts(event.target.checked)}/> Use available names for matching files</label>}</div>}
        {filingCount>0&&<p className="ig-confirm-safe"><ShieldCheck size={14}/> Original source media stays untouched.</p>}
      </div>}
      <footer className="ig-confirm-actions"><button className="ig-button ig-back" disabled={busy} onClick={()=>setConfirmationOpen(false)}>Back to group</button><button className="ig-button ig-primary" disabled={busy||!review||filingCount===0||issues.length>0||(conflicts.length>0&&!reviewedConflicts)} onClick={()=>void fileMedia()}>{busy?<><LoaderCircle className="ig-spin" size={15}/> Organising…</>:<><FolderInput size={15}/> Confirm &amp; organise {filingCount} {filingCount===1?'file':'files'}</>}</button></footer>
    </section></div>}
    <footer className="ig-footer"><span className="ig-footer-summary">{busy ? <><LoaderCircle size={14} className="ig-spin"/>{(progress?.phase === "collecting" || progress?.phase === "verifying") ? `${progress.phase === "verifying" ? "Verifying" : "Copying"} ${basename(progress.source)}` : progress?.phase === "filing" ? `Organising ${progress.completed} of ${progress.total} files` : "Getting things ready…"}</> : summary}</span><div>{step > 1 && <button className="ig-button ig-back" disabled={!canLeave} onClick={() => go(1)}><ArrowLeft size={14}/> Collect</button>}{step === 1 && staged.length > 0 ? <button className="ig-button ig-primary" disabled={readOnly || saveState !== "saved" || videosNeedType > 0} onClick={() => void collect()}><Copy size={15}/>{busy ? "Copying…" : "Copy to project"}</button> : step === 1 ? <button className="ig-button ig-primary" disabled={readOnly || !canLeave || !canAdvance(step)} onClick={() => go(2)}>Group media<ArrowRight size={14}/></button> : manifest.files.some(file=>file.status!=="Filed") ? <button className="ig-button ig-primary" disabled={readOnly||!canLeave||!clientsChecked} onClick={()=>go(4)}><Check size={15}/> Review and organise</button> : <button className="ig-button ig-primary" disabled={!canLeave} onClick={onBack}>Return to production<ArrowRight size={14}/></button>}</div></footer>
  </main>;
}
