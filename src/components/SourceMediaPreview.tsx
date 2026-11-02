import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Headphones, FileVideo, Image as ImageIcon, LoaderCircle } from "lucide-react";
import { InlineVideoPlayer } from "./InlineVideoPlayer";
import { InlineAudioPlayer } from "./InlineAudioPlayer";
import { mediaKind } from "./MediaTypes";

export function SourceMediaPreview({path,name,showHeading=true}:{path:string|null;name?:string;showHeading?:boolean}) {
  const [ready,setReady] = useState<string|null>(null), [failed,setFailed] = useState<string|null>(null);
  useEffect(() => {
    if (!path) return;
    let active = true;
    void invoke('media_prepare_preview',{path}).then(() => {if(active){setReady(path);setFailed(null);}}).catch(() => {if(active)setFailed(path);});
    return () => {active=false;};
  },[path]);
  if (!path) return <div className="ig-inspector-empty"><FileVideo size={25}/>{showHeading&&<strong>Preview</strong>}</div>;
  const kind = mediaKind(path);
  const Icon = kind === 'audio' ? Headphones : kind === 'image' ? ImageIcon : FileVideo;
  return <>
    {showHeading&&<header className="ig-inspector-heading"><span><Icon size={15}/><strong title={name}>{name || path.split(/[\\/]/).pop()}</strong></span></header>}
    <div className="ig-preview-media">{failed === path ? <div className="ig-preview-placeholder"><FileVideo size={25}/><span>This format can't be previewed here.</span></div> : ready !== path ? <div className="ig-preview-placeholder"><LoaderCircle className="ig-spin" size={22}/><span>Opening preview…</span></div> : kind === 'video' ? <InlineVideoPlayer compact key={path} src={convertFileSrc(path)} onError={() => setFailed(path)}/> : kind === 'audio' ? <InlineAudioPlayer key={path} src={convertFileSrc(path)} onError={() => setFailed(path)}/> : <img key={path} alt={name || 'Selected image'} src={convertFileSrc(path)} onError={() => setFailed(path)}/>}</div>
  </>;
}
