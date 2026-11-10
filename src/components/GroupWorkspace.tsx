import { PreviewSidebar } from "./PreviewSidebar";
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, CopyPlus, Folder, Headphones, FileVideo, GripVertical, Image, Search, UsersRound } from 'lucide-react';
import { NewIngestClient, type CreateIngestClient } from './NewIngestClient';
import { ClientLabel, parseClientLabel } from './ClientLabel';
import { SourceMediaPreview } from './SourceMediaPreview';
import { mediaKind } from './MediaTypes';
import { recordingGroups, type Recording } from './recordingGroups';
import './GroupWorkspace.css';
import { RecordingTimeline, RecordingPill } from './RecordingTimeline';

type File = Recording & {inbox_path:string;role:string;status:string;client:string|null;clients:string[];client_paths:string[]};
type Client = {name:string;path:string};
export function GroupWorkspace({projectRoot,files,clients,disabled,onAssign,onCreateClient}:{projectRoot:string;files:File[];clients:Client[];disabled:boolean;onAssign:(ids:string[],paths:string[],share?:boolean)=>void;onCreateClient:CreateIngestClient}) {
  const [selected,setSelected]=useState<string[]>([]),[preview,setPreview]=useState<File|null>(null);
  const [dragged,setDragged]=useState<string[]>([]),[over,setOver]=useState<string|null>(null),[query,setQuery]=useState('');
  const [share,setShare]=useState(false),[expanded,setExpanded]=useState<string[]>([]);
  const [collapsedGroups,setCollapsedGroups]=useState<string[]>([]);
  const [searchOpen,setSearchOpen]=useState(false);
  const anchor=useRef<string|null>(null);
  const pointer=useRef<{ids:string[];x:number;y:number;started:boolean}|null>(null);
  const suppressClick=useRef(false);
  const ghost=useRef<HTMLDivElement>(null);
  const storedPaths=(file:File)=>file.client_paths?.length?file.client_paths:file.clients?.length?file.clients:file.client?[file.client]:[];
  const paths=(file:File)=>storedPaths(file).filter(path=>clients.some(client=>client.path===path));
  const pending=files.filter(file=>file.status!=='Filed'&&!paths(file).length);
  const groups=recordingGroups(pending);
  const chosen=files.filter(file=>selected.includes(file.id)&&file.status!=='Filed');
  const choose=(file:File,shift=false)=>{
    if(suppressClick.current){suppressClick.current=false;return;}
    if(!shift&&selected.includes(file.id)){setSelected(current=>current.filter(id=>id!==file.id));setPreview(null);setShare(false);return;}
    if(!shift&&preview?.id===file.id){setPreview(null);return;}
    setPreview(file);if(disabled||file.status==='Filed')return;
    const available=files.filter(item=>item.status!=='Filed');
    const first=available.findIndex(item=>item.id===anchor.current),last=available.findIndex(item=>item.id===file.id);
    setSelected(shift&&first>=0?available.slice(Math.min(first,last),Math.max(first,last)+1).map(item=>item.id):[file.id]);
    if(!shift||first<0)anchor.current=file.id;
    setShare(false);
  };
  const assign=(ids:string[],path:string|null)=>{
    if(disabled||!ids.length)return;
    onAssign(ids,path?[path]:[],path?share:false);setSelected([]);setPreview(null);setShare(false);
    if(path)setExpanded(current=>current.includes(path)?current:[...current,path]);
  };
  const beginDrag=(event:React.PointerEvent<HTMLButtonElement>,ids:string[])=>{
    if(disabled||event.button!==0)return;
    if(event.pointerType==='mouse')event.currentTarget.blur();
    if(!ids.every(id=>selected.includes(id)))setShare(false);
    suppressClick.current=false;
    pointer.current={ids,x:event.clientX,y:event.clientY,started:false};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  // Pointer dragging avoids WebView2's native file-drop interception on Windows.
  useEffect(()=>{
    const hit=(event:PointerEvent)=>document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-media-destination]')||null;
    const destination=(event:PointerEvent)=>{
      const path=hit(event)?.dataset.mediaDestination;
      const ids=pointer.current?.ids||[];
      if(path==='unassigned'&&ids.every(id=>pending.some(file=>file.id===id)))return null;
      if(path&&path!=='unassigned'&&!share&&ids.every(id=>{const file=files.find(item=>item.id===id);return file&&paths(file).length===1&&paths(file)[0]===path;}))return null;
      return path||null;
    };
    const move=(event:PointerEvent)=>{
      const current=pointer.current;if(!current||disabled)return;
      if(!current.started&&Math.hypot(event.clientX-current.x,event.clientY-current.y)<6)return;
      if(!current.started){current.started=true;setDragged(current.ids);}
      setOver(destination(event));
      if(ghost.current)ghost.current.style.transform=`translate(${Math.min(event.clientX+14,window.innerWidth-230)}px,${Math.min(event.clientY+14,window.innerHeight-60)}px)`;
      const pane=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('.ig-client-destinations,.ig-unassigned');
      if(pane){const bounds=pane.getBoundingClientRect();if(event.clientY>bounds.bottom-35)pane.scrollTop+=14;else if(event.clientY<bounds.top+35)pane.scrollTop-=14;}
    };
    const finish=(event:PointerEvent)=>{
      const current=pointer.current;const path=destination(event);pointer.current=null;
      if(current?.started){suppressClick.current=true;if(path&&!disabled)assign(current.ids,path==='unassigned'?null:path);}
      setDragged([]);setOver(null);
    };
    const cancel=()=>{pointer.current=null;setDragged([]);setOver(null);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')cancel();};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',cancel);
    window.addEventListener('blur',cancel);window.addEventListener('keydown',escape);
    return()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);window.removeEventListener('keydown',escape);};
  });
  const row=(file:File, pill?:{left:number;width:number})=>{
    const kind=mediaKind(file.name),Icon=kind==='audio'?Headphones:kind==='image'?Image:FileVideo;
    return <button key={file.id} className={`ig-group-file ${selected.includes(file.id)?'selected':''} ${dragged.includes(file.id)?'drag-source':''} ${pill?'ig-interval-row':''}`} title={pill?`${file.name}\n${file.recording_metadata?.start_source?.startsWith('filesystem_')?'Filesystem fallback': 'Embedded recording time'} | ${Number(BigInt(file.recording_metadata!.duration_ns!))/1e9}s`:undefined} aria-pressed={selected.includes(file.id)} onClick={event=>choose(file,event.shiftKey)} onPointerDown={event=>{if(file.status!=='Filed')beginDrag(event,selected.includes(file.id)?chosen.map(item=>item.id):[file.id]);}}><GripVertical size={12}/><Icon size={15}/><span title={file.name}>{file.name}</span>{pill&&<RecordingPill {...pill}/>}{file.status==='Filed'&&<small>Organised</small>}</button>;
  };
  const mediaRows=(items:File[])=>([{kind:'video',label:'Video'},{kind:'audio',label:'Audio'},{kind:'image',label:'Stills'},{kind:null,label:'Other'}] as const).map(({kind,label})=>{
    const typed=items.filter(file=>mediaKind(file.name)===kind);
    return typed.length>0?<div className="ig-group-media-section" role="group" aria-label={label} key={label}>{typed.map(file=>row(file))}</div>:null;
  });
  const timelineRows=(items:File[])=><RecordingTimeline files={items} className="ig-recording-timeline">{(file,placement)=>row(file,placement)}</RecordingTimeline>;
  return <div className={`ig-group-layout ${dragged.length?'dragging':''}`} onClick={event=>{const target=event.target as HTMLElement;if(target.closest('.ig-preview-rail,.ig-group-file,.ig-auto-group-heading,button,input,textarea,select,a,[role="button"],video,audio'))return;setSelected([]);setPreview(null);setShare(false);}}><div className="ig-group-main">
    <div ref={ghost} className={`ig-media-drag-ghost ${dragged.length?'visible':''}`} aria-hidden="true"><GripVertical size={14}/><span>{dragged.length===1?files.find(file=>file.id===dragged[0])?.name:`${dragged.length} files`}</span></div>
    <section className={`ig-unassigned ${over==='unassigned'?'drop-over':''}`} data-media-destination="unassigned">
      <header className="ig-group-section-title"><h2>Media groups</h2><span>{pending.length} files</span>{chosen.some(file=>storedPaths(file).length>0)&&<button className="ig-text-button" disabled={disabled} onClick={()=>assign(chosen.map(file=>file.id),null)}>Remove client assignment</button>}</header>
      {groups.map(group=><section className={`ig-auto-group ${group.files.every(file=>selected.includes(file.id))?'selected':''}`} key={group.id}>
        <button type="button" className="ig-client-drop-heading ig-client-disclosure" aria-label={`${collapsedGroups.includes(group.id)?'Expand':'Collapse'} ${group.name}`} aria-expanded={!collapsedGroups.includes(group.id)} title={group.automatic?'Suggested from overlapping recording intervals.':undefined} onPointerDown={event=>beginDrag(event,group.files.map(file=>file.id))} onClick={()=>{if(suppressClick.current){suppressClick.current=false;return;}setCollapsedGroups(current=>current.includes(group.id)?current.filter(id=>id!==group.id):[...current,group.id]);}}><span className="ig-client-assign"><Folder size={16}/><span className="ig-disclosure-label">{group.name}</span><small>{group.files.length} {group.files.length===1?'file':'files'}</small></span><ChevronRight className="ig-disclosure-chevron" size={14}/></button>
        {!collapsedGroups.includes(group.id)&&(group.automatic?timelineRows(group.files):mediaRows(group.files))}
      </section>)}
      {!pending.length&&<div className="ig-assignment-empty">All media has a client.</div>}
    </section>
    <section className="ig-client-destinations">
      <header className="ig-group-section-title ig-clients-heading"><h2>Clients</h2>{chosen.some(file=>paths(file).length>0)&&<button className={`ig-icon-button ig-client-share ${share?'active':''}`} title="Share with another client" aria-label="Share with another client" aria-pressed={share} onClick={()=>setShare(!share)}><CopyPlus size={14}/></button>}<div className={`ig-client-search ${searchOpen?'open':''}`}>
        {searchOpen&&<input autoFocus aria-label="Find a client" placeholder="Find a client" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){setQuery('');setSearchOpen(false);}}}/>}
        <button type="button" className="ig-icon-button" aria-label={searchOpen?'Close client search':'Search clients'} title={searchOpen?'Close search':'Search clients'} aria-expanded={searchOpen} onClick={()=>{if(searchOpen)setQuery('');setSearchOpen(!searchOpen);}}><Search size={15}/></button>
      </div></header>
      <div className="ig-client-drop-grid"><NewIngestClient projectRoot={projectRoot} disabled={disabled} onCreate={onCreateClient}/>{[...clients].sort((a,b)=>parseClientLabel(a.name).name.localeCompare(parseClientLabel(b.name).name,undefined,{sensitivity:'base'})).filter(client=>`${parseClientLabel(client.name).name} ${client.name}`.toLowerCase().includes(query.toLowerCase())).map(client=>{
        const assigned=files.filter(file=>paths(file).includes(client.path));const open=expanded.includes(client.path);
        return <section key={client.path} className={`ig-client-drop ${over===client.path?'drop-over':''} ${chosen.length||dragged.length?'can-assign':''}`} data-media-destination={client.path}>
          <button type="button" className="ig-client-drop-heading ig-client-disclosure" disabled={!assigned.length} aria-label={`${open?'Collapse':'Expand'} ${client.name} media`} aria-expanded={open} onClick={()=>setExpanded(current=>current.includes(client.path)?current.filter(path=>path!==client.path):[...current,client.path])}><span className="ig-client-assign"><UsersRound size={16}/><ClientLabel name={client.name}/><small>{assigned.length} {assigned.length===1?'file':'files'}</small></span>{assigned.length>0&&<ChevronRight className="ig-disclosure-chevron" size={14}/>}</button>
          {open&&mediaRows(assigned)}
        </section>;
      })}</div>
      {!clients.length&&<div className="ig-assignment-empty">No clients with a mode and all four media folders.</div>}
    </section>
  </div><PreviewSidebar autoCollapsed={!preview} path={preview?.inbox_path} name={preview?.name} className={`ig-group-preview ${preview?'has-selection':'no-selection'}`}><SourceMediaPreview path={preview?.inbox_path||null} name={preview?.name} showHeading={false}/>{preview&&<div className="ig-source-preview-meta"><span>{preview.role}</span>{preview.timestamp_warning&&<span title={preview.timestamp_warning}>Date needs checking</span>}</div>}</PreviewSidebar></div>;
}
