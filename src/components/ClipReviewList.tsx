import type { ReactNode } from 'react';
import { VersionHistory } from './VersionHistory';
import './ClipReviewList.css';

type Item = { id: string; name: string; status?: string; failed?: boolean; checked?: boolean; fixed?: boolean };
export function ClipReviewList({label,items,selected,onSelect,onToggle,disabled=false,header,children,renderAction}:{label:string;items:Item[];selected:string;onSelect:(id:string)=>void;onToggle?:(id:string)=>void;disabled?:boolean;header?:ReactNode;children?:ReactNode;renderAction?:(id:string)=>ReactNode}) {
  return <aside className="clip-review-sidebar" onKeyDown={event=>{
    if(!(event.target instanceof HTMLButtonElement)||!event.target.classList.contains('version-option'))return;
    const index=items.findIndex(item=>item.id===selected);
    const next=event.key==='ArrowDown'?Math.min(items.length-1,index+1):event.key==='ArrowUp'?Math.max(0,index-1):event.key==='Home'?0:event.key==='End'?items.length-1:-1;
    if(next<0||!items[next])return;
    event.preventDefault();
    onSelect(items[next].id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('.version-option')[next]?.focus();
  }}>
    {header}
    <VersionHistory label={label}>{items.map(item=><div key={item.id} className={`version-entry clip-review-entry ${selected===item.id?'selected':''} ${onToggle?'with-inclusion':''}`}>
      <button type="button" className="version-option" aria-pressed={selected===item.id} aria-label={`Preview ${item.name}`} title={item.name} onClick={()=>onSelect(item.id)}>
        <span className="clip-review-name">{item.name.replace(/\.(mp4|mov|mxf|m4v|webm|avi)$/i,'')}</span>
        {item.status&&<span className={`version-state ${item.failed?'failed':''}`}>{item.status}</span>}
      </button>
      {renderAction?.(item.id)}
      {onToggle&&<label className="clip-review-include" title={item.fixed?'Main video is always included':`Include ${item.name}`}><input type="checkbox" aria-label={`Include ${item.name}`} checked={item.checked} disabled={disabled||item.fixed} onChange={()=>onToggle(item.id)}/></label>}
    </div>)}</VersionHistory>
    {children}
  </aside>;
}
