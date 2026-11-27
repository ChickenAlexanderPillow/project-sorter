import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Crosshair, Ellipsis, Maximize2, Minimize2, Pause, Pencil, Play, Plus, Trash2, Volume2, VolumeX, X } from 'lucide-react';
import { NoteTimelineTrack } from './NoteTimelineTrack';
import { formatNoteTime, parseNoteTime, validNoteRange } from './noteTiming';

export type NoteTimelineMarker={seconds:number;endSeconds?:number;selected?:boolean;timecode:string;endTimecode?:string;text?:string;onEditNote?:(text:string)=>void;key:string;onSelect:(seconds?:number)=>void;onEdit?:(value:string,end?:string)=>void};
export type NoteTimelineProps={expanded?:boolean;onToggleExpanded?:()=>void;markerFocusRequest?:number;timelineMarkers?:NoteTimelineMarker[];onAddTimestamp?:(seconds:number,endSeconds?:number)=>string|void};

export function TimelineNotes({root,timelineMarkers=[],onAddTimestamp,markerFocusRequest,expanded=false,onToggleExpanded}:{root:RefObject<HTMLElement|null>} & NoteTimelineProps){
  const [timeline,setTimeline]=useState<HTMLElement|null>(null);
  const [media,setMedia]=useState<HTMLMediaElement|null>(null);
  const [clock,setClock]=useState({time:0,duration:0});
  const [seekText,setSeekText]=useState<string|null>(null);
  const [timelineControls,setTimelineControls]=useState<HTMLDivElement|null>(null);
  const [transport,setTransport]=useState({paused:true,muted:false,volume:1,rate:1});
  const [editing,setEditing]=useState<string|null>(null);
  const [start,setStart]=useState('');
  const [end,setEnd]=useState('');
  const [note,setNote]=useState('');
  const [error,setError]=useState('');
  const addTimestamp=useRef(onAddTimestamp);addTimestamp.current=onAddTimestamp;
  const selected=timelineMarkers.find(marker=>marker.selected);
  const edited=timelineMarkers.find(marker=>marker.key===editing);
  useEffect(()=>{
    const node=root.current;if(!node)return;
    const closeOutside=(event:Event)=>node.querySelectorAll<HTMLDetailsElement>('.note-preview-menu[open]').forEach(menu=>{
      if(!menu.contains(event.target as Node))menu.open=false;
    });
    const closeOnEscape=(event:KeyboardEvent)=>{if(event.key==='Escape')node.querySelectorAll<HTMLDetailsElement>('.note-preview-menu[open]').forEach(menu=>{menu.open=false;});};
    document.addEventListener('pointerdown',closeOutside);node.addEventListener('keydown',closeOnEscape);
    return()=>{document.removeEventListener('pointerdown',closeOutside);node.removeEventListener('keydown',closeOnEscape);};
  },[root]);
  useEffect(()=>{
    const node=root.current;if(!node)return;
    const find=()=>{setTimeline(node.querySelector<HTMLElement>('.media-time-slider'));setMedia(node.querySelector<HTMLMediaElement>('video,audio'));};
    find();const observer=new MutationObserver(find);observer.observe(node,{childList:true,subtree:true});
    return()=>observer.disconnect();
  },[root]);
  useEffect(()=>{
    if(!media)return;
    setEditing(null);setError('');setSeekText(null);
    const update=()=>setClock({time:media.currentTime,duration:Number.isFinite(media.duration)?media.duration:0});
    const updateTransport=()=>setTransport({paused:media.paused,muted:media.muted,volume:media.volume,rate:media.playbackRate});
    const scrub=()=>{setSeekText(null);update();};
    updateTransport();
    const transportEvents=['play','pause','ended','volumechange','ratechange'];
    transportEvents.forEach(event=>media.addEventListener(event,updateTransport));
    root.current?.addEventListener('pepper-time-scrub',scrub);
    update();const events=['timeupdate','seeking','seeked','loadedmetadata','durationchange'];
    events.forEach(event=>media.addEventListener(event,update));
    const node=root.current;
    return()=>{events.forEach(event=>media.removeEventListener(event,update));transportEvents.forEach(event=>media.removeEventListener(event,updateTransport));node?.removeEventListener('pepper-time-scrub',scrub);};
  },[media]);
  useEffect(()=>{
    const node=root.current,card=node?.closest<HTMLElement>('.cf-note-preview');
    if(!node||!card||!onAddTimestamp)return;
    let frame=0;
    const update=()=>{
      const controls=node.querySelector<HTMLElement>('.note-preview-console');
      if(!controls)return;
      const heading=card.querySelector<HTMLElement>('.cf-preview-heading')?.offsetHeight??33;
      const room=window.innerHeight-Math.max(0,card.getBoundingClientRect().top)-controls.offsetHeight-heading-18;
      const height=`${Math.max(180,Math.min(300,room))}px`;
      if(card.style.getPropertyValue('--note-stage-height')!==height)card.style.setProperty('--note-stage-height',height);
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);};
    const observer=new ResizeObserver(schedule);
    const controls=node.querySelector('.note-preview-console');if(controls)observer.observe(controls);
    window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);schedule();
    return()=>{cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);card.style.removeProperty('--note-stage-height');};
  },[root,media,!!onAddTimestamp]);
  const seek=(seconds:number)=>{
    if(!media||!clock.duration)return;
    media.pause();media.currentTime=Math.max(0,Math.min(Math.floor(clock.duration),Math.floor(seconds)));
    setClock(current=>({...current,time:media.currentTime}));setSeekText(null);setError('');
  };
  const nudge=(direction:number,step=1)=>{if(media)seek(Math.floor(media.currentTime)+direction*step);};
  const togglePlayback=()=>{if(!media)return;if(media.paused)void media.play().catch(()=>setError('Playback could not start.'));else media.pause();};
  const openEditor=(marker:NoteTimelineMarker)=>{setEditing(marker.key);setStart(formatNoteTime(marker.seconds));setEnd(marker.endSeconds===undefined?'':formatNoteTime(marker.endSeconds));setNote(marker.text||'');setError('');};
  const createMarker=(seconds:number)=>{
    const at=Math.max(0,Math.min(Math.floor(clock.duration),Math.floor(seconds)));
    const key=addTimestamp.current?.(at);
    const existing=timelineMarkers.find(marker=>marker.key===key);
    if(existing){openEditor(existing);return;}
    if(key){setEditing(key);setStart(formatNoteTime(at));setEnd('');setNote('');setError('');}
  };
  const capture=(boundary:'in'|'out')=>{
    const marker=edited??selected;
    if(!media||!marker)return;
    const first=boundary==='in'?Math.floor(media.currentTime):parseNoteTime(edited?start:marker.timecode);
    const last=boundary==='out'?Math.floor(media.currentTime):parseNoteTime(edited?end:marker.endTimecode||'');
    if(!validNoteRange(first,last,clock.duration)){setError('Out must be after In and within this media.');return;}
    if(!edited)openEditor(marker);
    const inTime=formatNoteTime(first!),outTime=last===null?'':formatNoteTime(last);
    setStart(inTime);setEnd(outTime);setError('');
    if(edited)marker.onEditNote?.(note);
    marker.onEdit?.(inTime,outTime);
  };
  const markIn=()=>{if(media){media.pause();if(edited||selected)capture('in');else createMarker(media.currentTime);}};
  const markOut=()=>capture('out');
  useEffect(()=>{
    if(selected)openEditor(selected);
  },[selected?.key,markerFocusRequest,media]);
  const save=()=>{
    const first=parseNoteTime(start),last=end.trim()?parseNoteTime(end):null;
    if((end.trim()&&last===null)||!validNoteRange(first,last,clock.duration)){setError('Use a valid start and an optional later end within this media.');return;}
    edited?.onEditNote?.(note);edited?.onEdit?.(formatNoteTime(first!),last===null?'':formatNoteTime(last));
    setEditing(null);setError('');
  };
  // Shortcuts apply only inside this player and never while typing.
  const actions=useRef({nudge,markIn,markOut,createMarker});actions.current={nudge,markIn,markOut,createMarker};
  useEffect(()=>{
    const node=root.current;if(!node||!onAddTimestamp)return;
    const onKey=(event:KeyboardEvent)=>{
      if(event.metaKey||event.altKey||(event.target as Element).closest('input,textarea,select,[contenteditable=true],.note-range-handle'))return;
      const key=event.key.toLowerCase();
      if(!['arrowleft','arrowright','m','i','o'].includes(key)||(event.ctrlKey&&key!=='arrowleft'&&key!=='arrowright'))return;
      event.preventDefault();event.stopPropagation();
      if(key==='arrowleft'||key==='arrowright')actions.current.nudge(key==='arrowleft'?-1:1,event.ctrlKey?10:event.shiftKey?5:1);
      else if(key==='m'&&media&&Number.isFinite(media.duration)&&media.duration>0)actions.current.createMarker(media.currentTime);
      else if(key==='i')actions.current.markIn();else if(key==='o')actions.current.markOut();
    };
    node.addEventListener('keydown',onKey,true);return()=>node.removeEventListener('keydown',onKey,true);
  },[root,media,onAddTimestamp]);
  if(!timeline)return null;
  const timeField=(boundary:'in'|'out',value:string,setValue:(value:string)=>void)=><div className="note-boundary">
    <button type="button" className="note-boundary-label" title={`Go to ${boundary}`} disabled={parseNoteTime(value)===null} onClick={()=>{const time=parseNoteTime(value);if(time!==null)seek(time);}}>{boundary==='in'?'In':'Out'}</button>
    {boundary==='out'&&!value?<button type="button" className="note-set-out" title="Set Out to playhead (O)" onClick={markOut}>Set out</button>:<input aria-label={`${boundary==='in'?'In':'Out'} timestamp`} value={value} placeholder="00:00:00" onChange={event=>{setValue(event.target.value);setError('');}} onKeyDown={event=>{
      if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;
      event.preventDefault();const seconds=parseNoteTime(value)??media?.currentTime??0;
      const next=Math.max(0,Math.min(Math.floor(clock.duration),Math.floor(seconds)+(event.key==='ArrowUp'?1:-1)*(event.ctrlKey?10:event.shiftKey?5:1)));
      setValue(formatNoteTime(next));seek(next);
    }}/>}
    {(boundary==='in'||value)&&<button type="button" className="note-boundary-capture" title={`Set ${boundary} to playhead`} aria-label={`Set ${boundary} to playhead`} onClick={()=>capture(boundary)}><Crosshair size={12}/></button>}
    {boundary==='out'&&value&&<button type="button" className="note-boundary-clear" title="Remove Out point" aria-label="Remove Out point" onClick={()=>{const first=parseNoteTime(start);if(first===null){setError('Enter a valid In time.');return;}setEnd('');edited?.onEdit?.(formatNoteTime(first),'');}}><X size={12}/></button>}
  </div>;
  return onAddTimestamp&&root.current?createPortal(<section className="note-preview-console" aria-label="Preview controls" onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}>
    <div className="note-playback-bar" role="group" aria-label="Playback">
      <button type="button" className="note-play-toggle" aria-label={transport.paused?'Play preview':'Pause preview'} title={transport.paused?'Play':'Pause'} disabled={!clock.duration} onClick={togglePlayback}>{transport.paused?<Play size={17}/>:<Pause size={17}/>}</button>
      <div className="note-playback-clock">
        <input className="note-playhead" data-time-scrub aria-label="Playhead timestamp" title="Drag to scrub, or type a time. Arrow keys step by seconds; Shift 5s, Ctrl 10s." value={seekText??formatNoteTime(clock.time)} onChange={event=>setSeekText(event.target.value)} onKeyDown={event=>{
          if(event.key==='Enter'){event.preventDefault();const value=parseNoteTime(seekText??formatNoteTime(clock.time));if(value===null||value>clock.duration)setError('Enter a time within this media.');else seek(value);}
          else if(event.key==='Escape')setSeekText(null);
          else if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();nudge(event.key==='ArrowUp'?1:-1,event.ctrlKey?10:event.shiftKey?5:1);}
        }} onBlur={()=>{if(seekText===null)return;const value=parseNoteTime(seekText);if(value===null||value>clock.duration)setError('Enter a time within this media.');else seek(value);}}/>
        <span className="note-playback-duration">/ {formatNoteTime(clock.duration)}</span>
      </div>
      <div className="note-playback-actions">
        <div className="note-zoom-slot" ref={setTimelineControls}/>
        <button type="button" aria-label={transport.muted?'Unmute preview':'Mute preview'} title={transport.muted?'Unmute':'Mute'} onClick={()=>{if(media)media.muted=!media.muted;}}>{transport.muted||transport.volume===0?<VolumeX size={14}/>:<Volume2 size={14}/>}</button>
        <button type="button" className="note-add-marker" title="Add marker at playhead (M)" disabled={!clock.duration} onClick={()=>{if(media)createMarker(media.currentTime);}}><Plus size={14}/><span>Marker</span></button>
        {selected&&!edited&&<button type="button" title="Marker properties" aria-label="Marker properties" onClick={()=>openEditor(selected)}><Pencil size={14}/></button>}
        {onToggleExpanded&&<button type="button" title={expanded?'Restore 70:30 layout':'Expand preview to 80%'} aria-label={expanded?'Restore 70:30 layout':'Expand preview to 80%'} aria-pressed={expanded} onClick={onToggleExpanded}>{expanded?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button>}
        <details className="note-preview-menu"><summary aria-label="More playback controls" title="More playback controls"><Ellipsis size={15}/></summary><div className="note-preview-menu-content">
          <button type="button" aria-label={`Playback speed ${transport.rate}x`} onClick={()=>{if(media){const rates=[1,2,4];media.playbackRate=rates[(rates.indexOf(transport.rate)+1)%rates.length];}}}><span>Speed</span><strong>{transport.rate}x</strong></button>
          <label className="note-menu-volume"><span>Volume</span><input type="range" aria-label="Preview volume" min={0} max={1} step={.05} value={transport.muted?0:transport.volume} onChange={event=>{if(media){media.muted=false;media.volume=Number(event.target.value);}}}/></label>
        </div></details>
      </div>
    </div>
    <NoteTimelineTrack controlsTarget={timelineControls} duration={clock.duration} time={clock.time} markers={timelineMarkers} focusRequest={markerFocusRequest} onSeek={seek} onAdd={seconds=>{seek(seconds);createMarker(seconds);}} onSelect={(marker,seconds)=>{marker.onSelect(seconds);seek(seconds??marker.seconds);openEditor(marker);}}/>
    {edited&&<div className="note-marker-editor" role="group" aria-label="Marker properties" onKeyDown={event=>{if(event.key==='Escape'){setEditing(null);setError('');}else if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();save();}}}>
      <input className="note-marker-note" aria-label="Marker note" placeholder="Marker note" value={note} onChange={event=>setNote(event.target.value)}/>
      {timeField('in',start,setStart)}{timeField('out',end,setEnd)}
      <div className="note-marker-actions"><button type="button" className="note-marker-save" title="Save marker (Enter)" aria-label="Save marker" onClick={save}><Check size={14}/></button><button type="button" title="Delete marker" aria-label="Delete timestamp" onClick={()=>{edited.onEdit?.('');setEditing(null);}}><Trash2 size={13}/></button><button type="button" title="Close properties" aria-label="Close timestamp editor" onClick={()=>{setEditing(null);setError('');}}><X size={13}/></button></div>
    </div>}
    {error&&<div className="note-time-error" role="alert">{error}</div>}
  </section>,root.current):null;
}
