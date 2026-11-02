import { useState } from 'react';
import { Audio, AudioPlayer, NeutralAudioSkin } from '@videojs/react/audio';
import '@videojs/react/audio/neutral-skin.css';
import { AudioLines } from 'lucide-react';

export function InlineAudioPlayer({src,onError}:{src:string;onError?:()=>void}) {
  const [loadedSrc,setLoadedSrc]=useState<string|null>(null);
  return <div className={`pepper-audio-preview${loadedSrc===src?' media-preview-loaded':''}`}><div className="pepper-audio-art"><AudioLines size={32}/></div><AudioPlayer><NeutralAudioSkin className="pepper-audio-compact"><Audio src={src} preload="metadata" onLoadedData={()=>setLoadedSrc(src)} onError={onError}/></NeutralAudioSkin></AudioPlayer></div>;
}
