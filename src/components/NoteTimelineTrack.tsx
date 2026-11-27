import {useEffect,useLayoutEffect,useRef,useState,type PointerEvent} from 'react';
import {Focus,Minus,Plus,ScanLine,Search} from 'lucide-react';
import {createPortal} from 'react-dom';
import type {NoteTimelineMarker} from './TimelineNotes';
import {formatNoteTime} from './noteTiming';
import {markerLanes,markerViewport,moveRangeBoundary,timelineSecond,timelineZoomScroll} from './noteTimelineGeometry';
import {noteRangeContains} from './activeNoteRanges';

type Props={controlsTarget?:HTMLElement|null;duration:number;time:number;markers:NoteTimelineMarker[];focusRequest?:number;onSeek:(second:number)=>void;onSelect:(marker:NoteTimelineMarker,second?:number)=>void;onAdd:(second:number)=>void};
export function NoteTimelineTrack({duration,time,markers,focusRequest,onSeek,onSelect,onAdd,controlsTarget}:Props){
  const viewport=useRef<HTMLDivElement>(null),track=useRef<HTMLDivElement>(null),lane=useRef<HTMLDivElement>(null);
  const [zoom,setZoom]=useState(1),[width,setWidth]=useState(0),[scroll,setScroll]=useState(0);
  const [drag,setDrag]=useState<{key:string;start:number;end:number;boundary:'in'|'out'}|null>(null);
  const pendingCenter=useRef<number|null>(null);
  const pendingAnchor=useRef<{scroll:number;width:number;pointer:number}|null>(null);
  const zoomValue=useRef(zoom);zoomValue.current=zoom;
  const suppressHandleClick=useRef(false);
  const activeDrag=useRef<{id:number;marker:NoteTimelineMarker;start:number;end:number;boundary:'in'|'out'}|null>(null);
  const selected=markers.find(marker=>marker.selected);
  const lanes=markerLanes(markers,duration,Math.max(1,width*zoom-24));
  const laneHeight=lanes.count*22+1;
  const maxZoom=Math.max(1,duration/10);
  const focusMarker=(marker:NoteTimelineMarker)=>{
    const view=markerViewport(duration,marker.seconds,marker.endSeconds);
    pendingAnchor.current=null;pendingCenter.current=view.center;setZoom(view.zoom);
    // Recenter even when the zoom factor has not changed.
    if(viewport.current){viewport.current.scrollLeft=(view.center/duration*view.zoom-.5)*viewport.current.clientWidth;}
  };
  useEffect(()=>{
    if(selected&&duration>0)focusMarker(selected);
  },[selected?.key,focusRequest,duration]);
  useEffect(()=>{
    const element=viewport.current;if(!element)return;
    const observer=new ResizeObserver(()=>setWidth(element.clientWidth));observer.observe(element);setWidth(element.clientWidth);
    return()=>observer.disconnect();
  },[]);
  useLayoutEffect(()=>{
    const element=viewport.current;if(!element||!duration)return;
    if(pendingAnchor.current){
      const anchor=pendingAnchor.current;
      element.scrollLeft=timelineZoomScroll(anchor.scroll,anchor.width,element.scrollWidth,anchor.pointer,element.clientWidth);
      pendingAnchor.current=null;setScroll(element.scrollLeft);return;
    }
    if(pendingCenter.current===null)return;
    element.scrollLeft=pendingCenter.current/duration*element.scrollWidth-element.clientWidth/2;
    pendingCenter.current=null;setScroll(element.scrollLeft);
  },[zoom,width,duration]);
  useEffect(()=>{
    const element=viewport.current;if(!element)return;
    let pan:{id:number;x:number;scroll:number}|null=null;
    const wheel=(event:WheelEvent)=>{
      if(!duration)return;
      event.preventDefault();event.stopPropagation();
      if(event.deltaY===0){element.scrollLeft+=event.deltaX;return;}
      const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?element.clientWidth:1);
      const next=Math.max(1,Math.min(maxZoom,zoomValue.current*Math.exp(-Math.max(-500,Math.min(500,pixels))*.003)));
      if(Math.abs(next-zoomValue.current)<.0001)return;
      pendingCenter.current=null;
      pendingAnchor.current={scroll:element.scrollLeft,width:element.scrollWidth,pointer:event.clientX-element.getBoundingClientRect().left};
      zoomValue.current=next;setZoom(next);
    };
    const down=(event:globalThis.PointerEvent)=>{
      if(event.button!==1)return;
      event.preventDefault();event.stopPropagation();
      pan={id:event.pointerId,x:event.clientX,scroll:element.scrollLeft};
      element.setPointerCapture(event.pointerId);element.classList.add('is-panning');
    };
    const move=(event:globalThis.PointerEvent)=>{
      if(!pan||pan.id!==event.pointerId)return;
      element.scrollLeft=pan.scroll-(event.clientX-pan.x);event.preventDefault();event.stopPropagation();
    };
    const finish=(event:globalThis.PointerEvent)=>{
      if(!pan||pan.id!==event.pointerId)return;
      pan=null;element.classList.remove('is-panning');
      if(element.hasPointerCapture(event.pointerId))element.releasePointerCapture(event.pointerId);
      event.preventDefault();event.stopPropagation();
    };
    const preventAutoScroll=(event:MouseEvent)=>{if(event.button===1){event.preventDefault();event.stopPropagation();}};
    element.addEventListener('wheel',wheel,{passive:false});
    element.addEventListener('pointerdown',down,true);element.addEventListener('pointermove',move,true);element.addEventListener('pointerup',finish,true);element.addEventListener('pointercancel',finish,true);element.addEventListener('lostpointercapture',finish,true);
    element.addEventListener('mousedown',preventAutoScroll,true);element.addEventListener('auxclick',preventAutoScroll,true);
    return()=>{
      if(pan&&element.hasPointerCapture(pan.id))element.releasePointerCapture(pan.id);
      element.classList.remove('is-panning');
      element.removeEventListener('wheel',wheel);element.removeEventListener('pointerdown',down,true);element.removeEventListener('pointermove',move,true);element.removeEventListener('pointerup',finish,true);element.removeEventListener('pointercancel',finish,true);element.removeEventListener('lostpointercapture',finish,true);
      element.removeEventListener('mousedown',preventAutoScroll,true);element.removeEventListener('auxclick',preventAutoScroll,true);
    };
  },[duration,maxZoom]);
  const changeZoom=(next:number)=>{
    const element=viewport.current;
    pendingAnchor.current=null;
    pendingCenter.current=element?((element.scrollLeft+element.clientWidth/2)/Math.max(1,element.scrollWidth))*duration:time;
    setZoom(Math.max(1,Math.min(maxZoom,next)));
  };
  const select=(marker:NoteTimelineMarker,second=marker.seconds)=>{onSelect(marker,second);focusMarker(marker);};
  const commitRange=(marker:NoteTimelineMarker,start:number,end:number,boundary:'in'|'out')=>{
    const timecode=formatNoteTime(start),endTimecode=formatNoteTime(end);
    marker.onEdit?.(timecode,endTimecode);
    onSelect({...marker,seconds:start,endSeconds:end,timecode,endTimecode},boundary==='in'?start:end);
  };
  const finishDrag=(event:PointerEvent<HTMLButtonElement>,cancel=false)=>{
    const current=activeDrag.current;if(!current||current.id!==event.pointerId)return;
    activeDrag.current=null;setDrag(null);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    suppressHandleClick.current=true;
    if(!cancel)commitRange(current.marker,current.start,current.end,current.boundary);
    event.stopPropagation();
  };
  const handle=(marker:NoteTimelineMarker,boundary:'in'|'out',at:number)=><button type="button" className={`note-range-handle ${boundary}`} key={`${marker.key}-${boundary}`} style={{left:`${at/duration*100}%`,top:lanes.rows[marker.key]*22+1}} title={`Drag ${boundary==='in'?'In':'Out'} point`} aria-label={`${boundary==='in'?'In':'Out'} point ${formatNoteTime(at)}`} onPointerDown={event=>{
    if(event.button!==0)return;event.preventDefault();event.stopPropagation();
    suppressHandleClick.current=false;
    activeDrag.current={id:event.pointerId,marker,start:marker.seconds,end:marker.endSeconds!,boundary};
    event.currentTarget.setPointerCapture(event.pointerId);
  }} onPointerMove={event=>{
    const current=activeDrag.current,element=lane.current;if(!current||current.id!==event.pointerId||!element)return;
    const box=element.getBoundingClientRect();const second=timelineSecond(event.clientX,box.left,box.width,duration);
    const next=moveRangeBoundary(current.start,current.end,second,current.boundary,duration);
    current.start=next.start;current.end=next.end;setDrag({key:marker.key,...next,boundary});
    onSeek(boundary==='in'?next.start:next.end);event.stopPropagation();
  }} onPointerUp={event=>finishDrag(event)} onPointerCancel={event=>finishDrag(event,true)} onLostPointerCapture={event=>finishDrag(event,true)} onClick={event=>{event.stopPropagation();if(suppressHandleClick.current){suppressHandleClick.current=false;return;}onSeek(at);}} onKeyDown={event=>{
    if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;event.preventDefault();event.stopPropagation();
    const next=moveRangeBoundary(marker.seconds,marker.endSeconds!,at+(event.key==='ArrowLeft'?-1:1),boundary,duration);
    commitRange(marker,next.start,next.end,boundary);
  }}><span aria-hidden="true">{boundary==='in'?'[':']'}</span></button>;
  const startTime=duration*scroll/Math.max(1,width*zoom),endTime=Math.min(duration,startTime+duration/zoom);
  const controls=<details className="note-preview-menu note-zoom-menu"><summary aria-label="Timeline zoom" title="Timeline zoom"><Search size={14}/></summary><div className="note-preview-menu-content">
      <button type="button" title="Zoom out" aria-label="Zoom out timeline" disabled={zoom<=1} onClick={()=>changeZoom(zoom/2)}><Minus size={13}/><span>Zoom out</span></button>
      <button type="button" title="Zoom in" aria-label="Zoom in timeline" disabled={zoom>=maxZoom} onClick={()=>changeZoom(zoom*2)}><Plus size={13}/><span>Zoom in</span></button>
      <button type="button" title="Fit whole recording" aria-label="Fit whole recording" onClick={()=>{pendingCenter.current=duration/2;setZoom(1);if(viewport.current)viewport.current.scrollLeft=0;}}><ScanLine size={13}/><span>Fit recording</span></button>
      <button type="button" title="Zoom to selected marker" aria-label="Zoom to selected marker" disabled={!selected} onClick={()=>{if(selected)focusMarker(selected);}}><Focus size={13}/><span>Fit selection</span></button>
    </div></details>;
  return <div className="note-timeline" role="group" aria-label="Marker timeline">
    {controlsTarget?createPortal(controls,controlsTarget):controls}
    <div className="note-timeline-window"><span>{formatNoteTime(startTime)}</span><span>{formatNoteTime(endTime)}</span></div>
    <div className="note-timeline-viewport" title="Scroll to zoom. Drag with the middle mouse button to pan." ref={viewport} onScroll={event=>setScroll(event.currentTarget.scrollLeft)}>
      <div className="note-timeline-track" ref={track} style={{width:`${zoom*100}%`,height:laneHeight+23}}>
        <div className="note-marker-lane" ref={lane} role="group" aria-label="Markers" style={{height:laneHeight}}>
          {markers.map(marker=>{
            const first=drag?.key===marker.key?drag.start:marker.seconds,last=drag?.key===marker.key?drag.end:marker.endSeconds;
            const isRange=last!==undefined&&last>first;
            const rangeWidth=isRange?(last-first)/Math.max(1,duration)*Math.max(1,width*zoom-24):0;
            const handles=duration>0&&marker.selected&&isRange&&rangeWidth>=64;
            return <div className="note-lane-marker" key={marker.key}>
              <button type="button" className={`note-marker-block ${isRange?'range':'point'} ${noteRangeContains(time,first,last)?'playback-active':''}`} aria-current={noteRangeContains(time,first,last)?'time':undefined} aria-pressed={!!marker.selected} aria-label={`${isRange?'Select range':'Select marker'} ${marker.timecode}${marker.endTimecode?` to ${marker.endTimecode}`:''}: ${marker.text||'Untitled note'}`} title={`${marker.timecode}${marker.endTimecode?` – ${marker.endTimecode}`:''}\n${marker.text||'Untitled note'}`} style={{top:lanes.rows[marker.key]*22+3,left:`${first/Math.max(1,duration)*100}%`,width:isRange?`${(last-first)/Math.max(1,duration)*100}%`:undefined}} onClick={event=>{event.stopPropagation();select(marker);}} onDoubleClick={event=>event.stopPropagation()} onKeyDown={event=>{
                event.stopPropagation();if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();marker.onEdit?.('');}
              }}><span>{isRange?marker.text||'Range':'•'}</span></button>
              {handles&&<>{handle(marker,'in',first)}{handle(marker,'out',last!)}</>}
            </div>;
          })}
        </div>
        <span className="note-timeline-playhead" aria-hidden="true" style={{height:laneHeight+18,left:`calc(12px + (100% - 24px) * ${Math.max(0,Math.min(1,time/Math.max(1,duration)))})`}}/>
        <input className="note-timeline-seek" type="range" min={0} max={Math.floor(duration)||1} step={1} value={Math.min(Math.floor(time),Math.floor(duration)||1)} disabled={!duration} aria-label="Seek recording" onChange={event=>onSeek(Number(event.target.value))} onDoubleClick={event=>{
          event.preventDefault();event.stopPropagation();const box=lane.current?.getBoundingClientRect();if(box)onAdd(timelineSecond(event.clientX,box.left,box.width,duration));
        }}/>
      </div>
    </div>
  </div>;
}
