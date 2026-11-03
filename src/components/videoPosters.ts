import {convertFileSrc} from '@tauri-apps/api/core';
import {createPosterCache} from './posterCache';
import {previewPreparation} from './previewPreparation';

/** Cache an image, never a resident video player. */
export function captureVideoPoster(video:HTMLVideoElement):string|undefined {
  if(!video.videoWidth||!video.videoHeight||video.readyState<2)return;
  const scale=Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(video.videoWidth*scale));
  canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
  try{
    const context=canvas.getContext('2d');
    if(!context)return;
    context.drawImage(video,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/webp',0.7);
  }catch{return;}
}

async function loadPoster(path:string,signal:AbortSignal):Promise<string> {
  await previewPreparation.prepare(path);
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const video=document.createElement('video');
    let finished=false;
    const finish=(image?:string,error?:unknown)=>{
      if(finished)return;
      finished=true;clearTimeout(timeout);
      signal.removeEventListener('abort',abort);
      video.onloadeddata=null;video.onloadedmetadata=null;video.onseeked=null;video.onerror=null;
      video.pause();video.removeAttribute('src');video.load();
      if(image)resolve(image);else reject(error??new Error('No preview frame'));
    };
    const abort=()=>finish(undefined,new DOMException('Preview cancelled','AbortError'));
    const timeout=setTimeout(()=>finish(undefined,new Error('Preview timed out')),5000);
    signal.addEventListener('abort',abort,{once:true});
    video.muted=true;video.playsInline=true;video.preload='metadata';video.crossOrigin='anonymous';
    video.onloadedmetadata=()=>{
      // Seeking is the normal thumbnail extraction path. Metadata/loadeddata can
      // precede the first composited frame in WebView2 hardware decoders.
      video.currentTime=Math.min(0.1,Number.isFinite(video.duration)?video.duration/2:0.1);
    };
    video.onseeked=()=>{
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        if(!finished)finish(captureVideoPoster(video));
      }));
    };
    video.onerror=()=>finish();
    video.src=convertFileSrc(path);video.load();
  });
}
export const videoPosters=createPosterCache(loadPoster);
