import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { InlineVideoPlayer } from './InlineVideoPlayer';
import { ClipReviewList } from './ClipReviewList';
import type { ClientClip } from './useClientClips';

export function ClientClips({clips}:{clips:ClientClip[]}) {
  const [selected,setSelected]=useState('');
  const root=useRef<HTMLDivElement>(null);
  const chosen=clips.find(clip=>clip.path===selected)??clips[0];
  useEffect(()=>{root.current?.querySelectorAll<HTMLMediaElement>('video,audio').forEach(media=>media.pause());},[chosen?.path]);
  if(!chosen)return null;
  return <section ref={root} className="client-clips" aria-label="Client clips">
    <div className="version-browser client-clips-layout">
      <article className="export-preview" aria-label={chosen.name}><div className="clip-review-stage"><InlineVideoPlayer src={convertFileSrc(chosen.path)}/></div></article>
      <ClipReviewList label="Clips" items={clips.map(clip=>({id:clip.path,name:clip.name,status:clip.current?'Published':clip.published?'Changed':undefined}))} selected={chosen.path} onSelect={setSelected}/>
    </div>
  </section>;
}
