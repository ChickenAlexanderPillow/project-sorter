import { AudioLines, Check, Clapperboard, FileVideo, Folder, Headphones, Image, Layers, Mic, MonitorPlay, Music2, Package, ScanLine, SquarePen, type LucideIcon } from "lucide-react";

export const MEDIA_ROLE_ICONS = {
  'Proxy video': MonitorPlay,
  'Full-resolution video': ScanLine,
  'Raw audio': Mic,
  'Clean audio': AudioLines,
  'Music': Music2,
  'Stock': Package,
  'Miscellaneous': Folder,
  'Graphics': Layers,
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

export type SourceMedia = {path:string; name:string; kind:string; size:number; role:string; created?:string|null; modified?:string|null};
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
  const images=items.filter(item=>mediaKind(item.path)==='image');
  const options=videos.length ? [{role:'Proxy video',label:'Proxy',Icon:MEDIA_ROLE_ICONS['Proxy video']},{role:'Full-resolution video',label:'Full resolution',Icon:MEDIA_ROLE_ICONS['Full-resolution video']},{role:'Stock',label:'Stock',Icon:MEDIA_ROLE_ICONS.Stock},{role:'Miscellaneous',label:'Misc',Icon:MEDIA_ROLE_ICONS.Miscellaneous}] : audio.length ? [{role:'Raw audio',label:'Raw',Icon:MEDIA_ROLE_ICONS['Raw audio']},{role:'Clean audio',label:'Clean',Icon:MEDIA_ROLE_ICONS['Clean audio']},{role:'Music',label:'Music',Icon:MEDIA_ROLE_ICONS.Music}] : images.length ? [{role:'Stills',label:'Stills',Icon:Image},{role:'Graphics',label:'Graphics',Icon:MEDIA_ROLE_ICONS.Graphics},{role:'Stock',label:'Stock',Icon:MEDIA_ROLE_ICONS.Stock},{role:'Miscellaneous',label:'Misc',Icon:MEDIA_ROLE_ICONS.Miscellaneous}] : [];
  const relevant=videos.length?videos:audio.length?audio:images;
  return <MediaClassificationGrid options={options} selectedRole={relevant.every(item=>item.role===relevant[0]?.role)?relevant[0]?.role:undefined} disabled={disabled} onChange={onChange} label={videos.length?'Video type':audio.length?'Audio type':'Still type'}/>;
}

type ClassificationOption = {role:string;label:string;Icon:LucideIcon};

// Balance complete rows: 3 -> 3, 4 -> 2+2, 5 -> 3+2, 7 -> 3+2+2.
export function MediaClassificationGrid({options,selectedRole,onChange,disabled=false,label}:{options:ClassificationOption[];selectedRole?:string;onChange:(role:string)=>void;disabled?:boolean;label:string}) {
  if(!options.length)return null;
  const rows=Math.ceil(options.length/3);
  let remaining=options.length, index=0;
  const cells=Array.from({length:rows},(_,row)=>{
    const count=Math.ceil(remaining/(rows-row));
    remaining-=count;
    return options.slice(index,index+=count).map(option=>({...option,span:6/count}));
  }).flat();
  return <div className="ig-media-type-control"><div className="ig-type-rail" data-columns={Math.ceil(options.length/rows)} role="group" aria-label={label}>
    {cells.map(({role,label:optionLabel,Icon,span})=>{
      const active=selectedRole===role;
      const StateIcon=active?Check:Icon;
      return <button type="button" key={role} style={{gridColumn:`span ${span}`}} aria-pressed={active} disabled={disabled} onClick={()=>onChange(role)} title={optionLabel}><StateIcon size={15} aria-hidden="true"/><span>{optionLabel}</span></button>;
    })}
  </div></div>;
}
