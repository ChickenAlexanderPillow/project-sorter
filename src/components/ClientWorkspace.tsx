import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MessageSquareCheck, Files } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { RetainedView } from './RetainedView';
import { ClientFiles, type FileContextMenu } from './ClientFiles';
import { SourceMediaPreview } from './SourceMediaPreview';
import './ClientWorkspace.css';

export function ClientWorkspace({clientPath,reviewDefault,hasApprovals,finalPath,children,onContextMenu}:{clientPath:string;reviewDefault:boolean;hasApprovals:boolean;finalPath?:string|null;children:ReactNode;onContextMenu:FileContextMenu}){
  const [tab,setTab]=useState<'review'|'files'>(()=>reviewDefault?'review':'files');
  const previousDefault=useRef(reviewDefault);
  const [error,setError]=useState('');const id=useId();
  useEffect(()=>{if(reviewDefault&&!previousDefault.current)setTab('review');previousDefault.current=reviewDefault;},[reviewDefault]);
  return <section className="client-workspace">
    <nav className="cw-tabs" role="tablist" aria-label="Client workspace">
      <button type="button" id={`${id}-files`} role="tab" aria-selected={tab==='files'} aria-controls={`${id}-files-panel`} onClick={()=>setTab('files')}><Files size={15}/>Files</button>
      <button type="button" id={`${id}-review`} role="tab" aria-selected={tab==='review'} aria-controls={`${id}-review-panel`} onClick={()=>setTab('review')}><MessageSquareCheck size={15}/>Review</button>
    </nav>
    <div className="cw-panels">
      <RetainedView active={tab==='files'} id={`${id}-files-panel`} labelledBy={`${id}-files`}><ClientFiles clientPath={clientPath} onContextMenu={onContextMenu}/></RetainedView>
      <RetainedView active={tab==='review'} id={`${id}-review-panel`} labelledBy={`${id}-review`}>{!hasApprovals&&finalPath?<div className="cw-final-preview" onContextMenu={event=>onContextMenu(event,'Published final',[{label:'Open file location',action:()=>{void invoke('open_file_location',{path:finalPath}).catch(error=>setError(String(error)));}}])}><header><span>Published final</span></header><SourceMediaPreview path={finalPath} name={finalPath.split(/[\\/]/).pop()}/>{error&&<div className="cf-error" role="alert">{error}</div>}</div>:children}</RetainedView>
    </div>
  </section>;
}
