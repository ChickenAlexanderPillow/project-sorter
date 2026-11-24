import { useEffect, useRef } from 'react';
import { Audio, AudioPlayer, NeutralAudioSkin } from '@videojs/react/audio';
import '@videojs/react/audio/neutral-skin.css';
import { MediaTransition } from './MediaTransition';
import { AudioLines } from 'lucide-react';

type AudioProps={src:string;onError?:()=>void;onReady?:()=>void;seekTo?:number;onPlaybackTimeChange?:(currentTime:number,duration:number)=>void};
export function InlineAudioPlayer(props:AudioProps) {
  if(props.onReady)return <AudioSurface {...props}/>;
  return <MediaTransition source={props.src} onError={props.onError} render={(src,onReady,onError)=><AudioSurface src={src} onReady={onReady} onError={onError}/>}/>;
}
function AudioSurface({src,onError,onReady,seekTo,onPlaybackTimeChange}:AudioProps) {
  const root=useRef<HTMLDivElement>(null);
  const callback=useRef(onPlaybackTimeChange);callback.current=onPlaybackTimeChange;
  // Artwork is ready immediately; metadata and playable audio load independently.
  useEffect(()=>{onReady?.();},[src]);
  useEffect(()=>{
    const audio=root.current?.querySelector('audio');
    if(!audio)return;
    const report=()=>callback.current?.(audio.currentTime,Number.isFinite(audio.duration)?audio.duration:0);
    audio.addEventListener('timeupdate',report);audio.addEventListener('loadedmetadata',report);audio.addEventListener('durationchange',report);
    return()=>{audio.removeEventListener('timeupdate',report);audio.removeEventListener('loadedmetadata',report);audio.removeEventListener('durationchange',report);};
  },[src]);
  useEffect(()=>{
    const audio=root.current?.querySelector('audio');
    if(audio&&seekTo!==undefined&&Number.isFinite(seekTo)&&Math.abs(audio.currentTime-seekTo)>.05)audio.currentTime=Math.max(0,Math.min(seekTo,Number.isFinite(audio.duration)?audio.duration:seekTo));
  },[seekTo,src]);
  return <div className="pepper-audio-preview" ref={root}><div className="pepper-audio-art pepper-media-visual"><AudioLines size={32}/></div><AudioPlayer><NeutralAudioSkin className="pepper-audio-compact"><Audio src={src} preload="metadata" onError={onError}/></NeutralAudioSkin></AudioPlayer></div>;
}
