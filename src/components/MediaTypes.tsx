import { AudioLines, Image, Mic, MonitorPlay, ScanLine } from "lucide-react";

export type SourceMedia = {path:string; name:string; kind:string; size:number; role:string};
export function mediaKind(path:string) {
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext && ['mp4','mov','mxf','mkv','avi','webm','m4v','r3d','mpg','mpeg'].includes(ext)) return 'video';
  if (ext && ['wav','aif','aiff','mp3','flac','m4a','aac','ogg','opus'].includes(ext)) return 'audio';
  if (ext && ['jpg','jpeg','png','tif','tiff','heic','heif','webp','bmp','gif'].includes(ext)) return 'image';
  return null;
}
export const defaultRole = (path:string) => mediaKind(path) === 'video' ? 'Full-resolution video' : mediaKind(path) === 'audio' ? 'Raw audio' : 'Stills';
export function MediaTypeRail({items,onChange,disabled=false}:{items:{path:string;role:string}[];onChange:(role:string)=>void;disabled?:boolean}) {
  const videos=items.filter(item=>mediaKind(item.path)==='video');
  const audio=items.filter(item=>mediaKind(item.path)==='audio');
  const options=videos.length ? [{role:'Proxy video',label:'Proxy',Icon:MonitorPlay},{role:'Full-resolution video',label:'Full resolution',Icon:ScanLine}] : audio.length ? [{role:'Raw audio',label:'Raw',Icon:Mic},{role:'Clean audio',label:'Clean',Icon:AudioLines}] : [];
  const relevant=videos.length?videos:audio;
  return <div className="ig-media-type-control">{options.length?<div className="ig-type-rail" role="group" aria-label={videos.length?'Video type':'Audio type'}>{options.map(({role,label,Icon})=><button type="button" key={role} aria-pressed={relevant.every(item=>item.role===role)} disabled={disabled} onClick={()=>onChange(role)}><Icon size={15}/><span>{label}</span></button>)}</div>:<span className="ig-auto-types"><Image size={15}/> Stills</span>}</div>;
}
