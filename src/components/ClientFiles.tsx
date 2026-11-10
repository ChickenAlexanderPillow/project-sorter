import { Fragment, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowUpRight, ChartNoAxesGantt, Files, CircleAlert, FileVideo, FolderOpen, Headphones, Image, LoaderCircle, Package, RefreshCw, Search, SquarePen } from 'lucide-react';
import { selectFilePaths } from './fileSelection';
import { startNativeFileDrag } from './nativeFileDrag';
import { mediaRoleIcon } from './MediaTypes';
import { SourceMediaPreview } from './SourceMediaPreview';
import { previewPreparation } from './previewPreparation';
import { videoPosters } from './videoPosters';
import { useVisibleVideoPaths } from './useVisibleVideoPaths';
import { PremiereProjectHealth } from './PremiereProjectHealth';

import { clientRecordingFiles, clientOverlapGroups, clientAssetCategory, clientFileTooltip, type ClientAsset as Asset, type ClientRecordingAsset } from './clientFileGroups';
import { RecordingTimeline, RecordingPill, type RecordingPlacement } from './RecordingTimeline';
import type { RecordingMetadata } from './recordingGroups';
type Folder={label:string;path:string;available:boolean};
type Listing={files:Asset[];folders:Folder[];truncated:boolean};
const SECTIONS=[{id:'edit',name:'Edit',Icon:SquarePen},{id:'video',name:'Video',Icon:FileVideo},{id:'audio',name:'Audio',Icon:Headphones},{id:'stills',name:'Stills',Icon:Image},{id:'stock',name:'Stock',Icon:Package},{id:'all',name:'All',Icon:Files}] as const;
export type FileContextMenu=(event:MouseEvent,title:string,items:{label:string;action:()=>void;disabled?:boolean;separatorBefore?:boolean}[])=>void;
type Section=typeof SECTIONS[number]['id'];
const bytes=(size:number)=>size>=1024**3?`${(size/1024**3).toFixed(1)} GB`:size>=1024**2?`${(size/1024**2).toFixed(1)} MB`:`${Math.max(1,Math.round(size/1024))} KB`;
const PROJECT_ACTIONS:Record<string,string>={prproj:'Open in Premiere',aep:'Open in After Effects',aepx:'Open in After Effects',sesx:'Open in Audition',blend:'Open in Blender',drp:'Open in Resolve'};
const projectAction=(name:string)=>PROJECT_ACTIONS[name.split('.').pop()?.toLowerCase()||'']||'Open project';
const PROJECT_APPS:Record<string,string>={prproj:'Premiere Pro',aep:'After Effects',aepx:'After Effects',sesx:'Audition',blend:'Blender',drp:'DaVinci Resolve'};
const projectApp=(name:string)=>PROJECT_APPS[name.split('.').pop()?.toLowerCase()||'']||'Editing project';

export function ClientFiles({projectRoot,clientPath,onContextMenu}:{projectRoot:string;clientPath:string;onContextMenu:FileContextMenu}){
  const [section,setSection]=useState<Section>('edit');
  const [overlap,setOverlap]=useState(false);
  const [intervals,setIntervals]=useState<{key:string;data:Record<string,RecordingMetadata|null>}|null>(null);
  const [intervalsLoading,setIntervalsLoading]=useState(false);
  const [listing,setListing]=useState<Listing|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [selectedPath,setSelectedPath]=useState<string|null>(null),[query,setQuery]=useState(''),[searchOpen,setSearchOpen]=useState(false);
  const [revision,setRevision]=useState(0),[opening,setOpening]=useState(false);
  const [hoveredPath,setHoveredPath]=useState<string|null>(null);
  const fileList=useRef<HTMLDivElement>(null);
  const request=useRef(0);
  const selection=useRef(new Map<Section,string>());
  const [selectedPaths,setSelectedPaths]=useState<string[]>([]);
  const anchor=useRef<string|null>(null);
  const selections=useRef(new Map<Section,string[]>());
  const pointer=useRef<{id:number;x:number;y:number;paths:string[]}|null>(null);
  const dragged=useRef(false),nativeBusy=useRef(false);
  const [displaySection,setDisplaySection]=useState<Section>('edit');
  const [hasStills,setHasStills]=useState(false);
  const [hasStock,setHasStock]=useState(false);
  useEffect(()=>{
    let active=true;
    void Promise.all(['stills','stock'].map(category=>invoke<Listing>('client_files_list',{clientPath,category}))).then(([stills,stock])=>{if(active){setHasStills(stills.files.length>0);setHasStock(stock.files.length>0);if(!stills.files.length||!stock.files.length)setSection(current=>current==='stills'&&!stills.files.length||current==='stock'&&!stock.files.length?'edit':current);}}).catch(()=>{});
    return()=>{active=false;};
  },[clientPath,revision]);
  useEffect(()=>{
    const id=++request.current;let active=true;setError('');
    const accept=(next:Listing)=>{
      if(!active||id!==request.current)return;
      setListing(next);setDisplaySection(section);
      const previous=selection.current.get(section);
      const first=(section==='audio'?next.files.find(file=>file.variant==='Clean'):section==='edit'?next.files.find(file=>file.name.toLowerCase().endsWith('.prproj')):null)||next.files[0];
      const saved=(selections.current.get(section)||[]).filter(path=>next.files.some(file=>file.path===path));
      setSelectedPaths(saved.length?saved:first?[first.path]:[]);
      anchor.current=null;
      setSelectedPath(next.files.some(file=>file.path===previous)?previous!:first?.path||null);
      setLoading(false);
    };
    setLoading(true);
    void invoke<Listing>('client_files_list',{clientPath,category:section}).then(accept).catch(error=>{
      if(active&&id===request.current){setError(String(error));setLoading(false);}
    });
    return()=>{active=false;};
  },[clientPath,section,revision]);
  const intervalKey=`${clientPath}\0${revision}`;
  useEffect(()=>{
    let active=true;
    if(section!=='all'||displaySection!=='all'||!overlap||loading||!listing||intervals?.key===intervalKey){setIntervalsLoading(false);return;}
    setIntervalsLoading(true);
    void invoke<{path:string;recording_metadata:RecordingMetadata|null}[]>('client_files_recordings',{projectRoot,clientPath})
      .then(rows=>{if(active)setIntervals({key:intervalKey,data:Object.fromEntries(rows.map(row=>[row.path,row.recording_metadata]))});})
      .catch(error=>{if(active)setError(String(error));}).finally(()=>{if(active)setIntervalsLoading(false);});
    return()=>{active=false;};
  },[projectRoot,clientPath,section,displaySection,overlap,loading,listing,intervalKey,intervals?.key]);
  const category=SECTIONS.find(item=>item.id===displaySection)!;
  const visible=clientRecordingFiles(listing?.files||[],intervals?.key===intervalKey?intervals.data:{}).filter(file=>`${file.name} ${file.relative_path} ${file.variant} ${file.kind==='project'?projectApp(file.name):''}`.toLowerCase().includes(query.toLowerCase()));
  const selected=visible.find(file=>file.path===selectedPath)||visible[0]||null;
  const variantOrder=displaySection==='all'?['Projects','Video','Audio','Stills','Other']:displaySection==='video'?['Raw','Proxy']:displaySection==='audio'?['Clean','Raw','Music']:displaySection==='stills'?['Stills','Graphics']:displaySection==='stock'?['Stock']:['Premiere Pro','After Effects','Audition','Blender','DaVinci Resolve','Editing project'];
  const showIntervals=displaySection==='all'&&overlap&&intervals?.key===intervalKey;
  const groups=showIntervals?clientOverlapGroups(visible):variantOrder.map(variant=>({variant,timeline:false,files:visible.filter(file=>(displaySection==='all'?clientAssetCategory(file):displaySection==='edit'?projectApp(file.name):file.variant)===variant)})).filter(group=>group.files.length>0);
  const ordered=groups.flatMap(group=>group.files.map(file=>file.path));
  const visibleVideoPaths=useVisibleVideoPaths(fileList,ordered.join('\0'));
  const visibleSelection=selectedPaths.filter(path=>ordered.includes(path));
  const choose=(file:Asset,extend=false,toggle=false)=>{
    const next=selectFilePaths(selectedPaths,ordered,file.path,anchor.current,extend,toggle);
    setSelectedPaths(next);selections.current.set(displaySection,next);
    selection.current.set(displaySection,file.path);setSelectedPath(file.path);
    if(!extend)anchor.current=file.path;
    return next;
  };
  const pointerDown=(event:PointerEvent<HTMLButtonElement>,file:Asset)=>{
    if(event.button!==0||nativeBusy.current)return;
    dragged.current=false;
    const modifier=event.ctrlKey||event.metaKey;
    const paths=!event.shiftKey&&!modifier&&visibleSelection.includes(file.path)?visibleSelection:choose(file,event.shiftKey,modifier);
    pointer.current={id:event.pointerId,x:event.clientX,y:event.clientY,paths};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove=(event:PointerEvent<HTMLButtonElement>)=>{
    const pending=pointer.current;
    if(!pending||pending.id!==event.pointerId||Math.hypot(event.clientX-pending.x,event.clientY-pending.y)<6)return;
    pointer.current=null;dragged.current=true;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(!pending.paths.length)return;
    nativeBusy.current=true;setError('');
    void startNativeFileDrag(clientPath,pending.paths).catch(error=>setError(String(error))).finally(()=>{nativeBusy.current=false;});
  };
  const nameCounts=new Map<string,number>();
  for(const file of listing?.files||[])nameCounts.set(`${file.variant}/${file.name.toLowerCase()}`,(nameCounts.get(`${file.variant}/${file.name.toLowerCase()}`)||0)+1);
  const openFileLocation=async(path:string)=>{try{await invoke('open_file_location',{path});setError('');}catch(error){setError(String(error));}};
  const openProject=async(file:Asset)=>{
    if(opening)return;setOpening(true);setError('');
    try{await invoke('client_files_open_project',{clientPath,path:file.path});}catch(error){setError(String(error));}finally{setOpening(false);}
  };
  const fileRow=(file:ClientRecordingAsset,placement?:RecordingPlacement)=>{const Icon=file.kind==='project'?SquarePen:file.kind==='audio'?Headphones:file.kind==='image'?Image:FileVideo;const duplicate=(nameCounts.get(`${file.variant}/${file.name.toLowerCase()}`)||0)>1;const parent=duplicate?file.relative_path.replace(/[\\/][^\\/]*$/,''):'';const detail=parent&&parent!==file.name?parent:'';const fileButton=<button type="button" className={`cf-file ${visibleSelection.includes(file.path)?'selected':''} ${placement?'cf-interval-file':''}`} key={file.path} data-preview-path={file.path} data-preview-kind={file.kind} aria-pressed={visibleSelection.includes(file.path)} title={clientFileTooltip(file)} onContextMenu={event=>{if(!visibleSelection.includes(file.path))choose(file);onContextMenu(event,file.name,[...(file.kind==='project'?[{label:projectAction(file.name),action:()=>void openProject(file)}]:[]),{label:'Open file location',action:()=>void openFileLocation(file.path)}]);}} onPointerEnter={()=>{if(file.kind!=='project'){setHoveredPath(file.path);void previewPreparation.prepare(file.path).catch(()=>{});}}} onFocus={()=>{if(file.kind!=='project'){setHoveredPath(file.path);void previewPreparation.prepare(file.path).catch(()=>{});}}} onPointerDown={event=>pointerDown(event,file)} onPointerMove={pointerMove} onPointerUp={()=>{pointer.current=null;}} onPointerCancel={()=>{pointer.current=null;}} onDragStart={event=>event.preventDefault()} onClick={event=>{
              if(dragged.current){dragged.current=false;return;}
              if(event.detail===0||(!event.shiftKey&&!event.ctrlKey&&!event.metaKey))choose(file,event.shiftKey,event.ctrlKey||event.metaKey);
            }} onDoubleClick={()=>{if(!dragged.current&&file.kind==='project')void openProject(file);}}><Icon size={15}/><span>{file.name}</span>{placement?<RecordingPill {...placement}/>:detail&&<small>{detail}</small>}</button>;
            return displaySection==='edit'?<div className={`cf-project-row ${visibleSelection.includes(file.path)?'selected':''} ${placement?'cf-interval-file':''}`} key={file.path}>
              {fileButton}
              <div className="cf-row-actions" role="group" aria-label={`Actions for ${file.name}`}>
                <button type="button" title="Open file location" aria-label={`Open file location for ${file.name}`} onClick={()=>void openFileLocation(file.path)}><FolderOpen size={14}/></button>
                <button type="button" title={projectAction(file.name)} aria-label={`${projectAction(file.name)}: ${file.name}`} disabled={opening} onClick={()=>void openProject(file)}><ArrowUpRight size={14}/><span>Open</span></button>
              </div>
            </div>:fileButton;};
  return <><section className={`client-files ${displaySection==='edit'?'cf-edit':''}`} aria-label="Client files">
    <header className="cf-toolbar">
      <nav className="cf-sections" aria-label="File categories">{SECTIONS.filter(item=>item.id==='stills'?hasStills:item.id==='stock'?hasStock:true).map(({id,name,Icon})=><button type="button" key={id} aria-pressed={section===id} onClick={()=>{if(id!==section){setLoading(true);setSection(id);setQuery('');}}}><Icon size={15}/><span>{name}</span></button>)}</nav>
      <div className="cf-tools">
        {searchOpen&&<input autoFocus aria-label="Search client files" placeholder="Find a file" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){setQuery('');setSearchOpen(false);}}}/>}
        <button type="button" title={searchOpen?'Close file search':'Find a file'} aria-label={searchOpen?'Close file search':'Find a file'} aria-expanded={searchOpen} onClick={()=>{setSearchOpen(!searchOpen);if(searchOpen)setQuery('');}}><Search size={15}/></button>
        {section==='all'&&<button type="button" className="cf-overlap-toggle" role="switch" aria-checked={overlap} aria-label="Show overlapping recordings" title="Overlapping recordings" onClick={()=>setOverlap(value=>!value)}>{intervalsLoading?<LoaderCircle size={15} className="cf-spin"/>:<ChartNoAxesGantt size={15}/>}<span aria-hidden="true"><i/></span></button>}
        <button type="button" title="Refresh files" aria-label="Refresh client files" disabled={loading} onClick={()=>{listing?.files.forEach(file=>videoPosters.invalidate(file.path));setRevision(value=>value+1);}}><RefreshCw className={loading?'cf-spin':''} size={14}/></button>

      </div>
    </header>
    <div className="cf-body">
    {error&&<div className="cf-error" role="alert"><CircleAlert size={15}/><span>{error}</span></div>}
    {loading&&!listing?<div className="cf-loading" role="status"><LoaderCircle size={19} className="cf-spin"/><span>Opening {category.name.toLowerCase()}…</span></div>:!listing?null:!listing.files.length?<div className="cf-empty"><category.Icon size={29}/><strong>No {displaySection==='edit'?'editing projects':category.name.toLowerCase()} yet</strong></div>:<div className="cf-layout">
      <div className="cf-list-pane" aria-busy={loading}><div className="cf-list-summary"><span>{query?`${visible.length} of ${listing.files.length}`:listing.files.length} {displaySection==='edit'?(listing.files.length===1?'project':'projects'):(listing.files.length===1?'file':'files')}</span>{listing.truncated&&<span title="Open the folder to see the full collection">First 2,000 shown</span>}</div>
        <div className="cf-list" ref={fileList} tabIndex={0} onKeyDown={event=>{
          if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();setSelectedPaths(ordered);selections.current.set(displaySection,ordered);}
          if(event.key==='Escape'){pointer.current=null;setSelectedPaths([]);selections.current.set(displaySection,[]);}
        }} aria-label={`${category.name} files`}>
          {groups.map(({variant,files,timeline})=>{const Icon=mediaRoleIcon(files[0].path,variant);return <section className={`cf-variant ${timeline?'cf-overlap-group':''}`} key={`${variant}:${files[0].path}`} aria-label={variant}><h3><Icon size={13} aria-hidden="true"/>{variant}</h3>{timeline?<RecordingTimeline files={files} className="cf-recording-timeline">{(file,placement)=><Fragment key={file.path}>{file.path===files.find(item=>item.kind===file.kind)?.path&&<h4 className="cf-overlap-type">{clientAssetCategory(file)}</h4>}{fileRow(file,placement)}</Fragment>}</RecordingTimeline>:showIntervals?(['Projects','Video','Audio','Stills','Other'].map(type=>{const typed=files.filter(file=>clientAssetCategory(file)===type);return typed.length?<div className="cf-overlap-kind" key={type}><h4 className="cf-overlap-type">{type}</h4>{typed.map(file=>fileRow(file))}</div>:null;})):files.map(file=>fileRow(file))}</section>;})}
          {!visible.length&&<div className="cf-no-results">No matching files</div>}
        </div>
      </div>
      {selected&&(displaySection==='edit'||selected.kind==='project')&&<aside className="cf-project-sidebar" aria-label={`Project health for ${selected.name}`}>
        {loading?<div className="cf-loading" role="status"><LoaderCircle size={18} className="cf-spin"/>Loading project?</div>:selected.name.toLowerCase().endsWith('.prproj')?<PremiereProjectHealth key={`${clientPath}/${selected.path}/${selected.modified_ms}/${revision}`} projectRoot={projectRoot} clientPath={clientPath} projectPath={selected.path}/>:<div className="cf-health-unsupported"><h3>Project health</h3><p>Media checks are available for Premiere Pro projects.</p></div>}
      </aside>}
      {selected&&displaySection!=='edit'&&selected.kind!=='project'&&<aside className="cf-preview">
        <header className="cf-preview-heading"><strong title={selected.relative_path}>{selected.name}</strong></header>
        <div className="cf-preview-content">{selected.kind==='other'?<div className="cf-empty"><FolderOpen size={24}/><button className="cf-health-action" onClick={()=>void openFileLocation(selected.path)}>Open file location</button></div>:<SourceMediaPreview preloadPaths={visibleVideoPaths.filter(path=>visible.some(file=>file.path===path))} preloadPath={visibleVideoPaths.includes(hoveredPath||'')?hoveredPath:null} path={selected.path} name={selected.name} showHeading={false} quietLoading/>}</div>
        <footer className="cf-file-meta"><span>{bytes(selected.size)}</span>{selected.modified_ms!==null&&<time dateTime={new Date(selected.modified_ms).toISOString()} title={new Date(selected.modified_ms).toLocaleString()}>{new Date(selected.modified_ms).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})}</time>}</footer>
      </aside>}
    </div>}
    </div>
  </section></>;
}
