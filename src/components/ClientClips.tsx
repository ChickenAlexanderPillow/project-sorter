import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, ExternalLink, FolderOpen, RefreshCw, Video } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { SourceMediaPreview } from './SourceMediaPreview';
const formatStorage=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024**2?`${(bytes/1024).toFixed(1)} KB`:bytes<1024**3?`${(bytes/1024**2).toFixed(1)} MB`:`${(bytes/1024**3).toFixed(2)} GB`;

type Clip = { name: string; path: string; size: number; modified_ms: number; published: boolean; current: boolean };
export function ClientClips({clientPath, mainPublished}:{clientPath:string;mainPublished:boolean}) {
  const [clips,setClips]=useState<Clip[]>([]); const [selected,setSelected]=useState(''); const [error,setError]=useState(''); const [loading,setLoading]=useState(false); const [busy,setBusy]=useState<string|null>(null);
  const root=useRef<HTMLDivElement>(null);
  const refresh=useCallback(async()=>{setLoading(true);setError('');try{const next=await invoke<Clip[]>('list_client_clips',{clientPath});setClips(next);setSelected(current=>next.some(c=>c.path===current)?current:next[0]?.path||'');}catch(e){setError(String(e));}finally{setLoading(false);}},[clientPath]);
  useEffect(()=>{void refresh();const id=window.setInterval(()=>void refresh(),2500);return()=>window.clearInterval(id);},[refresh]);
  useEffect(()=>{root.current?.querySelectorAll<HTMLMediaElement>('video,audio').forEach(media=>media.pause());},[selected]);
  const act=async(fn:()=>Promise<unknown>)=>{try{await fn();}catch(e){setError(String(e));}};
  const publish=async(clip:Clip)=>{setBusy(clip.name);setError('');try{await invoke('publish_client_clips',{clientPath,clipNames:[clip.name]});await refresh();}catch(e){setError(String(e));}finally{setBusy(null);}};
  const chosen=clips.find(c=>c.path===selected);
  return <section ref={root} className="client-clips" aria-label="Client clips">
    <header className="client-clips-toolbar"><strong>Clips</strong><span>{clips.length} {clips.length===1?'video':'videos'}</span><button type="button" title="Refresh clips" aria-label="Refresh clips" onClick={()=>void refresh()}><RefreshCw size={14}/></button><button type="button" onClick={()=>void act(()=>invoke('open_folder',{path:`${clientPath}\\03_EXPORTS\\CLIPS`}))}><FolderOpen size={14}/>Open folder</button></header>
    {error&&<p className="client-clips-error" role="alert">{error}</p>}
    {loading&&clips.length===0&&!error?<p className="client-clips-empty">Loading clips…</p>:error&&clips.length===0?<p className="client-clips-empty">Clips folder unavailable or could not be scanned.</p>:clips.length===0?<p className="client-clips-empty"><Video size={18}/>No clips in 03_EXPORTS/CLIPS.</p>:<div className="client-clips-layout">
      <div className="client-clips-player">{chosen&&<><div className="client-clips-preview"><SourceMediaPreview path={chosen.path} name={chosen.name} showHeading={false}/></div><div className="client-clips-file"><strong title={chosen.name}>{chosen.name}</strong><span>{formatStorage(chosen.size)}</span></div><div className="client-clips-actions"><button type="button" onClick={()=>void act(()=>invoke('open_file_location',{path:chosen.path}))}><ExternalLink size={13}/>Show file</button><button type="button" onClick={()=>void act(()=>writeText(chosen.path))}><Copy size={13}/>Copy path</button>{chosen.published&&<span className={chosen.current?'current':'changed'}>{chosen.current?'Published':'Changed since publishing'}</span>}{mainPublished?<button type="button" className="primary" disabled={busy!==null||chosen.current} onClick={()=>void publish(chosen)}>{busy===chosen.name?'Publishing…':chosen.published?'Republish':'Publish clip'}</button>:<span className="client-clips-requirement">Publish the main video before clips.</span>}</div></>}</div>
      <ul className="client-clips-list">{clips.map(clip=><li key={clip.path}><button type="button" aria-current={clip.path===selected?'true':undefined} onClick={()=>setSelected(clip.path)}><span className="client-clips-thumb"><SourceMediaPreview path={clip.path} showHeading={false}/></span><span className="client-clips-list-meta"><strong title={clip.name}>{clip.name}</strong><small>{formatStorage(clip.size)} · {new Date(clip.modified_ms).toLocaleDateString()}</small></span><span className={clip.current?'current':clip.published?'changed':'unpublished'}>{clip.current?'Current':clip.published?'Changed':'Unpublished'}</span></button></li>)}</ul>
    </div>}
  </section>;
}
