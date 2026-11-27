import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { InlineVideoPlayer } from './InlineVideoPlayer';
import { ClipReviewList } from './ClipReviewList';
import type { ClientClip } from './useClientClips';
import { ArrowUpRight } from 'lucide-react';

export function ClientClips({clips,mainPublished,disabled,publishStates,onPublish}:{clips:ClientClip[];mainPublished:boolean;disabled:boolean;publishStates:Record<string,"Queued"|"Publishing">;onPublish:(clip:ClientClip)=>Promise<void>}) {
  const [selected,setSelected]=useState('');
  const root=useRef<HTMLDivElement>(null);
  const chosen=clips.find(clip=>clip.path===selected)??clips[0];
  useEffect(()=>{root.current?.querySelectorAll<HTMLMediaElement>('video,audio').forEach(media=>media.pause());},[chosen?.path]);
  if(!chosen)return null;
  return <section ref={root} className="client-clips" aria-label="Client clips">
    <div className="version-browser client-clips-layout">
      <article className="export-preview" aria-label={chosen.name}><div className="clip-review-stage"><InlineVideoPlayer src={convertFileSrc(chosen.path)}/></div></article>
      <ClipReviewList label="Clips" items={clips.map(clip=>({id:clip.path,name:clip.name,status:publishStates[clip.path]??(clip.current?'Published':clip.published?'Changed':undefined)}))} selected={chosen.path} onSelect={setSelected} renderAction={id=>{
        const clip=clips.find(item=>item.path===id)!;
        const title=publishStates[clip.path]?`${publishStates[clip.path]} ${clip.name}`:!mainPublished?'Publish the main video before publishing clips':clip.current?'Clip is already published':`Publish ${clip.name} to FINAL clips`;
        return <button type="button" className="frameio-icon-button clip-publish-button" title={title} aria-label={title} disabled={disabled||!mainPublished||clip.current||Boolean(publishStates[clip.path])} onClick={()=>void onPublish(clip)}><ArrowUpRight size={14} aria-hidden="true"/></button>;
      }}/>
    </div>
  </section>;
}
