import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Trash2, X } from 'lucide-react';
export type NoteTimelineMarker={seconds:number;selected?:boolean;timecode:string;text?:string;onEditNote?:(text:string)=>void;key:string;onSelect:()=>void;onEdit?:(value:string)=>void};
export type NoteTimelineProps={timelineMarkers?:NoteTimelineMarker[];onAddTimestamp?:(seconds:number)=>void};
export function TimelineNotes({root,timelineMarkers=[],onAddTimestamp}:{root:RefObject<HTMLElement|null>} & NoteTimelineProps){
 const [duration,setDuration]=useState(0);
 const [timeline,setTimeline]=useState<HTMLElement|null>(null);
 const [editing,setEditing]=useState<NoteTimelineMarker|null>(null);
 const [value,setValue]=useState('');
 const [note,setNote]=useState('');
 const [error,setError]=useState(false);
 useEffect(()=>{const node=root.current;if(!node)return;const find=()=>setTimeline(node.querySelector<HTMLElement>('.media-time-slider'));find();const observer=new MutationObserver(find);observer.observe(node,{childList:true,subtree:true});return()=>observer.disconnect();},[root]);
 const addTimestamp = useRef(onAddTimestamp);
 addTimestamp.current = onAddTimestamp;
 useEffect(() => {
   const node = root.current;
   if (!timeline || !node) return;
   const addAtDoubleClick = (event: MouseEvent) => {
     if (event.button !== 0 || !timeline.contains(event.target as Node) || (event.target as Element).closest('.pepper-timeline-markers')) return;
     const media = node.querySelector('video,audio') as HTMLMediaElement | null;
     if (!addTimestamp.current || !media || !Number.isFinite(media.duration) || media.duration <= 0) return;
     const box = timeline.getBoundingClientRect();
     if (!box.width) return;
     event.preventDefault();
     event.stopPropagation();
     addTimestamp.current(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * media.duration);
   };
   // Use the browser's dblclick event so player seeking and pointer capture do
   // not interfere with detecting the two clicks.
   node.addEventListener('dblclick', addAtDoubleClick, true);
   return () => {
     node.removeEventListener('dblclick', addAtDoubleClick, true);
   };
 }, [timeline, root]);
 useEffect(()=>{const media=root.current?.querySelector('video,audio') as HTMLMediaElement|null;if(!media)return;const update=()=>setDuration(Number.isFinite(media.duration)?media.duration:0);update();media.addEventListener('loadedmetadata',update);media.addEventListener('durationchange',update);return()=>{media.removeEventListener('loadedmetadata',update);media.removeEventListener('durationchange',update);};},[timeline,root]);
 const save=()=>{const parts=value.trim().match(/^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/);const media=root.current?.querySelector('video,audio') as HTMLMediaElement|null;const seconds=parts?+parts[1]*3600 + +parts[2]*60 + +parts[3]+Number('0.'+(parts[4]||'0')):NaN;if(!parts||!Number.isFinite(seconds)||seconds>(media?.duration||0)){setError(true);return;}editing?.onEditNote?.(note);editing?.onEdit?.(`${parts[1].padStart(2,'0')}:${parts[2]}:${parts[3]}.${(parts[4]||'0').padEnd(3,'0')}`);setEditing(null);};
 if(!timeline)return null;

 return createPortal(<div className="pepper-timeline-markers">{timelineMarkers.map(marker=><button key={marker.key} type="button" aria-pressed={!!marker.selected} aria-label={marker.text||'Untitled note'} style={{left:`${Math.max(0,Math.min(100,marker.seconds/(duration||1)*100))}%`}} onPointerDownCapture={event=>{event.preventDefault();event.stopPropagation();}} onClick={event=>{event.stopPropagation();const media=root.current?.querySelector('video,audio') as HTMLMediaElement|null;if(media)media.currentTime=marker.seconds;marker.onSelect();}} onDoubleClick={event=>{event.preventDefault();event.stopPropagation();setEditing(marker);setValue(marker.timecode);setNote(marker.text||'');setError(false);}} onKeyDown={event=>{if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();marker.onEdit?.('');}else if(event.key==='F2'){setEditing(marker);setValue(marker.timecode);setNote(marker.text||'');setError(false);}}}><i/><span>{marker.text||'Untitled note'}</span></button>)}{editing&&<div className="timeline-note-editor" role="dialog" aria-label="Edit marker note" onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')setEditing(null);if(event.key==='Enter')save();}}><input autoFocus className="timeline-note-text" aria-label="Note" placeholder="Add a note" value={note} onChange={event=>setNote(event.target.value)}/><input aria-label="Timestamp" aria-invalid={error} value={value} onChange={event=>{setValue(event.target.value);setError(false);}}/><button type="button" aria-label="Save timestamp" onClick={save}><Check size={13}/></button><button type="button" aria-label="Delete timestamp" onClick={()=>{editing.onEdit?.('');setEditing(null);}}><Trash2 size={13}/></button><button type="button" aria-label="Close timestamp editor" onClick={()=>setEditing(null)}><X size={13}/></button></div>}</div>,timeline);
}
