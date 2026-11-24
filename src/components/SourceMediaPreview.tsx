import type { NoteTimelineMarker } from './TimelineNotes';
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Headphones, FileVideo, Image as ImageIcon } from "lucide-react";
import { InlineVideoPlayer } from "./InlineVideoPlayer";
import { InlineAudioPlayer } from "./InlineAudioPlayer";
import { mediaKind } from "./MediaTypes";
import { MediaTransition } from "./MediaTransition";
import { previewPreparation } from "./previewPreparation";
import { videoPosters } from "./videoPosters";

type TimelineMarker=NoteTimelineMarker;
type Props={path:string|null;preloadPath?:string|null;preloadPaths?:readonly string[];name?:string;showHeading?:boolean;quietLoading?:boolean;seekTo?:number;onPlaybackTimeChange?:(currentTime:number,duration:number)=>void;onAddTimestamp?:(seconds:number)=>void;timelineMarkers?:TimelineMarker[]};
export function SourceMediaPreview({path,preloadPath,preloadPaths,name,showHeading=true,seekTo,onPlaybackTimeChange,onAddTimestamp,timelineMarkers}:Props) {
  const owner=useRef(Symbol('visible previews'));
  const candidatesKey=JSON.stringify([preloadPath,...(preloadPaths??[])].filter(candidate=>candidate&&candidate!==path));
  useEffect(()=>{
    videoPosters.setCandidates(owner.current,JSON.parse(candidatesKey) as string[]);
  },[candidatesKey]);
  useEffect(()=>{const key=owner.current;return()=>videoPosters.release(key);},[]);
  if(!path)return <div className="ig-inspector-empty"><FileVideo size={25}/>{showHeading&&<strong>Preview</strong>}</div>;
  const kind=mediaKind(path),Icon=kind==='audio'?Headphones:kind==='image'?ImageIcon:FileVideo;
  return <>
    {showHeading&&<header className="ig-inspector-heading"><span><Icon size={15}/><strong title={name}>{name||path.split(/[\\/]/).pop()}</strong></span></header>}
    <div className="ig-preview-media"><MediaTransition source={path} render={(source,onReady,onError)=><PreparedMedia path={source} onReady={onReady} onError={onError} seekTo={seekTo} onPlaybackTimeChange={onPlaybackTimeChange} timelineMarkers={timelineMarkers} onAddTimestamp={onAddTimestamp}/>} /></div>
  </>;
}
function PreparedMedia({path,onReady,onError,seekTo,onPlaybackTimeChange,onAddTimestamp,timelineMarkers}:{path:string;onReady:()=>void;onError:()=>void;seekTo?:number;onPlaybackTimeChange?:(currentTime:number,duration:number)=>void;onAddTimestamp?:(seconds:number)=>void;timelineMarkers?:TimelineMarker[]}) {
  const poster=useSyncExternalStore(videoPosters.subscribe,()=>videoPosters.get(path));
  const [prepared,setPrepared]=useState(()=>previewPreparation.isPrepared(path));
  useEffect(()=>{
    let active=true;
    void previewPreparation.prepare(path).then(()=>{if(active)setPrepared(true);}).catch(()=>{if(active)onError();});
    return()=>{active=false;};
  },[path]);
  if(!prepared)return <div className="ig-preview-placeholder"/>;
  const kind=mediaKind(path),src=convertFileSrc(path);
  return kind==='video'?<InlineVideoPlayer compact poster={poster} posterPath={path} src={src} onReady={onReady} onError={onError} seekTo={seekTo} onPlaybackTimeChange={onPlaybackTimeChange} timelineMarkers={timelineMarkers} onAddTimestamp={onAddTimestamp}/>:kind==='audio'?<InlineAudioPlayer src={src} onReady={onReady} onError={onError} seekTo={seekTo} onPlaybackTimeChange={onPlaybackTimeChange} timelineMarkers={timelineMarkers} onAddTimestamp={onAddTimestamp}/>:<img className="pepper-media-visual" alt={path.split(/[\\/]/).pop()||'Selected image'} src={src} onLoad={onReady} onError={onError}/>;
}
