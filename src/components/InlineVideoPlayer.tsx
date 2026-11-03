import { NeutralVideoSkin, Video, VideoPlayer, usePlayer } from "@videojs/react/video";
import "@videojs/react/video/neutral-skin.css";
import { useLayoutEffect, useRef, type MouseEvent } from "react";

import { MediaTransition } from './MediaTransition';
import { captureVideoPoster,videoPosters } from './videoPosters';

type InlineVideoPlayerProps = {
  src: string;
  poster?:string;
  posterPath?:string;
  className?: string;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  onError?: () => void;
  compact?: boolean;
  onReady?:()=>void;
};

const PLAYBACK_RATES = [1, 2, 4];

function PlaybackSpeedButton() {
  const player = usePlayer();
  const rate = usePlayer((state) => state.playbackRate);

  return (
    <button
      type="button"
      className="media-button pepper-speed-button"
      aria-label={`Playback speed ${rate}x. Click to change.`}
      title="Change playback speed"
      onClick={(event) => {
        event.stopPropagation();
        const currentIndex = PLAYBACK_RATES.indexOf(rate);
        player.setPlaybackRate(PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length]);
      }}
    >
      {rate}x
    </button>
  );
}

export function InlineVideoPlayer(props: InlineVideoPlayerProps) {
  // SourceMediaPreview owns the cross-media transition; standalone Review and
  // promotion players use this same transition around their video surface.
  if(props.onReady)return <VideoSurface {...props}/>;
  return <MediaTransition source={props.src} onError={props.onError} render={(src,onReady,onError)=><VideoSurface {...props} src={src} onReady={onReady} onError={onError}/>}/>;
}

function VideoSurface({ src, poster, posterPath, className, onContextMenu, onError, onReady, compact = false }: InlineVideoPlayerProps) {
  const owner=useRef(Symbol('selected video'));
  const media=useRef<HTMLVideoElement>(null);
  useLayoutEffect(()=>{
    if(!posterPath)return;
    const key=owner.current;
    videoPosters.setForeground(key,true);
    const video=media.current;
    const frame=video?.requestVideoFrameCallback(()=>{
      if(!videoPosters.get(posterPath)){
        const image=captureVideoPoster(video);
        if(image)videoPosters.put(posterPath,image);
      }
    });
    return()=>{if(frame!==undefined)video?.cancelVideoFrameCallback(frame);videoPosters.release(key);};
  },[src,posterPath]);
  return (
    <VideoPlayer poster={poster}>
      <div className={compact ? 'pepper-preview-player' : 'pepper-player-surface'} onContextMenu={onContextMenu}>
        <NeutralVideoSkin renderPoster={(props,{src})=>src?<img {...props} src={src} className={`${props.className??''} pepper-media-visual`} onLoad={event=>{props.onLoad?.(event);onReady?.();}}/>:null} className={`pepper-video-skin ${compact ? 'pepper-video-compact' : ''} ${className ?? ''}`} style={{ width: '100%', aspectRatio: '16 / 9' }}>
          <Video ref={media} className="pepper-media-visual" key={src} src={src} crossOrigin={posterPath?'anonymous':undefined} playsInline preload="metadata"
            onError={()=>{videoPosters.setForeground(owner.current,false);onError?.();}}
            onLoadedData={()=>{
              if(posterPath){
                videoPosters.setForeground(owner.current,false);
              }
              onReady?.();
            }}
            onPlaying={()=>{if(posterPath)videoPosters.setForeground(owner.current,true);}}
            onPause={()=>videoPosters.setForeground(owner.current,false)}/>

          {!compact && <PlaybackSpeedButton />}
        </NeutralVideoSkin>
      </div>
    </VideoPlayer>
  );
}
