import { MediaFileDates } from "./MediaFileDates";
import {normalizeIngestPath} from './ingestProgress';
import { PreviewSidebar } from "./PreviewSidebar";
import { useRef, useState } from 'react';
import { Check, Headphones, FileVideo, Image, X } from 'lucide-react';
import { mediaKind, MediaTypeRail, type SourceMedia } from './MediaTypes';
import { SourceMediaPreview } from './SourceMediaPreview';

export type CopiedMedia = SourceMedia & {id:string;status:string;source_name:string;original_path?:string;destinations?:string[]};
export function MediaSources({staged,copied,disabled,progress,onRemove,onType,onBrowse}:{staged:SourceMedia[];copied:CopiedMedia[];disabled:boolean;progress:{phase:string;source:string;bytes_copied:number;file_size:number;completed_sources:string[]}|null;onRemove:(path:string)=>void;onType:(paths:string[],role:string)=>void;onBrowse:()=>void}) {
  const [previewPath,setPreviewPath] = useState<string|null>(null), [selection,setSelection] = useState<string[]>([]);
  const anchor = useRef<string|null>(null);
  const all = [...staged,...copied];
  const resolvePath=(path:string|null)=>all.find(item=>item.path===path)?.path||[...copied].reverse().find(item=>item.original_path&&normalizeIngestPath(item.original_path)===normalizeIngestPath(path||''))?.path||path;
  const preview = all.find(item=>item.path===resolvePath(previewPath));
  const selectedPaths=selection.map(path=>resolvePath(path));
  const selected = all.filter(item=>selectedPaths.includes(item.path));
  const editable = (item:SourceMedia) => !copied.some(file=>file.path===item.path&&(file.status==='Filed'||Boolean(file.destinations?.length)));
  const selectItem = (item:SourceMedia,shift=false,toggle=false) => {
    const alreadySelected=selectedPaths.includes(item.path);
    if(!shift&&!toggle&&alreadySelected){setSelection(current=>current.filter(path=>resolvePath(path)!==item.path));setPreviewPath(null);return;}
    if(!shift&&!toggle&&previewPath===item.path){setPreviewPath(null);return;}
    if(toggle&&alreadySelected&&previewPath===item.path)setPreviewPath(null);else setPreviewPath(item.path);
    if(disabled||!editable(item))return;
    const kind=mediaKind(item.path);
    const section=all.filter(file=>mediaKind(file.path)===kind&&editable(file));
    const first=section.findIndex(file=>file.path===anchor.current),last=section.findIndex(file=>file.path===item.path);
    setSelection(current=>{
      const sameSection=current.map(path=>resolvePath(path)!).filter(path=>section.some(file=>file.path===path));
      if(shift&&first>=0&&last>=0)return [...new Set([...sameSection,...section.slice(Math.min(first,last),Math.max(first,last)+1).map(file=>file.path)])];
      return toggle?(sameSection.includes(item.path)?sameSection.filter(path=>path!==item.path):[...sameSection,item.path]):[item.path];
    });
    if(!shift||first<0)anchor.current=item.path;
  };
  const size = (value:number) => value>=1024**3?`${(value/1024**3).toFixed(1)} GB`:`${(value/1024**2).toFixed(1)} MB`;
  const renderTile = (item:SourceMedia) => {
    const kind=mediaKind(item.path), Icon=kind==='audio'?Headphones:kind==='image'?Image:FileVideo;
    const normalized=normalizeIngestPath;
    const isCopied=copied.some(file=>file.path===item.path)||Boolean(progress?.completed_sources?.some(path=>normalized(path)===normalized(item.path)));
    const isCopying=!isCopied&&Boolean(progress&&['collecting','verifying'].includes(progress.phase)&&normalized(progress.source)===normalized(item.path));
    const pct=progress?.file_size?Math.min(100,Math.round(progress.bytes_copied/progress.file_size*100)):0;

    return <article className={`ig-source-tile ig-source-media-tile ${preview?.path===item.path?'previewing':''} ${selectedPaths.includes(item.path)?'selected':''} ${isCopied?'imported':''}`} key={item.path} tabIndex={0} aria-label={item.name} onClick={e=>{if(!(e.target as HTMLElement).closest('button,input'))selectItem(item,e.shiftKey);}} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key===' '||e.key==='Enter')){e.preventDefault();selectItem(item,e.shiftKey);}}}>
      <header><input type="checkbox" aria-label={`Select ${item.name}`} disabled={disabled||!editable(item)} checked={selectedPaths.includes(item.path)} onClick={e=>{e.stopPropagation();selectItem(item,e.shiftKey,true);}} onChange={()=>{}}/><Icon size={20}/>{isCopied&&<span className="ig-source-imported-tick"><Check size={13}/>Copied</span>}{isCopying&&<span className="ig-file-progress-mark" aria-hidden="true"/>}{!isCopied&&!isCopying&&<button className="ig-icon-button" disabled={disabled} aria-label={`Remove ${item.name}`} onClick={e=>{e.stopPropagation();onRemove(item.path);}}><X size={14}/></button>}</header>
      <MediaTypeRail items={[item]} disabled={disabled||!editable(item)} onChange={role=>onType(selectedPaths.includes(item.path)?selected.filter(file=>editable(file)&&mediaKind(file.path)===kind).map(file=>file.path):[item.path],role)}/>
      <div className="ig-source-preview-link"><strong title={item.name}>{item.name}</strong><small>{size(item.size)}</small></div><MediaFileDates className="ig-source-dates" created={item.created} modified={item.modified}/>{isCopying&&<progress className="ig-file-progress" max={100} value={progress?.phase==='collecting'?pct:undefined} aria-label={`${progress?.phase==='collecting'?'Copying':'Checking'} ${item.name}`} />}
    </article>;
  };
  return <div className={all.length?'ig-sources-layout':'ig-sources-empty'} onClick={event=>{const target=event.target as HTMLElement;if(target.closest('.ig-preview-rail,.ig-source-media-tile,button,input,textarea,select,a,[role="button"],video,audio'))return;setSelection([]);setPreviewPath(null);}}><div className="ig-source-main">
    {!all.length?<div className="ig-empty"><FileVideo size={27}/><h2>Add your media</h2><button className="ig-button ig-primary" disabled={disabled} onClick={onBrowse}>Browse media</button></div>:<>
      {([{kind:'video',label:'Video',Icon:FileVideo},{kind:'audio',label:'Audio',Icon:Headphones},{kind:'image',label:'Stills',Icon:Image}] as const).map(({kind,label,Icon})=>{
        const items=all.filter(item=>mediaKind(item.path)===kind);
        if(!items.length)return null;
        const sectionSelected=selected.filter(item=>mediaKind(item.path)===kind);
        const editableSelection=sectionSelected.filter(editable);
        return <section className="ig-media-section" key={kind}>
          <header className="ig-media-section-heading"><input type="checkbox" aria-label={`Select all ${label.toLowerCase()}`} disabled={disabled} checked={items.filter(editable).length>0&&items.filter(editable).every(item=>selectedPaths.includes(item.path))} ref={node=>{if(node)node.indeterminate=sectionSelected.length>0&&!items.filter(editable).every(item=>selectedPaths.includes(item.path));}} onChange={e=>{setSelection(e.target.checked?items.filter(editable).map(item=>item.path):[]);if(!e.target.checked)setPreviewPath(null);anchor.current=items[0]?.path||null;}}/><Icon size={16}/><h2>{label}</h2><span>{sectionSelected.length?`${sectionSelected.length} selected`:items.length}</span></header>

          {editableSelection.length>1&&<div className="ig-source-selection-tools"><span>Classify {editableSelection.length} selected</span><MediaTypeRail items={editableSelection} disabled={disabled} onChange={role=>onType(editableSelection.map(item=>item.path),role)}/></div>}
          <div className="ig-source-tiles">{items.map(renderTile)}</div>
        </section>;
      })}
    </>}
  </div>{all.length>0&&<PreviewSidebar autoCollapsed={!preview} path={preview?.path} name={preview?.name} className="ig-source-inspector"><SourceMediaPreview path={preview?.path||null} name={preview?.name} showHeading={false}/>{preview&&<div className="ig-source-preview-meta"><span>{mediaKind(preview.path)==='video'?({'Unclassified video':'No type','Proxy video':'Proxy','Full-resolution video':'Full resolution',Stock:'Stock',Miscellaneous:'Misc'} as Record<string,string>)[preview.role]||'No type':mediaKind(preview.path)==='audio'?({'Raw audio':'Raw','Clean audio':'Clean',Music:'Music'} as Record<string,string>)[preview.role]||'Raw':({'Stills':'Stills',Graphics:'Graphics',Stock:'Stock',Miscellaneous:'Misc'} as Record<string,string>)[preview.role]||'Stills'}</span><span>{size(preview.size)}</span>{selectedPaths.includes(preview.path)&&<Check size={13}/>}</div>}{preview&&<div className="ig-preview-classification"><MediaTypeRail items={selectedPaths.includes(preview.path)?selected.filter(file=>editable(file)&&mediaKind(file.path)===mediaKind(preview.path)):[preview]} disabled={disabled||!editable(preview)} onChange={role=>onType(selectedPaths.includes(preview.path)?selected.filter(file=>editable(file)&&mediaKind(file.path)===mediaKind(preview.path)).map(file=>file.path):[preview.path],role)}/></div>}</PreviewSidebar>}</div>;
}
