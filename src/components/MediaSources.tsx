import { PreviewSidebar } from "./PreviewSidebar";
import { useRef, useState } from 'react';
import { Check, Headphones, FileVideo, Image, X } from 'lucide-react';
import { mediaKind, MediaTypeRail, type SourceMedia } from './MediaTypes';
import { SourceMediaPreview } from './SourceMediaPreview';

export type CopiedMedia = SourceMedia & {id:string;status:string;source_name:string};
export function MediaSources({staged,copied,disabled,onRemove,onType,onBrowse}:{staged:SourceMedia[];copied:CopiedMedia[];disabled:boolean;onRemove:(path:string)=>void;onType:(paths:string[],role:string)=>void;onBrowse:()=>void}) {
  const [previewPath,setPreviewPath] = useState<string|null>(null), [selection,setSelection] = useState<string[]>([]);
  const anchor = useRef<string|null>(null);
  const all = [...staged,...copied];
  const preview = all.find(item=>item.path===previewPath);
  const selected = all.filter(item=>selection.includes(item.path));
  const editable = (item:SourceMedia) => !copied.some(file=>file.path===item.path&&file.status==='Filed');
  const selectItem = (item:SourceMedia,shift=false,toggle=false) => {
    const alreadySelected=selection.includes(item.path);
    if(!shift&&!toggle&&alreadySelected){setSelection(current=>current.filter(path=>path!==item.path));setPreviewPath(null);return;}
    if(!shift&&!toggle&&previewPath===item.path){setPreviewPath(null);return;}
    if(toggle&&alreadySelected&&previewPath===item.path)setPreviewPath(null);else setPreviewPath(item.path);
    if(disabled||!editable(item))return;
    const kind=mediaKind(item.path);
    const section=all.filter(file=>mediaKind(file.path)===kind&&editable(file));
    const first=section.findIndex(file=>file.path===anchor.current),last=section.findIndex(file=>file.path===item.path);
    setSelection(current=>{
      const sameSection=current.filter(path=>section.some(file=>file.path===path));
      if(shift&&first>=0&&last>=0)return [...new Set([...sameSection,...section.slice(Math.min(first,last),Math.max(first,last)+1).map(file=>file.path)])];
      return toggle?(sameSection.includes(item.path)?sameSection.filter(path=>path!==item.path):[...sameSection,item.path]):[item.path];
    });
    if(!shift||first<0)anchor.current=item.path;
  };
  const size = (value:number) => value>=1024**3?`${(value/1024**3).toFixed(1)} GB`:`${(value/1024**2).toFixed(1)} MB`;
  const renderTile = (item:SourceMedia) => {
    const kind=mediaKind(item.path), Icon=kind==='audio'?Headphones:kind==='image'?Image:FileVideo;
    const isCopied=copied.some(file=>file.path===item.path);

    return <article className={`ig-source-tile ig-source-media-tile ${preview?.path===item.path?'previewing':''} ${selection.includes(item.path)?'selected':''} ${isCopied?'imported':''}`} key={item.path} tabIndex={0} aria-label={item.name} onClick={e=>{if(!(e.target as HTMLElement).closest('button,input'))selectItem(item,e.shiftKey);}} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key===' '||e.key==='Enter')){e.preventDefault();selectItem(item,e.shiftKey);}}}>
      <header><input type="checkbox" aria-label={`Select ${item.name}`} disabled={disabled||!editable(item)} checked={selection.includes(item.path)} onClick={e=>{e.stopPropagation();selectItem(item,e.shiftKey,true);}} onChange={()=>{}}/><Icon size={20}/>{isCopied&&<Check className="ig-source-imported-tick" size={16} aria-label="Imported"/>}{!isCopied&&<button className="ig-icon-button" disabled={disabled} aria-label={`Remove ${item.name}`} onClick={e=>{e.stopPropagation();onRemove(item.path);}}><X size={14}/></button>}</header>
      {kind!=='image'&&<MediaTypeRail items={[item]} disabled={disabled||!editable(item)} onChange={role=>onType(selection.includes(item.path)?selected.filter(file=>editable(file)&&mediaKind(file.path)===kind).map(file=>file.path):[item.path],role)}/>}
      <div className="ig-source-preview-link"><strong title={item.name}>{item.name}</strong><small>{size(item.size)}</small></div>
    </article>;
  };
  return <div className={all.length?'ig-sources-layout':'ig-sources-empty'} onClick={event=>{const target=event.target as HTMLElement;if(target.closest('.ig-preview-rail,.ig-source-media-tile,button,input,textarea,select,a,[role="button"],video,audio'))return;setSelection([]);setPreviewPath(null);}}><div className="ig-source-main">
    {!all.length?<div className="ig-empty"><FileVideo size={27}/><h2>Add your media</h2><button className="ig-button ig-primary" disabled={disabled} onClick={onBrowse}>Browse media</button></div>:<>
      {([{kind:'video',label:'Video',Icon:FileVideo},{kind:'audio',label:'Audio',Icon:Headphones},{kind:'image',label:'Stills',Icon:Image}] as const).map(({kind,label,Icon})=>{
        const items=all.filter(item=>mediaKind(item.path)===kind);
        if(!items.length)return null;
        const sectionSelected=selected.filter(item=>mediaKind(item.path)===kind);
        return <section className="ig-media-section" key={kind}>
          <header className="ig-media-section-heading"><input type="checkbox" aria-label={`Select all ${label.toLowerCase()}`} disabled={disabled} checked={items.filter(editable).length>0&&items.filter(editable).every(item=>selection.includes(item.path))} ref={node=>{if(node)node.indeterminate=sectionSelected.length>0&&!items.filter(editable).every(item=>selection.includes(item.path));}} onChange={e=>{setSelection(e.target.checked?items.filter(editable).map(item=>item.path):[]);if(!e.target.checked)setPreviewPath(null);anchor.current=items[0]?.path||null;}}/><Icon size={16}/><h2>{label}</h2><span>{sectionSelected.length?`${sectionSelected.length} selected`:items.length}</span></header>

          <div className="ig-source-tiles">{items.map(renderTile)}</div>
        </section>;
      })}
    </>}
  </div>{all.length>0&&<PreviewSidebar autoCollapsed={!preview} path={preview?.path} name={preview?.name} className="ig-source-inspector"><SourceMediaPreview path={preview?.path||null} name={preview?.name} showHeading={false}/>{preview&&<div className="ig-source-preview-meta"><span>{mediaKind(preview.path)==='video'?(preview.role==='Unclassified video'?'No type':preview.role==='Proxy video'?'Proxy':'Full resolution'):mediaKind(preview.path)==='audio'?(preview.role==='Clean audio'?'Clean':'Raw'):'Stills'}</span><span>{size(preview.size)}</span>{selection.includes(preview.path)&&<Check size={13}/>}</div>}</PreviewSidebar>}</div>;
}
