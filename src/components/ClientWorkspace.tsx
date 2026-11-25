import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MessageSquareCheck, Files, Video, HardDrive } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { RetainedView } from './RetainedView';
import { ClientFiles, type FileContextMenu } from './ClientFiles';
import { SourceMediaPreview } from './SourceMediaPreview';
import { parseClientLabel } from './ClientLabel';
import './ClientWorkspace.css';
import { StudioPanel } from './StudioPanel';
import { TakeHomePackage } from './TakeHomePackage';
import { ClientClips } from './ClientClips';

export function ClientWorkspace({projectRoot,clientPath,reviewDefault,hasApprovals,finalPath,clientType,huddleTemplate,studioRequest=0,advancedMode=false,children,onContextMenu}:{projectRoot:string;clientPath:string;reviewDefault:boolean;hasApprovals:boolean;finalPath?:string|null;clientType?:string|null;huddleTemplate?:string|null;studioRequest?:number;advancedMode?:boolean;children:ReactNode;onContextMenu:FileContextMenu}){
  const showStudio=clientType==='HUDDLE'&&huddleTemplate==='VIDEO_CALL';
  const [tab,setTab]=useState<'review'|'files'|'studio'|'drive'>(()=>showStudio&&studioRequest?'studio':reviewDefault?'review':'files');
  const previousDefault=useRef(reviewDefault);
  const [error,setError]=useState('');const id=useId();
  const [clientFilesRevision,setClientFilesRevision]=useState(0);
  const [reviewTab,setReviewTab]=useState<'main'|'clips'>('main');
  useEffect(()=>{if(reviewDefault&&!previousDefault.current)setTab('review');previousDefault.current=reviewDefault;},[reviewDefault]);
  useEffect(()=>{if(showStudio&&studioRequest)setTab('studio');},[studioRequest,showStudio]);
  useEffect(()=>{if(!advancedMode&&tab==='drive')setTab('files');},[advancedMode,tab]);
  return <section className="client-workspace">
    <nav className="cw-tabs" role="tablist" aria-label="Client workspace">
      <button type="button" id={`${id}-files`} role="tab" aria-selected={tab==='files'} aria-controls={`${id}-files-panel`} onClick={()=>setTab('files')}><Files size={15}/>Files</button>
      <button type="button" id={`${id}-review`} role="tab" aria-selected={tab==='review'} aria-controls={`${id}-review-panel`} onClick={()=>setTab('review')}><MessageSquareCheck size={15}/>Review</button>
      {showStudio&&<button type="button" id={`${id}-studio`} role="tab" aria-selected={tab==='studio'} aria-controls={`${id}-studio-panel`} onClick={()=>setTab('studio')}><Video size={15}/>Studio</button>}
      {advancedMode&&<button type="button" id={`${id}-drive`} role="tab" aria-selected={tab==='drive'} aria-controls={`${id}-drive-panel`} onClick={()=>setTab('drive')}><HardDrive size={15}/>Drive</button>}
    </nav>
    <div className="cw-panels">
      <RetainedView active={tab==='files'} id={`${id}-files-panel`} labelledBy={`${id}-files`}><ClientFiles key={`${clientPath}/${clientFilesRevision}`} projectRoot={projectRoot} clientPath={clientPath} onContextMenu={onContextMenu}/></RetainedView>
      <RetainedView active={tab==='review'} id={`${id}-review-panel`} labelledBy={`${id}-review`}><nav className="cw-review-tabs" aria-label="Review views"><button type="button" aria-pressed={reviewTab==='main'} onClick={()=>setReviewTab('main')}>Main video</button><button type="button" aria-pressed={reviewTab==='clips'} onClick={()=>setReviewTab('clips')}>Clips</button></nav><RetainedView active={reviewTab==='main'}><>{!hasApprovals&&finalPath?<div className="cw-final-preview" onContextMenu={event=>onContextMenu(event,'Published final',[{label:'Open file location',action:()=>{void invoke('open_file_location',{path:finalPath}).catch(error=>setError(String(error)));}}])}><header><span>Published final</span></header><SourceMediaPreview path={finalPath} name={finalPath.split(/[\\/]/).pop()}/>{error&&<div className="cf-error" role="alert">{error}</div>}</div>:children}</></RetainedView><RetainedView active={reviewTab==='clips'}><ClientClips clientPath={clientPath} mainPublished={Boolean(finalPath)}/></RetainedView></RetainedView>
      {showStudio&&<RetainedView active={tab==='studio'} id={`${id}-studio-panel`} labelledBy={`${id}-studio`}><StudioPanel refreshKey={studioRequest} clientPath={clientPath} clientName={parseClientLabel(clientPath.split(/[\\/]/).pop()||'Studio session').name} onSettings={()=>window.dispatchEvent(new CustomEvent('pepper-open-restream-settings'))}/></RetainedView>}
      {advancedMode&&<RetainedView active={tab==='drive'} id={`${id}-drive-panel`} labelledBy={`${id}-drive`}><TakeHomePackage active={tab==='drive'} projectRoot={projectRoot} clientPath={clientPath} clientName={clientPath.split(/[\\/]+/).pop()||clientPath} onFilesChanged={()=>setClientFilesRevision(value=>value+1)}/></RetainedView>}
    </div>
  </section>;
}
