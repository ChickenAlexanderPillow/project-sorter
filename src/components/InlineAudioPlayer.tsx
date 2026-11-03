import { useEffect } from 'react';
import { Audio, AudioPlayer, NeutralAudioSkin } from '@videojs/react/audio';
import '@videojs/react/audio/neutral-skin.css';
import { MediaTransition } from './MediaTransition';
import { AudioLines } from 'lucide-react';

type AudioProps={src:string;onError?:()=>void;onReady?:()=>void};
export function InlineAudioPlayer(props:AudioProps) {
  if(props.onReady)return <AudioSurface {...props}/>;
  return <MediaTransition source={props.src} onError={props.onError} render={(src,onReady,onError)=><AudioSurface src={src} onReady={onReady} onError={onError}/>}/>;
}
function AudioSurface({src,onError,onReady}:AudioProps) {
  // Artwork is ready immediately; metadata and playable audio load independently.
  useEffect(()=>{onReady?.();},[src]);
  return <div className="pepper-audio-preview"><div className="pepper-audio-art pepper-media-visual"><AudioLines size={32}/></div><AudioPlayer><NeutralAudioSkin className="pepper-audio-compact"><Audio src={src} preload="metadata" onError={onError}/></NeutralAudioSkin></AudioPlayer></div>;
}
