import { TimelineNotes, type NoteTimelineProps } from './TimelineNotes';
import { useEffect, useRef } from 'react';
import { Audio, AudioPlayer, NeutralAudioSkin } from '@videojs/react/audio';
import '@videojs/react/audio/neutral-skin.css';
import { MediaTransition } from './MediaTransition';
import { AudioLines } from 'lucide-react';
import { useTimeReadoutScrub } from './useTimeReadoutScrub';

type AudioProps=NoteTimelineProps & {src:string;onError?:()=>void;onReady?:()=>void;seekTo?:number;onPlaybackTimeChange?:(currentTime:number,duration:number)=>void};
export function InlineAudioPlayer(props:AudioProps) {
  if(props.onReady)return <AudioSurface {...props}/>;
  return <MediaTransition source={props.src} onError={props.onError} render={(src,onReady,onError)=><AudioSurface {...props} src={src} onReady={onReady} onError={onError}/>}/>;
}
function AudioSurface({src,onError,onReady,seekTo,onPlaybackTimeChange,timelineMarkers,onAddTimestamp,markerFocusRequest,expanded,onToggleExpanded}:AudioProps) {
  const root=useRef<HTMLDivElement>(null);
  useTimeReadoutScrub(root);
  const callback=useRef(onPlaybackTimeChange);callback.current=onPlaybackTimeChange;
  // Artwork is ready immediately; metadata and playable audio load independently.
  useEffect(()=>{onReady?.();},[src]);
  useEffect(()=>{
    const audio=root.current?.querySelector('audio');
    if(!audio)return;
    const report=()=>callback.current?.(audio.currentTime,Number.isFinite(audio.duration)?audio.duration:0);
    audio.addEventListener('seeking',report);audio.addEventListener('timeupdate',report);audio.addEventListener('loadedmetadata',report);audio.addEventListener('durationchange',report);
    return()=>{audio.removeEventListener('seeking',report);audio.removeEventListener('timeupdate',report);audio.removeEventListener('loadedmetadata',report);audio.removeEventListener('durationchange',report);};
  },[src]);
  useEffect(()=>{
    const audio=root.current?.querySelector('audio');
    if(audio&&seekTo!==undefined&&Number.isFinite(seekTo)&&Math.abs(audio.currentTime-seekTo)>.05)audio.currentTime=Math.max(0,Math.min(seekTo,Number.isFinite(audio.duration)?audio.duration:seekTo));
  },[seekTo,src,markerFocusRequest]);
  return <div className={`pepper-audio-preview ${onAddTimestamp?'has-note-timing':''}`} ref={root}><div className="pepper-audio-art pepper-media-visual"><AudioLines size={32}/></div><AudioPlayer><NeutralAudioSkin className="pepper-audio-compact"><Audio src={src} preload="metadata" onError={onError}/></NeutralAudioSkin></AudioPlayer><TimelineNotes expanded={expanded} onToggleExpanded={onToggleExpanded} markerFocusRequest={markerFocusRequest} root={root} timelineMarkers={timelineMarkers} onAddTimestamp={onAddTimestamp}/></div>;
}
