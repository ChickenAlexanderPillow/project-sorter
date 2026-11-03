import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Headphones, FileVideo, Image as ImageIcon } from "lucide-react";
import { InlineVideoPlayer } from "./InlineVideoPlayer";
import { InlineAudioPlayer } from "./InlineAudioPlayer";
import { mediaKind } from "./MediaTypes";
import { MediaTransition } from "./MediaTransition";

type Props={path:string|null;name?:string;showHeading?:boolean;quietLoading?:boolean};
export function SourceMediaPreview({path,name,showHeading=true}:Props) {
  if(!path)return <div className="ig-inspector-empty"><FileVideo size={25}/>{showHeading&&<strong>Preview</strong>}</div>;
  const kind=mediaKind(path),Icon=kind==='audio'?Headphones:kind==='image'?ImageIcon:FileVideo;
  return <>
    {showHeading&&<header className="ig-inspector-heading"><span><Icon size={15}/><strong title={name}>{name||path.split(/[\\/]/).pop()}</strong></span></header>}
    <div className="ig-preview-media"><MediaTransition source={path} render={(source,onReady,onError)=><PreparedMedia path={source} onReady={onReady} onError={onError}/>} /></div>
  </>;
}
function PreparedMedia({path,onReady,onError}:{path:string;onReady:()=>void;onError:()=>void}) {
  const [prepared,setPrepared]=useState(false);
  useEffect(()=>{
    let active=true;
    void invoke('media_prepare_preview',{path}).then(()=>{if(active)setPrepared(true);}).catch(()=>{if(active)onError();});
    return()=>{active=false;};
  },[path]);
  if(!prepared)return <div className="ig-preview-placeholder"/>;
  const kind=mediaKind(path),src=convertFileSrc(path);
  return kind==='video'?<InlineVideoPlayer compact src={src} onReady={onReady} onError={onError}/>:kind==='audio'?<InlineAudioPlayer src={src} onReady={onReady} onError={onError}/>:<img alt={path.split(/[\\/]/).pop()||'Selected image'} src={src} onLoad={onReady} onError={onError}/>;
}
