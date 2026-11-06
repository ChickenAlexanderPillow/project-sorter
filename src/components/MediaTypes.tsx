import { AudioLines, Clapperboard, FileVideo, Headphones, Image, Layers, Mic, MonitorPlay, Music2, ScanLine, SquarePen } from "lucide-react";

export const MEDIA_ROLE_ICONS = {
  'Proxy video': MonitorPlay,
  'Full-resolution video': ScanLine,
  'Raw audio': Mic,
  'Clean audio': AudioLines,
  'Premiere Pro': Clapperboard,
  'After Effects': Layers,
} as const;

// Role icons belong to section subheaders; file rows keep their media-kind icons.
export function mediaRoleIcon(path:string, role:string) {
  if (role in MEDIA_ROLE_ICONS) return MEDIA_ROLE_ICONS[role as keyof typeof MEDIA_ROLE_ICONS];
  const kind=mediaKind(path);
  if(kind==='video')return role==='Proxy'?MonitorPlay:role==='Raw'?ScanLine:FileVideo;
  if(kind==='audio')return role==='Clean'?AudioLines:role==='Raw'?Mic:role==='Music'?Music2:Headphones;
  if(kind==='image')return Image;
  return SquarePen;
}

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
  const options=videos.length ? [{role:'Proxy video',label:'Proxy',Icon:MEDIA_ROLE_ICONS['Proxy video']},{role:'Full-resolution video',label:'Full resolution',Icon:MEDIA_ROLE_ICONS['Full-resolution video']}] : audio.length ? [{role:'Raw audio',label:'Raw',Icon:MEDIA_ROLE_ICONS['Raw audio']},{role:'Clean audio',label:'Clean',Icon:MEDIA_ROLE_ICONS['Clean audio']}] : [];
  const relevant=videos.length?videos:audio;
  return <div className="ig-media-type-control">{options.length?<div className="ig-type-rail" role="group" aria-label={videos.length?'Video type':'Audio type'}>{options.map(({role,label,Icon})=><button type="button" key={role} aria-pressed={relevant.every(item=>item.role===role)} disabled={disabled} onClick={()=>onChange(role)}><Icon size={15}/><span>{label}</span></button>)}</div>:<span className="ig-auto-types"><Image size={15}/> Stills</span>}</div>;
}
