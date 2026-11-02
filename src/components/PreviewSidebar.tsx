import { useEffect, useState, type ReactNode } from 'react';
import { FileVideo, Headphones, Image, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { mediaKind } from './MediaTypes';

export function PreviewSidebar({children,className='',autoCollapsed=false,path,name}:{children:ReactNode;className?:string;autoCollapsed?:boolean;path?:string|null;name?:string}) {
  const [collapsed,setCollapsed]=useState(()=>{try{return localStorage.getItem('pepper.import.previewCollapsed')==='true';}catch{return false;}});
  const [expandedWhenEmpty,setExpandedWhenEmpty]=useState(false);
  useEffect(()=>{if(!autoCollapsed)setExpandedWhenEmpty(false);},[autoCollapsed]);
  const toggle=()=>{if(autoCollapsed){if(collapsed){setCollapsed(false);try{localStorage.setItem('pepper.import.previewCollapsed','false');}catch{/* Optional view preference. */}}setExpandedWhenEmpty(current=>!current);return;}setCollapsed(current=>{try{localStorage.setItem('pepper.import.previewCollapsed',String(!current));}catch{/* Optional view preference. */}return !current;});};
  const isCollapsed=collapsed||(autoCollapsed&&!expandedWhenEmpty);
  const kind=mediaKind(path||'');
  const Icon=kind==='audio'?Headphones:kind==='image'?Image:FileVideo;
  const title=name||path?.split(/[\\/]/).pop()||'Preview';
  return <aside className={`ig-inspector ig-preview-rail ${isCollapsed?'collapsed':''} ${className}`}><header className="ig-preview-toolbar">
    {!isCollapsed&&<span className="ig-preview-title"><Icon size={15}/><strong title={title}>{title}</strong></span>}
    <button type="button" className="ig-preview-collapse ig-icon-button" aria-label={isCollapsed?'Expand preview':'Collapse preview'} title={isCollapsed?'Expand preview':'Collapse preview'} aria-expanded={!isCollapsed} onClick={toggle}>{isCollapsed?<PanelRightOpen size={16}/>:<PanelRightClose size={16}/>}</button>
  </header>{!isCollapsed&&<div className="ig-preview-content">{children}</div>}</aside>;
}
