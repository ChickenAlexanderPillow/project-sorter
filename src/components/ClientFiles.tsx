import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowUpRight, CircleAlert, FileVideo, Headphones, Image, LoaderCircle, RefreshCw, Search, SquarePen } from 'lucide-react';
import { selectFilePaths } from './fileSelection';
import { startNativeFileDrag } from './nativeFileDrag';
import { mediaRoleIcon } from './MediaTypes';
import { SourceMediaPreview } from './SourceMediaPreview';

type Asset={name:string;path:string;relative_path:string;kind:string;variant:string;size:number;modified_ms:number|null};
type Folder={label:string;path:string;available:boolean};
type Listing={files:Asset[];folders:Folder[];truncated:boolean};
const SECTIONS=[{id:'edit',name:'Edit',Icon:SquarePen},{id:'video',name:'Video',Icon:FileVideo},{id:'audio',name:'Audio',Icon:Headphones},{id:'stills',name:'Stills',Icon:Image}] as const;
export type FileContextMenu=(event:MouseEvent,title:string,items:{label:string;action:()=>void;disabled?:boolean;separatorBefore?:boolean}[])=>void;
type Section=typeof SECTIONS[number]['id'];
const bytes=(size:number)=>size>=1024**3?`${(size/1024**3).toFixed(1)} GB`:size>=1024**2?`${(size/1024**2).toFixed(1)} MB`:`${Math.max(1,Math.round(size/1024))} KB`;
const PROJECT_ACTIONS:Record<string,string>={prproj:'Open in Premiere',aep:'Open in After Effects',aepx:'Open in After Effects',sesx:'Open in Audition',blend:'Open in Blender',drp:'Open in Resolve'};
const projectAction=(name:string)=>PROJECT_ACTIONS[name.split('.').pop()?.toLowerCase()||'']||'Open project';

export function ClientFiles({clientPath,onContextMenu}:{clientPath:string;onContextMenu:FileContextMenu}){
  const [section,setSection]=useState<Section>('edit');
  const [listing,setListing]=useState<Listing|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [selectedPath,setSelectedPath]=useState<string|null>(null),[query,setQuery]=useState(''),[searchOpen,setSearchOpen]=useState(false);
  const [revision,setRevision]=useState(0),[opening,setOpening]=useState(false);
  const request=useRef(0);
  const cache=useRef(new Map<string,{revision:number;listing:Listing}>());
  const selection=useRef(new Map<Section,string>());
  const [selectedPaths,setSelectedPaths]=useState<string[]>([]);
  const anchor=useRef<string|null>(null);
  const selections=useRef(new Map<Section,string[]>());
  const pointer=useRef<{id:number;x:number;y:number;paths:string[]}|null>(null);
  const dragged=useRef(false),nativeBusy=useRef(false);
  const [displaySection,setDisplaySection]=useState<Section>('edit');
  const [hasStills,setHasStills]=useState(false);
  useEffect(()=>{
    let active=true;
    void invoke<Listing>('client_files_list',{clientPath,category:'stills'}).then(next=>{if(active){cache.current.set(`${clientPath}/stills`,{revision,listing:next});setHasStills(next.files.length>0);if(!next.files.length)setSection(current=>current==='stills'?'edit':current);}}).catch(()=>{});
    return()=>{active=false;};
  },[clientPath,revision]);
  useEffect(()=>{
    const id=++request.current;let active=true;setError('');
    const accept=(next:Listing)=>{
      if(!active||id!==request.current)return;
      cache.current.set(`${clientPath}/${section}`,{revision,listing:next});
      setListing(next);setDisplaySection(section);
      const previous=selection.current.get(section);
      const first=section==='audio'?next.files.find(file=>file.variant==='Clean')||next.files[0]:next.files[0];
      const saved=(selections.current.get(section)||[]).filter(path=>next.files.some(file=>file.path===path));
      setSelectedPaths(saved.length?saved:first?[first.path]:[]);
      anchor.current=null;
      setSelectedPath(next.files.some(file=>file.path===previous)?previous!:first?.path||null);
      setLoading(false);
    };
    const cached=cache.current.get(`${clientPath}/${section}`);
    if(cached?.revision===revision){accept(cached.listing);return()=>{active=false;};}
    setLoading(true);
    void invoke<Listing>('client_files_list',{clientPath,category:section}).then(accept).catch(error=>{
      if(active&&id===request.current){setError(String(error));setLoading(false);}
    });
    return()=>{active=false;};
  },[clientPath,section,revision]);
  const category=SECTIONS.find(item=>item.id===displaySection)!;
  const visible=(listing?.files||[]).filter(file=>`${file.name} ${file.relative_path} ${file.variant}`.toLowerCase().includes(query.toLowerCase()));
  const selected=visible.find(file=>file.path===selectedPath)||visible[0]||null;
  const variantOrder=displaySection==='video'?['Raw','Proxy']:displaySection==='audio'?['Clean','Raw','Music']:displaySection==='stills'?['Stills','Graphics']:['Edit'];
  const groups=variantOrder.map(variant=>({variant,files:visible.filter(file=>file.variant===variant)})).filter(group=>group.files.length>0);
  const ordered=groups.flatMap(group=>group.files.map(file=>file.path));
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
  const openFolder=async(path:string)=>{try{await invoke('open_folder',{path});setError('');}catch(error){setError(String(error));}};
  const openProject=async(file:Asset)=>{
    if(opening)return;setOpening(true);setError('');
    try{await invoke('client_files_open_project',{clientPath,path:file.path});}catch(error){setError(String(error));}finally{setOpening(false);}
  };
  return <section className="client-files" aria-label="Client files">
    <header className="cf-toolbar">
      <nav className="cf-sections" aria-label="File categories">{SECTIONS.filter(item=>item.id!=='stills'||hasStills).map(({id,name,Icon})=><button type="button" key={id} aria-pressed={section===id} onClick={()=>{if(id!==section){setLoading(true);setSection(id);setQuery('');}}}><Icon size={15}/><span>{name}</span></button>)}</nav>
      <div className="cf-tools">
        {searchOpen&&<input autoFocus aria-label="Search client files" placeholder="Find a file" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){setQuery('');setSearchOpen(false);}}}/>}
        <button type="button" title={searchOpen?'Close file search':'Find a file'} aria-label={searchOpen?'Close file search':'Find a file'} aria-expanded={searchOpen} onClick={()=>{setSearchOpen(!searchOpen);if(searchOpen)setQuery('');}}><Search size={15}/></button>
        <button type="button" title="Refresh files" aria-label="Refresh client files" disabled={loading} onClick={()=>setRevision(value=>value+1)}><RefreshCw className={loading?'cf-spin':''} size={14}/></button>

      </div>
    </header>
    <div className="cf-body">
    {error&&<div className="cf-error" role="alert"><CircleAlert size={15}/><span>{error}</span></div>}
    {loading&&!listing?<div className="cf-loading" role="status"><LoaderCircle size={19} className="cf-spin"/><span>Opening {category.name.toLowerCase()}…</span></div>:!listing?null:!listing.files.length?<div className="cf-empty"><category.Icon size={29}/><strong>No {displaySection==='edit'?'editing projects':category.name.toLowerCase()} yet</strong></div>:<div className="cf-layout">
      <div className="cf-list-pane" aria-busy={loading}><div className="cf-list-summary"><span>{query?`${visible.length} of ${listing.files.length}`:listing.files.length} {listing.files.length===1?'file':'files'}</span>{listing.truncated&&<span title="Open the folder to see the full collection">First 2,000 shown</span>}</div>
        <div className="cf-list" tabIndex={0} onKeyDown={event=>{
          if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();setSelectedPaths(ordered);selections.current.set(displaySection,ordered);}
          if(event.key==='Escape'){pointer.current=null;setSelectedPaths([]);selections.current.set(displaySection,[]);}
        }} aria-label={`${category.name} files`}>
          {groups.map(({variant,files})=>{const Icon=mediaRoleIcon(files[0].path,variant);return <section className="cf-variant" key={variant} aria-label={variant}>{displaySection!=='edit'&&<h3><Icon size={13} aria-hidden="true"/>{variant}</h3>}{files.map(file=>{const Icon=file.kind==='project'?SquarePen:file.kind==='audio'?Headphones:file.kind==='image'?Image:FileVideo;const duplicate=(nameCounts.get(`${file.variant}/${file.name.toLowerCase()}`)||0)>1;const parent=duplicate?file.relative_path.replace(/[\\/][^\\/]*$/,''):'';const detail=parent&&parent!==file.name?parent:'';return <button type="button" className={`cf-file ${visibleSelection.includes(file.path)?'selected':''}`} key={file.path} aria-pressed={visibleSelection.includes(file.path)} title={file.kind==='project'?`${file.relative_path} · Double-click to open`:file.relative_path} onContextMenu={event=>{if(!visibleSelection.includes(file.path))choose(file);onContextMenu(event,file.name,[...(file.kind==='project'?[{label:projectAction(file.name),action:()=>void openProject(file)}]:[]),{label:'Open file location',action:()=>void openFolder(file.path.replace(/[\\/][^\\/]*$/,''))}]);}} onPointerDown={event=>pointerDown(event,file)} onPointerMove={pointerMove} onPointerUp={()=>{pointer.current=null;}} onPointerCancel={()=>{pointer.current=null;}} onDragStart={event=>event.preventDefault()} onClick={event=>{
              if(dragged.current){dragged.current=false;return;}
              if(event.detail===0||(!event.shiftKey&&!event.ctrlKey&&!event.metaKey))choose(file,event.shiftKey,event.ctrlKey||event.metaKey);
            }} onDoubleClick={()=>{if(!dragged.current&&file.kind==='project')void openProject(file);}}><Icon size={15}/><span>{file.name}</span>{detail&&<small>{detail}</small>}</button>;})}</section>;})}
          {!visible.length&&<div className="cf-no-results">No matching files</div>}
        </div>
      </div>
      {selected&&<aside className="cf-preview">
        <header className="cf-preview-heading"><strong title={selected.relative_path}>{selected.name}</strong></header>
        <div className="cf-preview-content">{selected.kind==='project'?<div className="cf-project"><SquarePen size={35}/><span>{selected.name.split('.').pop()?.toUpperCase()} project</span><button type="button" className="cf-open-project" disabled={opening} onClick={()=>void openProject(selected)}>{opening?<LoaderCircle className="cf-spin" size={15}/>:<ArrowUpRight size={15}/>} {opening?'Opening…':projectAction(selected.name)}</button></div>:<SourceMediaPreview path={selected.path} name={selected.name} showHeading={false} quietLoading/>}</div>
        <footer className="cf-file-meta"><span>{bytes(selected.size)}</span>{selected.modified_ms!==null&&<time dateTime={new Date(selected.modified_ms).toISOString()} title={new Date(selected.modified_ms).toLocaleString()}>{new Date(selected.modified_ms).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})}</time>}</footer>
      </aside>}
    </div>}
    </div>
  </section>;
}
