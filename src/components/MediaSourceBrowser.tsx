import { PreviewSidebar } from "./PreviewSidebar";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, ArrowUp, Check, ChevronRight, CircleAlert, Headphones, FileVideo, Folder, HardDrive, Image, LoaderCircle, RefreshCw, Search, Usb, X } from "lucide-react";
import { defaultRole, type SourceMedia } from "./MediaTypes";
import { SourceMediaPreview } from "./SourceMediaPreview";

type Location = {name:string;path:string;kind:string;available:boolean;total_bytes:number|null;free_bytes:number|null};
type Entry = {name:string;path:string;kind:string;size:number};
type Listing = {path:string;parent:string|null;entries:Entry[];truncated:boolean};
const pathKey = (path:string) => /^[a-z]:|^\\\\/i.test(path) ? path.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase() : path.replace(/\/+$/,'');
const size = (bytes:number) => bytes >= 1024**3 ? `${(bytes/1024**3).toFixed(1)} GB` : `${(bytes/1024**2).toFixed(1)} MB`;
const iconFor = (kind:string) => kind === 'folder' || kind === 'project' ? Folder : kind === 'removable' ? Usb : kind === 'audio' ? Headphones : kind === 'video' ? FileVideo : kind === 'image' ? Image : HardDrive;

export function MediaSourceBrowser({projectRoot,onAdd,onClose}:{projectRoot:string;onAdd:(files:SourceMedia[])=>void;onClose:()=>void}) {
  const [locations,setLocations] = useState<Location[]>([]), [listing,setListing] = useState<Listing|null>(null);
  const [loading,setLoading] = useState(false), [scanning,setScanning] = useState(false), [error,setError] = useState('');
  const [address,setAddress] = useState(''), [query,setQuery] = useState('');
  const [selected,setSelected] = useState<Entry[]>([]);
  const [preview,setPreview] = useState<Entry|null>(null);
  const anchor=useRef<string|null>(null);
  const knownDevices=useRef<Set<string>|null>(null);
  const [newDevices,setNewDevices]=useState<Location[]>([]);
  const request = useRef(0), scanRequest = useRef(0), dialog = useRef<HTMLDivElement>(null);
  const refresh = async () => {
    const id=++request.current;setLoading(true);setError('');
    try {const next=await invoke<Location[]>('media_source_locations',{projectRoot});if(id===request.current){knownDevices.current=new Set(next.filter(item=>item.available).map(item=>item.path));setNewDevices([]);setLocations(next);setListing(null);setAddress('');setQuery('');setPreview(null);}}
    catch(e){if(id===request.current)setError(String(e));}finally{if(id===request.current)setLoading(false);}
  };
  const browse = async (path:string) => {
    if(scanning)return;
    const id=++request.current;setLoading(true);setError('');
    try {const next=await invoke<Listing>('media_browse_folder',{path});if(id===request.current){setListing(next);setAddress(next.path);setQuery('');setPreview(null);}}
    catch(e){if(id===request.current)setError(String(e));}finally{if(id===request.current)setLoading(false);}
  };
  useEffect(() => {void refresh();const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();return()=>{request.current++;scanRequest.current++;previous?.focus();};},[projectRoot]);
  const isSelected=(path:string)=>selected.some(item=>pathKey(item.path)===pathKey(path));
  const selectEntry=(entry:Entry,shift=false,toggle=false)=>{
    if(scanning)return;
    if(entry.kind==='folder'&&!toggle){void browse(entry.path);return;}
    if(entry.kind!=='folder')setPreview(entry);
    const section=(listing?.entries||[]).filter(item=>item.kind===entry.kind&&item.name.toLowerCase().includes(query.toLowerCase()));
    const first=section.findIndex(item=>item.path===anchor.current),last=section.findIndex(item=>item.path===entry.path);
    setSelected(current=>{
      const sameKind=current.filter(item=>item.kind===entry.kind);
      if(shift&&first>=0&&last>=0){const range=section.slice(Math.min(first,last),Math.max(first,last)+1);return [...sameKind,...range.filter(item=>!sameKind.some(old=>pathKey(old.path)===pathKey(item.path)))];}
      return toggle?(sameKind.some(item=>pathKey(item.path)===pathKey(entry.path))?sameKind.filter(item=>pathKey(item.path)!==pathKey(entry.path)):[...sameKind,entry]):[entry];
    });
    if(!shift||first<0)anchor.current=entry.path;
  };
  const addSelected=async()=>{
    const id=++scanRequest.current;setScanning(true);setError('');
    try{const files=await invoke<Entry[]>('media_resolve_files',{paths:selected.map(entry=>entry.path)});if(id!==scanRequest.current)return;if(!files.length){setError('No supported media found in your selection.');return;}onAdd(files.map(entry=>({...entry,role:defaultRole(entry.path)})));onClose();}
    catch(e){if(id===scanRequest.current)setError(String(e));}finally{if(id===scanRequest.current)setScanning(false);}
  };
  // Discover inserted cards without resetting the current folder or selection.
  useEffect(()=>{
    let active=true,pending=false;
    const update=async()=>{if(pending)return;pending=true;try{const next=await invoke<Location[]>('media_source_locations',{projectRoot});if(active){const available=next.filter(item=>item.available);if(knownDevices.current){const added=available.filter(item=>item.kind==='removable'&&!knownDevices.current!.has(item.path));setNewDevices(current=>[...current.filter(item=>available.some(device=>device.path===item.path)),...added.filter(item=>!current.some(device=>device.path===item.path))]);}knownDevices.current=new Set(available.map(item=>item.path));setLocations(next);}}catch{/* Keep the last discovered locations while a device is mounting. */}finally{pending=false;}};
    const timer=window.setInterval(()=>void update(),3000);
    window.addEventListener('focus',update);
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',update);};
  },[projectRoot]);
  const visible=listing?.entries.filter(entry=>entry.name.toLowerCase().includes(query.toLowerCase()))||[];
  const drives=locations.filter(location=>location.available&&!['folder','project'].includes(location.kind));
  const emptyReaders=locations.filter(location=>!location.available);
  const folders=locations.filter(location=>['folder','project'].includes(location.kind));
  return <div className="ig-browser-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!scanning)onClose();}}>
    <div className={`ig-browser ${listing?'ig-browser-with-preview':''}`} role="dialog" aria-modal="true" aria-labelledby="media-browser-title" tabIndex={-1} ref={dialog} onKeyDown={e=>{
      if(e.key==='Escape'&&!scanning){e.stopPropagation();onClose();}
      if(e.key==='Tab'){const items=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]'));const first=items[0],last=items[items.length-1];if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    }}>
      <header className="ig-browser-heading"><div><h2 id="media-browser-title">Choose your media</h2></div><button className="ig-icon-button" aria-label="Close media browser" disabled={scanning} onClick={onClose}><X size={18}/></button></header>
      <div className="ig-browser-address"><button className="ig-icon-button" title="All locations" aria-label="All locations" disabled={loading||scanning||!listing} onClick={()=>{request.current++;setListing(null);setPreview(null);setAddress('');setError('');setQuery('');}}><ArrowLeft size={16}/></button><button className="ig-icon-button" title="Parent folder" aria-label="Parent folder" disabled={loading||scanning||!listing?.parent} onClick={()=>void browse(listing!.parent!)}><ArrowUp size={16}/></button><form onSubmit={e=>{e.preventDefault();if(!scanning&&address.trim())void browse(address.trim());}}><Folder size={15}/><input aria-label="Folder or network path" placeholder="Go to a folder or network location…" value={address} onChange={e=>setAddress(e.target.value)}/><button className="ig-icon-button" aria-label="Open folder path" disabled={!address.trim()||loading||scanning}><ChevronRight size={16}/></button></form><button className="ig-icon-button" aria-label="Refresh sources" disabled={loading||scanning} onClick={()=>void(listing?browse(listing.path):refresh())}><RefreshCw size={15}/></button></div>
      {listing&&newDevices.length>0&&<div className="ig-browser-device-notice"><Usb size={14}/><span>Card connected</span>{newDevices.map(device=><button className="ig-text-button" key={device.path} onClick={()=>{setNewDevices(current=>current.filter(item=>item.path!==device.path));void browse(device.path);}}>{device.name}<ChevronRight size={13}/></button>)}</div>}
      {error&&<div className="ig-alert" role="alert"><CircleAlert size={16}/><span>{error}</span></div>}
      <div className={`ig-browser-content ${listing?'ig-browser-split':''}`}>
        {loading?<div className="ig-loading"><LoaderCircle className="ig-spin" size={20}/>Opening media…</div>:!listing?<>
          <div className="ig-section-label"><span>Connected storage</span></div>
          <div className="ig-location-grid">{drives.map(location=>{const Icon=iconFor(location.kind);return <button key={location.path} className="ig-location-tile" onClick={()=>void browse(location.path)}><Icon size={24}/><strong>{location.name}</strong><span>{location.kind==='removable'?'Card or recorder':location.kind==='network'?'Network storage':'Computer storage'}</span>{location.total_bytes&&location.free_bytes!==null?<><div className="ig-drive-meter"><span style={{width:`${Math.min(100,Math.max(0,100*(1-location.free_bytes/location.total_bytes)))}%`}}/></div><small>{size(location.free_bytes)} free of {size(location.total_bytes)}</small></>:<small>{location.path}</small>}</button>;})}</div>
          <div className="ig-section-label"><span>Your folders</span><small>Local folders and this project</small></div>
          <div className="ig-location-grid ig-folder-locations">{folders.map(location=><button key={location.path} className="ig-location-tile" onClick={()=>void browse(location.path)}><Folder size={21}/><strong>{location.name}</strong><small title={location.path}>{location.path}</small></button>)}</div>
          {emptyReaders.length>0&&<details className="ig-empty-readers"><summary>{emptyReaders.length} empty card readers</summary><p>{emptyReaders.map(location=>location.path).join(' · ')} — insert a card to see it here.</p></details>}
        </>:<>
          <div className="ig-browser-recordings">
            <div className="ig-browser-folder-tools"><label className="ig-search"><Search size={14}/><input aria-label="Search this folder" placeholder="Search this folder" value={query} onChange={e=>setQuery(e.target.value)}/></label></div>
            {([{kind:'folder',label:'Folders',Icon:Folder},{kind:'video',label:'Video',Icon:FileVideo},{kind:'audio',label:'Audio',Icon:Headphones},{kind:'image',label:'Stills',Icon:Image}] as const).map(({kind,label,Icon})=>{
              const entries=visible.filter(entry=>entry.kind===kind);
              if(!entries.length)return null;
              const sectionSelected=selected.filter(entry=>entry.kind===kind);
              const checked=entries.every(entry=>isSelected(entry.path));
              return <section className="ig-browser-media-section" key={kind}>
                <header className="ig-media-section-heading"><input type="checkbox" aria-label={`Select all ${label.toLowerCase()}`} disabled={scanning} checked={checked} ref={node=>{if(node)node.indeterminate=!checked&&entries.some(entry=>isSelected(entry.path));}} onChange={e=>{setSelected(e.target.checked?entries:[]);anchor.current=entries[0]?.path||null;}}/><Icon size={15}/><h2>{label}</h2><span>{sectionSelected.length?`${sectionSelected.length} selected`:entries.length}</span></header>
                {entries.map(entry=><div className={`ig-browser-entry ${isSelected(entry.path)?'selected':''} ${preview?.path===entry.path?'previewing':''}`} key={entry.path} onClick={e=>{if(!(e.target as HTMLElement).closest('button,input'))selectEntry(entry,e.shiftKey);}}><input type="checkbox" disabled={scanning} checked={isSelected(entry.path)} aria-label={`Select ${entry.name}`} onClick={e=>{e.stopPropagation();selectEntry(entry,e.shiftKey,true);}} onChange={()=>{}}/><button className="ig-browser-entry-name" aria-label={`Select ${entry.name}`} onClick={e=>selectEntry(entry,e.shiftKey)}><Icon size={17}/><span>{entry.name}</span></button>{kind==='folder'?<button className="ig-icon-button" aria-label={`Open ${entry.name}`} onClick={()=>void browse(entry.path)}><ChevronRight size={16}/></button>:<small>{size(entry.size)}</small>}</div>)}
              </section>;
            })}
            {!visible.length&&<div className="ig-loading">{query?'No matching media or folders.':'No media in this folder.'}</div>}
            {listing.truncated&&<p className="ig-quiet-note">Showing the first 5,000 items.</p>}
          </div>
          <PreviewSidebar path={preview?.path} name={preview?.name} className="ig-browser-preview"><SourceMediaPreview path={preview?.path||null} name={preview?.name} showHeading={false}/>{preview&&<div className="ig-source-preview-meta"><span>{preview.kind==='video'?'Video':preview.kind==='audio'?'Audio':'Stills'}</span><span>{size(preview.size)}</span></div>}</PreviewSidebar>
        </>}
      </div>
      <footer className="ig-browser-footer"><div><strong>{selected.length?`${selected.length} item${selected.length===1?'':'s'} selected`:'Nothing selected yet'}</strong></div>{selected.length>0&&<button className="ig-text-button" onClick={()=>setSelected([])}>Clear</button>}<button className="ig-button" disabled={scanning} onClick={onClose}>Cancel</button><button className="ig-button ig-primary" disabled={!selected.length||scanning} onClick={()=>void addSelected()}>{scanning?<LoaderCircle className="ig-spin" size={15}/>:<Check size={15}/>} {scanning?'Finding media...':'Add selected'}</button></footer>
    </div>
  </div>;
}
